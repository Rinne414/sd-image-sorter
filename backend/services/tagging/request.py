"""Request models and validation constants for the tagging service.

Moved verbatim from services/tagging_service.py (decomposition 2026-07).
"""

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field, model_validator

from config import TAGGER_MODELS

# Validation constants
THRESHOLD_MIN = 0.0
THRESHOLD_MAX = 1.0
PATH_MAX_LENGTH = 4096
# Background-task / sequential pipeline: per-image work runs one at a time,
# so the only thing this ceiling caps is the request payload memory. The
# internal SQLite IN(...) reads are already chunked at 500 ids inside
# `database.get_images_by_ids` / `get_image_tags_map`, so a 5M ceiling does
# not change the database access pattern. The previous 10k ceiling was
# rejecting realistic personal SD libraries.
BATCH_EXPORT_LIMIT = 5_000_000
VALID_SORT_OPTIONS = ["frequency", "alphabetical"]


class TagRequest(BaseModel):
    """Request model for tagging operations."""

    image_ids: Optional[List[int]] = Field(default=None, max_length=BATCH_EXPORT_LIMIT)
    # None = "use the chosen model's registry default" (resolved by
    # resolve_request_thresholds). Hardcoding 0.35/0.85 here crushed
    # per-model defaults (camie 0.62) for callers that omit the field.
    threshold: Optional[float] = Field(default=None, ge=THRESHOLD_MIN, le=THRESHOLD_MAX)
    character_threshold: Optional[float] = Field(default=None, ge=THRESHOLD_MIN, le=THRESHOLD_MAX)
    retag_all: bool = False
    model_name: Optional[str] = Field(default=None, max_length=256)
    model_path: Optional[str] = Field(default=None, max_length=PATH_MAX_LENGTH)
    tags_path: Optional[str] = Field(default=None, max_length=PATH_MAX_LENGTH)
    custom_profile: Optional[str] = Field(default=None, max_length=64)
    use_gpu: bool = True
    allow_unsafe_acceleration: bool = False
    batch_size: Optional[int] = Field(default=None, ge=1, le=128)
    # v3.2.2 follow-up (T-power-PR1):
    # pre-tag blacklist applied at write time so unwanted tags
    # (masterpiece / monochrome / signature / watermark / ...) NEVER
    # enter the DB instead of being stripped at export time. Saves
    # repeated cleanup work for users who always reject the same set.
    pre_tag_blacklist: List[str] = Field(default_factory=list, max_length=500)
    # Max tags per image written to DB after the blacklist filter. 0 =
    # unlimited (current default behaviour). Suggested values vary by
    # base-model architecture (CLIP/SDXL ~50, T5/FLUX ~120, Anima/Qwen3 ~200);
    # see backend/services/dataset_audit_service.py and the frontend
    # base-model preset for the live recommendation.
    max_tags_per_image: int = Field(default=0, ge=0, le=2000)


def resolve_request_thresholds(
    model_name: str,
    threshold: Optional[float],
    character_threshold: Optional[float],
) -> tuple:
    """Fill unset thresholds from the chosen model's registry defaults."""
    model_config = TAGGER_MODELS.get(model_name, {})
    if threshold is None:
        threshold = float(model_config.get("default_threshold", 0.35))
    if character_threshold is None:
        character_threshold = float(model_config.get("default_character_threshold", 0.85))
    return threshold, character_threshold


class TagImportRequest(BaseModel):
    """Request model for tag import."""

    images: List[dict] = Field(..., max_length=BATCH_EXPORT_LIMIT)
    overwrite: bool = False


class BatchTagExportRequest(BaseModel):
    """Request model for batch sidecar export."""

    image_ids: Optional[List[int]] = Field(
        default=None, min_length=1, max_length=BATCH_EXPORT_LIMIT
    )
    selection_token: Optional[str] = Field(default=None, min_length=1)
    # ``output_folder`` is required when ``output_mode == "folder"``. When
    # ``output_mode == "beside_image"`` the field is ignored, so the schema
    # allows an empty string and the service-level validator only enforces
    # the path on the folder branch. Default is empty so callers do not have
    # to send a fake path when they pick beside_image.
    output_folder: str = Field(default="", max_length=PATH_MAX_LENGTH)
    output_mode: str = Field(default="folder", max_length=24)
    blacklist: Optional[List[str]] = Field(default=[], max_length=500)
    prefix: Optional[str] = Field(default="", max_length=256)
    content_mode: str = Field(default="tags", max_length=32)
    overwrite_policy: str = Field(default="unique", max_length=16)
    # v3.2.1: options for template content mode (preset_id, template_override, trigger, etc.)
    template_options: Optional[Dict[str, Any]] = Field(default=None)
    # v3.2.1: per-image caption overrides {image_id: caption_text} from live-preview edits
    image_overrides: Optional[Dict[int, str]] = Field(default=None)
    # Compact all-image rules from the v321 caption editor. This keeps
    # "add/remove from all" working for selection tokens without sending
    # every image ID or caption to the browser.
    caption_transforms: Optional[Dict[str, Any]] = Field(default=None)
    # Aurora #25c caption consolidation: per-image caption type + edited NL
    # sentence — the same contract the Dataset Maker export already speaks.
    # ``image_types`` values: "booru" | "nl" | "both"; an absent key means
    # "booru" and reproduces the pre-feature output byte-for-byte.
    # ``image_nl_overrides`` carries the caption editor's NL-box text; when a
    # key is absent the stored nl_caption (then ai_caption) is used instead.
    image_types: Optional[Dict[int, str]] = Field(default=None)
    image_nl_overrides: Optional[Dict[int, str]] = Field(default=None)
    # v3.2.1 follow-up: convert danbooru-style tag underscores to spaces while
    # preserving ``score_*`` prefixes (LoRA-trainer convention). ``None``
    # (default) means "follow the per-content-mode default" — tag modes
    # normalize, free-form text / prompt modes do not. ``True`` / ``False``
    # is an explicit user override surfaced as a checkbox in the export
    # modal.
    normalize_tag_underscores: Optional[bool] = Field(default=None)
    # P0-3 (diffusion-pipe style split export): additionally write each image's
    # natural-language caption to a second sidecar ``{stem}{suffix}.txt`` next
    # to the tag sidecar. Only valid for tag-only content modes (tags,
    # template) — NL-bearing modes already embed the sentence. The trigger
    # (template trigger, else ``prefix``) is injected at the front of the NL
    # text so each file stands alone as a training caption.
    nl_sidecar: bool = Field(default=False)
    nl_sidecar_suffix: str = Field(
        default="_nl", min_length=1, max_length=32, pattern=r"^[A-Za-z0-9._-]+$"
    )
    # P2-19 (2026-07-07): purpose-aware filtering in the export engine —
    # '' = off; character/style/concept reuse Smart Tag's semantics
    # (services.tag_training_filters) on the stored tag rows.
    training_purpose: str = Field(default="", max_length=24)
    # P2-18 (2026-07-07): collapse danbooru implication parents (cat_ears
    # present drops animal_ears) behind an explicit opt-in toggle.
    dedupe_implications: bool = Field(default=False)
    # Debt-22 opt-in: when true, POST /api/tags/export-batch starts a durable-id
    # background job (BulkJobService) with per-image progress and mid-run cancel
    # instead of exporting synchronously in the request.
    background: bool = Field(default=False)

    @model_validator(mode="after")
    def require_ids_or_selection_token(self):
        if self.image_ids is None and not self.selection_token:
            raise ValueError("Either image_ids or selection_token is required")
        if self.image_ids is not None and self.selection_token:
            raise ValueError("Provide either image_ids or selection_token, not both")
        return self


class ExportPreviewRequest(BaseModel):
    """Request model for template live preview rendering."""

    image_ids: List[int] = Field(default_factory=list, max_length=500)
    preset_id: str = "custom"
    template_override: Optional[str] = None
    trigger: str = ""
    blacklist: List[str] = Field(default_factory=list)
    replace_rules: Dict[str, str] = Field(default_factory=dict)
    max_tags: int = 0
    append: List[str] = Field(default_factory=list)
    caption_transforms: Optional[Dict[str, Any]] = Field(default=None)
    # P1-7 preview unification: when set to a real (non-template) content
    # mode, the preview renders through build_sidecar_content — the exact
    # engine the export writes with — instead of a template approximation.
    content_mode: Optional[str] = Field(default=None, max_length=32)
    prefix: str = Field(default="", max_length=256)
    normalize_tag_underscores: Optional[bool] = Field(default=None)
    quality_override: Optional[str] = None
    safety_override: Optional[str] = None
    rating_override: Optional[str] = None
    # v3.2.1 follow-up: forward the user's underscore-toggle to the live
    # preview so the preview matches what the same-name .txt export will
    # actually write. None = follow preset default.
    underscore_to_space_override: Optional[bool] = None
    preserve_underscore_prefixes_override: Optional[List[str]] = None
    # P2-19 / P2-18: preview twins of the export request fields so the live
    # preview shows exactly what the sidecars will contain.
    training_purpose: str = Field(default="", max_length=24)
    dedupe_implications: bool = Field(default=False)


class CombinedTagExportRequest(BatchTagExportRequest):
    """Request model for one-file combined export rendered server-side."""
