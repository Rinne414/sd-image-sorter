"""
Image endpoints for SD Image Sorter.
Handles image retrieval, filtering, and file serving.

Refactored to use Service Layer pattern with dependency injection.
"""
import logging
import os
import subprocess
import sys
from pathlib import Path
from typing import Optional, Any, List

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, UploadFile, File
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field, model_validator

from config import get_temp_dir
from services.image_service import ImageService
from services.service_provider import ServiceProvider
from utils.path_validation import PathValidationError


logger = logging.getLogger(__name__)


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
    ratings: List[str] = Field(default_factory=list)
    checkpoints: List[str] = Field(default_factory=list)
    loras: List[str] = Field(default_factory=list)
    prompts: List[str] = Field(default_factory=list)
    artist: Optional[str] = None
    search: str = ""
    sortBy: str = "newest"
    minWidth: Optional[int] = Field(default=None, ge=1, le=100000)
    maxWidth: Optional[int] = Field(default=None, ge=1, le=100000)
    minHeight: Optional[int] = Field(default=None, ge=1, le=100000)
    maxHeight: Optional[int] = Field(default=None, ge=1, le=100000)
    aspectRatio: Optional[str] = None
    minAesthetic: Optional[float] = Field(default=None, ge=0, le=10)
    maxAesthetic: Optional[float] = Field(default=None, ge=0, le=10)


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


class SaveEditedMetadataRequest(BaseModel):
    source_path: str
    output_path: str
    format: str = "png"
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
    tags: Optional[str] = Query(
        default=None,
        description="Comma-separated list of tags (AND logic - all tags must be present)",
        examples=["1girl,solo,long_hair"],
    ),
    ratings: Optional[str] = Query(
        default=None,
        description="Comma-separated content ratings. Options: general, sensitive, questionable, explicit",
        examples=["general,sensitive"],
    ),
    checkpoints: Optional[str] = Query(
        default=None,
        description="Comma-separated checkpoint/model names",
        examples=["sd_xl_base_1.0,animagine_xl"],
    ),
    loras: Optional[str] = Query(
        default=None,
        description="Comma-separated LoRA names",
        examples=["detail_tweaker,add_detail"],
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
        description="Sort order: newest, oldest, name_asc, name_desc, generator, generator_desc, prompt_length, prompt_length_asc, tag_count, tag_count_asc, rating, rating_desc, character_count, character_count_asc, random, file_size, file_size_asc",
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
        description="Offset for fallback pagination when the selected sort does not support cursor pagination",
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
    service: ImageService = Depends(get_image_service),
):
    """Retrieve images with optional filtering using cursor-based pagination."""
    return service.get_images(
        generators=generators,
        tags=tags,
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
        aspect_ratio=aspect_ratio,
        min_aesthetic=min_aesthetic,
        max_aesthetic=max_aesthetic,
        brightness_min=brightness_min,
        brightness_max=brightness_max,
        color_temperature=color_temperature,
        brightness_distribution=brightness_distribution,
    )


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
        ratings=request.ratings,
        checkpoints=request.checkpoints,
        loras=request.loras,
        prompts=request.prompts,
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
        excluded_image_ids=request.excludedImageIds,
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
    image_id: int,
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
        ratings=request.ratings,
        checkpoints=request.checkpoints,
        loras=request.loras,
        prompts=request.prompts,
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
    )


@router.post(
    "/images/delete-selected",
    response_model=DeleteSelectedImagesResponse,
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
    service: ImageService = Depends(get_image_service),
):
    """Move selected image files to OS trash with partial-failure reporting."""
    if not request.confirm_delete_files:
        raise HTTPException(
            status_code=400,
            detail="Deleting image files requires explicit confirmation",
        )

    if request.selection_token:
        return service.delete_selected_image_files_by_token(request.selection_token)
    return service.delete_selected_image_files(request.image_ids or [])


@router.post(
    "/images/remove-selected",
    response_model=RemoveSelectedImagesResponse,
    summary="Remove selected images from the gallery index",
    description="""
Remove selected database rows from the local gallery without deleting the backing
image files from disk. Re-scanning the source folder can add them back later.
    """,
)
async def remove_selected_images(
    request: RemoveSelectedImagesRequest,
    service: ImageService = Depends(get_image_service),
):
    """Remove selected images from the gallery index without touching files."""
    if request.selection_token:
        return service.remove_selected_images_from_gallery_by_token(request.selection_token)
    return service.remove_selected_images_from_gallery(request.image_ids or [])


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
