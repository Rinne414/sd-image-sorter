"""
Image endpoints for SD Image Sorter.
Handles image retrieval, filtering, and file serving.

Refactored to use Service Layer pattern with dependency injection.
"""
from typing import Optional

from fastapi import APIRouter, Depends, Query
from fastapi.responses import FileResponse, StreamingResponse

from services.image_service import ImageService


router = APIRouter(prefix="/api", tags=["images"])

# Service instance - will be set via dependency injection
_image_service: Optional[ImageService] = None


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
        description="Sort order: newest, oldest, name_asc, name_desc, generator, prompt_length, tag_count, rating, character_count, random, file_size",
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
        min_width=min_width,
        max_width=max_width,
        min_height=min_height,
        max_height=max_height,
        prompts=prompts,
        aspect_ratio=aspect_ratio,
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
