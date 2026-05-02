"""
Similarity service for SD Image Sorter.

Handles business logic for image embedding, similarity search, and duplicate detection.
"""
from typing import Optional, List

from fastapi import HTTPException, UploadFile, File, Query, BackgroundTasks
from starlette.concurrency import run_in_threadpool

import database as db
from model_health import get_model_health
from similarity import (
    SimilarityEmbeddingMissingError,
    SimilarityImageNotFoundError,
    SimilarityInsufficientEmbeddingsError,
    SimilarityInvalidImageError,
    SimilarityDuplicateSearchTooLargeError,
    SimilaritySearchWindowTooLargeError,
    ensure_clip_model_ready,
    get_similarity_index,
)


class SimilarityService:
    """Service for image similarity search and duplicate detection."""

    def embed_images(
        self,
        background_tasks: BackgroundTasks,
        image_ids: Optional[List[int]] = None,
    ) -> dict:
        """
        Start embedding images in the background.

        Generates CLIP embeddings for images to enable similarity search
        and duplicate detection.
        """
        index = get_similarity_index(db)
        progress = index.get_progress()
        if progress["running"]:
            return {
                "status": "already_running",
                "progress": progress,
            }

        try:
            ensure_clip_model_ready()
        except Exception as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc

        background_tasks.add_task(index.embed_batch, image_ids)

        return {"status": "started", "message": "Embedding started in background"}

    def get_embed_progress(self) -> dict:
        """Get current embedding progress."""
        index = get_similarity_index(db)
        return index.get_progress()

    def cancel_embedding(self) -> bool:
        index = get_similarity_index(db)
        return index.request_cancel()

    def search_similar(
        self,
        image_id: int,
        limit: int = 100,
        threshold: float = 0.5,
        offset: int = 0,
    ) -> dict:
        """
        Find images similar to a given image ID.

        Uses pre-computed CLIP embeddings to find visually and semantically
        similar images.
        """
        index = get_similarity_index(db)
        try:
            result = index.search_by_id(image_id, limit=limit, threshold=threshold, offset=offset)
        except SimilarityImageNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except SimilarityEmbeddingMissingError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except SimilaritySearchWindowTooLargeError as exc:
            raise HTTPException(status_code=413, detail=str(exc)) from exc
        return {
            "query_image_id": image_id,
            "results": result["results"],
            "count": len(result["results"]),
            "total": result["total"],
            "has_more": result["has_more"],
            "offset": result["offset"],
            "limit": result["limit"],
        }

    async def search_by_upload(
        self,
        file: UploadFile,
        limit: int = 100,
        threshold: float = 0.5,
        offset: int = 0,
    ) -> dict:
        """
        Find images similar to an uploaded image.

        Generates an embedding for the uploaded image and searches
        the database for visually/semantically similar images.
        """
        MAX_UPLOAD_SIZE = 50 * 1024 * 1024  # 50 MB
        image_data = bytearray()
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            image_data.extend(chunk)
            if len(image_data) > MAX_UPLOAD_SIZE:
                raise HTTPException(status_code=413, detail="File too large (max 50MB)")
        if not image_data:
            raise HTTPException(status_code=400, detail="Empty file uploaded")

        index = get_similarity_index(db)
        try:
            result = await run_in_threadpool(
                index.search_by_upload,
                bytes(image_data),
                limit,
                threshold,
                offset,
            )
        except SimilarityInvalidImageError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except SimilaritySearchWindowTooLargeError as exc:
            raise HTTPException(status_code=413, detail=str(exc)) from exc
        finally:
            await file.close()
        return {
            "results": result["results"],
            "count": len(result["results"]),
            "total": result["total"],
            "has_more": result["has_more"],
            "offset": result["offset"],
            "limit": result["limit"],
        }

    def find_duplicates(
        self,
        threshold: float = 0.95,
        limit: int = 500,
        offset: int = 0,
    ) -> dict:
        """
        Find near-duplicate image pairs above similarity threshold.

        Performs an all-to-all comparison of embedded images to find
        visually similar pairs.
        """
        index = get_similarity_index(db)
        try:
            result = index.find_duplicates(threshold=threshold, limit=limit, offset=offset)
        except SimilarityInsufficientEmbeddingsError as exc:
            return {
                "duplicates": [],
                "count": 0,
                "total": 0,
                "has_more": False,
                "offset": offset,
                "limit": limit,
                "threshold": threshold,
                "reason": "insufficient_embeddings",
                "embedded_count": exc.embedded_count,
                "minimum_required": exc.minimum_required,
            }
        except SimilarityDuplicateSearchTooLargeError as exc:
            return {
                "duplicates": [],
                "count": 0,
                "total": 0,
                "has_more": False,
                "offset": offset,
                "limit": limit,
                "threshold": threshold,
                "reason": "too_many_embeddings",
                "embedded_count": exc.embedded_count,
                "max_embeddings": exc.max_embeddings,
            }
        return {
            "duplicates": result["duplicates"],
            "count": len(result["duplicates"]),
            "total": result["total"],
            "has_more": result["has_more"],
            "offset": result["offset"],
            "limit": result["limit"],
            "threshold": result["threshold"],
        }

    def get_stats(self) -> dict:
        """Get statistics about embeddings."""
        with db.get_db() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT COUNT(*) FROM images WHERE COALESCE(is_readable, 1) = 1")
            total = cursor.fetchone()[0]
            cursor.execute("SELECT COUNT(*) FROM images WHERE embedding IS NOT NULL AND COALESCE(is_readable, 1) = 1")
            embedded = cursor.fetchone()[0]
            cursor.execute("SELECT COUNT(*) FROM images WHERE COALESCE(is_readable, 1) = 0")
            unreadable = cursor.fetchone()[0]
        return {
            "total_images": total,
            "embedded_images": embedded,
            "embedded_count": embedded,
            "pending": total - embedded,
            "pending_count": total - embedded,
            "unreadable_count": unreadable,
            "coverage": round(embedded / total * 100, 1) if total > 0 else 0,
        }

    def get_model_status(self) -> dict:
        """Expose the local CLIP model readiness for the frontend."""
        clip = get_model_health()["clip"]
        runtime_loaded = clip.get("runtime_loaded", False)
        effective_available = clip["available"] or runtime_loaded
        return {
            "status": "ok",
            **clip,
            "available": effective_available,
            "message": clip["message"] if not runtime_loaded or clip["available"] else "CLIP model is loaded and ready.",
        }
