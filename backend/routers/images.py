"""
Image endpoints for SD Image Sorter.
Handles image retrieval, filtering, and file serving.

Refactored to use Service Layer pattern with dependency injection.
"""
import logging
import subprocess
import sys
from pathlib import Path
from typing import Optional, Any, List, Union

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Path as FastAPIPath, Query, UploadFile, File
from pydantic import BaseModel, Field, model_validator

from config import get_temp_dir
from services import entry_stats_service
from services.bulk_job_service import get_bulk_job_service
from services.image_service import ImageService
from services.service_provider import ServiceProvider
from utils.path_validation import PathValidationError


logger = logging.getLogger(__name__)
PROMPT_MATCH_MODE_EXACT = "exact"
PROMPT_MATCH_MODE_CONTAINS = "contains"
VALID_PROMPT_MATCH_MODES = {PROMPT_MATCH_MODE_EXACT, PROMPT_MATCH_MODE_CONTAINS}


router = APIRouter(prefix="/api", tags=["images"])

# Service instance - will be set via dependency injection
_image_service_provider = ServiceProvider(ImageService)
READER_UPLOAD_TEMP_DIR = Path(get_temp_dir()) / "reader_uploads"
READER_UPLOAD_TTL_SECONDS = 24 * 60 * 60
PARSE_IMAGE_UPLOAD_MAX_BYTES = 64 * 1024 * 1024
PARSE_IMAGE_UPLOAD_CHUNK_SIZE = 1024 * 1024


class DeleteSelectedImagesRequest(BaseModel):
    image_ids: Optional[List[int]] = Field(default=None, min_length=1, max_length=5_000_000)
    selection_token: Optional[str] = Field(default=None, min_length=1)
    confirm_delete_files: bool = False
    # Debt-22 opt-in: when true the sync endpoint instead starts a durable-id
    # background job (BulkJobService) and returns the job envelope. Small
    # selections omit it and keep the unchanged synchronous behavior.
    background: bool = False

    @model_validator(mode="after")
    def require_ids_or_selection_token(self):
        if self.image_ids is None and not self.selection_token:
            raise ValueError("Either image_ids or selection_token is required")
        if self.image_ids is not None and self.selection_token:
            raise ValueError("Provide either image_ids or selection_token, not both")
        return self


class RemoveSelectedImagesRequest(BaseModel):
    # Per-image work is sequential; only the request payload memory matters.
    # Internal SQLite IN(...) lookups already chunk at 500. 5M covers any
    # realistic personal library; the previous 50k ceiling was rejecting
    # real users with larger collections.
    image_ids: Optional[List[int]] = Field(default=None, min_length=1, max_length=5_000_000)
    selection_token: Optional[str] = Field(default=None, min_length=1)
    # Debt-22 opt-in: see DeleteSelectedImagesRequest.background.
    background: bool = False

    @model_validator(mode="after")
    def require_ids_or_selection_token(self):
        if self.image_ids is None and not self.selection_token:
            raise ValueError("Either image_ids or selection_token is required")
        if self.image_ids is not None and self.selection_token:
            raise ValueError("Provide either image_ids or selection_token, not both")
        return self


class ReconnectMissingFilesRequest(BaseModel):
    search_folder: str = Field(..., min_length=1, max_length=4096)
    recursive: bool = True
    verify_uncertain: bool = True


class RepairConfirmRequest(BaseModel):
    """Body for POST /api/images/repair-confirm (Roadmap-C missing-file repair)."""
    review_id: int = Field(..., ge=1)
    action: str = Field(..., pattern="^(pick|merge|skip)$")
    # Required for pick/merge; ignored for skip. Validated against the review's
    # candidate ids in the service layer.
    chosen_image_id: Optional[int] = Field(default=None, ge=1)


class ExportSelectionRequest(BaseModel):
    # Same rationale as RemoveSelectedImagesRequest: sequential per-image
    # work + chunked SQL means the ceiling only caps payload memory.
    image_ids: Optional[List[int]] = Field(default=None, min_length=1, max_length=5_000_000)
    selection_token: Optional[str] = Field(default=None, min_length=1)
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=2000, ge=1, le=10000)

    @model_validator(mode="after")
    def require_ids_or_selection_token(self):
        if self.image_ids is None and not self.selection_token:
            raise ValueError("Either image_ids or selection_token is required")
        if self.image_ids is not None and self.selection_token:
            raise ValueError("Provide either image_ids or selection_token, not both")
        return self


class SelectionIdsRequest(BaseModel):
    generators: List[str] = Field(default_factory=list)
    tags: List[str] = Field(default_factory=list)
    tagMode: str = Field(default="and", pattern="^(and|or)$")
    ratings: List[str] = Field(default_factory=list)
    checkpoints: List[str] = Field(default_factory=list)
    loras: List[str] = Field(default_factory=list)
    prompts: List[str] = Field(default_factory=list)
    promptMatchMode: str = PROMPT_MATCH_MODE_EXACT
    artist: Optional[str] = None
    search: str = ""
    folder: Optional[str] = Field(default=None, max_length=4096)
    hasMetadata: Optional[bool] = Field(default=None)
    sortBy: str = "newest"
    minWidth: Optional[int] = Field(default=None, ge=1, le=100000)
    maxWidth: Optional[int] = Field(default=None, ge=1, le=100000)
    minHeight: Optional[int] = Field(default=None, ge=1, le=100000)
    maxHeight: Optional[int] = Field(default=None, ge=1, le=100000)
    aspectRatio: Optional[str] = None
    minAesthetic: Optional[float] = Field(default=None, ge=0, le=10)
    maxAesthetic: Optional[float] = Field(default=None, ge=0, le=10)
    minUserRating: Optional[int] = Field(default=None, ge=0, le=5)
    brightnessMin: Optional[float] = Field(default=None, ge=0, le=255)
    brightnessMax: Optional[float] = Field(default=None, ge=0, le=255)
    colorTemperature: Optional[str] = Field(default=None, pattern="^(warm|cool|neutral)$")
    brightnessDistribution: Optional[str] = Field(
        default=None,
        pattern="^(left_heavy|right_heavy|middle_heavy|edge_heavy|balanced)$",
    )
    # v3.2.2 per-item exclude filters
    excludeTags: List[str] = Field(default_factory=list)
    excludeGenerators: List[str] = Field(default_factory=list)
    excludeRatings: List[str] = Field(default_factory=list)
    excludeCheckpoints: List[str] = Field(default_factory=list)
    excludeLoras: List[str] = Field(default_factory=list)
    excludePrompts: List[str] = Field(default_factory=list)
    excludeColors: List[str] = Field(default_factory=list)
    colorHues: List[str] = Field(default_factory=list)  # v3.5.0 dominant-hue include
    excludeColorHues: List[str] = Field(default_factory=list)  # v3.5.0 dominant-hue exclude
    collectionId: Optional[int] = Field(default=None, ge=1)
    # Aurora Phase 3 gallery filters (compose with selection tokens)
    noCaption: Optional[bool] = Field(default=None)
    aestheticUnscored: Optional[bool] = Field(default=None)
    minSaturation: Optional[float] = Field(default=None, ge=0, le=255)
    maxSaturation: Optional[float] = Field(default=None, ge=0, le=255)
    seed: Optional[int] = Field(default=None)

    @model_validator(mode="after")
    def validate_prompt_match_mode(self):
        normalized = str(self.promptMatchMode or PROMPT_MATCH_MODE_EXACT).strip().lower()
        if normalized not in VALID_PROMPT_MATCH_MODES:
            raise ValueError("promptMatchMode must be exact or contains")
        self.promptMatchMode = normalized
        self.tagMode = "or" if str(self.tagMode or "and").strip().lower() == "or" else "and"
        return self


class SelectionTokenRequest(SelectionIdsRequest):
    chunkSize: int = Field(default=2000, ge=1, le=10000)
    excludedImageIds: List[int] = Field(default_factory=list, max_length=10000)


class SelectionIdsResponse(BaseModel):
    image_ids: List[int] = Field(default_factory=list)
    total: int = 0


class SelectionTokenResponse(BaseModel):
    selection_token: str
    total_estimate: int = 0
    exact_total: bool = True
    chunk_size: int = 2000


class SelectionChunkResponse(BaseModel):
    image_ids: List[int] = Field(default_factory=list)
    offset: int = 0
    limit: int = 2000
    next_offset: Optional[int] = None
    has_more: bool = False


class ExportSelectionImage(BaseModel):
    id: int
    filename: str = ""
    generator: Optional[str] = None
    prompt: str = ""
    negative_prompt: str = ""
    checkpoint: Optional[str] = None
    width: Optional[int] = None
    height: Optional[int] = None
    aesthetic_score: Optional[float] = None
    ai_caption: str = ""
    generation_params: dict[str, Any] = Field(default_factory=dict)
    tags: List[str] = Field(default_factory=list)


class ExportSelectionResponse(BaseModel):
    images: List[ExportSelectionImage] = Field(default_factory=list)
    missing_ids: List[int] = Field(default_factory=list)
    count: int = 0
    total: int = 0
    offset: int = 0
    limit: int = 0
    next_offset: Optional[int] = None
    has_more: bool = False
    source: str = "image_ids"
    exact_total: bool = True


class DeleteSelectedImagesResponse(BaseModel):
    deleted: int
    failed: List[dict[str, Any]]
    permanent_delete: bool = False
    trash_used: bool = True


class RemoveSelectedImagesResponse(BaseModel):
    removed: int
    missing_ids: List[int] = Field(default_factory=list)
    permanent_delete: bool = False


class BulkJobEnvelopeResponse(BaseModel):
    """Envelope returned when a bulk endpoint is invoked with ``background: true``.

    The client polls GET /api/bulk-jobs/{id} for progress and the final
    ``result``. This is a distinct response shape from the synchronous
    delete/remove responses, hence the Union response models below (Debt-22).
    """
    id: str
    job_id: str
    kind: str
    status: str
    total: int = 0
    processed: int = 0
    error_count: int = 0
    error_samples: List[str] = Field(default_factory=list)
    message: str = ""
    result: dict[str, Any] = Field(default_factory=dict)
    created_at: Optional[float] = None
    started_at: Optional[float] = None
    finished_at: Optional[float] = None
    operation: Optional[str] = None


class SaveEditedMetadataRequest(BaseModel):
    source_path: str = Field(..., min_length=1, description="Source image path (must be non-empty)")
    output_path: str = Field(..., min_length=1, description="Output image path (must be non-empty)")
    format: str = Field(default="png", min_length=1, description="Output format. Empty strings are rejected to avoid silent fallthrough to whatever default the writer picks; the caller must explicitly choose png/webp/jpg.")
    quality: Optional[int] = Field(default=None, ge=1, le=100)
    metadata: dict[str, Any] = Field(default_factory=dict)
    allow_overwrite: bool = False


class SaveEditedMetadataResponse(BaseModel):
    output_path: str
    format: str
    warnings: List[str] = Field(default_factory=list)


class OpenFolderRequest(BaseModel):
    image_id: Optional[int] = None


get_image_service = _image_service_provider.get
set_image_service = _image_service_provider.set


@router.get(
    "/images",
    summary="Get images with optional filters",
    description="""
Retrieve a list of images from the database with comprehensive filtering options.
Uses cursor-based pagination for efficient large dataset handling.

All filter parameters support comma-separated values. Tag filters use AND logic
(all tags must be present). Generator/rating filters use OR logic.

**Example requests:**
- `GET /api/images?generators=comfyui,nai&limit=100` - Get ComfyUI and NAI images
- `GET /api/images?tags=1girl,solo&ratings=general,sensitive` - Get safe solo girl images
- `GET /api/images?search=landscape&sort_by=random` - Random images with 'landscape' in prompt
- `GET /api/images?min_width=1920&aspect_ratio=landscape` - High-res landscape images

**Pagination:**
Use the `cursor` parameter with the `next_cursor` value from the previous response to get the next page.
Treat `next_cursor` as an opaque token and pass it back unchanged.
    """,
    responses={
        200: {
            "description": "List of images matching filters",
            "content": {
                "application/json": {
                    "example": {
                        "images": [
                            {
                                "id": 1,
                                "filename": "image_001.png",
                                "path": "/path/to/image_001.png",
                                "generator": "comfyui",
                                "prompt": "1girl, solo, masterpiece",
                                "negative_prompt": "lowres, bad anatomy",
                                "checkpoint": "sd_xl_base_1.0.safetensors",
                                "checkpoint_normalized": "sd_xl_base_1.0",
                                "width": 1024,
                                "height": 1536,
                                "rating": "general",
                                "library_order_time": "2024-01-15T10:30:00Z",
                                "source_file_mtime": "2024-02-01T08:45:12Z",
                                "created_at": "2024-01-15T10:30:00Z"
                            }
                        ],
                        "next_cursor": "eyJpZCI6MSwic29ydF92YWx1ZSI6IjIwMjQtMDEtMTVUMTA6MzA6MDBaIiwidiI6MX0",
                        "has_more": True,
                        "total": 500
                    }
                }
            }
        },
        400: {
            "description": "Invalid filter parameters",
            "content": {
                "application/json": {
                    "example": {"detail": "Invalid sort_by value. Must be one of: newest, oldest, ..."}
                }
            }
        }
    }
)
async def get_images(
    generators: Optional[str] = Query(
        default=None,
        description="Comma-separated list of generators to filter. Options: comfyui, nai, webui, forge",
        examples=["comfyui,nai"],
    ),
    generator: Optional[str] = Query(
        default=None,
        description=(
            "Singular alias for ``generators``. v3.2.2+ accepts both because users "
            "(and the OpenAPI examples) reach for the natural singular form first; "
            "previously ``?generator=nai`` was silently ignored and returned the "
            "entire unfiltered library."
        ),
        examples=["nai"],
        deprecated=True,
    ),
    tags: Optional[str] = Query(
        default=None,
        description="Comma-separated list of tags (AND logic by default - all tags must be present)",
        examples=["1girl,solo,long_hair"],
    ),
    tag: Optional[str] = Query(
        default=None,
        description="Singular alias for ``tags`` (v3.2.2+).",
        examples=["1girl"],
        deprecated=True,
    ),
    tag_mode: str = Query(
        default="and",
        description="Tag matching mode: 'and' (image must have ALL tags) or 'or' (image must have ANY tag)",
        pattern="^(and|or)$",
        examples=["and"],
    ),
    ratings: Optional[str] = Query(
        default=None,
        description="Comma-separated content ratings. Options: general, sensitive, questionable, explicit",
        examples=["general,sensitive"],
    ),
    rating: Optional[str] = Query(
        default=None,
        description="Singular alias for ``ratings`` (v3.2.2+).",
        examples=["general"],
        deprecated=True,
    ),
    checkpoints: Optional[str] = Query(
        default=None,
        description="Comma-separated checkpoint/model names",
        examples=["sd_xl_base_1.0,animagine_xl"],
    ),
    checkpoint: Optional[str] = Query(
        default=None,
        description="Singular alias for ``checkpoints`` (v3.2.2+).",
        examples=["animagine_xl"],
        deprecated=True,
    ),
    loras: Optional[str] = Query(
        default=None,
        description="Comma-separated LoRA names",
        examples=["detail_tweaker,add_detail"],
    ),
    lora: Optional[str] = Query(
        default=None,
        description="Singular alias for ``loras`` (v3.2.2+).",
        examples=["detail_tweaker"],
        deprecated=True,
    ),
    search: Optional[str] = Query(
        default=None,
        max_length=1000,
        description="Free-text search in image prompts",
        examples=["landscape"],
    ),
    artist: Optional[str] = Query(
        default=None,
        max_length=500,
        description="Filter by artist name",
        examples=["greg_rutkowski"],
    ),
    sort_by: str = Query(
        default="newest",
        description="Sort order: newest, oldest, name_asc, name_desc, generator, generator_desc, prompt_length, prompt_length_asc, tag_count, tag_count_asc, rating, rating_desc, character_count, character_count_asc, random, file_size, file_size_asc, aesthetic, aesthetic_asc, user_rating, user_rating_asc",
        examples=["newest"],
    ),
    limit: int = Query(
        default=100,
        ge=1,
        le=1000,
        description="Number of images to return (1-1000)",
        examples=[100],
    ),
    cursor: Optional[str] = Query(
        default=None,
        description="Opaque cursor from the previous page's next_cursor value. Pass it back unchanged.",
        examples=["eyJpZCI6NDIsInNvcnRfdmFsdWUiOiIyMDI0LTAxLTE1VDEwOjMwOjAwWiIsInYiOjF9"],
    ),
    offset: Optional[int] = Query(
        default=None,
        ge=0,
        le=100_000_000,
        description=(
            "Offset for fallback pagination when the selected sort does not support cursor pagination. "
            "Must be non-negative; large offsets are slow at library scale (prefer cursor pagination)."
        ),
        examples=[200],
    ),
    min_width: Optional[int] = Query(
        default=None,
        ge=1,
        le=100000,
        description="Minimum image width in pixels",
        examples=[1024],
    ),
    max_width: Optional[int] = Query(
        default=None,
        ge=1,
        le=100000,
        description="Maximum image width in pixels",
        examples=[2048],
    ),
    min_height: Optional[int] = Query(
        default=None,
        ge=1,
        le=100000,
        description="Minimum image height in pixels",
        examples=[1024],
    ),
    max_height: Optional[int] = Query(
        default=None,
        ge=1,
        le=100000,
        description="Maximum image height in pixels",
        examples=[2048],
    ),
    prompts: Optional[str] = Query(
        default=None,
        max_length=1000,
        description="Comma-separated prompt terms (AND logic)",
        examples=["masterpiece,best_quality"],
    ),
    prompt_match_mode: str = Query(
        default=PROMPT_MATCH_MODE_EXACT,
        description="Prompt term matching mode: exact token matching or contains substring matching",
        pattern="^(exact|contains)$",
        examples=["exact"],
    ),
    aspect_ratio: Optional[str] = Query(
        default=None,
        description="Filter by aspect ratio: square, landscape, portrait",
        examples=["landscape"],
    ),
    min_aesthetic: Optional[float] = Query(
        default=None,
        ge=0,
        le=10,
        description="Minimum aesthetic score (0-10)",
    ),
    max_aesthetic: Optional[float] = Query(
        default=None,
        ge=0,
        le=10,
        description="Maximum aesthetic score (0-10)",
    ),
    min_user_rating: Optional[int] = Query(
        default=None,
        ge=0,
        le=5,
        description="Minimum user star rating 0-5 (the gallery ★≥N filter); 0 or None shows all (v3.3.2).",
    ),
    # v3.2.1 color filters
    brightness_min: Optional[float] = Query(
        default=None,
        ge=0,
        le=255,
        description="Minimum average brightness (0-255). Set after running /api/colors/analyze.",
    ),
    brightness_max: Optional[float] = Query(
        default=None,
        ge=0,
        le=255,
        description="Maximum average brightness (0-255).",
    ),
    color_temperature: Optional[str] = Query(
        default=None,
        description="Filter by color temperature: warm | cool | neutral",
    ),
    brightness_distribution: Optional[str] = Query(
        default=None,
        description="Filter by brightness distribution shape: left_heavy | right_heavy | middle_heavy | edge_heavy | balanced",
    ),
    # v3.2.2 per-item exclude filters
    exclude_tags: Optional[str] = Query(
        default=None,
        description="Comma-separated tags to exclude (images with ANY of these tags are hidden)",
    ),
    exclude_generators: Optional[str] = Query(
        default=None,
        description="Comma-separated generators to exclude",
    ),
    exclude_ratings: Optional[str] = Query(
        default=None,
        description="Comma-separated ratings to exclude",
    ),
    exclude_checkpoints: Optional[str] = Query(
        default=None,
        description="Comma-separated checkpoints to exclude",
    ),
    exclude_loras: Optional[str] = Query(
        default=None,
        description="Comma-separated LoRAs to exclude",
    ),
    exclude_prompts: Optional[str] = Query(
        default=None,
        description="Comma-separated prompt terms to exclude (v3.3.0)",
    ),
    exclude_colors: Optional[str] = Query(
        default=None,
        description="Comma-separated color temperatures to exclude: warm/cool/neutral (v3.3.0)",
    ),
    color_hues: Optional[str] = Query(
        default=None,
        description="Comma-separated dominant hues to require (ANY match): red/orange/yellow/green/cyan/blue/purple/pink/brown/white/black/gray (v3.5.0)",
    ),
    exclude_color_hues: Optional[str] = Query(
        default=None,
        description="Comma-separated dominant hues to exclude (v3.5.0)",
    ),
    collection_id: Optional[int] = Query(
        default=None,
        ge=1,
        description="Restrict results to images in this collection (v3.3.1). Composes with all other filters.",
    ),
    folder: Optional[str] = Query(
        default=None,
        max_length=4096,
        description="Restrict results to images whose indexed path is within this folder subtree (recursive). v3.3.2 Library Navigation.",
    ),
    has_metadata: Optional[bool] = Query(
        default=None,
        description="Restrict to images that carry SD generation parameters (true) or carry none (false). Omit for all. v3.3.2 small-opt.",
    ),
    # Aurora Phase 3 gallery filters
    no_caption: Optional[bool] = Query(
        default=None,
        description="When true, only images with neither an AI caption nor an NL caption (both empty). Aurora Phase 3.",
    ),
    aesthetic_unscored: Optional[bool] = Query(
        default=None,
        description="When true, only images with no aesthetic score. Takes precedence over min/max_aesthetic. Aurora Phase 3.",
    ),
    min_saturation: Optional[float] = Query(
        default=None,
        ge=0,
        le=255,
        description="Minimum color saturation (0-255). Requires color analysis. Aurora Phase 3.",
    ),
    max_saturation: Optional[float] = Query(
        default=None,
        ge=0,
        le=255,
        description="Maximum color saturation (0-255). Requires color analysis. Aurora Phase 3.",
    ),
    seed: Optional[int] = Query(
        default=None,
        description="Match images generated with this exact seed (read from metadata_json). Aurora Phase 3.",
    ),
    service: ImageService = Depends(get_image_service),
):
    """Retrieve images with optional filtering using cursor-based pagination."""
    # v3.2.2: accept singular forms (``generator``, ``tag``, ``rating``,
    # ``checkpoint``, ``lora``) as aliases for the plural query params so
    # ``?generator=nai`` etc. no longer silently return the entire library.
    # Combine plural + singular, dedupe, comma-join.
    def _merge(plural: Optional[str], singular: Optional[str]) -> Optional[str]:
        if not singular:
            return plural
        combined = (plural + "," + singular) if plural else singular
        seen, parts = set(), []
        for tok in combined.split(","):
            t = tok.strip()
            if t and t not in seen:
                seen.add(t)
                parts.append(t)
        return ",".join(parts) if parts else None

    generators = _merge(generators, generator)
    tags = _merge(tags, tag)
    ratings = _merge(ratings, rating)
    checkpoints = _merge(checkpoints, checkpoint)
    loras = _merge(loras, lora)

    return service.get_images(
        generators=generators,
        tags=tags,
        tag_mode=tag_mode,
        ratings=ratings,
        checkpoints=checkpoints,
        loras=loras,
        search=search,
        artist=artist,
        sort_by=sort_by,
        limit=limit,
        cursor=cursor,
        offset=offset,
        min_width=min_width,
        max_width=max_width,
        min_height=min_height,
        max_height=max_height,
        prompts=prompts,
        prompt_match_mode=prompt_match_mode,
        aspect_ratio=aspect_ratio,
        min_aesthetic=min_aesthetic,
        max_aesthetic=max_aesthetic,
        min_user_rating=min_user_rating,
        brightness_min=brightness_min,
        brightness_max=brightness_max,
        color_temperature=color_temperature,
        brightness_distribution=brightness_distribution,
        exclude_tags=exclude_tags,
        exclude_generators=exclude_generators,
        exclude_ratings=exclude_ratings,
        exclude_checkpoints=exclude_checkpoints,
        exclude_loras=exclude_loras,
        exclude_prompts=exclude_prompts,
        exclude_colors=exclude_colors,
        color_hues=color_hues,
        exclude_color_hues=exclude_color_hues,
        collection_id=collection_id,
        folder=folder,
        has_metadata=has_metadata,
        no_caption=no_caption,
        aesthetic_unscored=aesthetic_unscored,
        min_saturation=min_saturation,
        max_saturation=max_saturation,
        seed=seed,
    )


@router.get(
    "/folders",
    summary="List image directories for the gallery folder tree",
    description="v3.3.2 Library Navigation: distinct directories that contain images, forward-slash normalized and sorted. The frontend builds a nested tree by splitting on '/'.",
)
async def list_library_folders(
    service: ImageService = Depends(get_image_service),
):
    """Return distinct image directories for the gallery folder tree."""
    return service.get_library_folders()


@router.get(
    "/library-roots",
    summary="List registered library roots",
    description="v3.3.2 Library Navigation: folders the user added as image sources, each with a live indexed-image count. Roots are auto-registered when a folder is scanned and persist independently of the images currently under them.",
)
async def list_library_roots(
    service: ImageService = Depends(get_image_service),
):
    """Return registered library roots with per-root image counts."""
    return service.get_library_roots()


@router.post(
    "/images/selection-token",
    response_model=SelectionTokenResponse,
    summary="Create a filtered selection token",
    description="""
Create a stateless token for the current gallery filter payload.

Newer clients use this before fetching `/api/images/selection-chunk` pages so
large filtered selections do not require one giant ID response. `total_estimate`
is exact for indexed filters and marked as an estimate when prompt post-filtering
may still remove SQL false positives.
    """,
)
async def create_selection_token(
    request: SelectionTokenRequest,
    service: ImageService = Depends(get_image_service),
):
    """Create a chunkable filtered-selection token."""
    return service.create_selection_token(
        generators=request.generators,
        tags=request.tags,
        tag_mode=request.tagMode,
        ratings=request.ratings,
        checkpoints=request.checkpoints,
        loras=request.loras,
        prompts=request.prompts,
        prompt_match_mode=request.promptMatchMode,
        artist=request.artist,
        search=request.search,
        sort_by=request.sortBy,
        min_width=request.minWidth,
        max_width=request.maxWidth,
        min_height=request.minHeight,
        max_height=request.maxHeight,
        aspect_ratio=request.aspectRatio,
        min_aesthetic=request.minAesthetic,
        max_aesthetic=request.maxAesthetic,
        min_user_rating=request.minUserRating,
        brightness_min=request.brightnessMin,
        brightness_max=request.brightnessMax,
        color_temperature=request.colorTemperature,
        brightness_distribution=request.brightnessDistribution,
        excluded_image_ids=request.excludedImageIds,
        exclude_tags=request.excludeTags,
        exclude_generators=request.excludeGenerators,
        exclude_ratings=request.excludeRatings,
        exclude_checkpoints=request.excludeCheckpoints,
        exclude_loras=request.excludeLoras,
        exclude_prompts=request.excludePrompts,
        exclude_colors=request.excludeColors,
        color_hues=request.colorHues,
        exclude_color_hues=request.excludeColorHues,
        collection_id=request.collectionId,
        folder=request.folder,
        has_metadata=request.hasMetadata,
        no_caption=request.noCaption,
        aesthetic_unscored=request.aestheticUnscored,
        min_saturation=request.minSaturation,
        max_saturation=request.maxSaturation,
        seed=request.seed,
        chunk_size=request.chunkSize,
    )


@router.get(
    "/images/selection-chunk",
    response_model=SelectionChunkResponse,
    summary="Fetch one filtered selection ID chunk",
    description="Fetch one ordered image-ID chunk from a token created by `/api/images/selection-token`.",
)
async def get_selection_chunk(
    selection_token: str = Query(..., min_length=1),
    offset: int = Query(0, ge=0),
    limit: int = Query(2000, ge=1, le=10000),
    service: ImageService = Depends(get_image_service),
):
    """Return one chunk of filtered-result image IDs."""
    return service.get_selection_chunk(selection_token, offset=offset, limit=limit)


@router.post(
    "/images/reconnect-missing/start",
    summary="Find moved files for missing gallery records",
    description="Start a background search that reconnects missing library records to files found under a user-selected folder. It does not move, delete, or modify image files.",
)
async def start_reconnect_missing_files(
    request: ReconnectMissingFilesRequest,
    background_tasks: BackgroundTasks,
    service: ImageService = Depends(get_image_service),
):
    return service.start_reconnect_missing_files(request, background_tasks)


@router.get(
    "/images/reconnect-missing/progress",
    summary="Get moved-file search progress",
)
async def get_reconnect_missing_files_progress(
    service: ImageService = Depends(get_image_service),
):
    return service.get_reconnect_progress()


@router.post(
    "/images/reconnect-missing/cancel",
    summary="Stop moved-file search",
)
async def cancel_reconnect_missing_files(
    service: ImageService = Depends(get_image_service),
):
    return service.cancel_reconnect_missing_files()


@router.get(
    "/images/repair-candidates",
    summary="List ambiguous missing-file matches awaiting review",
    description="""
Roadmap-C missing-file repair. After a reconnect run, discovered files that
matched several missing library rows by name+size are persisted as *pending*
reviews (the run never touches those rows). This lists them, enriched with each
candidate's current row (path / size / mtime) and whether the candidate's own
file is still missing on disk. Candidate ids deleted since the run are omitted.

Declared above `GET /api/images/{image_id}` so the dynamic-id route does not
shadow it.
    """,
    responses={
        200: {
            "description": "Pending (or scoped) reviews with enriched candidates",
            "content": {
                "application/json": {
                    "example": {
                        "total": 1,
                        "items": [
                            {
                                "review_id": 12,
                                "filename": "same.png",
                                "found_path": "D:/new/same.png",
                                "found_exists": True,
                                "candidate_count": 2,
                                "run_started_at": 1717430000.0,
                                "status": "pending",
                                "resolution": None,
                                "candidates": [
                                    {"image_id": 3, "path": "D:/old/same.png", "file_size": 2048,
                                     "source_mtime_ns": 1700000000000000000, "still_missing": True},
                                    {"image_id": 9, "path": "D:/other/same.png", "file_size": 2048,
                                     "source_mtime_ns": 1700000000000000000, "still_missing": True},
                                ],
                            }
                        ],
                    }
                }
            },
        }
    },
)
async def get_repair_candidates(
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    status: str = Query(
        default="pending",
        description="Filter by review status: pending | resolved | conflict | all.",
    ),
    service: ImageService = Depends(get_image_service),
):
    """List persisted ambiguous-match reviews with enriched candidate rows."""
    return service.get_repair_candidates(limit=limit, offset=offset, status=status)


@router.post(
    "/images/repair-confirm",
    summary="Resolve one ambiguous missing-file match",
    description="""
Roadmap-C missing-file repair. Resolve one pending review:

- **pick** — relink `chosen_image_id` to the review's found file.
- **merge** — relink `chosen_image_id` AND delete the other still-existing candidate rows.
- **skip** — record the decision; touch no image rows.

Refuses with 409 while a reconnect run is active. If the found path is already
indexed as a different row, the review is marked `conflict` and 409 is returned
(never silently duplicating a row). Declared above `GET /api/images/{image_id}`.
    """,
    responses={
        200: {
            "description": "Review resolved",
            "content": {
                "application/json": {
                    "example": {
                        "status": "resolved",
                        "review_id": 12,
                        "resolution": "merge",
                        "image_id": 3,
                        "new_path": "D:/new/same.png",
                        "deleted_ids": [9],
                    }
                }
            },
        },
        404: {"description": "Review not found"},
        409: {"description": "Reconnect run active, review already resolved, or found-path conflict"},
    },
)
async def confirm_repair(
    request: RepairConfirmRequest,
    service: ImageService = Depends(get_image_service),
):
    """Resolve one ambiguous missing-file match (pick / merge / skip)."""
    return service.confirm_repair(
        review_id=request.review_id,
        action=request.action,
        chosen_image_id=request.chosen_image_id,
    )


@router.get(
    "/images/count",
    summary="Count images matching filters",
    description="""
Return the exact number of images matching the same filter parameters as
`GET /api/images`. Powers the live "Apply · ~N images" filter preview
(Aurora Phase 3).

Unlike the `total` field on `GET /api/images` — which returns a `-1` skip
sentinel on the cursor path for very large libraries — this endpoint always
runs the count query and returns a real total. Sort order and pagination
parameters are irrelevant to a count and are not accepted.

Declared above `GET /api/images/{image_id}` so the dynamic-id route does not
shadow it.
    """,
    responses={
        200: {
            "description": "Exact match count",
            "content": {"application/json": {"example": {"total": 4213}}},
        }
    },
)
async def count_images(
    generators: Optional[str] = Query(default=None, description="Comma-separated generators to filter."),
    generator: Optional[str] = Query(default=None, description="Singular alias for generators.", deprecated=True),
    tags: Optional[str] = Query(default=None, description="Comma-separated tags (AND by default)."),
    tag: Optional[str] = Query(default=None, description="Singular alias for tags.", deprecated=True),
    tag_mode: str = Query(default="and", pattern="^(and|or)$", description="Tag matching mode."),
    ratings: Optional[str] = Query(default=None, description="Comma-separated ratings."),
    rating: Optional[str] = Query(default=None, description="Singular alias for ratings.", deprecated=True),
    checkpoints: Optional[str] = Query(default=None, description="Comma-separated checkpoints."),
    checkpoint: Optional[str] = Query(default=None, description="Singular alias for checkpoints.", deprecated=True),
    loras: Optional[str] = Query(default=None, description="Comma-separated LoRAs."),
    lora: Optional[str] = Query(default=None, description="Singular alias for loras.", deprecated=True),
    search: Optional[str] = Query(default=None, max_length=1000, description="Free-text search in prompts."),
    artist: Optional[str] = Query(default=None, max_length=500, description="Filter by artist name."),
    min_width: Optional[int] = Query(default=None, ge=1, le=100000),
    max_width: Optional[int] = Query(default=None, ge=1, le=100000),
    min_height: Optional[int] = Query(default=None, ge=1, le=100000),
    max_height: Optional[int] = Query(default=None, ge=1, le=100000),
    prompts: Optional[str] = Query(default=None, max_length=1000, description="Comma-separated prompt terms (AND)."),
    prompt_match_mode: str = Query(default=PROMPT_MATCH_MODE_EXACT, pattern="^(exact|contains)$"),
    aspect_ratio: Optional[str] = Query(default=None, description="square, landscape, or portrait."),
    min_aesthetic: Optional[float] = Query(default=None, ge=0, le=10),
    max_aesthetic: Optional[float] = Query(default=None, ge=0, le=10),
    min_user_rating: Optional[int] = Query(default=None, ge=0, le=5),
    brightness_min: Optional[float] = Query(default=None, ge=0, le=255),
    brightness_max: Optional[float] = Query(default=None, ge=0, le=255),
    color_temperature: Optional[str] = Query(default=None, description="warm | cool | neutral."),
    brightness_distribution: Optional[str] = Query(default=None),
    exclude_tags: Optional[str] = Query(default=None, description="Comma-separated tags to exclude."),
    exclude_generators: Optional[str] = Query(default=None),
    exclude_ratings: Optional[str] = Query(default=None),
    exclude_checkpoints: Optional[str] = Query(default=None),
    exclude_loras: Optional[str] = Query(default=None),
    exclude_prompts: Optional[str] = Query(default=None),
    exclude_colors: Optional[str] = Query(default=None),
    color_hues: Optional[str] = Query(default=None),
    exclude_color_hues: Optional[str] = Query(default=None),
    collection_id: Optional[int] = Query(default=None, ge=1),
    folder: Optional[str] = Query(default=None, max_length=4096),
    has_metadata: Optional[bool] = Query(default=None),
    # Aurora Phase 3 gallery filters
    no_caption: Optional[bool] = Query(default=None, description="Only images with no AI and no NL caption."),
    aesthetic_unscored: Optional[bool] = Query(default=None, description="Only images with no aesthetic score. Takes precedence over min/max_aesthetic."),
    min_saturation: Optional[float] = Query(default=None, ge=0, le=255),
    max_saturation: Optional[float] = Query(default=None, ge=0, le=255),
    seed: Optional[int] = Query(default=None, description="Match images generated with this exact seed."),
    service: ImageService = Depends(get_image_service),
):
    """Return the exact number of images matching the given filters."""
    # Accept singular aliases exactly as GET /api/images does.
    def _merge(plural: Optional[str], singular: Optional[str]) -> Optional[str]:
        if not singular:
            return plural
        combined = (plural + "," + singular) if plural else singular
        seen, parts = set(), []
        for tok in combined.split(","):
            t = tok.strip()
            if t and t not in seen:
                seen.add(t)
                parts.append(t)
        return ",".join(parts) if parts else None

    return service.get_image_count(
        generators=_merge(generators, generator),
        tags=_merge(tags, tag),
        tag_mode=tag_mode,
        ratings=_merge(ratings, rating),
        checkpoints=_merge(checkpoints, checkpoint),
        loras=_merge(loras, lora),
        search=search,
        artist=artist,
        min_width=min_width,
        max_width=max_width,
        min_height=min_height,
        max_height=max_height,
        prompts=prompts,
        prompt_match_mode=prompt_match_mode,
        aspect_ratio=aspect_ratio,
        min_aesthetic=min_aesthetic,
        max_aesthetic=max_aesthetic,
        min_user_rating=min_user_rating,
        brightness_min=brightness_min,
        brightness_max=brightness_max,
        color_temperature=color_temperature,
        brightness_distribution=brightness_distribution,
        exclude_tags=exclude_tags,
        exclude_generators=exclude_generators,
        exclude_ratings=exclude_ratings,
        exclude_checkpoints=exclude_checkpoints,
        exclude_loras=exclude_loras,
        exclude_prompts=exclude_prompts,
        exclude_colors=exclude_colors,
        color_hues=color_hues,
        exclude_color_hues=exclude_color_hues,
        collection_id=collection_id,
        folder=folder,
        has_metadata=has_metadata,
        no_caption=no_caption,
        aesthetic_unscored=aesthetic_unscored,
        min_saturation=min_saturation,
        max_saturation=max_saturation,
        seed=seed,
    )


@router.get(
    "/images/{image_id}",
    summary="Get a single image",
    description="Retrieve detailed information about a specific image including all associated tags.",
    responses={
        200: {
            "description": "Image details with tags",
            "content": {
                "application/json": {
                    "example": {
                        "image": {
                            "id": 1,
                            "filename": "image_001.png",
                            "path": "/path/to/image_001.png",
                            "generator": "comfyui",
                            "prompt": "1girl, solo, masterpiece",
                            "negative_prompt": "lowres, bad anatomy",
                            "checkpoint": "sd_xl_base_1.0.safetensors",
                            "checkpoint_normalized": "sd_xl_base_1.0",
                            "width": 1024,
                            "height": 1536,
                            "rating": "general"
                        },
                        "tags": [
                            {"tag": "1girl", "confidence": 0.95},
                            {"tag": "solo", "confidence": 0.92}
                        ]
                    }
                }
            }
        },
        404: {"description": "Image not found", "content": {"application/json": {"example": {"detail": "Image not found"}}}}
    }
)
async def get_image(
    image_id: int = FastAPIPath(..., ge=1, le=2_147_483_647, description="Image ID (must fit in signed 32-bit int)"),
    service: ImageService = Depends(get_image_service),
):
    """Get a single image with its associated tags."""
    return service.get_image_by_id(image_id)


@router.post(
    "/images/export-data",
    response_model=ExportSelectionResponse,
    summary="Get prompt and tag export data for selected images",
    description="""
Return prompt text and tags for a selected image batch.

Legacy clients may pass explicit `image_ids`. Newer large-selection clients may
pass `selection_token`, `offset`, and `limit` to page export preview data without
sending a giant ID payload. Missing explicit IDs are reported in `missing_ids`
instead of failing the whole export.
    """,
)
async def export_selection_data(
    request: ExportSelectionRequest,
    service: ImageService = Depends(get_image_service),
):
    """Get export-ready prompt and tag data for selected images or a token chunk."""
    if request.selection_token:
        return service.get_export_selection_data_for_token(
            request.selection_token,
            offset=request.offset,
            limit=request.limit,
        )
    return service.get_export_selection_data(request.image_ids or [])


@router.post(
    "/images/selection-ids",
    response_model=SelectionIdsResponse,
    summary="Resolve all image IDs for the current filtered result set",
    description="""
Return the full ordered ID set for the current gallery filter payload.

This is used for truthful filtered-result selection. Unlike visible or loaded
selection, this endpoint resolves the full matching result set in backend sort
order, not just the thumbnails currently mounted in the DOM.
    """,
)
async def get_selection_ids(
    request: SelectionIdsRequest,
    service: ImageService = Depends(get_image_service),
):
    """Return the full filtered-result ID set for selection flows."""
    return service.get_filtered_selection_ids(
        generators=request.generators,
        tags=request.tags,
        tag_mode=request.tagMode,
        ratings=request.ratings,
        checkpoints=request.checkpoints,
        loras=request.loras,
        prompts=request.prompts,
        prompt_match_mode=request.promptMatchMode,
        artist=request.artist,
        search=request.search,
        sort_by=request.sortBy,
        min_width=request.minWidth,
        max_width=request.maxWidth,
        min_height=request.minHeight,
        max_height=request.maxHeight,
        aspect_ratio=request.aspectRatio,
        min_aesthetic=request.minAesthetic,
        max_aesthetic=request.maxAesthetic,
        min_user_rating=request.minUserRating,
        brightness_min=request.brightnessMin,
        brightness_max=request.brightnessMax,
        color_temperature=request.colorTemperature,
        brightness_distribution=request.brightnessDistribution,
        exclude_tags=request.excludeTags,
        exclude_generators=request.excludeGenerators,
        exclude_ratings=request.excludeRatings,
        exclude_checkpoints=request.excludeCheckpoints,
        exclude_loras=request.excludeLoras,
        exclude_prompts=request.excludePrompts,
        exclude_colors=request.excludeColors,
        color_hues=request.colorHues,
        exclude_color_hues=request.excludeColorHues,
        collection_id=request.collectionId,
        folder=request.folder,
        has_metadata=request.hasMetadata,
        no_caption=request.noCaption,
        aesthetic_unscored=request.aestheticUnscored,
        min_saturation=request.minSaturation,
        max_saturation=request.maxSaturation,
        seed=request.seed,
    )


@router.post(
    "/images/delete-selected",
    response_model=Union[DeleteSelectedImagesResponse, BulkJobEnvelopeResponse],
    summary="Move selected image files to OS trash",
    description="""
Move the selected image files to the operating system Trash / Recycle Bin and
remove their database rows.

This is a destructive action and requires explicit confirmation from the client.
The response reports partial failures per image instead of hiding them. The
backend must not fall back to permanent deletion when trash is unavailable.
    """,
)
async def delete_selected_images(
    request: DeleteSelectedImagesRequest,
    background_tasks: BackgroundTasks,
    service: ImageService = Depends(get_image_service),
):
    """Move selected image files to OS trash with partial-failure reporting."""
    if not request.confirm_delete_files:
        raise HTTPException(
            status_code=400,
            detail="Deleting image files requires explicit confirmation",
        )

    # Debt-22: opt into a durable-id background job for large selections. The
    # ids are snapshotted server-side before any file is trashed; poll via
    # GET /api/bulk-jobs/{job_id} and cancel via POST /api/bulk-jobs/{job_id}/cancel.
    if request.background:
        return service.start_delete_bulk_job(request, background_tasks)

    if request.selection_token:
        return service.delete_selected_image_files_by_token(request.selection_token)
    return service.delete_selected_image_files(request.image_ids or [])


@router.post(
    "/images/delete-selected/start",
    summary="Start a background delete-to-trash job for selected images",
    description="""
Move the selected image files to the OS Trash / Recycle Bin and remove their
database rows as a **background job** with progress polling. Cloned from the
gallery move job (``/api/move/start``) so large selections stream progress
instead of freezing the request.

This is a destructive action and requires explicit confirmation from the client.
The selected ids are snapshotted server-side before any deletion. The final
progress payload reports ``deleted`` and per-image ``failed`` entries, matching
the synchronous endpoint's shape.
    """,
)
async def start_delete_selected_images_job(
    request: DeleteSelectedImagesRequest,
    background_tasks: BackgroundTasks,
    service: ImageService = Depends(get_image_service),
):
    """Start the background delete-to-trash job with partial-failure reporting."""
    if not request.confirm_delete_files:
        raise HTTPException(
            status_code=400,
            detail="Deleting image files requires explicit confirmation",
        )
    return service.start_delete_selected_job(request, background_tasks)


@router.get(
    "/images/delete-selected/progress",
    summary="Get delete-to-trash job progress",
)
async def get_delete_selected_images_progress(
    service: ImageService = Depends(get_image_service),
):
    """Get current gallery delete-to-trash job progress."""
    return service.get_delete_progress()


@router.post(
    "/images/delete-selected/cancel",
    summary="Stop the delete-to-trash job",
)
async def cancel_delete_selected_images(
    service: ImageService = Depends(get_image_service),
):
    """Request cooperative cancellation of the active delete-to-trash job."""
    return service.cancel_delete()


@router.post(
    "/images/delete-selected/reset",
    summary="Reset a stuck delete-to-trash job",
)
async def reset_delete_selected_images(
    service: ImageService = Depends(get_image_service),
):
    """Reset a stuck delete-to-trash job."""
    return service.reset_delete_progress()


@router.post(
    "/images/remove-selected",
    response_model=Union[RemoveSelectedImagesResponse, BulkJobEnvelopeResponse],
    summary="Remove selected images from the gallery index",
    description="""
Remove selected database rows from the local gallery without deleting the backing
image files from disk. Re-scanning the source folder can add them back later.
    """,
)
async def remove_selected_images(
    request: RemoveSelectedImagesRequest,
    background_tasks: BackgroundTasks,
    service: ImageService = Depends(get_image_service),
):
    """Remove selected images from the gallery index without touching files."""
    # Debt-22: opt into a durable-id background job for large selections.
    if request.background:
        return service.start_remove_bulk_job(request, background_tasks)

    if request.selection_token:
        return service.remove_selected_images_from_gallery_by_token(request.selection_token)
    return service.remove_selected_images_from_gallery(request.image_ids or [])


@router.post(
    "/images/remove-selected/start",
    summary="Start a background remove-from-gallery job for selected images",
    description="""
Remove selected database rows from the local gallery (files stay on disk) as a
**background job** with progress polling. Cloned from the move/delete jobs so
large selections stream progress instead of freezing the request. The selected
ids are snapshotted server-side before any removal.
    """,
)
async def start_remove_selected_images_job(
    request: RemoveSelectedImagesRequest,
    background_tasks: BackgroundTasks,
    service: ImageService = Depends(get_image_service),
):
    """Start the background remove-from-gallery job (DB rows only, files kept)."""
    return service.start_remove_selected_job(request, background_tasks)


@router.get(
    "/images/remove-selected/progress",
    summary="Get remove-from-gallery job progress",
)
async def get_remove_selected_images_progress(
    service: ImageService = Depends(get_image_service),
):
    """Get current gallery remove-from-gallery job progress."""
    return service.get_remove_progress()


@router.post(
    "/images/remove-selected/cancel",
    summary="Stop the remove-from-gallery job",
)
async def cancel_remove_selected_images(
    service: ImageService = Depends(get_image_service),
):
    """Request cooperative cancellation of the active remove-from-gallery job."""
    return service.cancel_remove()


@router.post(
    "/images/remove-selected/reset",
    summary="Reset a stuck remove-from-gallery job",
)
async def reset_remove_selected_images(
    service: ImageService = Depends(get_image_service),
):
    """Reset a stuck remove-from-gallery job."""
    return service.reset_remove_progress()


# ---------------------------------------------------------------------------
# Debt-22: unified durable bulk-job registry (delete / remove / export).
# The operation-specific "start" happens on the existing sync endpoints with
# ``background: true`` (and on POST /api/tags/export-batch); these routes let a
# client poll, cancel, and list any bulk job by its durable id.
# ---------------------------------------------------------------------------
@router.get(
    "/bulk-jobs",
    summary="List bulk background jobs",
    description=(
        "List token-scoped bulk jobs (delete-files / remove-from-gallery / "
        "export-sidecars) tracked by the durable BulkJobService. Pass "
        "``active_only=true`` to hide finished jobs (Debt-22)."
    ),
)
async def list_bulk_jobs(
    active_only: bool = Query(
        default=False,
        description="Only return non-terminal (queued/running) jobs.",
    ),
):
    """List durable bulk background jobs."""
    return {"jobs": get_bulk_job_service().list_jobs(active_only=active_only)}


@router.get(
    "/bulk-jobs/{job_id}",
    summary="Get a bulk background job by id",
    description=(
        "Poll one durable bulk job by id. Returns ``status`` "
        "(queued/running/done/error/cancelled), ``processed``/``total``, "
        "``error_count``, bounded ``error_samples``, and — on completion — the "
        "operation ``result`` (Debt-22)."
    ),
)
async def get_bulk_job(
    job_id: str = FastAPIPath(..., min_length=1, max_length=64),
):
    """Return one durable bulk job's status snapshot."""
    job = get_bulk_job_service().get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Bulk job not found")
    return job


@router.post(
    "/bulk-jobs/{job_id}/cancel",
    summary="Cancel a bulk background job by id",
    description=(
        "Request cooperative cancellation of a running bulk job. The worker "
        "stops at the next chunk boundary and settles as ``cancelled`` with "
        "partial progress (Debt-22)."
    ),
)
async def cancel_bulk_job(
    job_id: str = FastAPIPath(..., min_length=1, max_length=64),
):
    """Request cancellation of a durable bulk job."""
    job = get_bulk_job_service().cancel_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Bulk job not found")
    return job


@router.post(
    "/images/{image_id}/reparse",
    summary="Re-parse image metadata",
    description="""
Re-extract metadata from the image file and update the database.
Useful when the original metadata extraction failed or when the image was modified.

Supports re-parsing for:
- ComfyUI: JSON workflow in PNG text chunks
- NovelAI: JSON in Comment text chunk
- WebUI/Forge: parameters text chunk
- WebP: EXIF and XMP metadata
    """,
    responses={
        200: {"description": "Updated image data", "content": {"application/json": {"example": {"image": {}, "tags": []}}}},
        404: {"description": "Image not found", "content": {"application/json": {"example": {"detail": "Image not found"}}}},
        500: {"description": "Failed to reparse", "content": {"application/json": {"example": {"detail": "Failed to reparse metadata"}}}}
    }
)
async def reparse_image(
    image_id: int,
    service: ImageService = Depends(get_image_service),
):
    """Re-parse metadata for a single image and update the database."""
    return service.reparse_image(image_id)


class SetUserRatingRequest(BaseModel):
    """Body for POST /api/images/{image_id}/rating (v3.3.2 FF-2)."""
    stars: int = Field(..., ge=0, le=5, description="User star rating 0-5 (0 = unrated)")


@router.post(
    "/images/{image_id}/rating",
    summary="Set an image's user star rating",
    description=(
        "Set the explicit user star rating (0-5; 0 = unrated) for one image (v3.3.2). "
        "This is the Eagle-style manual rating, independent of the AI WD14 rating tags "
        "(general/sensitive/questionable/explicit)."
    ),
    responses={
        200: {"description": "Rating updated", "content": {"application/json": {"example": {"image_id": 42, "user_rating": 4, "updated": True}}}},
        404: {"description": "Image not found", "content": {"application/json": {"example": {"detail": "Image not found"}}}},
    },
)
async def set_image_user_rating(
    image_id: int,
    request: SetUserRatingRequest,
    service: ImageService = Depends(get_image_service),
):
    """Set the user star rating (0-5) for a single image."""
    try:
        result = service.set_user_rating(image_id, request.stars)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not result.get("updated"):
        raise HTTPException(status_code=404, detail="Image not found")
    entry_stats_service.record_activity(entry_stats_service.KIND_RATED, 1)
    return result


@router.post(
    "/image-metadata/save-edited",
    response_model=SaveEditedMetadataResponse,
    summary="Save an image copy with edited metadata",
    description="""
Save a copy of an image to a caller-selected path after editing common SD metadata fields.

This endpoint is used by the Single Image Reader metadata editor. It defaults to
save-as-new behavior and returns format-specific warnings where metadata support
is limited (notably JPEG / some WebP viewers).
    """,
    responses={
        200: {
            "description": "Edited image saved successfully",
            "content": {
                "application/json": {
                    "example": {
                        "output_path": "/path/to/image.metadata-edited.png",
                        "format": "png",
                        "warnings": [],
                    }
                }
            }
        },
        400: {"description": "Invalid path, format, or metadata payload"},
        409: {"description": "Output path already exists and overwrite was not confirmed"},
    },
)
async def save_edited_image_metadata(
    request: SaveEditedMetadataRequest,
    service: ImageService = Depends(get_image_service),
):
    """Save a new image with edited metadata."""
    try:
        return service.save_image_with_edited_metadata(
            source_path=request.source_path,
            output_path=request.output_path,
            image_format=request.format,
            metadata=request.metadata,
            allow_overwrite=request.allow_overwrite,
            quality=request.quality,
        )
    except FileExistsError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except (PathValidationError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except PermissionError as exc:
        # v3.2.2: previously bubbled up as 500 "UnhandledException" when
        # users tried to save into a system-protected directory like
        # C:\Windows\System32\. That looks like a server crash; return a
        # 403 with the OS-provided reason instead.
        raise HTTPException(
            status_code=403,
            detail=f"Permission denied writing to output path: {exc}",
        ) from exc
    except OSError as exc:
        # Catch the OS-level errors (read-only path, ENOSPC, ENOENT on
        # the parent directory, network drive timeout) and surface them
        # as 400 with the underlying message rather than a generic 500.
        raise HTTPException(
            status_code=400,
            detail=f"Cannot write to output path: {exc}",
        ) from exc


@router.get(
    "/image-file/{image_id}",
    summary="Get image file",
    description="Serve the actual image file for display or download.",
    responses={
        200: {"description": "Image file binary data"},
        404: {"description": "Image not found or file missing", "content": {"application/json": {"example": {"detail": "Image not found"}}}}
    }
)
async def get_image_file(
    image_id: int,
    service: ImageService = Depends(get_image_service),
):
    """Serve the actual image file."""
    return service.get_image_file(image_id)


@router.get(
    "/image-thumbnail/{image_id}",
    summary="Get image thumbnail",
    description="""
Get a cached thumbnail of the image.

Thumbnails are cached in backend/thumbnails/ using WebP format for optimal
compression. Cache invalidation is based on source file modification time.

Supported cache sizes: 256, 384, 512 (requested sizes are normalized to nearest).
Custom sizes between 1-4096 are generated on-demand but not cached.
    """,
    responses={
        200: {
            "description": "Thumbnail image (WebP format)",
            "headers": {
                "Cache-Control": {"description": "Cache duration", "example": "public, max-age=86400"},
                "X-Thumbnail-Cache": {"description": "Cache status", "example": "HIT"}
            }
        },
        404: {"description": "Image not found", "content": {"application/json": {"example": {"detail": "Image not found"}}}},
        500: {"description": "Failed to generate thumbnail", "content": {"application/json": {"example": {"detail": "Failed to generate thumbnail"}}}}
    }
)
async def get_image_thumbnail(
    image_id: int,
    size: int = Query(default=256, ge=1, le=4096, description="Thumbnail max dimension in pixels (1-4096)"),
    service: ImageService = Depends(get_image_service),
):
    """Get a thumbnail of the image with persistent disk caching."""
    return await service.get_image_thumbnail(image_id, size)


@router.get(
    "/image-preview-by-path",
    summary="Get a thumbnail for a file by absolute path",
    description="""
Roadmap-C missing-file repair. Serve a WebP thumbnail for a found-but-unlinked
image file addressed by absolute path (the id-based thumbnail endpoint can't
reach a file that is not yet an indexed image).

The path is validated before any read: directory traversal (`..`) is rejected,
the file must exist, and it must be an allowed image type. Size is clamped to
1..1024. Returns 404 JSON for an invalid, missing, or non-image path.
    """,
    responses={
        200: {"description": "Thumbnail image (WebP)"},
        404: {"description": "Invalid, missing, or non-image path",
              "content": {"application/json": {"example": {"detail": "File does not exist"}}}},
    },
)
async def get_image_preview_by_path(
    path: str = Query(..., min_length=1, max_length=4096, description="Absolute path to the image file."),
    size: int = Query(default=256, ge=1, le=1024, description="Thumbnail max dimension in pixels (1-1024)."),
    service: ImageService = Depends(get_image_service),
):
    """Serve a WebP thumbnail for a validated file path (repair-review preview)."""
    return await service.get_image_preview_by_path(path, size)


@router.get("/thumbnail-cache/stats")
async def get_thumbnail_cache_statistics(
    service: ImageService = Depends(get_image_service),
):
    """Get thumbnail cache statistics."""
    return service.get_thumbnail_cache_stats()


@router.post("/thumbnail-cache/clear")
async def clear_thumbnail_cache(
    service: ImageService = Depends(get_image_service),
):
    """Clear all cached thumbnails."""
    return service.clear_thumbnail_cache()


@router.post("/thumbnail-cache/cleanup")
async def cleanup_thumbnail_cache(
    max_age_days: int = Query(default=30, ge=1, le=365),
    service: ImageService = Depends(get_image_service),
):
    """Remove cached thumbnails older than max_age_days."""
    return service.cleanup_thumbnail_cache(max_age_days)


@router.post(
    "/open-folder",
    summary="Open image in file explorer",
    description="""
Open the containing folder of an image in the OS file explorer, with the file selected.

Supports Windows (explorer), Linux (xdg-open), and macOS (open -R).
    """,
    responses={
        200: {
            "description": "Folder opened successfully",
            "content": {"application/json": {"example": {"success": True, "path": "/path/to/image.png"}}}
        },
        404: {
            "description": "Image not found or file missing",
            "content": {"application/json": {"example": {"detail": "Image not found"}}}
        },
        500: {
            "description": "Failed to open folder",
            "content": {"application/json": {"example": {"detail": "Failed to open folder: ..."}}}
        }
    }
)
async def open_folder(
    body: OpenFolderRequest,
    service: ImageService = Depends(get_image_service),
):
    """Open the containing folder of an image in the OS file explorer."""
    if body.image_id is None:
        raise HTTPException(status_code=400, detail="image_id is required")

    return service.open_image_folder(
        body.image_id,
        platform=sys.platform,
        popen=subprocess.Popen,
    )


@router.post(
    "/parse-image",
    summary="Parse uploaded image metadata",
    description="""
Accept an image file upload and return parsed SD metadata without saving to the database.

Useful for inspecting metadata of images that are not yet in the library.
Returns generator type, prompt, negative prompt, checkpoint, LoRAs, generation
parameters, image dimensions, and file size.
    """,
    responses={
        200: {
            "description": "Parsed metadata",
            "content": {
                "application/json": {
                    "example": {
                        "generator": "comfyui",
                        "prompt": "1girl, solo, masterpiece",
                        "negative_prompt": "lowres, bad anatomy",
                        "checkpoint": "sd_xl_base_1.0.safetensors",
                        "loras": ["detail_tweaker"],
                        "width": 1024,
                        "height": 1536,
                        "file_size": 2048576,
                        "metadata": {}
                    }
                }
            }
        },
        400: {
            "description": "No file uploaded",
            "content": {"application/json": {"example": {"detail": "No file uploaded"}}}
        },
        500: {
            "description": "Failed to parse image",
            "content": {"application/json": {"example": {"detail": "Failed to parse image metadata: ..."}}}
        }
    }
)
async def parse_uploaded_image(
    file: UploadFile = File(...),
    service: ImageService = Depends(get_image_service),
):
    """Parse metadata from an uploaded image file without saving to database."""
    return await service.parse_uploaded_image(
        file,
        temp_dir=READER_UPLOAD_TEMP_DIR,
        temp_ttl_seconds=READER_UPLOAD_TTL_SECONDS,
        max_bytes=PARSE_IMAGE_UPLOAD_MAX_BYTES,
        chunk_size=PARSE_IMAGE_UPLOAD_CHUNK_SIZE,
    )
