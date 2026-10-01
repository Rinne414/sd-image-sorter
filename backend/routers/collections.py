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
from typing import List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, model_validator

import database as db
import db_pinned_sets
from services.tag_export_service import iter_selection_token_id_chunks

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


# Selection tokens can resolve to tens of thousands of ids; expand them in
# DB-sized chunks instead of one giant query.
BULK_MEMBERSHIP_TOKEN_CHUNK_SIZE = 500


class BulkMembershipRequest(BaseModel):
    image_ids: List[int] = Field(default_factory=list)
    selection_token: Optional[str] = Field(default=None, min_length=1)
    member: bool = True

    @model_validator(mode="after")
    def require_scope(self) -> "BulkMembershipRequest":
        if not self.image_ids and not self.selection_token:
            raise ValueError("image_ids or selection_token is required")
        return self


class PinnedSetRequest(BaseModel):
    image_ids: List[int] = Field(..., min_length=1)
    # "view": a set the Gallery opens (newest 8 kept); "token": the pictures
    # behind a selection token given to another tool (kept 30 days).
    purpose: str = Field(default="view", pattern="^(view|token)$")


def _require_visible(collection_id: int) -> None:
    """Hidden picture sets are not collections: every collection route answers
    404 for them, exactly as for an id that does not exist."""
    if db_pinned_sets.is_hidden(collection_id):
        raise HTTPException(status_code=404, detail="Collection not found")


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


@router.post("/pinned")
def create_pinned_set(request: PinnedSetRequest):
    """Store pictures as a hidden "show only these" set and return its collection
    id: the Gallery opens it with the ordinary collection filter (``collection_id``).
    """
    made = db_pinned_sets.create_pinned_set(request.image_ids, purpose=request.purpose)
    return {"collection_id": made["id"], "count": made["count"]}


@router.get("/pinned/{collection_id}")
def get_pinned_set(collection_id: int):
    """Whether a pinned set still exists in the active library, and its size."""
    found = db_pinned_sets.get_pinned_set(collection_id)
    return {
        "exists": found is not None,
        "collection_id": collection_id,
        "count": found["count"] if found else 0,
    }


@router.delete("/pinned/{collection_id}")
def delete_pinned_set(collection_id: int):
    """Remove a pinned set (the only way to delete one; ordinary collection routes do not see them)."""
    return {"deleted": db_pinned_sets.delete_pinned_set(collection_id)}


@router.patch("/{collection_id}")
async def rename_collection(collection_id: int, request: RenameCollectionRequest):
    """Rename a collection."""
    _require_visible(collection_id)
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
    _require_visible(collection_id)
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
    _require_visible(collection_id)
    if not db.collection_exists(collection_id):
        raise HTTPException(status_code=404, detail="Collection not found")
    return {"image_ids": db.get_collection_image_ids(collection_id)}


@router.post("/{collection_id}/items")
async def set_membership(collection_id: int, request: MembershipRequest):
    """Add/remove an image to/from a collection (reference, no file copy)."""
    _require_visible(collection_id)
    try:
        member = db.set_collection_membership(collection_id, request.image_id, request.member)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return {"member": member}


@router.post("/{collection_id}/items/bulk")
async def set_membership_bulk(collection_id: int, request: BulkMembershipRequest):
    """Add/remove many images to/from a collection in one call (reference, no copy).

    Scope is an explicit id list or a gallery filtered-selection token
    ("Select all matching" can cover tens of thousands of images).
    """
    _require_visible(collection_id)
    if not db.collection_exists(collection_id):
        raise HTTPException(status_code=404, detail="Collection not found")

    if request.selection_token:
        # Invalid tokens raise HTTPException(400) inside the decoder.
        ids: List[int] = []
        for chunk in iter_selection_token_id_chunks(
            request.selection_token, chunk_size=BULK_MEMBERSHIP_TOKEN_CHUNK_SIZE
        ):
            ids.extend(int(image_id) for image_id in chunk)
    else:
        ids = [int(image_id) for image_id in request.image_ids]

    try:
        changed = db.set_collection_membership_bulk(collection_id, ids, request.member)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return {
        "success": True,
        "added": changed if request.member else 0,
        "removed": 0 if request.member else changed,
        "requested": len(ids),
    }


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

