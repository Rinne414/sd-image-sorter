"""Smart Tag model runtime: tagger resolution, GPU batching, memory pressure.

Owns booru-tagger resolution (_resolve_tagger / _resolve_tagger_by_model),
the threshold-aware single/batch tag calls, the hardware-aware batch-size
probe + live memory-pressure relief, the serial ToriiGate caption call, and
the two-phase model-residency helpers (_release_booru_sessions /
_load_toriigate_for_phase2). Heavy backends (tagger / oppai_oracle_tagger /
toriigate_tagger / hardware_monitor) stay lazy imports inside functions so
importing this module never loads a model.

Split verbatim out of services/smart_tag_service.py.
"""
from __future__ import annotations

import gc
import logging
import time
from typing import Any, Dict, List, Optional

from config import TAGGER_MODELS
from services.smart_tag.jobs import SmartTagJobState
from services.smart_tag.request import SmartTagRequest
from services.smart_tag.results import _flatten_tag_names

# Shared logger: keep the historical channel name so log capture, filtering,
# and support-log diagnostics behave exactly as before the decomposition.
logger = logging.getLogger("services.smart_tag_service")


# GPU batch size for the booru tagging phase of Smart Tag. Mirrors the regular
# bulk-tagging worker (services/tagging_service.py passes its fetch batch size,
# default ~100) so Smart Tag drives the GPU the same way bulk tagging does:
# WD14's tag_batch self-tunes downward on CUDA OOM (adaptive backoff) and
# OppaiOracle uses it as a fixed chunk. The previous Smart Tag pipeline tagged
# ONE image per GPU call, which barely touched the GPU — this restores batching.
SMART_TAG_TAG_BATCH_SIZE = 64


def _resolve_tagger(req: SmartTagRequest):
    """Pick the right tagger backend for the request.

    OppaiOracle requires its dedicated tagger class (two-input ONNX);
    everything else routes through the WD14 wrapper.
    """
    name = (req.tagger_model or "").strip().lower()
    if name.startswith("toriigate") or TAGGER_MODELS.get(name, {}).get("captioner_only"):
        raise ValueError("ToriiGate is a natural-language caption model. Use natural_language_mode='toriigate' instead of the booru tagger slot.")
    if name.startswith("oppai-oracle"):
        from oppai_oracle_tagger import get_oppai_oracle_tagger
        return get_oppai_oracle_tagger(
            model_name=req.tagger_model,
            threshold=req.general_threshold,
            character_threshold=req.character_threshold,
            use_gpu=req.use_gpu,
            force_reload=False,
        )
    from tagger import get_tagger
    return get_tagger(
        model_name=req.tagger_model or None,
        threshold=req.general_threshold,
        character_threshold=req.character_threshold,
        copyright_threshold=req.copyright_threshold,
        use_gpu=req.use_gpu,
        force_reload=False,
    )


def _resolve_tagger_by_model(
    model_name: str,
    *,
    general_threshold: float,
    character_threshold: float,
    copyright_threshold: float,
    use_gpu: bool,
):
    """v3.2.2 T-power-PR3 (D wire-up): factory that returns a tagger for
    a specific model name. Used by the multi-tagger consensus path so
    each tagger entry in ``SmartTagRequest.taggers`` gets its own
    instance (and its own threshold) without mutating the caller's
    SmartTagRequest. OppaiOracle vs WD14 dispatch mirrors
    ``_resolve_tagger``.
    """
    name = (model_name or "").strip().lower()
    if name.startswith("toriigate") or TAGGER_MODELS.get(name, {}).get("captioner_only"):
        raise ValueError("ToriiGate cannot be used as a booru consensus tagger.")
    if name.startswith("oppai-oracle"):
        from oppai_oracle_tagger import get_oppai_oracle_tagger
        return get_oppai_oracle_tagger(
            model_name=model_name,
            threshold=general_threshold,
            character_threshold=character_threshold,
            use_gpu=use_gpu,
            force_reload=False,
        )
    from tagger import get_tagger
    return get_tagger(
        model_name=model_name or None,
        threshold=general_threshold,
        character_threshold=character_threshold,
        copyright_threshold=copyright_threshold,
        use_gpu=use_gpu,
        force_reload=False,
    )


def _tag_image_with_thresholds(
    tagger,
    image_path: str,
    *,
    general_threshold: float,
    character_threshold: float,
    copyright_threshold: float,
) -> Dict[str, Any]:
    """Call tagger.tag with the richest threshold set it supports.

    WD/Camie/PixAI use the copyright threshold. OppaiOracle has no copyright
    category, so its compatible tag method intentionally ignores that knob.
    """
    import inspect

    kwargs: Dict[str, Any] = {
        "threshold": general_threshold,
        "character_threshold": character_threshold,
    }
    try:
        params = inspect.signature(tagger.tag).parameters
        if "copyright_threshold" in params:
            kwargs["copyright_threshold"] = copyright_threshold
    except (TypeError, ValueError):
        # Some proxy objects may not expose a clean signature. Try the richer
        # call first; if the object rejects it, retry below without copyright.
        kwargs["copyright_threshold"] = copyright_threshold
    try:
        return tagger.tag(image_path, **kwargs)
    except TypeError:
        kwargs.pop("copyright_threshold", None)
        return tagger.tag(image_path, **kwargs)


def _recommended_tag_batch_size(model_name: str, use_gpu: bool) -> int:
    """Hardware-aware booru batch size for Smart Tag.

    Mirrors the bulk tagging worker (``services/tagging_service``): start from
    ``recommend_tagger_config``'s VRAM/model-aware value instead of a fixed 64,
    so an 8GB-VRAM laptop GPU starts at a size that actually fits (e.g. 16 for
    the heavy EVA02 default) rather than attempting 64 and relying on the
    tagger's OOM backoff. That adaptive backoff stays as the second line of
    defense. Clamped to ``[1, SMART_TAG_TAG_BATCH_SIZE]``.
    """
    try:
        from hardware_monitor import get_system_info, recommend_tagger_config

        rec = recommend_tagger_config(
            get_system_info(), model_name=(model_name or None), use_gpu=use_gpu
        )
        if use_gpu:
            size = int(rec.get("recommended_batch_size") or 16)
        else:
            size = int(rec.get("recommended_cpu_chunk_size") or 8)
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("smart-tag: hardware batch-size probe failed (%s); using fallback.", exc)
        size = 16 if use_gpu else 8
    return max(1, min(size, SMART_TAG_TAG_BATCH_SIZE))


def _apply_memory_pressure(job: "SmartTagJobState", tagger, current_batch_size: int) -> int:
    """Live VRAM/RAM-pressure check (mirrors the bulk tagging worker) so Smart
    Tag reacts to the user's *current* machine usage mid-run, not just at job
    start: it refreshes the tagger session when free VRAM is nearly gone and
    shrinks the booru batch when RAM is tight. Returns the (possibly reduced)
    batch size; never grows it back (conservative, like the bulk worker)."""
    try:
        from hardware_monitor import check_memory_pressure

        pressure = check_memory_pressure()
    except Exception:  # pragma: no cover - hardware_monitor optional
        return current_batch_size

    if pressure.get("should_restart_session") and hasattr(tagger, "_recreate_session"):
        try:
            tagger._recreate_session()
            job.message = "VRAM pressure detected — refreshed the tagger session."
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning("smart-tag: session refresh under VRAM pressure failed: %s", exc)

    ram_pct = pressure.get("ram_percent_used")
    if pressure.get("should_pause"):
        reduced = max(1, current_batch_size // 2)
        gc.collect()
        time.sleep(2)
        job.message = f"Memory pressure high — pausing briefly and reducing batch to {reduced}."
        return reduced
    if ram_pct is not None and ram_pct >= 90.0 and current_batch_size > 2:
        reduced = max(2, current_batch_size // 2)
        job.message = f"High RAM usage — reducing batch to {reduced}."
        return reduced
    return current_batch_size


def _tag_batch_with_thresholds(
    tagger,
    image_paths: List[str],
    *,
    general_threshold: float,
    character_threshold: float,
    copyright_threshold: float,
    preferred_batch_size: int = SMART_TAG_TAG_BATCH_SIZE,
) -> List[Dict[str, Any]]:
    """GPU-batch a list of images through ``tagger.tag_batch``.

    Returns one result dict per path (same shape as ``tagger.tag``). Mirrors
    ``_tag_image_with_thresholds`` for the copyright-threshold capability
    difference (WD14 accepts it, OppaiOracle does not). Falls back to per-image
    tagging if the backend has no usable ``tag_batch`` or the batch call fails,
    so behaviour degrades to exactly the old one-at-a-time path rather than
    breaking the run.
    """
    if not image_paths:
        return []

    batch_fn = getattr(tagger, "tag_batch", None)
    if callable(batch_fn):
        import inspect

        kwargs: Dict[str, Any] = {
            "preferred_batch_size": preferred_batch_size,
            "threshold": general_threshold,
            "character_threshold": character_threshold,
        }
        wants_copyright = True
        try:
            params = inspect.signature(batch_fn).parameters
            wants_copyright = ("copyright_threshold" in params) or any(
                p.kind == p.VAR_KEYWORD for p in params.values()
            )
        except (TypeError, ValueError):
            wants_copyright = True
        if wants_copyright:
            kwargs["copyright_threshold"] = copyright_threshold

        for attempt_kwargs in (kwargs, {k: v for k, v in kwargs.items() if k != "copyright_threshold"}):
            try:
                results = batch_fn(image_paths, **attempt_kwargs)
            except TypeError:
                # A kwarg this backend rejects (e.g. copyright_threshold on
                # OppaiOracle). Retry with the trimmed kwargs on the next loop;
                # if that was already the trimmed pass, drop to per-image below.
                continue
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "smart-tag tag_batch failed (%s); falling back to per-image tagging.",
                    exc,
                )
                break
            if isinstance(results, tuple):  # return_runtime_info shape (defensive)
                results = results[0]
            if results is not None and len(results) == len(image_paths):
                return list(results)
            logger.warning(
                "smart-tag tag_batch returned %s results for %d paths; per-image fallback.",
                "None" if results is None else len(results),
                len(image_paths),
            )
            break

    # Per-image fallback: each failure is isolated so one bad image doesn't sink
    # the window. An empty dict means "no tags" — the image can still get a VLM
    # caption downstream.
    out: List[Dict[str, Any]] = []
    for path in image_paths:
        try:
            out.append(
                _tag_image_with_thresholds(
                    tagger,
                    path,
                    general_threshold=general_threshold,
                    character_threshold=character_threshold,
                    copyright_threshold=copyright_threshold,
                )
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("smart-tag per-image tag failed for %s: %s", path, exc)
            out.append({})
    return out


def _toriigate_nl_text(
    nl_tagger,
    image_path: str,
    image_id: int,
    tags: Optional[List[str]] = None,
) -> str:
    """Run a single ToriiGate natural-language caption (local model, serial)."""
    try:
        # Only pass the kwarg when grounding tags exist so pre-v3.4.3 tagger
        # doubles (tests, custom backends) without the kwarg keep working.
        out = nl_tagger.tag(image_path, tags=tags) if tags else nl_tagger.tag(image_path)
        # nl_text is the JSON-sanitized prose; raw_text may be a (truncated)
        # JSON blob the model emitted and must never reach the caption.
        nl_text = str(out.get("nl_text") or "").strip()
        if not nl_text:
            nl_text = ", ".join(_flatten_tag_names(out.get("general_tags") or []))
        return nl_text
    except Exception as exc:  # noqa: BLE001
        logger.warning("ToriiGate natural-language caption failed for image %s: %s", image_id, exc)
        return ""


def _release_booru_sessions(taggers: List[Any]) -> None:
    """Release booru ONNX sessions (and CUDA cache) before ToriiGate loads.

    The taggers are singletons that self-heal on next use (release_session
    flips their loaded flag), so releasing here never breaks later jobs.
    """
    for tagger in taggers:
        release = getattr(tagger, "release_session", None)
        if callable(release):
            try:
                release()
            except Exception:  # noqa: BLE001
                logger.warning("Booru session release failed; continuing.", exc_info=True)
    try:
        from ai_runtime_guard import clear_torch_cuda_cache

        clear_torch_cuda_cache()
    except Exception:  # noqa: BLE001
        pass


def _load_toriigate_for_phase2(job: SmartTagJobState, req: "SmartTagRequest"):
    """Load ToriiGate after the booru phase (two-phase residency contract)."""
    from model_health import get_torch_onnx_runtime_health

    runtime_health = get_torch_onnx_runtime_health()
    compatibility_error = runtime_health.get("runtime_compatibility_error")
    if compatibility_error:
        raise RuntimeError(compatibility_error)
    if req.use_gpu and runtime_health.get("torch_cuda_available") is not True:
        raise RuntimeError(
            "ToriiGate CUDA runtime is not ready. Open Model Manager, run Prepare, "
            "then restart the app."
        )

    from toriigate_tagger import get_toriigate_tagger

    job.message = "Loading ToriiGate natural-language model..."
    nl_tagger = get_toriigate_tagger(
        model_name="toriigate-0.5",
        use_gpu=req.use_gpu,
        force_reload=False,
        caption_length=req.toriigate_caption_length,
        max_new_tokens=req.toriigate_max_new_tokens,
        allow_cpu_fallback=False,
    )
    if hasattr(nl_tagger, "load"):
        nl_tagger.load()
    return nl_tagger
