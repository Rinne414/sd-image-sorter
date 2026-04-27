"""
Persistent thumbnail cache for SD Image Sorter.
Generates and caches thumbnails on disk to avoid regenerating on every request.
"""
import hashlib
import io
import logging
import os
import threading
from datetime import datetime, timezone
from email.utils import format_datetime
from pathlib import Path
import asyncio
from typing import Optional, Tuple

from PIL import Image, ImageDraw
from config import get_thumbnail_cache_dir

logger = logging.getLogger(__name__)

# Supported thumbnail sizes
SUPPORTED_SIZES = {256, 384, 512}
DEFAULT_SIZE = 256

# Cache directory relative to the package-local data root
CACHE_DIR = Path(get_thumbnail_cache_dir())

# Cache settings
CACHE_MAX_AGE_DAYS = 30  # Invalidate cached thumbnails older than this

# Thread lock for cache cleanup operations
_cache_lock = threading.Lock()


def _ensure_cache_dir() -> Path:
    """Ensure the thumbnail cache directory exists."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    return CACHE_DIR


def _get_cache_key(source_path: str, size: int, mtime: float) -> str:
    """Generate a cache key based on image path, size, and modification time.

    Using mtime ensures cache invalidation when the source image changes.
    """
    # Normalize the source path
    normalized_path = os.path.abspath(source_path)

    # Create a hash from path + mtime for uniqueness
    key_data = f"{normalized_path}:{size}:{mtime}"
    hash_key = hashlib.md5(key_data.encode(), usedforsecurity=False).hexdigest()

    return f"{hash_key}_{size}.webp"


def _get_cache_path(cache_key: str) -> Path:
    """Get the full path for a cache file."""
    return CACHE_DIR / cache_key


def get_cached_thumbnail(source_path: str, size: int) -> Optional[Tuple[bytes, datetime]]:
    """Check if a valid cached thumbnail exists.

    Returns:
        Tuple of (thumbnail_bytes, last_modified) if cache hit, None if cache miss.
    """
    if size not in SUPPORTED_SIZES:
        # Fall back to nearest supported size
        size = min(SUPPORTED_SIZES, key=lambda s: abs(s - size))

    try:
        source_mtime = os.path.getmtime(source_path)
    except OSError:
        return None

    cache_key = _get_cache_key(source_path, size, source_mtime)
    cache_path = _get_cache_path(cache_key)

    if not cache_path.exists():
        return None

    try:
        # Read cached file
        with open(cache_path, "rb") as f:
            thumbnail_bytes = f.read()

        # Get last modified time of cached file
        last_modified = datetime.fromtimestamp(
            cache_path.stat().st_mtime,
            tz=timezone.utc
        )

        return (thumbnail_bytes, last_modified)
    except OSError:
        return None


def generate_and_cache_thumbnail(source_path: str, size: int) -> Tuple[bytes, datetime]:
    """Generate a thumbnail and cache it to disk.

    Returns:
        Tuple of (thumbnail_bytes, last_modified).
    """
    _ensure_cache_dir()

    # Normalize size to supported values
    if size not in SUPPORTED_SIZES:
        size = min(SUPPORTED_SIZES, key=lambda s: abs(s - size))

    # Get source file modification time for cache key
    source_mtime = os.path.getmtime(source_path)
    source_modified = datetime.fromtimestamp(source_mtime, tz=timezone.utc)

    # Generate thumbnail
    with Image.open(source_path) as source_img:
        thumb = source_img.copy()

        # Handle different color modes
        if thumb.mode in ("P", "RGBA", "LA"):
            thumb = thumb.convert("RGBA")
        else:
            thumb = thumb.convert("RGB")

        # Resize to thumbnail
        thumb.thumbnail((size, size), Image.Resampling.LANCZOS)

        # Convert to RGBA for WebP if needed
        if thumb.mode != "RGBA":
            thumb = thumb.convert("RGBA")

        # Save to buffer as WebP (good compression for thumbnails)
        buffer = io.BytesIO()
        thumb.save(buffer, format="WEBP", quality=85, method=4)
        buffer.seek(0)
        thumbnail_bytes = buffer.read()

    # Save to cache
    cache_key = _get_cache_key(source_path, size, source_mtime)
    cache_path = _get_cache_path(cache_key)

    try:
        with open(cache_path, "wb") as f:
            f.write(thumbnail_bytes)
    except OSError as e:
        # Log but don't fail - cache write is optional
        logger.warning("Failed to write thumbnail cache: %s", e)

    return (thumbnail_bytes, source_modified)


def get_thumbnail(source_path: str, size: int = DEFAULT_SIZE) -> Tuple[bytes, datetime, bool]:
    """Get a thumbnail, using cache if available or generating if needed.

    Args:
        source_path: Path to the source image.
        size: Desired thumbnail size (will be normalized to supported sizes).

    Returns:
        Tuple of (thumbnail_bytes, last_modified, cache_hit).
    """
    # Normalize size to supported values
    if size not in SUPPORTED_SIZES:
        original_size = size
        size = min(SUPPORTED_SIZES, key=lambda s: abs(s - original_size))

    # Try cache first
    cached = get_cached_thumbnail(source_path, size)
    if cached is not None:
        return (*cached, True)

    # Generate and cache
    thumbnail_bytes, last_modified = generate_and_cache_thumbnail(source_path, size)
    return (thumbnail_bytes, last_modified, False)


def generate_placeholder_thumbnail(
    size: int = DEFAULT_SIZE,
    *,
    label: str = "Unreadable",
) -> bytes:
    """Generate a lightweight placeholder thumbnail for unreadable images."""
    canvas_size = max(64, size if size in SUPPORTED_SIZES else min(SUPPORTED_SIZES, key=lambda s: abs(s - size)))
    image = Image.new("RGBA", (canvas_size, canvas_size), (28, 35, 52, 255))
    draw = ImageDraw.Draw(image)

    accent = (255, 159, 67, 255)
    muted = (98, 114, 164, 255)

    draw.rounded_rectangle(
        (8, 8, canvas_size - 8, canvas_size - 8),
        radius=18,
        outline=muted,
        width=3,
        fill=(18, 24, 38, 255),
    )
    draw.line((22, 22, canvas_size - 22, canvas_size - 22), fill=accent, width=8)
    draw.line((canvas_size - 22, 22, 22, canvas_size - 22), fill=accent, width=8)
    draw.rounded_rectangle(
        (24, canvas_size - 64, canvas_size - 24, canvas_size - 24),
        radius=12,
        outline=muted,
        width=2,
        fill=(36, 46, 66, 230),
    )
    draw.text((canvas_size // 2 - 32, canvas_size - 54), label[:10], fill=(240, 244, 255, 255))

    buffer = io.BytesIO()
    image.save(buffer, format="WEBP", quality=85, method=4)
    return buffer.getvalue()




async def get_thumbnail_async(source_path, size=256):
    """Async version of get_thumbnail for use in FastAPI endpoints."""
    if size not in SUPPORTED_SIZES:
        size = min(SUPPORTED_SIZES, key=lambda s: abs(s - size))

    cached = get_cached_thumbnail(source_path, size)
    if cached is not None:
        return (*cached, True)

    loop = asyncio.get_running_loop()
    thumbnail_bytes, last_modified = await loop.run_in_executor(
        None, generate_and_cache_thumbnail, source_path, size
    )
    return (thumbnail_bytes, last_modified, False)


def clear_cache() -> int:
    """Clear all cached thumbnails.

    Returns:
        Number of files deleted.
    """
    if not CACHE_DIR.exists():
        return 0

    count = 0
    with _cache_lock:
        for cache_file in CACHE_DIR.iterdir():
            if cache_file.is_file() and cache_file.suffix == ".webp":
                try:
                    cache_file.unlink()
                    count += 1
                except OSError as e:
                    logger.debug("Failed to delete cache file %s: %s", cache_file, e)

    return count


def cleanup_old_cache(max_age_days: int = CACHE_MAX_AGE_DAYS) -> int:
    """Remove cached thumbnails older than max_age_days.

    This handles orphaned cache entries where the source file was deleted
    but the cache file remains.

    Returns:
        Number of files deleted.
    """
    if not CACHE_DIR.exists():
        return 0

    cutoff_time = datetime.now(timezone.utc).timestamp() - (max_age_days * 86400)
    count = 0

    with _cache_lock:
        for cache_file in CACHE_DIR.iterdir():
            if cache_file.is_file() and cache_file.suffix == ".webp":
                try:
                    if cache_file.stat().st_mtime < cutoff_time:
                        cache_file.unlink()
                        count += 1
                except OSError as e:
                    logger.debug("Failed to cleanup cache file %s: %s", cache_file, e)

    return count


def get_cache_stats() -> dict:
    """Get statistics about the thumbnail cache.

    Returns:
        Dictionary with cache statistics.
    """
    if not CACHE_DIR.exists():
        return {
            "exists": False,
            "file_count": 0,
            "total_size_bytes": 0,
            "total_size_mb": 0.0,
        }

    file_count = 0
    total_size = 0

    for cache_file in CACHE_DIR.iterdir():
        if cache_file.is_file() and cache_file.suffix == ".webp":
            file_count += 1
            total_size += cache_file.stat().st_size

    return {
        "exists": True,
        "file_count": file_count,
        "total_size_bytes": total_size,
        "total_size_mb": round(total_size / (1024 * 1024), 2),
    }
