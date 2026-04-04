"""
Similarity search router.

Endpoints for image embedding, similarity search, and duplicate detection.

Refactored to use Service Layer pattern with dependency injection.
"""
from typing import Optional

from fastapi import APIRouter, Depends, UploadFile, File, Query, BackgroundTasks

from services.similarity_service import SimilarityService


router = APIRouter(prefix="/api/similarity", tags=["similarity"])

# Service instance - will be set via dependency injection
_similarity_service: Optional[SimilarityService] = None


def get_similarity_service() -> SimilarityService:
    """Dependency injection for SimilarityService."""
    global _similarity_service
    if _similarity_service is None:
        _similarity_service = SimilarityService()
    return _similarity_service


def set_similarity_service(service: SimilarityService) -> None:
    """Set the similarity service instance."""
    global _similarity_service
    _similarity_service = service


@router.post(
    "/embed",
    summary="Start image embedding",
    description="""
Start generating CLIP embeddings for images (runs in background).

Embeddings are used for similarity search and duplicate detection.
If `image_ids` is provided, only those images are embedded.
Otherwise, all images without embeddings are processed.

Poll `/api/similarity/progress` to track embedding status.
    """,
    responses={
        200: {
            "description": "Embedding started",
            "content": {
                "application/json": {
                    "example": {"status": "started", "message": "Embedding started in background"}
                }
            }
        }
    }
)
async def embed_images(
    background_tasks: BackgroundTasks,
    image_ids: Optional[list] = None,
    service: SimilarityService = Depends(get_similarity_service),
):
    """Start embedding images in the background."""
    return service.embed_images(background_tasks, image_ids)


@router.get("/progress")
async def get_embed_progress(
    service: SimilarityService = Depends(get_similarity_service),
):
    """Get current embedding progress."""
    return service.get_embed_progress()


@router.get(
    "/search/{image_id}",
    summary="Find similar images",
    description="""
Find images similar to a specific image using CLIP embeddings.

Returns images ranked by cosine similarity score. Higher scores indicate
greater visual/semantic similarity.

**Threshold recommendations:**
- `0.95+`: Near-duplicates
- `0.80-0.95`: Very similar images
- `0.60-0.80`: Somewhat similar
- `0.50-0.60`: Loosely related
    """,
    responses={
        200: {
            "description": "Similar images found",
            "content": {
                "application/json": {
                    "example": {
                        "query_image_id": 1,
                        "results": [
                            {"id": 42, "similarity": 0.95, "filename": "similar_image.png"}
                        ],
                        "count": 1
                    }
                }
            }
        }
    }
)
async def search_similar(
    image_id: int,
    limit: int = Query(default=20, ge=1, le=100, description="Maximum results (1-100)"),
    threshold: float = Query(default=0.5, ge=0.0, le=1.0, description="Minimum similarity threshold (0.0-1.0)"),
    service: SimilarityService = Depends(get_similarity_service),
):
    """Find images similar to a given image ID."""
    return service.search_similar(image_id, limit, threshold)


@router.post(
    "/search-upload",
    summary="Find similar images by upload",
    description="""
Find images similar to an uploaded image file.

Generates a CLIP embedding for the uploaded image on-the-fly
and searches the database for similar images.
    """,
    responses={
        200: {
            "description": "Similar images found",
            "content": {
                "application/json": {
                    "example": {
                        "results": [
                            {"id": 42, "similarity": 0.89, "filename": "similar_image.png"}
                        ],
                        "count": 1
                    }
                }
            }
        },
        400: {"description": "Empty file uploaded"}
    }
)
async def search_by_upload(
    file: UploadFile = File(..., description="Image file to search for similar images"),
    limit: int = Query(default=20, ge=1, le=100, description="Maximum results (1-100)"),
    threshold: float = Query(default=0.5, ge=0.0, le=1.0, description="Minimum similarity threshold"),
    service: SimilarityService = Depends(get_similarity_service),
):
    """Find images similar to an uploaded image."""
    return await service.search_by_upload(file, limit, threshold)


@router.get(
    "/duplicates",
    summary="Find duplicate images",
    description="""
Find near-duplicate image pairs in the database.

Compares all embedded images against each other and returns pairs
with similarity above the threshold. Useful for identifying
duplicate or near-duplicate images.

**Recommended thresholds:**
- `0.98`: Exact or near-exact duplicates
- `0.95`: Very similar (minor edits, crops)
- `0.90`: Similar (same scene, different shot)
    """,
    responses={
        200: {
            "description": "Duplicate pairs found",
            "content": {
                "application/json": {
                    "example": {
                        "duplicates": [
                            {
                                "image_a": {"id": 1, "filename": "image_001.png"},
                                "image_b": {"id": 2, "filename": "image_002.png"},
                                "similarity": 0.98,
                            }
                        ],
                        "count": 1,
                        "threshold": 0.95
                    }
                }
            }
        }
    }
)
async def find_duplicates(
    threshold: float = Query(default=0.95, ge=0.5, le=1.0, description="Similarity threshold (0.5-1.0)"),
    limit: int = Query(default=100, ge=1, le=1000, description="Maximum pairs to return (1-1000)"),
    service: SimilarityService = Depends(get_similarity_service),
):
    """Find near-duplicate image pairs above similarity threshold."""
    return service.find_duplicates(threshold, limit)


@router.get("/stats")
async def embedding_stats(
    service: SimilarityService = Depends(get_similarity_service),
):
    """Get statistics about embeddings."""
    return service.get_stats()
