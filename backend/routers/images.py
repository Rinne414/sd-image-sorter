"""
Image endpoints for SD Image Sorter.
Handles image retrieval, filtering, and file serving.
"""
import io
import os
from datetime import datetime, timezone
from email.utils import format_datetime
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse, StreamingResponse
from PIL import Image

import database as db
from image_manager import reparse_image_metadata
from utils.path_validation import validate_file_path, is_safe_path, ALLOWED_IMAGE_EXTENSIONS

router = APIRouter(prefix="/api", tags=["images"])


@router.get("/images")
async def get_images(
    generators: Optional[str] = None,
    tags: Optional[str] = None,
    ratings: Optional[str] = None,
    checkpoints: Optional[str] = None,
    loras: Optional[str] = None,
    search: Optional[str] = None,
    artist: Optional[str] = None,  # Artist filter
    favorites_only: bool = Query(default=False, description="Only return favorite images"),
    sort_by: str = Query(default="newest", description="Sort by: newest, oldest, name_asc, name_desc, generator, prompt_length, tag_count, rating, character_count, random, file_size"),
    limit: int = Query(default=500, description="Number of images to return. 0 = all images (use with caution for large libraries)"),
    offset: int = 0,
    min_width: Optional[int] = None,
    max_width: Optional[int] = None,
    min_height: Optional[int] = None,
    max_height: Optional[int] = None,
    prompts: Optional[str] = None,  # Comma-separated prompt terms (AND logic)
    aspect_ratio: Optional[str] = None  # 'square', 'landscape', 'portrait'
):
    """
    Get images with optional filters.
    - generators: Comma-separated list of generators (comfyui, nai, webui, forge)
    - tags: Comma-separated list of tags (AND logic)
    - ratings: Comma-separated ratings (general, sensitive, questionable, explicit)
    - artist: Artist name filter
    - search: Search in prompts
    - sort_by: Sorting method
    - limit: Number of images (default 500, 0 for all - use with caution)
    - min_width, max_width, min_height, max_height: Dimension filters
    - aspect_ratio: 'square', 'landscape', or 'portrait'
    """
    gen_list = generators.split(",") if generators else None
    tag_list = tags.split(",") if tags else None
    rating_list = ratings.split(",") if ratings else None
    cp_list = checkpoints.split(",") if checkpoints else None
    lr_list = loras.split(",") if loras else None
    prompt_list = prompts.split(",") if prompts else None

    # Use very high limit when 0 (all images) - but warn in logs for large libraries
    actual_limit = limit if limit > 0 else 100000

    favorite_ids = set(db.get_favorite_source_ids())
    scoped_image_ids = list(favorite_ids) if favorites_only else None

    images = db.get_images(
        generators=gen_list,
        tags=tag_list,
        ratings=rating_list,
        checkpoints=cp_list,
        loras=lr_list,
        search_query=search,
        prompt_terms=prompt_list,
        artist=artist,
        sort_by=sort_by,
        limit=actual_limit,
        offset=offset,
        min_width=min_width,
        max_width=max_width,
        min_height=min_height,
        max_height=max_height,
        aspect_ratio=aspect_ratio,
        image_ids=scoped_image_ids,
    )

    for image in images:
        image["is_favorite"] = image["id"] in favorite_ids

    return {"images": images, "count": len(images)}


def _resolve_image_source_path(image_id: int, primary_path: str) -> str:
    """Resolve the best available image source path, including Favorites fallback."""
    if primary_path and os.path.exists(primary_path):
        return primary_path

    favorites = db.get_collection_by_slug(db.FAVORITES_COLLECTION_SLUG)
    favorite_item = db.get_collection_item(favorites["id"], image_id) if favorites else None
    candidate_path = favorite_item["copied_path"] if favorite_item else None

    if candidate_path:
        is_valid_candidate, _ = validate_file_path(candidate_path, ALLOWED_IMAGE_EXTENSIONS)
        favorites_root = favorites["folder_path"] if favorites else db.FAVORITES_FOLDER_PATH
        if is_valid_candidate and is_safe_path(favorites_root, candidate_path) and os.path.exists(candidate_path):
            return candidate_path

    raise HTTPException(status_code=404, detail="Image file not found on disk")


@router.get("/images/{image_id}")
async def get_image(image_id: int):
    """Get a single image with its tags."""
    image = db.get_image_by_id(image_id)
    if not image:
        raise HTTPException(status_code=404, detail="Image not found")

    favorites = db.get_collection_by_slug(db.FAVORITES_COLLECTION_SLUG)
    favorite_item = db.get_collection_item(favorites["id"], image_id) if favorites else None
    image["is_favorite"] = favorite_item is not None
    image["favorite_copy_path"] = favorite_item["copied_path"] if favorite_item else None

    tags = db.get_image_tags(image_id)
    return {"image": image, "tags": tags}


@router.post("/images/{image_id}/reparse")
async def reparse_image(image_id: int):
    """Re-parse metadata for a single image and update the database."""
    image = db.get_image_by_id(image_id)
    if not image:
        raise HTTPException(status_code=404, detail="Image not found")

    source_path = _resolve_image_source_path(image_id, image["path"])

    try:
        reparse_image_metadata(image_id, source_path)
    except Exception as exc:
        raise HTTPException(status_code=500, detail="Failed to reparse metadata") from exc
    return await get_image(image_id)


@router.get("/image-file/{image_id}")
async def get_image_file(image_id: int):
    """Serve the actual image file."""
    image = db.get_image_by_id(image_id)
    if not image:
        raise HTTPException(status_code=404, detail="Image not found")

    file_path = _resolve_image_source_path(image_id, image["path"])
    return FileResponse(file_path)


@router.get("/image-thumbnail/{image_id}")
async def get_image_thumbnail(image_id: int, size: int = Query(default=256, gt=0, description="Thumbnail max size in pixels")):
    """Get a real thumbnail of the image."""
    image = db.get_image_by_id(image_id)
    if not image:
        raise HTTPException(status_code=404, detail="Image not found")

    source_path = _resolve_image_source_path(image_id, image["path"])

    try:
        with Image.open(source_path) as source_img:
            source_format = (source_img.format or "PNG").upper()
            thumb = source_img.copy()

            if thumb.mode in ("P", "RGBA", "LA"):
                thumb = thumb.convert("RGBA")
            else:
                thumb = thumb.convert("RGB")

            thumb.thumbnail((size, size), Image.Resampling.LANCZOS)

            buffer = io.BytesIO()
            if source_format in ("JPEG", "JPG"):
                thumb = thumb.convert("RGB")
                save_format = "JPEG"
                media_type = "image/jpeg"
            elif source_format == "WEBP":
                save_format = "WEBP"
                media_type = "image/webp"
            else:
                save_format = "PNG"
                media_type = "image/png"

            thumb.save(buffer, format=save_format)
            buffer.seek(0)

            last_modified = datetime.fromtimestamp(os.path.getmtime(source_path), tz=timezone.utc)
            return StreamingResponse(
                buffer,
                media_type=media_type,
                headers={
                    "Cache-Control": "public, max-age=3600",
                    "Last-Modified": format_datetime(last_modified, usegmt=True),
                },
            )
    except Exception as exc:
        raise HTTPException(status_code=500, detail="Failed to generate thumbnail") from exc
