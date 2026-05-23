"""Smart-Tag orchestrator: WD14/OppaiOracle + VLM + noise-strip + trigger inject.

This module runs the LoraHub-style "smart caption" pipeline against a list of
image IDs already in our gallery DB. The pipeline is:

    1. For each image, run a local tagger (WD14 / OppaiOracle / Camie / etc)
       to produce booru-style tags. If the image already has tags in the DB
       and skip_existing is True, skip the tagger call.
    2. Strip "noise" tags (quality / score / safety / meta / time markers)
       from the WD14 output before they go anywhere near the VLM. These are
       the tags LoRA trainers explicitly want to *anchor*, not have the VLM
       describe back as scene-content.
    3. Pick a VLM prompt preset based on the user's chosen training purpose:
        - style     -> describe medium / rendering / lighting / composition
                       at a HIGH LEVEL, no clothing enumeration
        - character -> describe pose / action / expression / framing,
                       explicitly NOT hair color / eye color / signature
                       outfit (those are baked into the latent)
        - general   -> 2-3 sentences covering subject / pose / clothing /
                       background / lighting
    4. Call the configured VLM with the assembled prompt.
    5. Build the final caption: [rating] [trigger] [general_tags] [NL_text].
    6. Inject trigger word at the front (if user supplied one).
    7. Write the result back to the DB via the existing tagging service plumb.

The implementation deliberately mirrors LoraHub's
``lorahub/api/routers/image_studio/ai.py`` design — the prompt strings are
adapted to match the LoraHub wording so smart-tag results are comparable
between the two tools, and the noise-tag table mirrors LoraHub's
``QUALITY_TAGS / SCORE_TAGS / SAFETY_TAGS / META_TAGS / TIME_TAGS`` from
``lorahub/core/dataset/captions.py``.

This service is pure orchestration: it does not load models, it does not
own the DB connection. It calls into ``tagger.get_tagger`` /
``oppai_oracle_tagger.get_oppai_oracle_tagger`` / the VLM providers and
the existing tagging-service write path. That keeps it cheap to test,
easy to swap a tagger out, and lets the existing model-runtime safety
guards (chunk-size clamps, GPU fallback, BSOD-prevention session refresh)
keep working unchanged.
"""
from __future__ import annotations

import logging
import re
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Noise-tag vocabularies (mirror LoraHub captions.py constants)
# ---------------------------------------------------------------------------

QUALITY_NOISE_TAGS: frozenset = frozenset({
    "masterpiece", "best quality", "good quality", "normal quality",
    "low quality", "worst quality", "high quality", "high_quality",
    "best_quality", "lowres", "highres", "absurdres",
})

# Pony score_N family. Includes the bare and "_up" rollup forms.
SCORE_NOISE_TAGS: frozenset = frozenset(
    {f"score_{i}" for i in range(1, 10)}
    | {"score_9_up", "score_8_up", "score_7_up", "score_6_up"}
    # Also handle space-normalized variants.
    | {f"score {i}" for i in range(1, 10)}
)

SAFETY_NOISE_TAGS: frozenset = frozenset({
    "safe", "sensitive", "questionable", "nsfw", "explicit",
    # OppaiOracle-style "rating:explicit" markers
    "rating:general", "rating:sensitive", "rating:questionable", "rating:explicit",
})

META_NOISE_TAGS: frozenset = frozenset({
    "anime", "illustration", "anime screenshot", "anime_screenshot",
    "jpeg artifacts", "jpeg_artifacts", "official art", "official_art",
    "sketch", "monochrome", "greyscale", "grayscale",
})

TIME_NOISE_TAGS: frozenset = frozenset({
    "newest", "recent", "mid", "early", "old",
})

# Combined set used by auto-strip; callers can subset if they want
# finer-grained control.
DEFAULT_NOISE_TAGS: frozenset = (
    QUALITY_NOISE_TAGS
    | SCORE_NOISE_TAGS
    | SAFETY_NOISE_TAGS
    | META_NOISE_TAGS
    | TIME_NOISE_TAGS
)

_SCORE_RE: re.Pattern = re.compile(r"^score[\s_]\d+(_up)?$", re.IGNORECASE)
_YEAR_RE: re.Pattern = re.compile(r"^year\s+\d{4}$", re.IGNORECASE)


def is_noise_tag(tag: str, noise_set: Iterable[str] = DEFAULT_NOISE_TAGS) -> bool:
    """Return True if ``tag`` should be stripped before VLM / final caption.

    Handles the score_N family via regex (so ``score_9_up`` is caught even
    though it is in the literal set) and the ``year 2024`` regex form.
    """
    lowered = (tag or "").strip().lower()
    if not lowered:
        return True
    if lowered in noise_set:
        return True
    if _SCORE_RE.match(lowered) or _YEAR_RE.match(lowered):
        return True
    return False


def filter_noise_tags(
    tags: List[str], noise_set: Iterable[str] = DEFAULT_NOISE_TAGS
) -> List[str]:
    """Return ``tags`` with noise entries dropped, preserving order."""
    noise_lower = {n.lower() for n in noise_set}
    return [t for t in tags if not is_noise_tag(t, noise_lower)]


# ---------------------------------------------------------------------------
# VLM prompt presets (training-purpose specific, copied from LoraHub design)
# ---------------------------------------------------------------------------

PROMPT_PRESETS: Dict[str, str] = {
    "style": (
        "You are writing the natural-language sentence that will sit inside an Anima "
        "training caption for a STYLE LoRA. The reader is the text encoder; your "
        "sentence must teach it the visual style of the image.\n\n"
        "Write 2-3 sentences in plain English describing:\n"
        "  - the artistic medium and rendering (e.g. clean lineart with soft cel "
        "shading, painterly highlights, halftone screentone, vivid saturated palette, "
        "soft pastel palette, dynamic angle, painterly background)\n"
        "  - lighting and color mood (warm/cool/neon/golden hour/etc.)\n"
        "  - composition and framing (close-up portrait, dynamic low angle, full-body shot, etc.)\n"
        "  - the subject and pose ONLY at a high level (one girl in a dynamic pose, "
        "a group on a ship deck), without enumerating clothing items or accessories.\n\n"
        "Do NOT begin with a trigger word, header, or label - output ONLY the sentences. "
        "Do NOT use vague praise (beautiful, stunning, gorgeous, amazing).\n\n"
        "Reference WD14 general tags (for grounding only): {tags}"
    ),
    "character": (
        "You are writing the natural-language sentences that will sit inside an Anima "
        "training caption for a CHARACTER LoRA. The model must learn the character's "
        "fixed identity from the latent, so your sentences must describe what VARIES "
        "across images.\n\n"
        "Write 2-3 sentences focusing on:\n"
        "  - pose, action, expression\n"
        "  - position/direction inside the frame (e.g. \"standing on the left side of "
        "the image, looking back over her shoulder\")\n"
        "  - background and setting\n"
        "  - framing (close-up, full body, from behind, etc.)\n"
        "  - lighting/mood\n\n"
        "Do NOT describe: hair color, eye color, hair style/length, the character's "
        "signature outfit, or any other fixed identity feature. Do NOT begin with a "
        "trigger word or label - output ONLY the sentences.\n\n"
        "Reference WD14 general tags: {tags}"
    ),
    "general": (
        "Write a 2-3 sentence natural-language description of the image for LoRA "
        "training. Cover subject, pose, clothing, background, lighting, composition. "
        "Plain English, no headers or labels.\n\n"
        "Reference WD14 tags: {tags}"
    ),
    "concept": (
        # "Concept LoRA" trains a non-character, non-style concept (e.g. an
        # object, a setting, a pose). Same as general but emphasises the
        # concept anchoring.
        "Write a 2-3 sentence natural-language description of the image for a "
        "CONCEPT LoRA. Focus on the concept that varies across the dataset (the "
        "object/pose/setting/effect being trained), and how it appears in this "
        "specific image. Cover composition, lighting, and any subject context that "
        "frames the concept. Plain English, no headers or labels.\n\n"
        "Reference WD14 tags: {tags}"
    ),
}

# Allowed values for the API. style/character/general are the LoraHub trio;
# concept is our addition. nsfw is a routing-only alias of general — it
# uses the same prompt but flags the request so a future iteration can
# pick a less-restrictive provider/route if available.
TRAINING_PURPOSE_ALIASES: Dict[str, str] = {
    "style": "style",
    "style_lora": "style",
    "art": "style",
    "art_style": "style",
    "character": "character",
    "character_lora": "character",
    "char": "character",
    "general": "general",
    "concept": "concept",
    "concept_lora": "concept",
    "nsfw": "general",  # Same prompt, flagged differently in routing
    "nsfw_lora": "general",
}


def normalize_training_purpose(value: Optional[str]) -> str:
    """Map a user-provided training purpose to a canonical preset key."""
    if not value:
        return "general"
    key = str(value).strip().lower().replace("-", "_")
    return TRAINING_PURPOSE_ALIASES.get(key, "general")


def build_vlm_prompt(training_purpose: str, wd14_tags: List[str]) -> str:
    """Render the per-image VLM prompt for the given training purpose.

    The WD14 tag list is filtered for noise BEFORE being substituted into
    the template so the VLM never sees ``masterpiece, score_9, anime`` and
    parrots them back into the natural-language sentences.
    """
    canonical = normalize_training_purpose(training_purpose)
    template = PROMPT_PRESETS.get(canonical) or PROMPT_PRESETS["general"]
    cleaned = filter_noise_tags(wd14_tags)
    return template.replace("{tags}", ", ".join(cleaned))



# ---------------------------------------------------------------------------
# Caption assembly + trigger injection
# ---------------------------------------------------------------------------


def _normalize_tag(tag: str) -> str:
    """Normalize a single tag: strip, lowercase, swap underscores to spaces.

    The score_N family is preserved verbatim because the upstream Pony /
    Animagine prompt prefix relies on the literal ``score_7_up`` form.
    """
    stripped = (tag or "").strip()
    if not stripped:
        return ""
    if _SCORE_RE.match(stripped.lower()):
        return stripped.lower()
    return stripped.replace("_", " ").lower()


def _dedupe_preserving_order(items: Iterable[str]) -> List[str]:
    seen: Set[str] = set()
    out: List[str] = []
    for item in items:
        if not item:
            continue
        if item in seen:
            continue
        seen.add(item)
        out.append(item)
    return out


def assemble_caption(
    *,
    rating: Optional[str],
    general_tags: List[str],
    character_tags: List[str],
    nl_text: str,
    trigger_word: Optional[str],
    auto_strip_noise: bool,
    include_rating_prefix: bool = False,
) -> str:
    """Assemble the final training caption.

    Layout (LoraHub-compatible, simplified):
        [trigger] [character_tags] [general_tags] [NL_text]

    Notes:
    * ``rating`` is ignored unless ``include_rating_prefix`` is True; we keep
      it off by default because most LoRA recipes do not want a literal
      ``rating:explicit`` token in the caption.
    * ``auto_strip_noise`` removes quality / score / safety / meta / time
      noise tags from the *final* caption regardless of what the VLM emits
      - the VLM was already told not to produce them, but the local tagger
      may have added them to the WD14 list.
    * ``trigger_word`` is injected as the very first token. If the trigger
      already appears anywhere in the WD14 tags we leave it where it is to
      preserve user intent, otherwise we prepend it.
    """
    pieces: List[str] = []

    nl = (nl_text or "").strip()

    general_norm = [_normalize_tag(t) for t in (general_tags or []) if t]
    character_norm = [_normalize_tag(t) for t in (character_tags or []) if t]

    if auto_strip_noise:
        general_norm = filter_noise_tags(general_norm)
        character_norm = filter_noise_tags(character_norm)

    general_norm = _dedupe_preserving_order(general_norm)
    character_norm = _dedupe_preserving_order(character_norm)

    trigger_clean = (trigger_word or "").strip().lower()
    if trigger_clean:
        # If trigger is already buried in the WD14 tags (case insensitive),
        # leave it - the user explicitly tagged with it.
        already_present = any(
            t.strip().lower() == trigger_clean for t in general_norm + character_norm
        )
        if not already_present:
            pieces.append(trigger_clean)

    if include_rating_prefix and rating:
        rating_norm = str(rating).strip().lower()
        if rating_norm and rating_norm != "unknown":
            pieces.append(rating_norm)

    pieces.extend(character_norm)
    pieces.extend(general_norm)

    tag_section = ", ".join(_dedupe_preserving_order(pieces))
    if nl and tag_section:
        return f"{tag_section}, {nl}"
    if nl:
        return nl
    return tag_section


# ---------------------------------------------------------------------------
# Job tracking (synchronous worker thread, polled progress)
# ---------------------------------------------------------------------------


@dataclass
class SmartTagJobState:
    """Minimal job-state record for a single Smart Tag run.

    The shape mirrors the existing TaggingService progress payload
    (status / current / total / message / errors) so the frontend can
    reuse the same progress-rendering helpers.
    """
    job_id: str
    status: str = "queued"  # queued | running | completed | failed | cancelled
    total: int = 0
    processed: int = 0
    succeeded: int = 0
    failed: int = 0
    message: str = ""
    started_at: float = field(default_factory=time.time)
    finished_at: Optional[float] = None
    cancel_requested: bool = False
    last_caption_preview: str = ""
    errors: List[Dict[str, str]] = field(default_factory=list)
    settings: Dict[str, Any] = field(default_factory=dict)

    def snapshot(self) -> Dict[str, Any]:
        return {
            "job_id": self.job_id,
            "status": self.status,
            "total": self.total,
            "processed": self.processed,
            "succeeded": self.succeeded,
            "failed": self.failed,
            "message": self.message,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "last_caption_preview": self.last_caption_preview,
            "errors": list(self.errors[-25:]),  # tail-cap so payload stays small
            "settings": dict(self.settings),
        }


_jobs_lock = threading.Lock()
_jobs: Dict[str, SmartTagJobState] = {}
_active_job_id: Optional[str] = None


def _new_job_id() -> str:
    return uuid.uuid4().hex


def get_job(job_id: str) -> Optional[SmartTagJobState]:
    with _jobs_lock:
        return _jobs.get(job_id)


def get_active_job() -> Optional[SmartTagJobState]:
    with _jobs_lock:
        if _active_job_id is None:
            return None
        return _jobs.get(_active_job_id)


def cancel_active_job() -> Optional[SmartTagJobState]:
    """Mark the running job (if any) as cancel-requested. Returns the job."""
    with _jobs_lock:
        if _active_job_id is None:
            return None
        job = _jobs.get(_active_job_id)
        if job is None:
            return None
        job.cancel_requested = True
        job.message = "Cancellation requested..."
        return job



# ---------------------------------------------------------------------------
# Pipeline runner
# ---------------------------------------------------------------------------


@dataclass
class SmartTagRequest:
    """Input contract for ``start_smart_tag_job``.

    image_ids OR folder_path is required; folder_path is reserved for a
    future "import-from-folder" path - the MVP only accepts image_ids that
    are already in the gallery DB.
    """
    image_ids: List[int]
    training_purpose: str = "general"
    trigger_word: str = ""
    merge_strategy: str = "replace"  # replace | append
    auto_strip_noise: bool = True
    skip_existing: bool = True
    enable_wd14: bool = True
    enable_vlm: bool = True
    tagger_model: str = ""  # "" -> use the configured default
    use_gpu: bool = True
    general_threshold: float = 0.35
    character_threshold: float = 0.85


def _coerce_request(payload: Dict[str, Any]) -> SmartTagRequest:
    image_ids = payload.get("image_ids") or []
    if not isinstance(image_ids, list):
        raise ValueError("image_ids must be a list of integers")
    cleaned_ids: List[int] = []
    for raw in image_ids:
        try:
            cleaned_ids.append(int(raw))
        except (TypeError, ValueError):
            raise ValueError(f"image_ids contains non-integer entry: {raw!r}")
    if not cleaned_ids:
        raise ValueError("image_ids is required and must be non-empty")

    return SmartTagRequest(
        image_ids=cleaned_ids,
        training_purpose=normalize_training_purpose(payload.get("training_purpose")),
        trigger_word=str(payload.get("trigger_word") or "").strip(),
        merge_strategy=str(payload.get("merge_strategy") or "replace").strip().lower(),
        auto_strip_noise=bool(payload.get("auto_strip_noise", True)),
        skip_existing=bool(payload.get("skip_existing", True)),
        enable_wd14=bool(payload.get("enable_wd14", True)),
        enable_vlm=bool(payload.get("enable_vlm", True)),
        tagger_model=str(payload.get("tagger_model") or "").strip(),
        use_gpu=bool(payload.get("use_gpu", True)),
        general_threshold=float(payload.get("general_threshold", 0.35)),
        character_threshold=float(payload.get("character_threshold", 0.85)),
    )


def _resolve_tagger(req: SmartTagRequest):
    """Pick the right tagger backend for the request.

    OppaiOracle requires its dedicated tagger class (two-input ONNX);
    everything else routes through the WD14 wrapper.
    """
    name = (req.tagger_model or "").strip().lower()
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
        use_gpu=req.use_gpu,
        force_reload=False,
    )


def _flatten_tag_names(items: List[Any]) -> List[str]:
    out: List[str] = []
    for item in items or []:
        if isinstance(item, dict):
            tag = item.get("tag")
            if tag:
                out.append(str(tag))
        elif isinstance(item, str):
            out.append(item)
    return out


def _process_one_image(
    *,
    image_path: str,
    image_id: int,
    req: SmartTagRequest,
    tagger,
    vlm_provider,
) -> Dict[str, Any]:
    """Run the full per-image pipeline. Returns a dict with caption + tags."""
    # ------- Stage 1: WD14 / OppaiOracle local tagging --------------------
    general_names: List[str] = []
    character_names: List[str] = []
    rating: Optional[str] = None

    if req.enable_wd14 and tagger is not None:
        result = tagger.tag(
            image_path,
            threshold=req.general_threshold,
            character_threshold=req.character_threshold,
        )
        general_names = _flatten_tag_names(result.get("general_tags"))
        character_names = _flatten_tag_names(result.get("character_tags"))
        rating = result.get("rating") or None

    # ------- Stage 2: VLM caption --------------------------------------
    nl_text = ""
    if req.enable_vlm and vlm_provider is not None:
        prompt = build_vlm_prompt(req.training_purpose, general_names)
        # Most providers' VLMConfig owns the user_prompt; we override it
        # for this call only via build_user_message's tag injection so we
        # don't mutate the shared config.
        try:
            import asyncio

            async def _call() -> str:
                # Stash the original user_prompt and swap in our preset
                # for this call only. caption_image() reads
                # config.user_prompt at call time, so this is safe even
                # for concurrent calls if the caller runs them serially.
                config = vlm_provider.config
                original_user_prompt = getattr(config, "user_prompt", "")
                original_with_tags = getattr(config, "user_prompt_with_tags", "")
                try:
                    config.user_prompt = prompt
                    config.user_prompt_with_tags = prompt
                    vlm_result = await vlm_provider.caption_image(
                        image_path,
                        tags=general_names if general_names else None,
                    )
                    return (vlm_result.caption or "").strip()
                finally:
                    config.user_prompt = original_user_prompt
                    config.user_prompt_with_tags = original_with_tags

            nl_text = asyncio.run(_call())
        except Exception as exc:  # noqa: BLE001
            logger.warning("VLM caption failed for image %s: %s", image_id, exc)
            nl_text = ""

    # ------- Stage 3: Caption assembly ---------------------------------
    caption = assemble_caption(
        rating=rating,
        general_tags=general_names,
        character_tags=character_names,
        nl_text=nl_text,
        trigger_word=req.trigger_word,
        auto_strip_noise=req.auto_strip_noise,
    )

    return {
        "image_id": image_id,
        "caption": caption,
        "general_tags": general_names,
        "character_tags": character_names,
        "rating": rating,
        "nl_text": nl_text,
    }


def _persist_result(image_id: int, result: Dict[str, Any], merge_strategy: str) -> None:
    """Write the caption back to the DB so it shows up in the Caption Editor.

    We reuse ``database.add_tags_batch`` (the same write path the regular
    tagging worker uses) so this plays nicely with the rest of the app's
    tag-display, search, and export plumbing. ``ai_caption`` carries the
    final composed caption (trigger + tags + NL sentences); the per-tag
    rows carry the individual tag/confidence pairs.
    """
    try:
        import database as db
    except Exception as exc:
        logger.error("smart-tag DB import failed: %s", exc)
        return

    caption = (result.get("caption") or "").strip()
    general = result.get("general_tags") or []
    character = result.get("character_tags") or []

    # On append, glue the new caption onto whatever was there before.
    final_caption = caption
    if merge_strategy == "append":
        try:
            existing_rows = db.get_image_tags(image_id) or []
            # ai_caption isn't returned by get_image_tags; pull from the
            # row directly to honour append semantics.
            row = db.get_images_by_ids([image_id]).get(image_id) or {}
            prior = (row.get("ai_caption") or "").strip()
            if prior and prior != caption:
                final_caption = f"{prior}, {caption}".strip(", ")
            del existing_rows  # not used; kept for documentation of intent
        except Exception as exc:  # noqa: BLE001
            logger.warning("smart-tag append-merge fallback to replace for %s: %s", image_id, exc)

    # Build the per-tag rows the way add_tags_batch expects.
    tag_rows: List[Dict[str, Any]] = []
    for t in character:
        if t:
            tag_rows.append({"tag": t, "confidence": 1.0})
    for t in general:
        if t:
            tag_rows.append({"tag": t, "confidence": 1.0})

    try:
        db.add_tags_batch([
            {
                "image_id": image_id,
                "tags": tag_rows,
                "ai_caption": final_caption or None,
            }
        ])
    except Exception as exc:  # noqa: BLE001
        logger.error("smart-tag DB write failed for %s: %s", image_id, exc)


def _resolve_image_paths(image_ids: List[int]) -> Dict[int, str]:
    """Return ``{image_id: file_path}`` for every id that exists in the DB."""
    try:
        import database as db
    except Exception as exc:
        logger.error("smart-tag DB import failed: %s", exc)
        return {}
    rows = db.get_images_by_ids(list(image_ids))
    out: Dict[int, str] = {}
    for image_id, record in (rows or {}).items():
        path = record.get("path") if isinstance(record, dict) else getattr(record, "path", None)
        if path:
            out[int(image_id)] = str(path)
    return out


def _run_pipeline(job: SmartTagJobState, req: SmartTagRequest) -> None:
    """Body of the worker thread - drives the pipeline and updates job state."""
    global _active_job_id
    job.status = "running"
    job.message = "Resolving images..."
    paths = _resolve_image_paths(req.image_ids)
    job.total = len(paths)
    if not paths:
        job.status = "failed"
        job.message = "No matching images found in the gallery DB."
        job.finished_at = time.time()
        with _jobs_lock:
            if _active_job_id == job.job_id:
                _active_job_id = None
        return

    # Lazy provider construction so importing this module never triggers
    # heavy ONNX / VLM SDK loads.
    tagger = None
    vlm_provider = None
    try:
        if req.enable_wd14:
            job.message = "Loading local tagger..."
            tagger = _resolve_tagger(req)
            if hasattr(tagger, "load"):
                tagger.load()
        if req.enable_vlm:
            job.message = "Loading VLM provider..."
            try:
                # The vlm router owns the "load saved settings -> VLMConfig"
                # plumbing; the vlm_providers registry owns "VLMConfig ->
                # concrete provider instance". Compose them here so the
                # smart-tag pipeline picks up whatever provider/model the
                # user already configured in Settings.
                from routers.vlm import _build_config as _build_vlm_config
                from vlm_providers import get_provider as _get_vlm_provider

                vlm_config = _build_vlm_config()
                if not (vlm_config.endpoint or vlm_config.api_key):
                    logger.info(
                        "smart-tag: no VLM endpoint/api_key configured; "
                        "running tagger-only."
                    )
                    vlm_provider = None
                else:
                    vlm_provider = _get_vlm_provider(vlm_config)
            except Exception as exc:
                logger.warning("VLM provider not available, continuing without it: %s", exc)
                vlm_provider = None
    except Exception as exc:  # noqa: BLE001
        job.status = "failed"
        job.message = f"Failed to initialise pipeline: {exc}"
        job.finished_at = time.time()
        with _jobs_lock:
            if _active_job_id == job.job_id:
                _active_job_id = None
        return

    # Per-image loop (sequential for the MVP - LoraHub does this
    # in parallel pools, we will follow up with that once the basic
    # path is verified end-to-end).
    job.message = f"Smart-tagging {job.total} image(s)..."
    for image_id, path in paths.items():
        if job.cancel_requested:
            job.status = "cancelled"
            job.message = "Cancelled by user."
            break
        try:
            result = _process_one_image(
                image_path=path,
                image_id=image_id,
                req=req,
                tagger=tagger,
                vlm_provider=vlm_provider,
            )
            _persist_result(image_id, result, req.merge_strategy)
            job.succeeded += 1
            preview = (result.get("caption") or "").strip()
            if preview:
                # Cap preview to keep snapshot payload small.
                job.last_caption_preview = preview[:200]
        except Exception as exc:  # noqa: BLE001
            job.failed += 1
            job.errors.append({"image_id": str(image_id), "error": str(exc)})
            logger.warning("smart-tag failed on image %s: %s", image_id, exc)
        finally:
            job.processed += 1
            job.message = f"Processed {job.processed}/{job.total}"

    if job.status == "running":
        job.status = "completed"
        job.message = f"Done. {job.succeeded} ok, {job.failed} failed."
    job.finished_at = time.time()
    with _jobs_lock:
        if _active_job_id == job.job_id:
            _active_job_id = None


def start_smart_tag_job(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Public entry point used by the router.

    Validates the payload, registers a job, and starts the pipeline in a
    daemon worker thread. Returns the initial job snapshot.
    """
    global _active_job_id
    req = _coerce_request(payload)

    with _jobs_lock:
        if _active_job_id is not None:
            existing = _jobs.get(_active_job_id)
            if existing and existing.status in ("queued", "running"):
                raise RuntimeError(
                    "Another Smart Tag job is already running. "
                    "Cancel it first or wait for it to finish."
                )
        job = SmartTagJobState(
            job_id=_new_job_id(),
            settings={
                "image_count": len(req.image_ids),
                "training_purpose": req.training_purpose,
                "trigger_word": req.trigger_word,
                "merge_strategy": req.merge_strategy,
                "auto_strip_noise": req.auto_strip_noise,
                "skip_existing": req.skip_existing,
                "enable_wd14": req.enable_wd14,
                "enable_vlm": req.enable_vlm,
                "tagger_model": req.tagger_model,
            },
        )
        _jobs[job.job_id] = job
        _active_job_id = job.job_id

    threading.Thread(
        target=_run_pipeline,
        args=(job, req),
        name=f"smart-tag-{job.job_id[:8]}",
        daemon=True,
    ).start()
    return job.snapshot()
