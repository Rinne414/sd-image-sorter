"""
Favorites endpoints for SD Image Sorter.
Favorites create a copied snapshot in the built-in favorites folder.
"""
import os

from fastapi import APIRouter, HTTPException

import database as db
from image_manager import copy_image
from utils.path_validation import validate_folder_path

router = APIRouter(prefix="/api", tags=["favorites"])


@router.get("/favorites")
async def get_favorites_summary():
    """Get Favorites collection summary."""
    collection = db.get_collection_by_slug(db.FAVORITES_COLLECTION_SLUG)
    if not collection:
        raise HTTPException(status_code=404, detail="Favorites collection not found")

    return {
        "collection": collection,
        "count": db.get_favorites_count(),
        "source_image_ids": db.get_favorite_source_ids(),
    }


@router.post("/favorites/{image_id}")
async def add_to_favorites(image_id: int):
    """Add an image to Favorites and copy it to the favorites folder."""
    image = db.get_image_by_id(image_id)
    if not image:
        raise HTTPException(status_code=404, detail="Image not found")

    if not os.path.exists(image["path"]):
        raise HTTPException(status_code=404, detail="Image file not found on disk")

    collection = db.get_collection_by_slug(db.FAVORITES_COLLECTION_SLUG)
    if not collection:
        raise HTTPException(status_code=404, detail="Favorites collection not found")

    is_valid, error = validate_folder_path(collection["folder_path"], allow_create=True)
    if not is_valid:
        raise HTTPException(status_code=400, detail=error or "Invalid favorites folder")

    existing_item = db.get_collection_item(collection["id"], image_id)
    if existing_item and os.path.exists(existing_item["copied_path"]):
        return {
            "status": "ok",
            "image_id": image_id,
            "is_favorite": True,
            "copied_path": existing_item["copied_path"],
        }

    copied_path = copy_image(image["path"], collection["folder_path"])
    db.add_collection_item(
        collection_id=collection["id"],
        source_image_id=image_id,
        copied_path=copied_path,
        prompt=image.get("prompt"),
        negative_prompt=image.get("negative_prompt"),
        checkpoint=image.get("checkpoint"),
        loras=image.get("loras"),
        metadata_json=image.get("metadata_json"),
        created_at=image.get("created_at"),
        width=image.get("width"),
        height=image.get("height"),
        file_size=image.get("file_size"),
    )

    return {
        "status": "ok",
        "image_id": image_id,
        "is_favorite": True,
        "copied_path": copied_path,
    }


@router.delete("/favorites/{image_id}")
async def remove_from_favorites(image_id: int):
    """Remove an image from Favorites without deleting the copied file."""
    collection = db.get_collection_by_slug(db.FAVORITES_COLLECTION_SLUG)
    if not collection:
        raise HTTPException(status_code=404, detail="Favorites collection not found")

    db.remove_collection_item(collection["id"], image_id)
    return {
        "status": "ok",
        "image_id": image_id,
        "is_favorite": False,
    }
