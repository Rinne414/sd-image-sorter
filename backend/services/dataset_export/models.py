"""Pydantic request/response models for the dataset export service.

Moved verbatim from services/dataset_export_service.py (decomposition 2026-07,
claude-dsexport-pins-REPORT.md §6). Defined ONCE here and re-exported by the
facade so the from-import bindings in routers/dataset.py keep class identity —
FastAPI response_model= coercion, request validation, and the facade's
_copy_progress isinstance check all rely on it. No duplicate definition of
these classes may ever exist.
"""

from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field


ExportProgressCallback = Callable[[Dict[str, Any]], None]


class DatasetExportRequest(BaseModel):
    """Request schema for ``POST /api/dataset/export``.

    The UI still behaves best for curated LoRA-sized sets, but the API no
    longer imposes an arbitrary image-count cap. Large folder imports should
    use ``dataset_scan_tokens`` so the browser sends only a compact token while
    the backend streams the manifest.

    Two import sources are supported in one request:

    * ``image_ids`` — IDs from the main library DB, resolved via
      ``database.get_images_by_ids`` (legacy + 'send selection' flow).
    * ``image_paths`` — absolute file paths supplied by the Dataset
      Maker session for items the user imported directly from a folder
      (issue #5 point 5: "small gallery" without DB pollution). The
      export pipeline builds virtual records for these paths so the
      same rename + caption + sidecar logic applies.

    At least one of the two must be non-empty.
    """
    image_ids: List[int] = Field(default_factory=list)
    image_paths: List[str] = Field(default_factory=list)
    dataset_scan_tokens: List[Dict[str, Any]] = Field(default_factory=list, max_length=100)
    output_folder: str = Field(default="", max_length=4096)
    output_mode: str = Field(default="folder", max_length=24)

    naming_pattern: str = Field(default="{filename}", min_length=1, max_length=200)
    trigger: str = Field(default="", max_length=100)
    image_op: str = Field(default="copy")
    overwrite_policy: str = Field(default="unique")

    # Caption rendering options — match the export-template engine knobs
    # the Dataset Maker UI exposes.
    content_mode: str = Field(default="template", max_length=32)
    prefix: str = Field(default="", max_length=256)
    template_options: Optional[Dict[str, Any]] = None
    caption_transforms: Optional[Dict[str, Any]] = None
    blacklist: List[str] = Field(default_factory=list, max_length=200)
    common_tags: List[str] = Field(default_factory=list, max_length=200)
    normalize_tag_underscores: bool = True

    # User-edited captions, keyed by either ``str(image_id)`` (for
    # gallery-source items) or absolute path (for local-source items).
    # Empty string means "use whatever the template engine renders".
    image_overrides: Dict[str, str] = Field(default_factory=dict)

    # Per-image natural-language caption type (point 3: two-box editor). Keyed
    # like ``image_overrides``. Values: ``"booru"`` (tags only — the default and
    # the back-compat path; absent keys behave identically), ``"nl"`` (replace
    # tags with the natural-language sentence), ``"both"`` (tags then sentence).
    # ``image_nl_overrides`` carries the user-edited NL-box text per image so a
    # freshly-rendered booru caption can be paired with an edited sentence
    # without freezing the whole caption.
    image_types: Dict[str, str] = Field(default_factory=dict)
    image_nl_overrides: Dict[str, str] = Field(default_factory=dict)

    # Phase 4 masked training: also export stored masks, named for the
    # chosen trainer. "onetrainer" writes ``<stem>-masklabel.png`` beside
    # each exported image; "kohya" writes ``mask/<stem>.png`` (a
    # conditioning_data_dir layout). Images without a stored mask are
    # counted, never failed — no mask means "train the whole image".
    mask_export: str = Field(default="none", max_length=16)

    # Trainer handoff (roadmap #2): "kohya_toml" drops a ready-to-use
    # dataset_config.toml into the output folder. Official kohya docs say
    # folder-name repeats ("5_cat") are IGNORED by the config-file method —
    # num_repeats must be explicit in the TOML (docs/config_README-en.md),
    # and masked loss consumes a separate same-filename mask directory via
    # conditioning_data_dir (docs/masked_loss_README.md), which is exactly
    # what mask_export="kohya" produces.
    trainer_config: str = Field(default="none", max_length=16)
    trainer_repeats: int = Field(default=10, ge=1, le=1000)
    trainer_batch: int = Field(default=2, ge=1, le=64)
    trainer_resolution: int = Field(default=1024, ge=256, le=4096)
    # keep_tokens: how many leading caption tokens stay FIXED while the
    # rest shuffle (official config example: shuffle_caption = true +
    # keep_tokens = N). This is how the trigger word survives shuffling.
    # 0 = don't emit shuffle/keep lines at all.
    trainer_keep_tokens: int = Field(default=0, ge=0, le=50)


class DatasetExportPreviewRequest(BaseModel):
    """Request schema for ``POST /api/dataset/export-preview``.

    This mirrors the export request but does not require an output folder.
    The preview must render captions through the exact same helper as export
    so the text the user edits is the text that lands in sidecars.
    """

    model_config = ConfigDict(extra="ignore")

    image_ids: List[int] = Field(default_factory=list)
    image_paths: List[str] = Field(default_factory=list)
    dataset_scan_tokens: List[Dict[str, Any]] = Field(default_factory=list, max_length=100)
    output_folder: str = Field(default="", max_length=4096)
    output_mode: str = Field(default="folder", max_length=24)

    naming_pattern: str = Field(default="{filename}", min_length=1, max_length=200)
    trigger: str = Field(default="", max_length=100)
    overwrite_policy: str = Field(default="unique")

    content_mode: str = Field(default="template", max_length=32)
    prefix: str = Field(default="", max_length=256)
    template_options: Optional[Dict[str, Any]] = None
    caption_transforms: Optional[Dict[str, Any]] = None
    blacklist: List[str] = Field(default_factory=list, max_length=500)
    common_tags: List[str] = Field(default_factory=list, max_length=500)
    normalize_tag_underscores: bool = True
    image_overrides: Dict[str, str] = Field(default_factory=dict)
    image_types: Dict[str, str] = Field(default_factory=dict)
    image_nl_overrides: Dict[str, str] = Field(default_factory=dict)
    limit: int = Field(default=72, ge=1, le=500)


class DatasetExportItemResult(BaseModel):
    image_id: int
    src_image_path: Optional[str] = None
    dst_image_path: Optional[str] = None
    dst_caption_path: Optional[str] = None
    skipped_reason: Optional[str] = None
    error: Optional[str] = None


class DatasetExportResponse(BaseModel):
    status: str  # "ok" | "partial" | "failed" | "cancelled"
    exported: int
    skipped: int
    error_count: int
    masks_written: int = 0
    masks_missing: int = 0
    trainer_config_path: Optional[str] = None
    output_folder: str
    output_mode: str = "folder"
    items: List[DatasetExportItemResult]
    total_items: int = 0
    items_truncated: bool = False
    error_messages: List[str]


class DatasetExportStartResponse(BaseModel):
    status: str
    job_id: str
    total: int
    output_folder: str
    message: str
