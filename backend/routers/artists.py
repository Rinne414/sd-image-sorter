"""
Artist Identification API Router for SD Image Sorter.

Endpoints for identifying artist/style in images using LSNet-style classification.
"""
import os
import threading
import logging
from typing import List, Optional, Dict, Any
from fastapi import APIRouter, HTTPException, BackgroundTasks
from pydantic import BaseModel, Field, field_validator, model_validator

from artist_identifier import get_artist_identifier, ArtistIdentifier
from config import ARTIST_HF_MODEL_ID, ARTIST_MODELSCOPE_MODEL_ID

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/artists", tags=["artists"])


# ============== Request/Response Models ==============

class ArtistModelConfig(BaseModel):
    model_source: str = Field("huggingface", pattern="^(huggingface|modelscope|local)$")
    model_path: Optional[str] = None

    @field_validator("model_path", mode="before")
    @classmethod
    def normalize_model_path(cls, value):
        if value is None:
            return None
        value = str(value).strip()
        return value or None

    @model_validator(mode="after")
    def validate_local_model_path(self):
        if self.model_source == "local":
            if not self.model_path:
                raise ValueError("Local model path is required when model_source is 'local'")

            normalized_path = os.path.abspath(os.path.expanduser(self.model_path))
            if not os.path.isfile(normalized_path):
                raise ValueError("Local model file not found")
            self.model_path = normalized_path
        return self


class IdentifyRequest(ArtistModelConfig):
    image_id: int = Field(..., ge=1)
    threshold: float = Field(0.35, ge=0.0, le=1.0)
    top_k: int = Field(5, ge=1, le=20)


class IdentifyBatchRequest(ArtistModelConfig):
    image_ids: List[int] = Field(..., min_length=1)
    threshold: float = Field(0.35, ge=0.0, le=1.0)
    top_k: int = Field(5, ge=1, le=20)


class IdentifyResponse(BaseModel):
    image_id: int
    artist: str
    confidence: float
    top_predictions: List[dict]
    model_loaded: bool
    # P0-5: Artist identifier uses a hardcoded label list, not a real trained model.
    # Always True to inform callers this feature is experimental.
    experimental: bool = True


class BatchProgress(BaseModel):
    running: bool
    total: int
    processed: int
    errors: int
    results: List[dict]


class ModelInfo(BaseModel):
    name: str
    source: str
    available: bool
    artist_count: int


class StatsResponse(BaseModel):
    total_images: int
    identified_images: int
    undefined_count: int
    artist_counts: dict


# ============== Background Task State ==============

_batch_progress: Dict[str, Any] = {
    "running": False,
    "total": 0,
    "processed": 0,
    "errors": 0,
    "results": [],
}

# Lock for thread-safe batch progress dict access
_batch_lock = threading.Lock()


# ============== Endpoints ==============

@router.post(
    "/identify",
    response_model=IdentifyResponse,
    summary="Identify artist of single image",
    description="""
Identify the artist or art style of a single image.

Uses a classification model to predict the most likely artist.
Returns "undefined" if confidence is below the threshold.

**Note:** This feature is experimental. The artist identification
uses a predefined label list and may not accurately identify all artists.
    """,
    responses={
        200: {
            "description": "Artist identification result",
            "content": {
                "application/json": {
                    "example": {
                        "image_id": 1,
                        "artist": "greg_rutkowski",
                        "confidence": 0.78,
                        "top_predictions": [
                            {"artist": "greg_rutkowski", "confidence": 0.78},
                            {"artist": "alphonse_mucha", "confidence": 0.45}
                        ],
                        "model_loaded": True,
                        "experimental": True
                    }
                }
            }
        },
        404: {"description": "Image not found or file missing"}
    }
)
async def identify_artist(request: IdentifyRequest):
    """
    Identify the artist/style of a single image.

    Uses a classification model to predict the most likely artist
    based on visual style. Results are stored in the database.

    Args:
        request: IdentifyRequest with:
            - image_id: ID of image to analyze
            - threshold: Minimum confidence to assign artist (default 0.35)
            - top_k: Number of top predictions to return (default 5)

    Returns:
        IdentifyResponse with:
        - image_id: The analyzed image ID
        - artist: Predicted artist name or "undefined"
        - confidence: Confidence score for top prediction
        - top_predictions: List of top-k predictions with scores
        - model_loaded: Whether model was loaded successfully
        - experimental: Always True (feature is experimental)

    Raises:
        HTTPException 404: Image not found or file missing on disk
    """
    import database as db

    # Get image path
    with db.get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT path FROM images WHERE id = ?", (request.image_id,))
        row = cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Image not found")

        image_path = row[0]

    if not os.path.exists(image_path):
        raise HTTPException(status_code=404, detail="Image file not found")

    # Identify artist
    identifier = get_artist_identifier(
        model_path=request.model_path,
        model_source=request.model_source,
        threshold=request.threshold,
    )
    result = identifier.identify(image_path, top_k=request.top_k)
    if result.get("error"):
        raise HTTPException(status_code=503, detail=result["error"])

    # Store result in database
    with db.get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """INSERT OR REPLACE INTO artist_predictions
               (image_id, artist, confidence, top_predictions)
               VALUES (?, ?, ?, ?)""",
            (
                request.image_id,
                result["artist"],
                result["confidence"],
                str(result["top_predictions"]),
            ),
        )

    return IdentifyResponse(
        image_id=request.image_id,
        artist=result["artist"],
        confidence=result["confidence"],
        top_predictions=result["top_predictions"],
        model_loaded=result["model_loaded"],
        experimental=True,
    )


@router.post(
    "/identify-batch",
    summary="Batch artist identification",
    description="""
Start batch artist identification for multiple images.

Runs in background. Poll progress with `/api/artists/batch-progress` endpoint.
Results are stored in the artist_predictions table.
    """,
    responses={
        200: {
            "description": "Batch started",
            "content": {
                "application/json": {
                    "example": {
                        "message": "Batch identification started",
                        "total": 100
                    }
                }
            }
        },
        400: {"description": "Batch already running"}
    }
)
async def identify_batch(
    request: IdentifyBatchRequest,
    background_tasks: BackgroundTasks,
):
    """
    Start batch artist identification for multiple images.

    Processes images in the background. Poll progress via the
    /api/artists/batch-progress endpoint.

    Args:
        request: IdentifyBatchRequest with:
            - image_ids: List of image IDs to identify
            - threshold: Minimum confidence threshold
            - top_k: Number of predictions per image
        background_tasks: FastAPI background tasks

    Returns:
        Dict with:
        - message: Status message
        - total: Number of images to process

    Note:
        Only one batch can run at a time.
    """
    global _batch_progress

    with _batch_lock:
        if _batch_progress["running"]:
            raise HTTPException(status_code=409, detail="Batch identification already in progress")

        # Reset progress
        _batch_progress = {
            "running": True,
            "total": len(request.image_ids),
            "processed": 0,
            "errors": 0,
            "results": [],
        }

    # Start background task
    background_tasks.add_task(
        _run_batch_identification,
        request.image_ids,
        request.threshold,
        request.top_k,
        request.model_source,
        request.model_path,
    )

    return {
        "message": "Batch identification started",
        "total": len(request.image_ids),
    }


def _run_batch_identification(
    image_ids: List[int],
    threshold: float,
    top_k: int,
    model_source: str = "huggingface",
    model_path: Optional[str] = None,
):
    """Background task for batch identification with optimized batch operations."""
    import database as db
    global _batch_progress

    identifier = get_artist_identifier(
        model_path=model_path,
        model_source=model_source,
        threshold=threshold,
    )

    # Batch fetch all image paths in a single query (N+1 fix)
    with db.get_db() as conn:
        cursor = conn.cursor()
        placeholders = ",".join("?" * len(image_ids))
        cursor.execute(
            f"SELECT id, path FROM images WHERE id IN ({placeholders})",
            image_ids
        )
        image_map = {row[0]: row[1] for row in cursor.fetchall()}

    # Collect all predictions to insert
    predictions_to_insert = []

    for image_id in image_ids:
        try:
            # Check if image exists in our map
            if image_id not in image_map:
                raise FileNotFoundError(f"Image {image_id} not found in database")

            image_path = image_map[image_id]

            if not os.path.exists(image_path):
                raise FileNotFoundError(f"Image file not found for image {image_id}")

            # Identify artist
            result = identifier.identify(image_path, top_k=top_k)
            if result.get("error"):
                raise RuntimeError(result["error"])

            # Collect for batch insert
            predictions_to_insert.append({
                "image_id": image_id,
                "artist": result["artist"],
                "confidence": result["confidence"],
                "top_predictions": str(result["top_predictions"]),
            })

            with _batch_lock:
                _batch_progress["results"].append({
                    "image_id": image_id,
                    "artist": result["artist"],
                    "confidence": result["confidence"],
                })

        except Exception as e:
            logger.error(f"Error processing image {image_id}: {e}")
            with _batch_lock:
                _batch_progress["errors"] += 1
        finally:
            with _batch_lock:
                _batch_progress["processed"] += 1

    # Batch insert all predictions (N+1 fix)
    if predictions_to_insert:
        with db.get_db() as conn:
            cursor = conn.cursor()
            cursor.executemany(
                """INSERT OR REPLACE INTO artist_predictions
                   (image_id, artist, confidence, top_predictions)
                   VALUES (?, ?, ?, ?)""",
                [(p["image_id"], p["artist"], p["confidence"], p["top_predictions"])
                 for p in predictions_to_insert]
            )

    with _batch_lock:
        _batch_progress["running"] = False


@router.get("/batch-progress", response_model=BatchProgress)
async def get_batch_progress():
    """Get the current batch identification progress."""
    with _batch_lock:
        return BatchProgress(**_batch_progress)


@router.get("/models", response_model=List[ModelInfo])
async def list_models():
    """List available artist identification models."""
    models = []

    # Check if transformers is available
    available = ArtistIdentifier.is_available()

    models.append(ModelInfo(
        name=f"{ARTIST_HF_MODEL_ID} (HuggingFace)",
        source="huggingface",
        available=available,
        artist_count=0,  # Will be determined when loaded
    ))

    models.append(ModelInfo(
        name=(f"{ARTIST_MODELSCOPE_MODEL_ID} (ModelScope)" if ARTIST_MODELSCOPE_MODEL_ID else "Custom ModelScope mirror"),
        source="modelscope",
        available=available,
        artist_count=0,
    ))

    # Check for local models
    local_models_dir = os.path.join(os.path.dirname(__file__), "..", "..", "models", "artist")
    if os.path.exists(local_models_dir):
        try:
            for f in os.listdir(local_models_dir):
                if f.endswith(('.onnx', '.pt', '.pth', '.bin', '.safetensors')):
                    models.append(ModelInfo(
                        name=f,
                        source="local",
                        available=True,
                        artist_count=0,
                    ))
        except PermissionError:
            logger.warning(f"Permission denied when accessing local models directory: {local_models_dir}")

    return models


@router.get("/stats", response_model=StatsResponse)
async def get_stats():
    """Get artist identification statistics."""
    import database as db

    with db.get_db() as conn:
        cursor = conn.cursor()

        # Total images
        cursor.execute("SELECT COUNT(*) FROM images")
        total_images = cursor.fetchone()[0]

        # Identified images
        cursor.execute("SELECT COUNT(*) FROM artist_predictions")
        identified_images = cursor.fetchone()[0]

        # Undefined count
        cursor.execute(
            "SELECT COUNT(*) FROM artist_predictions WHERE artist = 'undefined'"
        )
        undefined_count = cursor.fetchone()[0]

        # Artist counts
        cursor.execute("""
            SELECT artist, COUNT(*) as count
            FROM artist_predictions
            WHERE artist != 'undefined'
            GROUP BY artist
            ORDER BY count DESC
            LIMIT 50
        """)
        artist_counts = {row[0]: row[1] for row in cursor.fetchall()}

    return StatsResponse(
        total_images=total_images,
        identified_images=identified_images,
        undefined_count=undefined_count,
        artist_counts=artist_counts,
    )


@router.get("/list")
async def list_artists():
    """Get the list of known artists."""
    identifier = get_artist_identifier()
    return {"artists": identifier.get_artists_list()}


@router.delete("/clear")
async def clear_predictions():
    """Clear all artist predictions."""
    import database as db

    with db.get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM artist_predictions")

    return {"message": "All artist predictions cleared"}
