"""
Aesthetic scoring endpoints.
Uses LAION Aesthetic Predictor (CLIP + linear head) to score images 1-10.
"""
import logging
from typing import Any, Dict

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query

from services.aesthetic_service import AestheticService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["aesthetic"])
_aesthetic_service: AestheticService | None = None


def get_aesthetic_service() -> AestheticService:
    global _aesthetic_service
    if _aesthetic_service is None:
        _aesthetic_service = AestheticService()
    return _aesthetic_service


def set_aesthetic_service(service: AestheticService) -> None:
    global _aesthetic_service
    _aesthetic_service = service


def _apply_scoring_state_update(update: Dict[str, Any]) -> None:
    _scoring_state.update(update)


@router.get("/aesthetic/status")
def aesthetic_status(service: AestheticService = Depends(get_aesthetic_service)):
    """Check if the aesthetic predictor is available and how many images are scored."""
    try:
        from aesthetic import is_available
        return service.get_status(is_available)
    except ImportError:
        return {
            "available": False,
            "message": "Aesthetic predictor dependencies are not installed",
            "scored_count": service.get_status(lambda: False)["scored_count"],
        }


@router.post("/aesthetic/score/{image_id}")
def score_single_image(
    image_id: int,
    service: AestheticService = Depends(get_aesthetic_service),
):
    """Score a single image by database ID."""
    try:
        from aesthetic import predict_score
    except ImportError:
        raise HTTPException(status_code=503, detail="Aesthetic predictor dependencies not installed")

    return service.score_single_image(
        image_id=image_id,
        predict_score=predict_score,
    )


# Background task state
_scoring_state = {
    "running": False,
    "total": 0,
    "completed": 0,
    "current": "",
    "errors": 0,
}


@router.post("/aesthetic/score-all")
def score_all_images(background_tasks: BackgroundTasks, force: bool = Query(False)):
    """Score all unscored images in background. Use force=true to rescore all."""
    if _scoring_state["running"]:
        return {"status": "already_running", **_scoring_state}

    try:
        from aesthetic import predict_score, is_available
        if not is_available():
            raise HTTPException(status_code=503, detail="Aesthetic predictor dependencies not installed")
    except ImportError:
        raise HTTPException(status_code=503, detail="Aesthetic predictor dependencies not installed")

    service = get_aesthetic_service()
    total = service.count_images_to_score(force=force)

    background_tasks.add_task(_score_batch, force)
    return {"status": "started", "total": total}


def _score_batch(force: bool = False):
    """Background task to score all images."""
    from aesthetic import predict_score

    try:
        service = get_aesthetic_service()
        service.score_batch(
            force=force,
            predict_score=predict_score,
            progress_callback=_apply_scoring_state_update,
        )
    except Exception as exc:
        logger.error("Aesthetic batch job failed: %s", exc)
        _scoring_state["running"] = False
        _scoring_state["current"] = ""


@router.get("/aesthetic/progress")
def scoring_progress():
    """Get the progress of background aesthetic scoring."""
    return _scoring_state
