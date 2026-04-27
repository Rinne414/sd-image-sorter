"""
Image endpoints for SD Image Sorter.
Handles image retrieval, filtering, and file serving.

Refactored to use Service Layer pattern with dependency injection.
"""
import logging
import os
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Optional, Any, List

from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

import database as db
from config import get_temp_dir
from metadata_parser import parse_image, verify_image_readable
from services.image_service import ImageService
from utils.path_validation import PathValidationError


logger = logging.getLogger(__name__)


router = APIRouter(prefix="/api", tags=["images"])

# Service instance - will be set via dependency injection
_image_service: Optional[ImageService] = None
READER_UPLOAD_TEMP_DIR = Path(get_temp_dir()) / "reader_uploads"
READER_UPLOAD_TTL_SECONDS = 24 * 60 * 60
PARSE_IMAGE_UPLOAD_MAX_BYTES = 64 * 1024 * 1024
PARSE_IMAGE_UPLOAD_CHUNK_SIZE = 1024 * 1024


class DeleteSelectedImagesRequest(BaseModel):
    image_ids: List[int] = Field(..., min_length=1)
    confirm_delete_files: bool = False


class ExportSelectionRequest(BaseModel):
    image_ids: List[int] = Field(..., min_length=1, max_length=50000)


class ExportSelectionImage(BaseModel):
    id: int
    filename: str = ""
    generator: Optional[str] = None
    prompt: str = ""
    checkpoint: Optional[str] = None
    width: Optional[int] = None
    height: Optional[int] = None
    aesthetic_score: Optional[float] = None
    tags: List[str] = Field(default_factory=list)


class ExportSelectionResponse(BaseModel):
    images: List[ExportSelectionImage] = Field(default_factory=list)
    missing_ids: List[int] = Field(default_factory=list)


class DeleteSelectedImagesResponse(BaseModel):
    deleted: int
    failed: List[dict[str, Any]]
    permanent_delete: bool = True


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


def get_image_service() -> ImageService:
    """Dependency injection for ImageService."""
    global _image_service
    if _image_service is None:
        _image_service = ImageService()
    return _image_service


def set_image_service(service: ImageService) -> None:
    """Set the image service instance (for testing or custom configuration)."""
    global _image_service
    _image_service = service


def _cleanup_stale_reader_uploads() -> None:
    """Best-effort cleanup for temporary Reader uploads kept for follow-up save actions."""
    try:
        READER_UPLOAD_TEMP_DIR.mkdir(parents=True, exist_ok=True)
        cutoff = time.time() - READER_UPLOAD_TTL_SECONDS
        for candidate in READER_UPLOAD_TEMP_DIR.iterdir():
            try:
                if candidate.is_file() and candidate.stat().st_mtime < cutoff:
                    candidate.unlink()
            except OSError:
                continue
    except OSError:
        logger.debug("Failed to prepare Reader temp directory", exc_info=True)


def _allocate_reader_upload_path(filename: str) -> Path:
    suffix = Path(filename or "").suffix.lower() or ".png"
    if suffix not in {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"}:
        suffix = ".png"
    READER_UPLOAD_TEMP_DIR.mkdir(parents=True, exist_ok=True)
    return READER_UPLOAD_TEMP_DIR / f"{uuid.uuid4().hex}{suffix}"


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
Use the `cursor` parameter with the `next_cursor` value from previous response to get the next page.
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
                                "width": 1024,
                                "height": 1536,
                                "rating": "general",
                                "created_at": "2024-01-15T10:30:00Z"
                            }
                        ],
                        "next_cursor": "1",
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
        description="Cursor for pagination (image ID from previous page's next_cursor)",
        examples=["42"],
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
Return prompt text and tags for a selected image batch in one request.

Used by the export modal so the frontend does not spam one request per image.
Missing image IDs are reported in `missing_ids` instead of failing the whole export.
    """,
)
async def export_selection_data(
    request: ExportSelectionRequest,
    service: ImageService = Depends(get_image_service),
):
    """Get export-ready prompt and tag data for multiple selected images."""
    return service.get_export_selection_data(request.image_ids)


@router.post(
    "/images/delete-selected",
    response_model=DeleteSelectedImagesResponse,
    summary="Delete selected image files from disk",
    description="""
Delete the selected image files from disk and remove their database rows.

This is a destructive action and requires explicit confirmation from the client.
The response reports partial failures per image instead of hiding them.
    """,
)
async def delete_selected_images(
    request: DeleteSelectedImagesRequest,
    service: ImageService = Depends(get_image_service),
):
    """Delete selected image files from disk with partial-failure reporting."""
    if not request.confirm_delete_files:
        raise HTTPException(
            status_code=400,
            detail="Deleting image files requires explicit confirmation",
        )

    return service.delete_selected_image_files(request.image_ids)


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
    body: dict,
    service: ImageService = Depends(get_image_service),
):
    """Open the containing folder of an image in the OS file explorer."""
    image_id = body.get("image_id")
    if image_id is None:
        raise HTTPException(status_code=400, detail="image_id is required")

    image = db.get_image_by_id(image_id)
    if not image:
        raise HTTPException(status_code=404, detail="Image not found")

    try:
        file_path = service.resolve_image_source_path(image_id, image.get("path", ""))
        normalized_path = os.path.normpath(file_path)

        if sys.platform == "win32":
            subprocess.Popen(["explorer", "/select,", normalized_path])
        elif sys.platform == "darwin":
            subprocess.Popen(["open", "-R", normalized_path])
        else:
            # Linux: open the parent directory
            parent_dir = os.path.dirname(normalized_path)
            subprocess.Popen(["xdg-open", parent_dir])

        return {"success": True, "path": normalized_path}
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Failed to open folder for image %s: %s", image_id, e)
        raise HTTPException(
            status_code=500,
            detail=f"Failed to open folder: {e}"
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
async def parse_uploaded_image(file: UploadFile = File(...)):
    """Parse metadata from an uploaded image file without saving to database."""
    if not file or not file.filename:
        raise HTTPException(status_code=400, detail="No file uploaded")

    # Determine suffix from uploaded filename
    _, ext = os.path.splitext(file.filename)
    if not ext:
        ext = ".png"

    tmp_path = None
    cleanup_tmp = True
    try:
        _cleanup_stale_reader_uploads()
        tmp_path = _allocate_reader_upload_path(file.filename)
        with open(tmp_path, "wb") as tmp:
            total_bytes = 0
            while True:
                chunk = await file.read(PARSE_IMAGE_UPLOAD_CHUNK_SIZE)
                if not chunk:
                    break
                total_bytes += len(chunk)
                if total_bytes > PARSE_IMAGE_UPLOAD_MAX_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail="Uploaded image is too large to parse (max 64MB)",
                    )
                tmp.write(chunk)

        readable, read_error = await run_in_threadpool(verify_image_readable, str(tmp_path))
        if not readable:
            raise HTTPException(
                status_code=422,
                detail=f"Invalid or unreadable image file: {read_error or 'image decode failed'}",
            )

        # Parse metadata using the existing parser
        result = await run_in_threadpool(parse_image, str(tmp_path))
        if result.get("parse_error") or result.get("width", 0) <= 0 or result.get("height", 0) <= 0:
            raise HTTPException(
                status_code=422,
                detail=f"Failed to parse image metadata: {result.get('parse_error') or 'image metadata could not be read'}",
            )

        result["source_temp_path"] = str(tmp_path.resolve())
        cleanup_tmp = False
        return result
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Failed to parse uploaded image %s: %s", file.filename, e)
        raise HTTPException(
            status_code=500,
            detail=f"Failed to parse image metadata: {e}"
        )
    finally:
        await file.close()
        # Clean up temp file
        if cleanup_tmp and tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
