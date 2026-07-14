"""Smart Tag natural-language caption phase (shared by all pipelines).

Owns _CaptionPhase + _build_caption_phase (job-constant VLM prompt setup),
_handle_caption_result (assemble + persist + counters, cancel-safe), the
concurrent/serial _run_caption_phase executor, and the ToriiGate
memory-pressure relief for the serial caption loop.

Split verbatim out of services/smart_tag_service.py.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

from services.smart_tag.jobs import SmartTagJobState, _record_job_error
from services.smart_tag.prompts import PROMPT_PRESETS, _vlm_context_tags_for
from services.smart_tag.request import SmartTagCaptionProfile, SmartTagRequest
from services.smart_tag.results import (
    _append_caption_result,
    _assemble_result_dict,
    _persist_result,
)
from services.smart_tag.tagging import _toriigate_nl_text
from services.tag_training_filters import (
    format_trait_suppression_block,
    normalize_training_purpose,
)
from vlm_providers.registry import PROMPT_PRESETS as VLM_PROMPT_PRESETS

# Shared logger: keep the historical channel name so log capture, filtering,
# and support-log diagnostics behave exactly as before the decomposition.
logger = logging.getLogger("services.smart_tag_service")


@dataclass
class _CaptionPhase:
    """Resolved settings for the natural-language caption phase, shared by the
    single-tagger and multi-tagger pipelines so both run the VLM the same way."""
    vlm_provider: Any = None
    nl_tagger: Any = None
    use_vlm: bool = False
    use_toriigate: bool = False
    worker_count: int = 1
    include_tags_as_context: bool = True

    @property
    def nl_active(self) -> bool:
        return self.use_vlm or self.use_toriigate


def _resolve_vlm_prompts(
    req: SmartTagRequest,
) -> Tuple[Optional[str], str, str]:
    """Resolve job-local VLM prompts without mutating provider settings."""
    system_prompt: Optional[str] = None
    if req.caption_profile is SmartTagCaptionProfile.KREA2_LONG_NL:
        profile = VLM_PROMPT_PRESETS[req.caption_profile.value]
        system_prompt = profile["system_prompt"]
        user_prompt = profile["user_prompt"]
        user_prompt_with_tags = profile["user_prompt_with_tags"]
    else:
        template = (
            PROMPT_PRESETS.get(normalize_training_purpose(req.training_purpose))
            or PROMPT_PRESETS["general"]
        )
        user_prompt = template
        user_prompt_with_tags = template

    suppression = format_trait_suppression_block(req.suppressed_traits)
    if suppression:
        user_prompt = f"{user_prompt}\n\n{suppression}"
        user_prompt_with_tags = f"{user_prompt_with_tags}\n\n{suppression}"
    return system_prompt, user_prompt, user_prompt_with_tags


def _build_caption_phase(req: "SmartTagRequest", vlm_provider, nl_tagger) -> "_CaptionPhase":
    """Resolve caption-phase settings and, for VLM mode, set the job-constant
    training-purpose prompt template ONCE on the provider config.

    The provider is built fresh per job and never cached/shared
    (registry.get_provider always constructs a new instance), so setting the
    template here can't bleed into another request, and the per-image {tags}
    substitution done by the provider's build_user_message keeps the concurrent
    calls race-free (no per-image mutation of shared config).
    """
    use_vlm = bool(
        req.enable_vlm
        and req.natural_language_mode == "vlm"
        and vlm_provider is not None
    )
    use_toriigate = bool(
        req.enable_vlm
        and req.natural_language_mode == "toriigate"
        and nl_tagger is not None
    )
    ctx = _CaptionPhase(
        vlm_provider=vlm_provider,
        nl_tagger=nl_tagger,
        use_vlm=use_vlm,
        use_toriigate=use_toriigate,
    )
    if use_vlm:
        config = vlm_provider.config
        ctx.worker_count = max(1, int(getattr(config, "concurrent_requests", 1) or 1))
        ctx.include_tags_as_context = bool(getattr(config, "include_tags_as_context", True)) and req.vlm_grounding
        system_prompt, user_prompt, user_prompt_with_tags = _resolve_vlm_prompts(req)
        if system_prompt is not None:
            config.system_prompt = system_prompt
        config.user_prompt = user_prompt
        config.user_prompt_with_tags = user_prompt_with_tags
        # Smart Tag's VLM role is prose only (booru tags come from the local
        # tagger), so force nl_caption regardless of the VLM Settings preset.
        # Without this, a preset like anima_flux that stored output_format=
        # "both"/"danbooru_tags" would skip the NL parse path entirely.
        config.output_format = "nl_caption"
    return ctx


def _handle_caption_result(
    job: SmartTagJobState,
    req: "SmartTagRequest",
    source_key: str,
    image_id: int,
    path: str,
    partial: Dict[str, Any],
    nl_text: str,
    *,
    nl_active: bool,
) -> None:
    """Assemble + persist one image's caption and update job counters/progress.

    Used by both pipelines. Persists per image (id>0 -> DB, else path-source
    results file) so a cancel keeps finished work. Has no ``await`` so it stays
    atomic when called from concurrent asyncio tasks on the single-threaded
    worker loop.
    """
    try:
        result = _assemble_result_dict(partial, nl_text, image_id, req)
        if image_id > 0:
            _persist_result(image_id, result, req.merge_strategy)
        else:
            _append_caption_result(
                job,
                path,
                (result.get("caption") or "").strip(),
                (result.get("booru_text") or "").strip(),
                (result.get("nl_text") or "").strip(),
            )
        job.succeeded += 1
        job.noise_stripped_count += int(partial.get("noise_stripped") or 0)
        preview = (result.get("caption") or "").strip()
        if preview:
            job.last_caption_preview = preview[:200]
    except Exception as exc:  # noqa: BLE001
        job.failed += 1
        _record_job_error(job, str(source_key), str(exc))
        logger.warning("smart-tag failed on image %s: %s", source_key, exc)
    finally:
        job.processed += 1
        if job.total > 0:
            job.phase_completion = min(1.0, job.processed / job.total)
        label = "VLM captioning" if nl_active else "Processing"
        job.message = f"{label} {job.processed}/{job.total}"


def _record_required_caption_failure(
    job: SmartTagJobState,
    source_key: str,
    error: Exception,
) -> None:
    """Record a required profile caption failure without persisting tag-only output."""
    job.failed += 1
    _record_job_error(job, str(source_key), str(error))
    job.processed += 1
    if job.total > 0:
        job.phase_completion = min(1.0, job.processed / job.total)
    job.message = f"VLM captioning {job.processed}/{job.total}"


def _run_caption_phase(
    job: SmartTagJobState,
    req: "SmartTagRequest",
    items: List[Tuple[str, int, str, Dict[str, Any]]],
    ctx: "_CaptionPhase",
) -> None:
    """Run the natural-language + persist phase for a window of items.

    ``items`` are ``(source_key, image_id, path, partial)`` tuples whose tags
    are already computed. VLM mode runs up to ``ctx.worker_count`` captions
    concurrently (this is what makes ``config.concurrent_requests`` matter);
    ToriiGate runs serially (local GPU model); booru-only assembles directly.
    Each image is persisted as soon as it completes (cancel-safe).
    """
    import asyncio

    if job.cancel_requested or not items:
        return

    if ctx.use_vlm:
        async def _caption_all() -> None:
            sem = asyncio.Semaphore(ctx.worker_count)

            async def _one(item: Tuple[str, int, str, Dict[str, Any]]) -> None:
                source_key, image_id, path, partial = item
                if job.cancel_requested:
                    return
                nl_text = ""
                try:
                    async with sem:
                        if job.cancel_requested:
                            return
                        tags = _vlm_context_tags_for(
                            partial,
                            ctx.include_tags_as_context,
                            req.training_purpose,
                            req.trigger_word,
                        )
                        res = await ctx.vlm_provider.caption_image(path, tags=tags)
                        provider_error = (getattr(res, "error", "") or "").strip()
                        if provider_error:
                            raise RuntimeError(provider_error)
                        nl_text = (getattr(res, "caption", "") or "").strip()
                        if req.caption_profile is not None and not nl_text:
                            raise RuntimeError(
                                f"Caption profile {req.caption_profile.value!r} requires a non-empty "
                                "natural-language caption, but the VLM returned no answer content."
                            )
                except Exception as exc:  # noqa: BLE001
                    # Legacy generic jobs retain their booru output. Explicit
                    # caption profiles fail closed because tag-only output does
                    # not satisfy their training-caption contract.
                    logger.warning(
                        "VLM caption failed for image %s: %s", image_id or source_key, exc
                    )
                    if req.caption_profile is not None:
                        _record_required_caption_failure(job, source_key, exc)
                        return
                    nl_text = ""
                _handle_caption_result(
                    job, req, source_key, image_id, path, partial, nl_text,
                    nl_active=ctx.nl_active,
                )

            await asyncio.gather(*[_one(item) for item in items], return_exceptions=True)

        asyncio.run(_caption_all())
    else:
        captions_since_pressure_check = 0
        for source_key, image_id, path, partial in items:
            if job.cancel_requested:
                break
            if ctx.use_toriigate:
                captions_since_pressure_check += 1
                if captions_since_pressure_check >= TORIIGATE_PRESSURE_CHECK_INTERVAL:
                    captions_since_pressure_check = 0
                    _relieve_caption_pressure(job, ctx.nl_tagger)
            nl_text = (
                _toriigate_nl_text(
                    ctx.nl_tagger,
                    path,
                    image_id,
                    tags=_vlm_context_tags_for(
                        partial,
                        req.toriigate_grounding,
                        req.training_purpose,
                        req.trigger_word,
                    ),
                )
                if ctx.use_toriigate
                else ""
            )
            _handle_caption_result(
                job, req, source_key, image_id, path, partial, nl_text,
                nl_active=ctx.nl_active,
            )


# How many serial ToriiGate captions between live memory-pressure checks.
TORIIGATE_PRESSURE_CHECK_INTERVAL = 16


def _relieve_caption_pressure(job: SmartTagJobState, nl_tagger) -> None:
    """Live VRAM-pressure check for the serial ToriiGate caption loop.

    The booru phase has had this for a while (_apply_memory_pressure); the
    caption phase ran without any live check, so a long ToriiGate run could
    creep into VRAM exhaustion with no relief valve.
    """
    try:
        from hardware_monitor import check_memory_pressure

        pressure = check_memory_pressure()
    except Exception:  # pragma: no cover - hardware_monitor optional
        return
    if pressure.get("should_restart_session") and hasattr(nl_tagger, "_recreate_session"):
        try:
            nl_tagger._recreate_session()
            job.message = "VRAM pressure detected — refreshed the ToriiGate session."
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning("smart-tag: ToriiGate session refresh under pressure failed: %s", exc)
