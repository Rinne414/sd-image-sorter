"""
Image service for SD Image Sorter.

Handles business logic for image retrieval, filtering, and file operations.
"""
import io
import os
from datetime import datetime, timezone
from email.utils import format_datetime
from typing import Optional, Dict, Any, List

from fastapi import HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from PIL import Image, UnidentifiedImageError

import database as db
from image_manager import reparse_image_metadata
from thumbnail_cache import (
    get_thumbnail,
    get_thumbnail_async,
    generate_placeholder_thumbnail,
    clear_cache as clear_thumbnail_cache,
    cleanup_old_cache,
    get_cache_stats,
    SUPPORTED_SIZES,
)
from utils.path_validation import validate_file_path, ALLOWED_IMAGE_EXTENSIONS


# Validation constants
DIMENSION_MIN = 1
DIMENSION_MAX = 100000
LIMIT_MAX = 1000
OFFSET_MAX = 10000000
SEARCH_MAX_LENGTH = 1000
DEFAULT_PAGE_SIZE = 100

# Valid sort options and aspect ratios
VALID_SORT_OPTIONS = [
    "newest", "oldest", "name_asc", "name_desc", "generator", "generator_desc",
    "prompt_length", "prompt_length_asc", "tag_count", "tag_count_asc",
    "rating", "rating_desc", "character_count", "character_count_asc",
    "aesthetic", "aesthetic_asc",
    "random", "file_size", "file_size_asc"
]
VALID_ASPECT_RATIOS = ["square", "landscape", "portrait"]



def _sanitize_filter_value(value: str) -> str:
    """
    Sanitize a filter value to prevent potential injection or corruption.
    
    - Strips leading/trailing whitespace
    - Removes null bytes
    - Limits length to prevent abuse
    """
    if not value:
        return value
    # Remove null bytes and strip whitespace
    sanitized = value.replace('\x00', '').strip()
    # Limit length to reasonable maximum (1000 chars)
    if len(sanitized) > 1000:
        sanitized = sanitized[:1000]
    return sanitized


def _sanitize_filter_list(items: Optional[str]) -> Optional[List[str]]:
    """
    Parse and sanitize a comma-separated filter string into a list.
    
    Returns None if input is None or empty after sanitization.
    """
    if not items:
        return None
    # Split and sanitize each item
    parts = items.split(',')
    sanitized = [_sanitize_filter_value(p) for p in parts]
    # Filter out empty strings
    result = [p for p in sanitized if p]
    return result if result else None



class ImageService:
    """Service for image retrieval, filtering, and file operations."""

    def get_images(
        self,
        generators: Optional[str] = None,
        tags: Optional[str] = None,
        ratings: Optional[str] = None,
        checkpoints: Optional[str] = None,
        loras: Optional[str] = None,
        search: Optional[str] = None,
        artist: Optional[str] = None,
        sort_by: str = "newest",
        limit: int = DEFAULT_PAGE_SIZE,
        cursor: Optional[str] = None,
        offset: Optional[int] = None,
        min_width: Optional[int] = None,
        max_width: Optional[int] = None,
        min_height: Optional[int] = None,
        max_height: Optional[int] = None,
        prompts: Optional[str] = None,
        aspect_ratio: Optional[str] = None,
        min_aesthetic: Optional[float] = None,
        max_aesthetic: Optional[float] = None,
    ) -> Dict[str, Any]:
        """
        Retrieve images with optional filtering using cursor-based pagination.

        Args:
            generators: Comma-separated list of generators
            tags: Comma-separated tags (AND logic)
            ratings: Comma-separated ratings
            checkpoints: Comma-separated checkpoint names
            loras: Comma-separated LoRA names
            search: Free-text search in prompts
            artist: Artist name filter
            sort_by: Sorting method
            limit: Number of images to return
            cursor: Image ID cursor for pagination
            offset: Offset for fallback pagination when cursor sorting is unavailable
            min_width: Minimum width filter
            max_width: Maximum width filter
            min_height: Minimum height filter
            max_height: Maximum height filter
            prompts: Comma-separated prompt terms
            aspect_ratio: 'square', 'landscape', or 'portrait'

        Returns:
            Dict containing images, next_cursor, has_more, total

        Raises:
            HTTPException 400: Invalid parameters
        """
        # Validate sort_by
        if sort_by not in VALID_SORT_OPTIONS:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid sort_by value. Must be one of: {', '.join(VALID_SORT_OPTIONS)}"
            )

        # Validate aspect_ratio
        if aspect_ratio is not None and aspect_ratio not in VALID_ASPECT_RATIOS:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid aspect_ratio value. Must be one of: {', '.join(VALID_ASPECT_RATIOS)}"
            )

        # Validate dimension ranges
        if min_width is not None and max_width is not None and min_width > max_width:
            raise HTTPException(
                status_code=400,
                detail="min_width cannot be greater than max_width"
            )
        if min_height is not None and max_height is not None and min_height > max_height:
            raise HTTPException(
                status_code=400,
                detail="min_height cannot be greater than max_height"
            )

        # Parse comma-separated values
        gen_list = generators.split(",") if generators else None
        tag_list = tags.split(",") if tags else None
        rating_list = ratings.split(",") if ratings else None
        cp_list = checkpoints.split(",") if checkpoints else None
        lr_list = loras.split(",") if loras else None
        prompt_list = prompts.split(",") if prompts else None

        # Parse cursor
        cursor_id = None
        if cursor:
            try:
                cursor_id = int(cursor)
            except ValueError:
                raise HTTPException(
                    status_code=400,
                    detail="Invalid cursor format. Must be an integer image ID."
                )

        supports_cursor_pagination = sort_by in {"newest", "oldest"} and offset is None

        if supports_cursor_pagination:
            result = db.get_images_paginated(
                generators=gen_list,
                tags=tag_list,
                ratings=rating_list,
                checkpoints=cp_list,
                loras=lr_list,
                search_query=search,
                prompt_terms=prompt_list,
                artist=artist,
                sort_by=sort_by,
                limit=limit,
                cursor_id=cursor_id,
                min_width=min_width,
                max_width=max_width,
                min_height=min_height,
                max_height=max_height,
                aspect_ratio=aspect_ratio,
                min_aesthetic=min_aesthetic,
                max_aesthetic=max_aesthetic,
            )
            result["next_offset"] = None
            return result

        page_offset = max(0, offset or 0)
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
            limit=limit + 1,
            offset=page_offset,
            min_width=min_width,
            max_width=max_width,
            min_height=min_height,
            max_height=max_height,
            aspect_ratio=aspect_ratio,
            min_aesthetic=min_aesthetic,
            max_aesthetic=max_aesthetic,
        )

        has_more = len(images) > limit
        if has_more:
            images = images[:limit]

        total = db.get_filtered_image_count(
            generators=gen_list,
            tags=tag_list,
            ratings=rating_list,
            checkpoints=cp_list,
            loras=lr_list,
            search_query=search,
            prompt_terms=prompt_list,
            artist=artist,
            min_width=min_width,
            max_width=max_width,
            min_height=min_height,
            max_height=max_height,
            aspect_ratio=aspect_ratio,
            min_aesthetic=min_aesthetic,
            max_aesthetic=max_aesthetic,
        )

        return {
            "images": images,
            "next_cursor": None,
            "next_offset": page_offset + len(images) if has_more else None,
            "has_more": has_more,
            "total": total,
        }

    def get_image_by_id(self, image_id: int) -> Dict[str, Any]:
        """
        Get a single image with its associated tags.

        Args:
            image_id: The unique identifier of the image

        Returns:
            Dict containing 'image' and 'tags' fields

        Raises:
            HTTPException 404: Image not found
        """
        image = db.get_image_by_id(image_id)
        if not image:
            raise HTTPException(status_code=404, detail="Image not found")

        tags = db.get_image_tags(image_id)
        return {"image": image, "tags": tags}

    def resolve_image_source_path(self, image_id: int, primary_path: str) -> str:
        """
        Resolve the best available image source path.

        Args:
            image_id: Image ID for error messages
            primary_path: Primary path from database

        Returns:
            Resolved absolute path to the image file

        Raises:
            HTTPException 404: Image file not found on disk
        """
        candidate_paths = []

        if primary_path:
            candidate_paths.append(primary_path)
            if not os.path.isabs(primary_path):
                backend_root = os.path.dirname(os.path.dirname(__file__))
                project_root = os.path.dirname(backend_root)
                candidate_paths.append(os.path.abspath(os.path.join(backend_root, primary_path)))
                candidate_paths.append(os.path.abspath(os.path.join(project_root, primary_path)))

        for candidate in candidate_paths:
            if not candidate:
                continue
            try:
                candidate_path = os.path.abspath(candidate)
                if not os.path.exists(candidate_path):
                    continue
                if os.path.realpath(candidate_path) != candidate_path:
                    continue
                return candidate_path
            except OSError:
                continue

        raise HTTPException(status_code=404, detail="Image file not found on disk")

    def reparse_image(self, image_id: int) -> Dict[str, Any]:
        """
        Re-parse metadata for a single image and update the database.

        Args:
            image_id: The unique identifier of the image

        Returns:
            Updated image data

        Raises:
            HTTPException 404: Image not found
            HTTPException 500: Failed to parse metadata
        """
        image = db.get_image_by_id(image_id)
        if not image:
            raise HTTPException(status_code=404, detail="Image not found")

        source_path = self.resolve_image_source_path(image_id, image["path"])

        try:
            reparse_image_metadata(image_id, source_path)
        except Exception as exc:
            raise HTTPException(status_code=500, detail="Failed to reparse metadata") from exc

        return self.get_image_by_id(image_id)

    def get_image_file(self, image_id: int) -> FileResponse:
        """
        Serve the actual image file.

        Args:
            image_id: The unique identifier of the image

        Returns:
            FileResponse with the image binary data

        Raises:
            HTTPException 404: Image not found or file missing
        """
        image = db.get_image_by_id(image_id)
        if not image:
            raise HTTPException(status_code=404, detail="Image not found")

        file_path = self.resolve_image_source_path(image_id, image["path"])
        filename = image.get("filename") or os.path.basename(file_path)
        ext = os.path.splitext(filename)[1].lower()
        media_types = {
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".webp": "image/webp",
            ".bmp": "image/bmp",
            ".gif": "image/gif",
        }
        return FileResponse(
            file_path,
            media_type=media_types.get(ext),
            filename=filename,
            content_disposition_type="inline",
        )

    async def get_image_thumbnail(
        self,
        image_id: int,
        size: int = 256
    ) -> StreamingResponse:
        """
        Get a thumbnail of the image with persistent disk caching.

        Args:
            image_id: The unique identifier of the image
            size: Maximum thumbnail dimension

        Returns:
            StreamingResponse with WebP image data

        Raises:
            HTTPException 404: Image not found
            HTTPException 500: Failed to generate thumbnail
        """
        image = db.get_image_by_id(image_id)
        if not image:
            raise HTTPException(status_code=404, detail="Image not found")

        source_path = self.resolve_image_source_path(image_id, image["path"])

        try:
            if os.path.islink(source_path):
                raise HTTPException(status_code=404, detail="Image file not found on disk")
            thumbnail_bytes, last_modified, cache_hit = await get_thumbnail_async(source_path, size)
            media_type = "image/webp"
            max_age = 86400 if cache_hit else 3600

            return StreamingResponse(
                io.BytesIO(thumbnail_bytes),
                media_type=media_type,
                headers={
                    "Cache-Control": f"public, max-age={max_age}",
                    "Last-Modified": format_datetime(last_modified, usegmt=True),
                    "X-Thumbnail-Cache": "HIT" if cache_hit else "MISS",
                },
            )
        except (UnidentifiedImageError, OSError):
            placeholder_bytes = generate_placeholder_thumbnail(size)
            return StreamingResponse(
                io.BytesIO(placeholder_bytes),
                media_type="image/webp",
                headers={
                    "Cache-Control": "no-cache",
                    "X-Thumbnail-Cache": "MISS",
                    "X-Thumbnail-Placeholder": "UNREADABLE",
                },
            )
        except Exception as exc:
            raise HTTPException(status_code=500, detail="Failed to generate thumbnail") from exc

    def get_thumbnail_cache_stats(self) -> Dict[str, Any]:
        """Get thumbnail cache statistics."""
        stats = get_cache_stats()
        return {
            "cache_stats": stats,
            "supported_sizes": list(SUPPORTED_SIZES),
        }

    def clear_thumbnail_cache(self) -> Dict[str, int]:
        """Clear all cached thumbnails."""
        count = clear_thumbnail_cache()
        return {"deleted_count": count}

    def cleanup_thumbnail_cache(self, max_age_days: int = 30) -> Dict[str, Any]:
        """Remove cached thumbnails older than max_age_days."""
        count = cleanup_old_cache(max_age_days)
        return {"deleted_count": count, "max_age_days": max_age_days}
