"""Collections & Favorites API router (v3.3.0 FEAT-COLLECTIONS).

Exposes the previously-headless collections data layer to the UI:
- List / create / rename / delete collections.
- Toggle Favorites (heart) on a source image.
- Add / remove a source image to / from any collection (reference, no copy).
- List the images in a collection.

Favorites and ad-hoc membership are stored as *references* in
``collection_items`` (the copied_path points at the source image's own path)
so toggling is instant and reversible without physically copying files.
"""
from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import database as db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/collections", tags=["collections"])


class CreateCollectionRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    folder_path: Optional[str] = Field(default=None, max_length=4096)


class RenameCollectionRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)


class FavoriteRequest(BaseModel):
    image_id: int = Field(..., ge=1)
    favorited: bool = True


class MembershipRequest(BaseModel):
    image_id: int = Field(..., ge=1)
    member: bool = True


# PLACEHOLDER_ENDPOINTS


@router.get("")
async def list_collections():
    """List all collections with item counts (newest first)."""
    return {"collections": db.list_collections()}


@router.post("")
async def create_collection(request: CreateCollectionRequest):
    """Create a new collection."""
    try:
        return db.create_collection(request.name, request.folder_path)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.patch("/{collection_id}")
async def rename_collection(collection_id: int, request: RenameCollectionRequest):
    """Rename a collection."""
    try:
        ok = db.rename_collection(collection_id, request.name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if not ok:
        raise HTTPException(status_code=404, detail="Collection not found")
    return {"status": "ok"}


@router.delete("/{collection_id}")
async def delete_collection(collection_id: int):
    """Delete a collection and its references (Favorites is protected)."""
    try:
        ok = db.delete_collection(collection_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if not ok:
        raise HTTPException(status_code=404, detail="Collection not found")
    return {"status": "ok"}


@router.get("/{collection_id}/images")
async def list_collection_images(collection_id: int):
    """Return the source image ids in a collection (newest-added first)."""
    if not db.collection_exists(collection_id):
        raise HTTPException(status_code=404, detail="Collection not found")
    return {"image_ids": db.get_collection_image_ids(collection_id)}


@router.post("/{collection_id}/items")
async def set_membership(collection_id: int, request: MembershipRequest):
    """Add/remove an image to/from a collection (reference, no file copy)."""
    try:
        member = db.set_collection_membership(collection_id, request.image_id, request.member)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return {"member": member}


@router.get("/favorites/ids")
async def favorite_ids():
    """Return all favorited source image ids (for hydrating heart icons)."""
    return {"image_ids": db.get_favorite_source_ids(), "count": db.get_favorites_count()}


@router.post("/favorites")
async def toggle_favorite(request: FavoriteRequest):
    """Toggle Favorites membership for a source image."""
    try:
        favorited = db.set_favorite(request.image_id, request.favorited)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return {"favorited": favorited}

