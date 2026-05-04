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


class CleanRequest(BaseModel):
    # Caller must provide explicit keys. Server enforces a whitelist
    # (``disk_service.SAFE_TO_CLEAN_KEYS``) so an unexpected client cannot
    # ask for "delete everything" through this endpoint.
    keys: List[str] = Field(..., min_length=1, max_length=16)


@router.get("/cache-status", summary="Report cache directory sizes")
def cache_status():
    """Return safe-to-clean and preserved directory sizes."""
    return disk_service.get_cache_status()


@router.post("/cleanup", summary="Wipe whitelisted cache directories")
def cleanup(request: CleanRequest):
    """Wipe contents of the requested whitelisted cache directories.

    Returns a partial-failure payload so the UI can show truthfully which
    keys were cleared, how much space each freed, and which (if any) hit
    file-locked / permission errors.
    """
    return disk_service.clean_caches(request.keys)
