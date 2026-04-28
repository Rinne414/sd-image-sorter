"""
Image service for SD Image Sorter.

Handles business logic for image retrieval, filtering, and file operations.
"""
import logging
import base64
import binascii
import io
import json
import os
import subprocess
import uuid
from pathlib import Path
from datetime import datetime, timezone
from email.utils import format_datetime
from typing import Optional, Dict, Any, List, Callable

from fastapi import HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from PIL import Image, PngImagePlugin, UnidentifiedImageError
from starlette.concurrency import run_in_threadpool

import database as db
from constants import VALID_ASPECT_RATIOS
from image_manager import reparse_image_metadata
from metadata_parser import parse_image, verify_image_readable
from services.indexed_file_mutation_service import save_and_reconcile_checked
from thumbnail_cache import (
    get_thumbnail,
    get_thumbnail_async,
    generate_placeholder_thumbnail,
    clear_cache as clear_thumbnail_cache,
    cleanup_old_cache,
    get_cache_stats,
    SUPPORTED_SIZES,
)
from utils.path_validation import (
    ALLOWED_IMAGE_EXTENSIONS,
    PathValidationError,
    validate_file_path,
    validate_image_output_path,
)
from utils.pagination_cursor import (
    decode_image_cursor,
    encode_image_cursor_from_image,
)
from utils.source_paths import resolve_existing_indexed_image_path


logger = logging.getLogger(__name__)

# Validation constants
DIMENSION_MIN = 1
DIMENSION_MAX = 100000
LIMIT_MAX = 1000
OFFSET_MAX = 10000000
SEARCH_MAX_LENGTH = 1000
DEFAULT_PAGE_SIZE = 100
SELECTION_IDS_FETCH_CHUNK = 2000
SELECTION_TOKEN_DEFAULT_CHUNK = 2000
SELECTION_TOKEN_MAX_CHUNK = 10000
SELECTION_TOKEN_VERSION = 1
SELECTION_TOKEN_RANDOM_SORT_ERROR = (
    "random sort cannot use the chunked selection token protocol; use selection-ids or a snapshot protocol"
)


def _invalid_selection_token() -> HTTPException:
    return HTTPException(status_code=400, detail="Invalid selection token")


def _coerce_optional_int_filter(value: Any, field_name: str) -> Optional[int]:
    if value is None:
        return None
    if isinstance(value, bool):
        raise _invalid_selection_token()
    try:
        return int(value)
    except (TypeError, ValueError):
        raise _invalid_selection_token()


def _coerce_optional_float_filter(value: Any, field_name: str) -> Optional[float]:
    if value is None:
        return None
    if isinstance(value, bool):
        raise _invalid_selection_token()
    try:
        return float(value)
    except (TypeError, ValueError):
        raise _invalid_selection_token()


def _coerce_optional_string_filter(value: Any, field_name: str) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, (dict, list, tuple, set)):
        raise _invalid_selection_token()
    return str(value)


# Valid sort options and aspect ratios
VALID_SORT_OPTIONS = [
    "newest", "oldest", "name_asc", "name_desc", "generator", "generator_desc",
    "prompt_length", "prompt_length_asc", "tag_count", "tag_count_asc",
    "rating", "rating_desc", "character_count", "character_count_asc",
    "aesthetic", "aesthetic_asc",
    "random", "file_size", "file_size_asc"
]
JPEG_LIMITATION_WARNING = "JPEG metadata support is limited; use PNG for the most reliable SD prompt preservation."
WEBP_LIMITATION_WARNING = "WebP metadata support depends on the viewer; use PNG if another tool fails to read the saved prompt."
JPEG_ALPHA_WARNING = "JPEG does not support transparency; transparent pixels were flattened onto a white background."
EDITED_METADATA_KEY_ALIASES = {
    "negative prompt": "negative_prompt",
    "negative_prompt": "negative_prompt",
    "checkpoint": "model",
    "model_name": "model",
    "cfg": "cfg_scale",
    "cfg_scale": "cfg_scale",
    "cfg scale": "cfg_scale",
    "lora": "loras",
    "lora_text": "loras",
    "lora metadata": "loras",
    "lora_metadata": "loras",
}
PARAMETER_EXPORT_ORDER = [
    ("steps", "Steps"),
    ("sampler", "Sampler"),
    ("cfg_scale", "CFG scale"),
    ("seed", "Seed"),
    ("size", "Size"),
    ("model", "Model"),
    ("model_hash", "Model hash"),
    ("clip_skip", "Clip skip"),
    ("denoising_strength", "Denoising strength"),
    ("schedule_type", "Schedule type"),
    ("loras", "LoRAs"),
]


def _cleanup_stale_reader_uploads(temp_dir: Path, ttl_seconds: int) -> None:
    """Best-effort cleanup for temporary Reader uploads kept for follow-up save actions."""
    try:
        temp_dir.mkdir(parents=True, exist_ok=True)
        cutoff = datetime.now(timezone.utc).timestamp() - ttl_seconds
        for candidate in temp_dir.iterdir():
            try:
                if candidate.is_file() and candidate.stat().st_mtime < cutoff:
                    candidate.unlink()
            except OSError:
                continue
    except OSError:
        logger.debug("Failed to prepare Reader temp directory", exc_info=True)


def _allocate_reader_upload_path(temp_dir: Path, filename: str) -> Path:
    suffix = Path(filename or "").suffix.lower() or ".png"
    if suffix not in {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"}:
        suffix = ".png"
    temp_dir.mkdir(parents=True, exist_ok=True)
    return temp_dir / f"{uuid.uuid4().hex}{suffix}"



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


def _sanitize_filter_values(items: Any) -> Optional[List[str]]:
    """Normalize string or iterable filter inputs into one sanitized string list."""
    if items is None:
        return None

    if isinstance(items, str):
        return _sanitize_filter_list(items)

    if isinstance(items, (list, tuple, set)):
        result: List[str] = []
        for item in items:
            sanitized = _sanitize_filter_value(str(item or ""))
            if sanitized:
                result.append(sanitized)
        return result or None

    sanitized = _sanitize_filter_value(str(items))
    return [sanitized] if sanitized else None


def _normalize_edited_metadata(metadata: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Normalize metadata keys from the editor into a stable backend shape."""
    normalized: Dict[str, Any] = {}

    for raw_key, raw_value in (metadata or {}).items():
        key = str(raw_key or "").strip()
        if not key:
            continue

        canonical_key = EDITED_METADATA_KEY_ALIASES.get(key.lower().replace("-", "_"), key.lower().replace("-", "_"))
        value: Any = raw_value
        if isinstance(value, (list, tuple, set)):
            parts = [str(item).strip() for item in value if str(item).strip()]
            value = ", ".join(parts) if parts else None
        elif isinstance(value, str):
            stripped = value.strip()
            value = stripped if stripped else None

        if value is None:
            continue

        normalized[canonical_key] = value

    if "size" not in normalized:
        width = normalized.get("width")
        height = normalized.get("height")
        if width is not None and height is not None:
            normalized["size"] = f"{width}x{height}"

    return normalized


def _build_sd_parameters_text(metadata: Dict[str, Any]) -> str:
    """Build a WebUI-style parameters blob that the existing parser can read back."""
    prompt = str(metadata.get("prompt") or "").strip()
    negative_prompt = str(metadata.get("negative_prompt") or "").strip()
    lines: List[str] = []
    if prompt:
        lines.append(prompt)
    if negative_prompt:
        lines.append(f"Negative prompt: {negative_prompt}")

    parts: List[str] = []
    emitted_keys = set()
    for key, label in PARAMETER_EXPORT_ORDER:
        value = metadata.get(key)
        if value is None or value == "":
            continue
        emitted_keys.add(key)
        parts.append(f"{label}: {value}")

    extra_keys = sorted(
        key for key in metadata.keys()
        if key not in emitted_keys and key not in {"prompt", "negative_prompt", "width", "height"}
    )
    for key in extra_keys:
        value = metadata.get(key)
        if value is None or value == "":
            continue
        label = " ".join(part.capitalize() for part in key.split("_"))
        parts.append(f"{label}: {value}")

    if parts:
        lines.append(", ".join(parts))

    return "\n".join(lines).strip()


def _build_pnginfo(metadata: Dict[str, Any], parameters_text: str) -> PngImagePlugin.PngInfo:
    pnginfo = PngImagePlugin.PngInfo()
    if parameters_text:
        pnginfo.add_text("parameters", parameters_text)

    pnginfo.add_text("Software", "SD Image Sorter")

    for key, value in metadata.items():
        if value is None or value == "":
            continue
        pnginfo.add_text(str(key), str(value))

    return pnginfo


def _build_exif_bytes(image: Image.Image, parameters_text: str) -> Optional[bytes]:
    try:
        exif = image.getexif()
        if parameters_text:
            exif[0x010E] = parameters_text  # ImageDescription
        exif[0x0131] = "SD Image Sorter"  # Software
        return exif.tobytes()
    except Exception:
        return None


def _prepare_image_for_save(image: Image.Image, pil_format: str, warnings: List[str]) -> Image.Image:
    """Prepare image mode conversions required by the target output format."""
    if pil_format != "JPEG":
        return image.copy()

    if image.mode in ("RGB", "L", "CMYK"):
        return image.copy()

    converted = image.convert("RGBA")
    background = Image.new("RGBA", converted.size, (255, 255, 255, 255))
    background.alpha_composite(converted)
    warnings.append(JPEG_ALPHA_WARNING)
    return background.convert("RGB")


class ImageService:
    """Service for image retrieval, filtering, and file operations."""

    def _validate_common_gallery_filters(
        self,
        *,
        sort_by: str,
        aspect_ratio: Optional[str],
        min_width: Optional[int],
        max_width: Optional[int],
        min_height: Optional[int],
        max_height: Optional[int],
    ) -> None:
        """Validate shared gallery filter constraints used by list and selection flows."""
        if sort_by not in VALID_SORT_OPTIONS:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid sort_by value. Must be one of: {', '.join(VALID_SORT_OPTIONS)}"
            )

        if aspect_ratio is not None and aspect_ratio not in VALID_ASPECT_RATIOS:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid aspect_ratio value. Must be one of: {', '.join(VALID_ASPECT_RATIOS)}"
            )

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

    def _filter_and_mark_missing_images(self, images: List[Dict[str, Any]]) -> tuple[List[Dict[str, Any]], int]:
        """Drop rows whose backing files no longer exist and persist that state in SQLite."""
        live_images: List[Dict[str, Any]] = []
        missing_count = 0

        for image in images:
            image_id = int(image.get("id") or 0)
            primary_path = str(image.get("path") or "")
            resolved_path = resolve_existing_indexed_image_path(primary_path, backend_file=__file__)
            if resolved_path:
                live_images.append(image)
                continue

            missing_count += 1
            if image_id > 0:
                db.mark_image_unreadable(image_id, "File not found on disk")

        return live_images, missing_count

    def delete_selected_image_files(self, image_ids: List[int]) -> Dict[str, Any]:
        """Delete image files from disk and remove their database rows.

        Returns a partial-failure payload so the frontend can show a truthful
        summary instead of pretending the whole batch succeeded.
        """
        deleted = 0
        failed: List[Dict[str, Any]] = []
        seen_ids = set()

        for raw_image_id in image_ids or []:
            image_id = int(raw_image_id)
            if image_id in seen_ids:
                continue
            seen_ids.add(image_id)

            image = db.get_image_by_id(image_id)
            if not image:
                failed.append({
                    "image_id": image_id,
                    "filename": None,
                    "error": "Image not found",
                })
                continue

            filename = image.get("filename") or Path(str(image.get("path") or "")).name or f"image_{image_id}"

            try:
                source_path = self.resolve_image_source_path(image_id, image.get("path", ""))
                Path(source_path).unlink()
                db.delete_image(image_id)
                deleted += 1
            except HTTPException as exc:
                failed.append({
                    "image_id": image_id,
                    "filename": filename,
                    "error": exc.detail or "Image file not found on disk",
                })
            except Exception as exc:
                failed.append({
                    "image_id": image_id,
                    "filename": filename,
                    "error": str(exc),
                })

        return {
            "deleted": deleted,
            "failed": failed,
            "permanent_delete": True,
        }

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
            cursor: Opaque cursor token from a previous page (legacy integer IDs still accepted)
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
        self._validate_common_gallery_filters(
            sort_by=sort_by,
            aspect_ratio=aspect_ratio,
            min_width=min_width,
            max_width=max_width,
            min_height=min_height,
            max_height=max_height,
        )

        gen_list = _sanitize_filter_values(generators)
        tag_list = _sanitize_filter_values(tags)
        rating_list = _sanitize_filter_values(ratings)
        cp_list = _sanitize_filter_values(checkpoints)
        lr_list = _sanitize_filter_values(loras)
        prompt_list = _sanitize_filter_values(prompts)
        search = _sanitize_filter_value(search) if search else None
        artist = _sanitize_filter_value(artist) if artist else None

        cursor_payload = None
        if cursor:
            try:
                cursor_payload = decode_image_cursor(cursor)
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc

        supports_cursor_pagination = sort_by in {"newest", "oldest"} and offset is None

        if supports_cursor_pagination:
            collected: List[Dict[str, Any]] = []
            current_cursor = cursor_payload
            total = -1
            total_missing = 0
            fetch_limit = min(max(limit * 2, 32), LIMIT_MAX)

            while len(collected) < limit + 1:
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
                    limit=fetch_limit,
                    cursor_id=current_cursor.image_id if current_cursor else None,
                    cursor_sort_value=current_cursor.sort_value if current_cursor else None,
                    cursor_is_opaque=current_cursor.is_opaque if current_cursor else False,
                    min_width=min_width,
                    max_width=max_width,
                    min_height=min_height,
                    max_height=max_height,
                    aspect_ratio=aspect_ratio,
                    min_aesthetic=min_aesthetic,
                    max_aesthetic=max_aesthetic,
                    skip_count=total >= 0,
                )
                if total < 0:
                    total = result.get("total", -1)

                live_images, missing_count = self._filter_and_mark_missing_images(result.get("images", []))
                total_missing += missing_count
                collected.extend(live_images)

                if len(collected) >= limit + 1 or not result.get("has_more") or not result.get("images"):
                    break

                current_cursor = decode_image_cursor(result["next_cursor"])

            has_more = len(collected) > limit
            if has_more:
                collected = collected[:limit]

            if total >= 0:
                total = max(0, total - total_missing)

            return {
                "images": collected,
                "next_cursor": encode_image_cursor_from_image(collected[-1]) if has_more and collected else None,
                "next_offset": None,
                "has_more": has_more,
                "total": total,
            }

        page_offset = max(0, offset or 0)
        fetch_limit = min(max(limit * 2, 32), LIMIT_MAX)
        scan_offset = page_offset
        images: List[Dict[str, Any]] = []
        total_missing = 0

        while len(images) < limit + 1:
            batch = db.get_images(
                generators=gen_list,
                tags=tag_list,
                ratings=rating_list,
                checkpoints=cp_list,
                loras=lr_list,
                search_query=search,
                prompt_terms=prompt_list,
                artist=artist,
                sort_by=sort_by,
                limit=fetch_limit,
                offset=scan_offset,
                min_width=min_width,
                max_width=max_width,
                min_height=min_height,
                max_height=max_height,
                aspect_ratio=aspect_ratio,
                min_aesthetic=min_aesthetic,
                max_aesthetic=max_aesthetic,
            )
            if not batch:
                break

            live_batch, missing_count = self._filter_and_mark_missing_images(batch)
            total_missing += missing_count
            images.extend(live_batch)
            scan_offset += len(batch)

            if len(images) >= limit + 1 or len(batch) < fetch_limit:
                break

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

    def _build_selection_filter_contract(
        self,
        *,
        generators: Optional[List[str]] = None,
        tags: Optional[List[str]] = None,
        ratings: Optional[List[str]] = None,
        checkpoints: Optional[List[str]] = None,
        loras: Optional[List[str]] = None,
        prompts: Optional[List[str]] = None,
        artist: Optional[str] = None,
        search: Optional[str] = None,
        sort_by: str = "newest",
        min_width: Optional[int] = None,
        max_width: Optional[int] = None,
        min_height: Optional[int] = None,
        max_height: Optional[int] = None,
        aspect_ratio: Optional[str] = None,
        min_aesthetic: Optional[float] = None,
        max_aesthetic: Optional[float] = None,
    ) -> Dict[str, Any]:
        """Build the canonical filter contract encoded into selection tokens."""
        sort_by = _coerce_optional_string_filter(sort_by, "sortBy") or "newest"
        artist = _coerce_optional_string_filter(artist, "artist")
        search = _coerce_optional_string_filter(search, "search")
        aspect_ratio = _coerce_optional_string_filter(aspect_ratio, "aspectRatio")
        min_width = _coerce_optional_int_filter(min_width, "minWidth")
        max_width = _coerce_optional_int_filter(max_width, "maxWidth")
        min_height = _coerce_optional_int_filter(min_height, "minHeight")
        max_height = _coerce_optional_int_filter(max_height, "maxHeight")
        min_aesthetic = _coerce_optional_float_filter(min_aesthetic, "minAesthetic")
        max_aesthetic = _coerce_optional_float_filter(max_aesthetic, "maxAesthetic")

        self._validate_common_gallery_filters(
            sort_by=sort_by,
            aspect_ratio=aspect_ratio,
            min_width=min_width,
            max_width=max_width,
            min_height=min_height,
            max_height=max_height,
        )
        return {
            "generators": _sanitize_filter_values(generators) or [],
            "tags": _sanitize_filter_values(tags) or [],
            "ratings": _sanitize_filter_values(ratings) or [],
            "checkpoints": _sanitize_filter_values(checkpoints) or [],
            "loras": _sanitize_filter_values(loras) or [],
            "prompts": _sanitize_filter_values(prompts) or [],
            "artist": _sanitize_filter_value(artist) if artist else None,
            "search": _sanitize_filter_value(search) if search else "",
            "sortBy": sort_by or "newest",
            "minWidth": min_width,
            "maxWidth": max_width,
            "minHeight": min_height,
            "maxHeight": max_height,
            "aspectRatio": aspect_ratio,
            "minAesthetic": min_aesthetic,
            "maxAesthetic": max_aesthetic,
        }

    def _selection_ids_from_contract(
        self,
        contract: Dict[str, Any],
        *,
        offset: int = 0,
        limit: Optional[int] = None,
    ) -> List[int]:
        return db.get_filtered_image_ids(
            generators=contract["generators"],
            tags=contract["tags"],
            ratings=contract["ratings"],
            checkpoints=contract["checkpoints"],
            loras=contract["loras"],
            search_query=contract["search"] or None,
            sort_by=contract["sortBy"],
            min_width=contract["minWidth"],
            max_width=contract["maxWidth"],
            min_height=contract["minHeight"],
            max_height=contract["maxHeight"],
            prompt_terms=contract["prompts"],
            aspect_ratio=contract["aspectRatio"],
            artist=contract["artist"],
            min_aesthetic=contract["minAesthetic"],
            max_aesthetic=contract["maxAesthetic"],
            fetch_chunk_size=SELECTION_IDS_FETCH_CHUNK,
            offset=offset,
            limit=limit,
        )

    def _selection_total_estimate(self, contract: Dict[str, Any]) -> int:
        return db.get_filtered_image_count(
            generators=contract["generators"],
            tags=contract["tags"],
            ratings=contract["ratings"],
            checkpoints=contract["checkpoints"],
            loras=contract["loras"],
            search_query=contract["search"] or None,
            min_width=contract["minWidth"],
            max_width=contract["maxWidth"],
            min_height=contract["minHeight"],
            max_height=contract["maxHeight"],
            prompt_terms=contract["prompts"],
            aspect_ratio=contract["aspectRatio"],
            artist=contract["artist"],
            min_aesthetic=contract["minAesthetic"],
            max_aesthetic=contract["maxAesthetic"],
        )

    def _encode_selection_token(self, contract: Dict[str, Any]) -> str:
        payload = {
            "v": SELECTION_TOKEN_VERSION,
            "issued_at": datetime.now(timezone.utc).isoformat(),
            "filters": contract,
        }
        raw = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
        return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")

    def _decode_selection_token(self, selection_token: str) -> Dict[str, Any]:
        try:
            padded = selection_token + "=" * (-len(selection_token) % 4)
            payload = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8"))
        except (binascii.Error, json.JSONDecodeError, UnicodeDecodeError, ValueError):
            raise HTTPException(status_code=400, detail="Invalid selection token")

        if not isinstance(payload, dict) or payload.get("v") != SELECTION_TOKEN_VERSION:
            raise HTTPException(status_code=400, detail="Invalid selection token")
        filters = payload.get("filters")
        if not isinstance(filters, dict):
            raise HTTPException(status_code=400, detail="Invalid selection token")
        for list_field in ("generators", "tags", "ratings", "checkpoints", "loras", "prompts"):
            value = filters.get(list_field)
            if value is not None and not isinstance(value, list):
                raise _invalid_selection_token()

        try:
            return self._build_selection_filter_contract(
                generators=filters.get("generators"),
                tags=filters.get("tags"),
                ratings=filters.get("ratings"),
                checkpoints=filters.get("checkpoints"),
                loras=filters.get("loras"),
                prompts=filters.get("prompts"),
                artist=filters.get("artist"),
                search=filters.get("search"),
                sort_by=filters.get("sortBy") or "newest",
                min_width=filters.get("minWidth"),
                max_width=filters.get("maxWidth"),
                min_height=filters.get("minHeight"),
                max_height=filters.get("maxHeight"),
                aspect_ratio=filters.get("aspectRatio"),
                min_aesthetic=filters.get("minAesthetic"),
                max_aesthetic=filters.get("maxAesthetic"),
            )
        except HTTPException:
            raise
        except (TypeError, ValueError):
            raise _invalid_selection_token()

    def create_selection_token(
        self,
        *,
        chunk_size: int = SELECTION_TOKEN_DEFAULT_CHUNK,
        **filters: Any,
    ) -> Dict[str, Any]:
        """Create a stateless filtered-selection token for chunked ID retrieval."""
        contract = self._build_selection_filter_contract(**filters)
        if contract["sortBy"] == "random":
            raise HTTPException(status_code=400, detail=SELECTION_TOKEN_RANDOM_SORT_ERROR)
        normalized_chunk = max(1, min(int(chunk_size or SELECTION_TOKEN_DEFAULT_CHUNK), SELECTION_TOKEN_MAX_CHUNK))
        exact_total = not bool(contract["prompts"])
        return {
            "selection_token": self._encode_selection_token(contract),
            "total_estimate": self._selection_total_estimate(contract),
            "exact_total": exact_total,
            "chunk_size": normalized_chunk,
        }

    def get_selection_chunk(self, selection_token: str, *, offset: int = 0, limit: int = SELECTION_TOKEN_DEFAULT_CHUNK) -> Dict[str, Any]:
        """Resolve one ordered chunk of image IDs from a selection token."""
        contract = self._decode_selection_token(selection_token)
        if contract["sortBy"] == "random":
            raise HTTPException(status_code=400, detail=SELECTION_TOKEN_RANDOM_SORT_ERROR)
        normalized_offset = max(0, int(offset or 0))
        normalized_limit = max(1, min(int(limit or SELECTION_TOKEN_DEFAULT_CHUNK), SELECTION_TOKEN_MAX_CHUNK))
        ids = self._selection_ids_from_contract(
            contract,
            offset=normalized_offset,
            limit=normalized_limit + 1,
        )
        image_ids = ids[:normalized_limit]
        has_more = len(ids) > normalized_limit
        return {
            "image_ids": image_ids,
            "offset": normalized_offset,
            "limit": normalized_limit,
            "next_offset": normalized_offset + len(image_ids) if has_more else None,
            "has_more": has_more,
        }

    def get_filtered_selection_ids(
        self,
        *,
        generators: Optional[List[str]] = None,
        tags: Optional[List[str]] = None,
        ratings: Optional[List[str]] = None,
        checkpoints: Optional[List[str]] = None,
        loras: Optional[List[str]] = None,
        prompts: Optional[List[str]] = None,
        artist: Optional[str] = None,
        search: Optional[str] = None,
        sort_by: str = "newest",
        min_width: Optional[int] = None,
        max_width: Optional[int] = None,
        min_height: Optional[int] = None,
        max_height: Optional[int] = None,
        aspect_ratio: Optional[str] = None,
        min_aesthetic: Optional[float] = None,
        max_aesthetic: Optional[float] = None,
    ) -> Dict[str, Any]:
        """Resolve the full filtered-result ID set in current gallery sort order."""
        contract = self._build_selection_filter_contract(
            generators=generators,
            tags=tags,
            ratings=ratings,
            checkpoints=checkpoints,
            loras=loras,
            prompts=prompts,
            artist=artist,
            search=search,
            sort_by=sort_by,
            min_width=min_width,
            max_width=max_width,
            min_height=min_height,
            max_height=max_height,
            aspect_ratio=aspect_ratio,
            min_aesthetic=min_aesthetic,
            max_aesthetic=max_aesthetic,
        )
        image_ids = self._selection_ids_from_contract(contract)
        return {
            "image_ids": image_ids,
            "total": len(image_ids),
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

    def get_export_selection_data(
        self,
        image_ids: List[int],
        *,
        source: str = "image_ids",
        total: Optional[int] = None,
        offset: int = 0,
        limit: Optional[int] = None,
        has_more: bool = False,
        next_offset: Optional[int] = None,
        exact_total: bool = True,
    ) -> Dict[str, Any]:
        """Return prompt and tag export data for multiple images in one request."""
        images_map = db.get_images_by_ids(image_ids)
        tags_map = db.get_image_tags_map(image_ids)

        export_images: List[Dict[str, Any]] = []
        missing_ids: List[int] = []

        for image_id in image_ids:
            image = images_map.get(image_id)
            if not image:
                missing_ids.append(image_id)
                continue

            export_images.append(
                {
                    "id": image_id,
                    "filename": image.get("filename") or "",
                    "generator": image.get("generator"),
                    "prompt": image.get("prompt") or "",
                    "checkpoint": image.get("checkpoint"),
                    "width": image.get("width"),
                    "height": image.get("height"),
                    "aesthetic_score": image.get("aesthetic_score"),
                    "tags": [tag["tag"] for tag in tags_map.get(image_id, [])],
                }
            )

        normalized_limit = int(limit if limit is not None else len(image_ids))
        return {
            "images": export_images,
            "missing_ids": missing_ids,
            "count": len(export_images),
            "total": int(total if total is not None else len(image_ids)),
            "offset": max(0, int(offset or 0)),
            "limit": max(0, normalized_limit),
            "next_offset": next_offset,
            "has_more": bool(has_more),
            "source": source,
            "exact_total": bool(exact_total),
        }

    def get_export_selection_data_for_token(
        self,
        selection_token: str,
        *,
        offset: int = 0,
        limit: int = SELECTION_TOKEN_DEFAULT_CHUNK,
    ) -> Dict[str, Any]:
        """Return one export-data page from a filtered selection token."""
        contract = self._decode_selection_token(selection_token)
        if contract["sortBy"] == "random":
            raise HTTPException(status_code=400, detail=SELECTION_TOKEN_RANDOM_SORT_ERROR)

        normalized_offset = max(0, int(offset or 0))
        normalized_limit = max(1, min(int(limit or SELECTION_TOKEN_DEFAULT_CHUNK), SELECTION_TOKEN_MAX_CHUNK))
        ids = self._selection_ids_from_contract(
            contract,
            offset=normalized_offset,
            limit=normalized_limit + 1,
        )
        image_ids = ids[:normalized_limit]
        has_more = len(ids) > normalized_limit
        return self.get_export_selection_data(
            image_ids,
            source="selection_token",
            total=self._selection_total_estimate(contract),
            offset=normalized_offset,
            limit=normalized_limit,
            has_more=has_more,
            next_offset=normalized_offset + len(image_ids) if has_more else None,
            exact_total=not bool(contract["prompts"]),
        )

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
        resolved_path = resolve_existing_indexed_image_path(primary_path, backend_file=__file__)
        if resolved_path:
            return resolved_path

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

    def save_image_with_edited_metadata(
        self,
        source_path: str,
        output_path: str,
        image_format: str,
        metadata: Optional[Dict[str, Any]],
        allow_overwrite: bool = False,
        quality: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Save a copy of an image with edited SD metadata."""
        is_valid, error = validate_file_path(source_path, ALLOWED_IMAGE_EXTENSIONS)
        if not is_valid:
            raise PathValidationError(error or "Invalid source image path")

        source = Path(source_path).resolve()
        output = validate_image_output_path(output_path, allow_overwrite=allow_overwrite)

        normalized_output_format = output.extension.lstrip(".").lower()
        if normalized_output_format == "jpeg":
            normalized_output_format = "jpg"

        requested_format = str(image_format or normalized_output_format).strip().lower()
        if requested_format == "jpeg":
            requested_format = "jpg"
        if requested_format not in {"png", "webp", "jpg"}:
            raise ValueError("Unsupported output format")
        if requested_format != normalized_output_format:
            raise ValueError("Output path extension does not match the selected format")

        if quality is not None and (quality < 1 or quality > 100):
            raise ValueError("Quality must be between 1 and 100")

        normalized_metadata = _normalize_edited_metadata(metadata)
        parameters_text = _build_sd_parameters_text(normalized_metadata)
        warnings: List[str] = []

        pil_format = "PNG"
        if requested_format == "webp":
            pil_format = "WEBP"
            warnings.append(WEBP_LIMITATION_WARNING)
        elif requested_format == "jpg":
            pil_format = "JPEG"
            warnings.append(JPEG_LIMITATION_WARNING)

        def _write_edited_image(final_output_path: str, _overwrite_requested: bool) -> None:
            with Image.open(source) as image:
                save_image = _prepare_image_for_save(image, pil_format, warnings)
                save_kwargs: Dict[str, Any] = {}
                icc_profile = image.info.get("icc_profile")
                if icc_profile:
                    save_kwargs["icc_profile"] = icc_profile

                if pil_format == "PNG":
                    save_kwargs["pnginfo"] = _build_pnginfo(normalized_metadata, parameters_text)
                else:
                    exif_bytes = _build_exif_bytes(image, parameters_text)
                    if exif_bytes:
                        save_kwargs["exif"] = exif_bytes
                    save_kwargs["quality"] = int(quality if quality is not None else (92 if pil_format == "JPEG" else 95))

                try:
                    save_image.save(final_output_path, format=pil_format, **save_kwargs)
                finally:
                    save_image.close()

        write_result = save_and_reconcile_checked(
            str(output.path),
            _write_edited_image,
            allow_overwrite=allow_overwrite,
            source_path=str(source),
            preserve_derived_state=(source == output.path),
            backend_file=__file__,
        )
        warnings.extend(write_result.warnings)

        return {
            "output_path": str(output.path),
            "format": requested_format,
            "warnings": warnings,
        }

    def open_image_folder(
        self,
        image_id: int,
        *,
        platform: str,
        popen: Callable[[List[str]], Any] = subprocess.Popen,
    ) -> Dict[str, Any]:
        """Open the containing folder of an indexed image in the OS file explorer."""
        image = db.get_image_by_id(image_id)
        if not image:
            raise HTTPException(status_code=404, detail="Image not found")

        try:
            file_path = self.resolve_image_source_path(image_id, image.get("path", ""))
            normalized_path = os.path.normpath(file_path)

            if platform == "win32":
                popen(["explorer", "/select,", normalized_path])
            elif platform == "darwin":
                popen(["open", "-R", normalized_path])
            else:
                popen(["xdg-open", os.path.dirname(normalized_path)])

            return {"success": True, "path": normalized_path}
        except HTTPException:
            raise
        except Exception as exc:
            logger.error("Failed to open folder for image %s: %s", image_id, exc)
            raise HTTPException(
                status_code=500,
                detail=f"Failed to open folder: {exc}",
            ) from exc

    async def parse_uploaded_image(
        self,
        file: UploadFile,
        *,
        temp_dir: Path,
        temp_ttl_seconds: int,
        max_bytes: int,
        chunk_size: int,
    ) -> Dict[str, Any]:
        """Parse uploaded image metadata without persisting the image in the library DB."""
        if not file or not file.filename:
            raise HTTPException(status_code=400, detail="No file uploaded")

        tmp_path: Optional[Path] = None
        cleanup_tmp = True

        try:
            _cleanup_stale_reader_uploads(temp_dir, temp_ttl_seconds)
            tmp_path = _allocate_reader_upload_path(temp_dir, file.filename)

            with open(tmp_path, "wb") as tmp_handle:
                total_bytes = 0
                while True:
                    chunk = await file.read(chunk_size)
                    if not chunk:
                        break
                    total_bytes += len(chunk)
                    if total_bytes > max_bytes:
                        raise HTTPException(
                            status_code=413,
                            detail="Uploaded image is too large to parse (max 64MB)",
                        )
                    tmp_handle.write(chunk)

            readable, read_error = await run_in_threadpool(verify_image_readable, str(tmp_path))
            if not readable:
                raise HTTPException(
                    status_code=422,
                    detail=f"Invalid or unreadable image file: {read_error or 'image decode failed'}",
                )

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
        except Exception as exc:
            logger.error("Failed to parse uploaded image %s: %s", getattr(file, "filename", None), exc)
            raise HTTPException(
                status_code=500,
                detail=f"Failed to parse image metadata: {exc}",
            ) from exc
        finally:
            await file.close()
            if cleanup_tmp and tmp_path and os.path.exists(tmp_path):
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass

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
