"""
Similarity search router.

Endpoints for image embedding, similarity search, and duplicate detection.
"""
import threading
from typing import Optional

from fastapi import APIRouter, HTTPException, UploadFile, File, Query, BackgroundTasks

import database as db
from similarity import get_similarity_index


router = APIRouter(prefix="/api/similarity", tags=["similarity"])


@router.post("/embed")
async def embed_images(
    background_tasks: BackgroundTasks,
    image_ids: Optional[list] = None,
):
    """
    Start embedding images (background task).

    If image_ids is provided, only embed those images.
    Otherwise, embed all images without embeddings.
    """
    index = get_similarity_index(db)
    progress = index.get_progress()
    if progress["running"]:
        return {
            "status": "already_running",
            "progress": progress,
        }

    # Run in background thread
    def _run_embed():
        index.embed_batch(image_ids)

    thread = threading.Thread(target=_run_embed, daemon=True)
    thread.start()

    return {"status": "started", "message": "Embedding started in background"}


@router.get("/progress")
async def get_embed_progress():
    """Get current embedding progress."""
    index = get_similarity_index(db)
    return index.get_progress()


@router.get("/search/{image_id}")
async def search_similar(
    image_id: int,
    limit: int = Query(20, ge=1, le=100),
    threshold: float = Query(0.5, ge=0.0, le=1.0),
):
    """Find images similar to a given image ID."""
    index = get_similarity_index(db)
    results = index.search_by_id(image_id, limit=limit, threshold=threshold)
    return {
        "query_image_id": image_id,
        "results": results,
        "count": len(results),
    }


@router.post("/search-upload")
async def search_by_upload(
    file: UploadFile = File(...),
    limit: int = Query(20, ge=1, le=100),
    threshold: float = Query(0.5, ge=0.0, le=1.0),
):
    """Find images similar to an uploaded image."""
    image_data = await file.read()
    if not image_data:
        raise HTTPException(status_code=400, detail="Empty file uploaded")

    index = get_similarity_index(db)
    results = index.search_by_upload(image_data, limit=limit, threshold=threshold)
    return {
        "results": results,
        "count": len(results),
    }


@router.get("/duplicates")
async def find_duplicates(
    threshold: float = Query(0.95, ge=0.5, le=1.0),
    limit: int = Query(100, ge=1, le=1000),
):
    """Find near-duplicate image pairs above similarity threshold."""
    index = get_similarity_index(db)
    results = index.find_duplicates(threshold=threshold, limit=limit)
    return {
        "duplicates": results,
        "count": len(results),
        "threshold": threshold,
    }


@router.get("/stats")
async def embedding_stats():
    """Get statistics about embeddings."""
    with db.get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) FROM images")
        total = cursor.fetchone()[0]
        cursor.execute("SELECT COUNT(*) FROM images WHERE embedding IS NOT NULL")
        embedded = cursor.fetchone()[0]
    return {
        "total_images": total,
        "embedded_images": embedded,
        "pending": total - embedded,
        "coverage": round(embedded / total * 100, 1) if total > 0 else 0,
    }
