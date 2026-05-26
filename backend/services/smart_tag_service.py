"""Smart-Tag orchestrator: WD14/OppaiOracle + VLM + noise-strip + trigger inject.

This module runs an automated "smart caption" pipeline against a list of
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
        - concept   -> emphasise the concept being trained; describe how
                       it appears in this specific image
    4. Call the configured VLM with the assembled prompt.
    5. Build the final caption: [rating] [trigger] [general_tags] [NL_text].
    6. Inject trigger word at the front (if user supplied one).
    7. Write the result back to the DB via the existing tagging service plumb.

The pipeline shape follows widely-used LoRA-training conventions
(separate STYLE / CHARACTER / GENERAL caption strategies, danbooru-style
quality / score / safety / meta tag families filtered out before the VLM
sees the tag list). The prompt strings, noise-tag set, and per-purpose
behaviours are written specifically for this project under MIT, not
adapted from any other tool's source code; functional similarity is
unavoidable because the underlying training recipes (Anima, Pony,
NoobAI, Illustrious) are public domain best practice.

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
# Noise-tag vocabularies
#
# The token sets below are danbooru / Pony-style training conventions: the
# QUALITY / SCORE / SAFETY / META / TIME family of tags that LoRA trainers
# anchor literally and do not want the VLM to paraphrase. The vocabulary is
# industry standard public-domain taxonomy from the WD14 / Pony / Illustrious
# recipes, not adapted from any single project's source.
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


def compute_consensus_tags(
    per_tagger_outputs: List[Dict[str, Any]],
    *,
    consensus_min: int = 2,
    skip_categories: Optional[Iterable[str]] = None,
) -> Dict[str, Any]:
    """v3.2.2 T-power-PR2 (D): fuse the outputs of N taggers via weighted
    voting + per-category bypass.

    Each ``per_tagger_outputs`` entry is::

        {
            "model": str,
            "weight": float,            # 0.0-1.0, defaults to 1.0
            "general_tags":   [{tag, confidence, category}, ...],
            "character_tags": [...],
            "rating": {label, score} | str,
        }

    Voting rule per tag:

      - sum of weights from taggers that produced it (above their own
        threshold — that filtering already happened upstream) is >= ``consensus_min``
      - OR the tag's category is in ``skip_categories`` (default
        ``{'character', 'copyright'}``) — most taggers can't recognize
        characters reliably, so we use OR semantics there: any single
        tagger detecting it keeps it.

    Returns ``{"general_tags": [...], "character_tags": [...], "rating": str}``
    where each output tag carries:

      - ``tag``: name (verbatim from the first tagger that produced it)
      - ``confidence``: max confidence across the taggers that voted yes
      - ``category``: 'general' | 'character'
      - ``votes``: int — count of taggers that produced this tag (for diagnostics)
    """
    skip = set(
        s.lower() for s in (
            skip_categories
            if skip_categories is not None
            else {"character", "copyright"}
        )
    )
    consensus_min = max(1, int(consensus_min or 1))

    # Per-tag accumulator: {tag_lc: {tag, category, votes_count, weight_sum, max_conf}}
    accum: Dict[str, Dict[str, Any]] = {}

    for output in per_tagger_outputs or []:
        weight = float(output.get("weight") or 1.0)
        for category_key, category_label in (("general_tags", "general"), ("character_tags", "character")):
            for tag_row in (output.get(category_key) or []):
                if isinstance(tag_row, dict):
                    name = str(tag_row.get("tag") or "").strip()
                    conf = float(tag_row.get("confidence") or 0.0)
                    cat = str(tag_row.get("category") or category_label).lower()
                else:
                    name = str(tag_row or "").strip()
                    conf = 1.0
                    cat = category_label
                if not name:
                    continue
                key = name.lower()
                slot = accum.setdefault(key, {
                    "tag": name,
                    "category": cat,
                    "votes": 0,
                    "weight_sum": 0.0,
                    "max_conf": 0.0,
                    "first_category": category_label,
                })
                slot["votes"] += 1
                slot["weight_sum"] += weight
                if conf > slot["max_conf"]:
                    slot["max_conf"] = conf

    general: List[Dict[str, Any]] = []
    character: List[Dict[str, Any]] = []

    for slot in accum.values():
        category = slot["first_category"]
        bypass = category in skip
        if not bypass and slot["weight_sum"] < float(consensus_min):
            continue
        rendered = {
            "tag": slot["tag"],
            "confidence": round(slot["max_conf"], 4) if slot["max_conf"] else 1.0,
            "category": category,
            "votes": slot["votes"],
        }
        if category == "character":
            character.append(rendered)
        else:
            general.append(rendered)

    # Rating: pick the rating from the tagger with the highest score across
    # all taggers that returned one. Plain-string ratings get score=1.0.
    best_rating = ""
    best_rating_score = -1.0
    for output in per_tagger_outputs or []:
        rating = output.get("rating")
        if not rating:
            continue
        if isinstance(rating, dict):
            label = str(rating.get("label") or "").strip()
            score = float(rating.get("score") or 0.0)
        else:
            label = str(rating).strip()
            score = 1.0
        if label and score > best_rating_score:
            best_rating = label
            best_rating_score = score

    return {
        "general_tags": general,
        "character_tags": character,
        "rating": best_rating,
    }


# ---------------------------------------------------------------------------
# VLM prompt presets (training-purpose specific)
#
# Each prompt instructs the VLM what to describe and what to omit so the
# resulting natural-language sentence pairs cleanly with WD14 tags inside a
# LoRA training caption. The wording below is original to this project; the
# instructional content reflects standard LoRA-training advice (style ->
# rendering only, character -> describe what varies, etc.) which is public
# domain industry practice.
# ---------------------------------------------------------------------------

PROMPT_PRESETS: Dict[str, str] = {
    "style": (
        "Task: produce the natural-language portion of a LoRA training "
        "caption that targets STYLE. The text encoder must learn the visual "
        "style of this image, not its specific subject.\n\n"
        "Output 2-3 plain English sentences that cover:\n"
        "  - rendering medium and technique (linework weight, shading style, "
        "screentone, painterly vs vector, palette saturation and temperature)\n"
        "  - lighting and color mood (golden hour, neon, dramatic rim, overcast, etc.)\n"
        "  - composition and framing (close portrait, full body, low angle, dynamic crop)\n"
        "  - subject only at a high level (single figure in motion, group scene); "
        "do not list clothing pieces, accessories, or character-specific traits\n\n"
        "Rules: no leading trigger word or label, no headers, no empty praise like "
        "\"stunning\" or \"gorgeous\".\n\n"
        "WD14 tags for grounding (do not parrot them back literally): {tags}"
    ),
    "character": (
        "Task: produce the natural-language portion of a LoRA training "
        "caption that targets a CHARACTER. The character's fixed identity is "
        "learned from the trained weights, so duplicating it in captions hurts "
        "training. Write only about what changes across images.\n\n"
        "Output 2-3 plain English sentences focused on:\n"
        "  - pose, action, and facial expression of the moment\n"
        "  - position and orientation within the frame\n"
        "  - background, setting, time of day\n"
        "  - shot framing (close-up, full body, over the shoulder, from behind)\n"
        "  - lighting and overall mood\n\n"
        "Do not describe: hair color, eye color, hair style or length, the "
        "character's signature outfit, or any other fixed identity feature. "
        "No leading trigger word, no headers, no labels.\n\n"
        "WD14 tags for grounding: {tags}"
    ),
    "general": (
        "Task: write 2-3 plain English sentences describing this image for use as "
        "the natural-language portion of a LoRA training caption. Cover the visible "
        "subject, the pose or action, clothing, background, lighting, and overall "
        "composition. No headers, no labels, no trigger word.\n\n"
        "WD14 tags for grounding: {tags}"
    ),
    "concept": (
        # CONCEPT LoRA: trains a non-character, non-style concept (an object,
        # action, setting, or visual effect). The caption must center on that
        # concept so the model learns to associate it with the trigger.
        "Task: write 2-3 plain English sentences for a CONCEPT LoRA caption. "
        "Center the description on the concept being trained (the object, action, "
        "setting, or visual effect that varies across the dataset) and how it "
        "appears in this specific image. Cover composition, lighting, and just "
        "enough subject context to anchor the concept. No headers, no labels, no "
        "trigger word.\n\n"
        "WD14 tags for grounding: {tags}"
    ),
}

# Allowed values for the API. style / character / general / concept cover the
# common LoRA training intents. nsfw is a routing-only alias of general — it
# uses the same prompt but flags the request so a future iteration can pick
# a less-restrictive provider / route if one is available.
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
    stage: str = ""  # "" | "tagging" | "vlm"
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
            "stage": self.stage,
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
    # v3.2.2 T-power-PR2 (D): multi-tagger consensus.
    # When ``taggers`` is non-empty, the orchestrator runs each one
    # sequentially against the image and fuses the per-tag votes via
    # ``compute_consensus_tags``. ``tagger_model`` is ignored in this mode.
    # Default: empty list = legacy single-tagger path. ``consensus_min``
    # is the minimum sum of weights for a tag to survive the vote;
    # ``consensus_skip_categories`` lists category names that bypass the
    # vote with OR semantics (default: 'character' + 'copyright', because
    # most taggers can't recognize specific characters reliably).
    taggers: List[Dict[str, Any]] = field(default_factory=list)
    consensus_min: int = 2
    consensus_skip_categories: List[str] = field(
        default_factory=lambda: ["character", "copyright"]
    )


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

    # T-power-PR2 (D): coerce taggers list to a stable shape.
    raw_taggers = payload.get("taggers") or []
    cleaned_taggers: List[Dict[str, Any]] = []
    if isinstance(raw_taggers, list):
        for entry in raw_taggers:
            if not isinstance(entry, dict):
                continue
            model = str(entry.get("model") or "").strip()
            if not model:
                continue
            cleaned_taggers.append({
                "model": model,
                "weight": float(entry.get("weight") or 1.0),
                "general_threshold": float(entry.get("general_threshold") or 0.35),
                "character_threshold": float(entry.get("character_threshold") or 0.85),
            })

    raw_skip = payload.get("consensus_skip_categories")
    if raw_skip is None:
        skip_categories = ["character", "copyright"]
    elif isinstance(raw_skip, list):
        skip_categories = [str(s).strip().lower() for s in raw_skip if str(s).strip()]
    else:
        skip_categories = ["character", "copyright"]

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
        taggers=cleaned_taggers,
        consensus_min=max(1, int(payload.get("consensus_min", 2) or 2)),
        consensus_skip_categories=skip_categories,
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


def _resolve_tagger_by_model(
    model_name: str,
    *,
    general_threshold: float,
    character_threshold: float,
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
        use_gpu=use_gpu,
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
        # T-power-PR3 (D wire-up): when SmartTagRequest.taggers is
        # populated, run each tagger sequentially on this image and
        # fuse via compute_consensus_tags. The single-tagger object
        # passed in (from _resolve_tagger) is ignored here.
        if req.taggers:
            per_tagger_outputs: List[Dict[str, Any]] = []
            for entry in req.taggers:
                model_name = str(entry.get("model") or "").strip()
                if not model_name:
                    continue
                weight = float(entry.get("weight") or 1.0)
                gen_th = float(entry.get("general_threshold") or req.general_threshold)
                char_th = float(entry.get("character_threshold") or req.character_threshold)
                try:
                    one_tagger = _resolve_tagger_by_model(
                        model_name,
                        general_threshold=gen_th,
                        character_threshold=char_th,
                        use_gpu=req.use_gpu,
                    )
                    if hasattr(one_tagger, "load"):
                        one_tagger.load()
                    out = one_tagger.tag(
                        image_path,
                        threshold=gen_th,
                        character_threshold=char_th,
                    )
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "smart-tag consensus: tagger %s failed on %s: %s",
                        model_name, image_path, exc,
                    )
                    continue
                per_tagger_outputs.append({
                    "model": model_name,
                    "weight": weight,
                    "general_tags": out.get("general_tags") or [],
                    "character_tags": out.get("character_tags") or [],
                    "rating": out.get("rating"),
                })
            fused = compute_consensus_tags(
                per_tagger_outputs,
                consensus_min=req.consensus_min,
                skip_categories=req.consensus_skip_categories,
            )
            general_names = _flatten_tag_names(fused.get("general_tags"))
            character_names = _flatten_tag_names(fused.get("character_tags"))
            rating = fused.get("rating") or None
        else:
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
    vlm_enabled = req.enable_vlm and vlm_provider is not None
    if req.enable_wd14 and vlm_enabled:
        job.stage = "vlm"
    elif req.enable_wd14:
        job.stage = "tagging"
    elif vlm_enabled:
        job.stage = "vlm"
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
