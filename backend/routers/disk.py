"""
Disk usage endpoints.

Surfaces "what is using disk space" and lets the user wipe a tightly
whitelisted set of cache directories. Designed to be the user-driven
counterpart to the (intentionally absent) auto-cleanup behavior — we never
auto-delete anything; the user gets to see and choose.
"""
import logging
from typing import List

from fastapi import APIRouter
from pydantic import BaseModel, Field

from services import disk_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/disk", tags=["disk"])


class CacheSettingsRequest(BaseModel):
    thumbnail_cache_max_mb: int = Field(..., ge=0, le=102400)


class CleanRequest(BaseModel):
    # Caller must provide explicit keys. Server enforces a whitelist
    # (``disk_service.SAFE_TO_CLEAN_KEYS``) so an unexpected client cannot
    # ask for "delete everything" through this endpoint.
    keys: List[str] = Field(..., min_length=1, max_length=16)


@router.get("/cache-status", summary="Report cache directory sizes")
def cache_status():
    """Return safe-to-clean and preserved directory sizes."""
    return disk_service.get_cache_status()


@router.post("/settings", summary="Update disk/cache settings")
def update_settings(request: CacheSettingsRequest):
    """Persist cache limits and apply safe cleanup immediately."""
    return disk_service.update_cache_settings(thumbnail_cache_max_mb=request.thumbnail_cache_max_mb)


@router.post("/runtime/rebuild-core", summary="Schedule lightweight Python environment rebuild")
def rebuild_core_runtime():
    """Schedule backend/venv rebuild for the next launcher start."""
    return disk_service.request_core_runtime_rebuild()


@router.post("/cleanup", summary="Wipe whitelisted cache directories")
def cleanup(request: CleanRequest):
    """Wipe contents of the requested whitelisted cache directories.

    Returns a partial-failure payload so the UI can show truthfully which
    keys were cleared, how much space each freed, and which (if any) hit
    file-locked / permission errors.
    """
    return disk_service.clean_caches(request.keys)
