"""
Artist Identification API Router for SD Image Sorter.

Endpoints for identifying artist/style in images using LSNet-style classification.
"""
import os
import threading
import logging
import time
from typing import List, Optional, Dict, Any
from fastapi import APIRouter, HTTPException, BackgroundTasks, Query
from pydantic import BaseModel, Field, field_validator, model_validator

from artist_identifier import (
    get_artist_identifier,
    ArtistIdentifier,
    ARTIST_THRESHOLD_DEFAULT,
)
from config import ARTIST_HF_MODEL_ID, ARTIST_MODELSCOPE_MODEL_ID
from model_health import get_model_health

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
    threshold: float = Field(ARTIST_THRESHOLD_DEFAULT, ge=0.0, le=1.0)
    top_k: int = Field(5, ge=1, le=20)


class IdentifyBatchRequest(ArtistModelConfig):
    image_ids: List[int] = Field(..., min_length=1)
    threshold: float = Field(ARTIST_THRESHOLD_DEFAULT, ge=0.0, le=1.0)
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
    step: Optional[str] = None
    message: Optional[str] = None
    current_item: Optional[str] = None
    started_at: Optional[float] = None
    updated_at: Optional[float] = None


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
    artist_stats: Dict[str, Dict[str, float]] = Field(default_factory=dict)


class ArtistImageResponse(BaseModel):
    image_id: int
    filename: str
    artist: str
    confidence: float
    confidence_percent: float
    path: str


class ArtistImageListResponse(BaseModel):
    artist: str
    total: int
    limit: int
    offset: int
    has_more: bool
    images: List[ArtistImageResponse]


# ============== Background Task State ==============

_batch_progress: Dict[str, Any] = {
    "running": False,
    "total": 0,
    "processed": 0,
    "errors": 0,
    "results": [],
    "step": "idle",
    "message": "",
    "current_item": None,
    "started_at": None,
    "updated_at": None,
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
            - threshold: Minimum confidence to assign artist (default 0.03)
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
            "step": "starting",
            "message": "Preparing artist identification...",
            "current_item": None,
            "started_at": time.time(),
            "updated_at": time.time(),
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

    try:
        with _batch_lock:
            _batch_progress["step"] = "loading_runtime"
            _batch_progress["message"] = "Loading artist runtime..."
            _batch_progress["updated_at"] = time.time()

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

        with _batch_lock:
            _batch_progress["step"] = "identifying"
            _batch_progress["message"] = f"Identifying {len(image_ids)} image(s)..."
            _batch_progress["updated_at"] = time.time()

        # Collect all predictions to insert
        predictions_to_insert = []

        for image_id in image_ids:
            try:
                # Check if image exists in our map
                if image_id not in image_map:
                    raise FileNotFoundError(f"Image {image_id} not found in database")

                image_path = image_map[image_id]
                current_item = os.path.basename(image_path)
                with _batch_lock:
                    _batch_progress["current_item"] = current_item
                    _batch_progress["message"] = f"Identifying {current_item}"
                    _batch_progress["updated_at"] = time.time()

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
                    _batch_progress["updated_at"] = time.time()
            finally:
                with _batch_lock:
                    _batch_progress["processed"] += 1
                    _batch_progress["updated_at"] = time.time()

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
            _batch_progress["step"] = "done"
            _batch_progress["message"] = (
                f"Completed artist identification: {_batch_progress['processed']}/{_batch_progress['total']} processed"
                + (f", {_batch_progress['errors']} failed." if _batch_progress["errors"] else ".")
            )
            _batch_progress["current_item"] = None
            _batch_progress["updated_at"] = time.time()
    except Exception as exc:
        logger.error("Artist batch job failed: %s", exc)
        with _batch_lock:
            _batch_progress["running"] = False
            _batch_progress["step"] = "error"
            _batch_progress["message"] = f"Artist identification failed: {exc}"
            _batch_progress["current_item"] = None
            _batch_progress["updated_at"] = time.time()


@router.get("/batch-progress", response_model=BatchProgress)
async def get_batch_progress():
    """Get the current batch identification progress."""
    with _batch_lock:
        return BatchProgress(**_batch_progress)


@router.get("/models", response_model=List[ModelInfo])
async def list_models():
    """List available artist identification models."""
    health = get_model_health()["artist"]
    models = []

    models.append(ModelInfo(
        name=f"{ARTIST_HF_MODEL_ID} (HuggingFace)",
        source="huggingface",
        available=health["available"],
        artist_count=0,  # Will be determined when loaded
    ))

    models.append(ModelInfo(
        name=(f"{ARTIST_MODELSCOPE_MODEL_ID} (ModelScope)" if ARTIST_MODELSCOPE_MODEL_ID else "Custom ModelScope mirror"),
        source="modelscope",
        available=bool(health["runtime_path"] and health["missing_dependencies"] == []),
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


@router.get("/diagnostics")
async def get_artist_diagnostics():
    """Return user-friendly runtime diagnostics for the artist feature.

    Reports the richer of two signals:
      * Static health from model_health (Kaloscope runtime + checkpoint present).
      * Live singleton state — if the identifier has already loaded a model
        (HF fallback / ModelScope fallback / local), treat the feature as
        available even when the Kaloscope files are missing.
    """
    artist = dict(get_model_health()["artist"])
    live_loaded = False
    live_backend: Optional[str] = None
    live_error: Optional[str] = None
    try:
        identifier = get_artist_identifier()
        live_loaded = bool(
            identifier._model is not None and identifier._model != "placeholder"
        )
        live_backend = getattr(identifier, "_backend", None)
        live_error = getattr(identifier, "_load_error", None)
    except Exception:  # identifier import/init must not crash diagnostics
        pass

    if live_loaded:
        artist["available"] = True
        artist["message"] = (
            f"Artist identifier is loaded ({live_backend or 'fallback'})."
        )
    artist["runtime_loaded"] = live_loaded
    artist["runtime_backend"] = live_backend
    if live_error and not artist.get("available"):
        artist["runtime_error"] = live_error
    return {
        "status": "ok",
        **artist,
    }


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
            SELECT artist, COUNT(*) as count, AVG(confidence) as avg_confidence, MAX(confidence) as max_confidence
            FROM artist_predictions
            WHERE artist != 'undefined'
            GROUP BY artist
            ORDER BY count DESC
        """)
        artist_counts = {}
        artist_stats: Dict[str, Dict[str, float]] = {}
        for row in cursor.fetchall():
            artist = row[0]
            artist_counts[artist] = row[1]
            artist_stats[artist] = {
                "count": float(row[1]),
                "avg_confidence": float(row[2] or 0.0),
                "max_confidence": float(row[3] or 0.0),
            }

    return StatsResponse(
        total_images=total_images,
        identified_images=identified_images,
        undefined_count=undefined_count,
        artist_counts=artist_counts,
        artist_stats=artist_stats,
    )


@router.get("/images/{artist_name}", response_model=ArtistImageListResponse)
async def get_artist_images(
    artist_name: str,
    limit: int = Query(default=120, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
):
    """Return images identified for a specific artist ordered by confidence."""
    import database as db

    safe_artist = str(artist_name or "").strip()
    if not safe_artist:
        raise HTTPException(status_code=400, detail="Artist name is required")

    with db.get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT COUNT(*)
            FROM artist_predictions ap
            WHERE ap.artist = ?
            """,
            (safe_artist,),
        )
        total = int(cursor.fetchone()[0] or 0)

        cursor.execute(
            """
            SELECT i.id, i.filename, i.path, ap.artist, ap.confidence
            FROM artist_predictions ap
            INNER JOIN images i ON i.id = ap.image_id
            WHERE ap.artist = ?
            ORDER BY ap.confidence DESC, i.created_at DESC, i.id DESC
            LIMIT ?
            OFFSET ?
            """,
            (safe_artist, limit, offset),
        )
        rows = cursor.fetchall()

    images = [
        ArtistImageResponse(
            image_id=int(row[0]),
            filename=str(row[1] or ""),
            path=str(row[2] or ""),
            artist=str(row[3] or ""),
            confidence=float(row[4] or 0.0),
            confidence_percent=round(float(row[4] or 0.0) * 100, 1),
        )
        for row in rows
    ]

    return ArtistImageListResponse(
        artist=safe_artist,
        total=total,
        limit=limit,
        offset=offset,
        has_more=(offset + len(images)) < total,
        images=images,
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
