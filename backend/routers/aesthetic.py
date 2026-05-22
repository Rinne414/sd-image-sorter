"""
Aesthetic scoring endpoints.
Uses LAION Aesthetic Predictor (CLIP + linear head) to score images 1-10.
"""
import logging

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query

from exceptions import ImageFileNotFoundError, ImageNotFoundError, ServiceError
from services.aesthetic_service import AestheticService
from services.service_provider import ServiceProvider

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["aesthetic"])
_aesthetic_service_provider = ServiceProvider(AestheticService)
get_aesthetic_service = _aesthetic_service_provider.get
set_aesthetic_service = _aesthetic_service_provider.set


@router.get("/aesthetic/status")
def aesthetic_status(service: AestheticService = Depends(get_aesthetic_service)):
    """Check if the aesthetic predictor is available and how many images are scored."""
    try:
        from aesthetic import is_available
        return service.get_status(is_available)
    except (ImportError, OSError) as exc:
        # OSError covers Windows DLL load failures (e.g. broken cudnn). Without
        # it, this endpoint returns 500 instead of a clean "not available"
        # status, breaking the aesthetic settings panel for any user with a
        # damaged torch runtime.
        logger.warning("Aesthetic predictor unavailable: %s", exc)
        return {
            "available": False,
            "message": "Aesthetic predictor dependencies are not installed or runtime is broken",
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
    except (ImportError, OSError) as exc:
        logger.warning("Aesthetic predictor torch import failed: %s", exc)
        raise HTTPException(status_code=503, detail="Aesthetic predictor dependencies not installed or runtime is broken")

    try:
        return service.score_single_image(
            image_id=image_id,
            predict_score=predict_score,
        )
    except ImageNotFoundError as exc:
        raise HTTPException(status_code=404, detail=exc.message)
    except ServiceError as exc:
        raise HTTPException(status_code=500, detail=exc.message)


@router.post("/aesthetic/score-all")
def score_all_images(
    background_tasks: BackgroundTasks,
    force: bool = Query(False),
    service: AestheticService = Depends(get_aesthetic_service),
):
    """Score all unscored images in background. Use force=true to rescore all."""
    if service.is_scoring_running():
        return {"status": "already_running", **service.get_scoring_progress()}

    try:
        from aesthetic import predict_score, is_available
        if not is_available():
            raise HTTPException(status_code=503, detail="Aesthetic predictor dependencies not installed")
    except (ImportError, OSError) as exc:
        logger.warning("Aesthetic predictor torch import failed: %s", exc)
        raise HTTPException(status_code=503, detail="Aesthetic predictor dependencies not installed or runtime is broken")

    total = service.count_images_to_score(force=force)
    service.start_scoring_progress(total=total)

    background_tasks.add_task(_score_batch, force)
    return {"status": "started", "total": total}


def _score_batch(force: bool = False):
    """Background task to score all images."""
    from aesthetic import predict_score

    service = get_aesthetic_service()
    try:
        service.score_batch(
            force=force,
            predict_score=predict_score,
            progress_callback=service.apply_scoring_progress_update,
        )
        service.finish_scoring_progress()
    except Exception as exc:
        logger.error("Aesthetic batch job failed: %s", exc)
        # Surface the error via the progress endpoint so the UI can show a
        # toast instead of treating it as a clean completion.
        service.finish_scoring_progress(error=str(exc))


@router.post("/aesthetic/cancel")
def cancel_scoring(service: AestheticService = Depends(get_aesthetic_service)):
    """Request cancellation of the running aesthetic scoring batch."""
    cancelled = service.request_cancel()
    return {"status": "cancelled" if cancelled else "not_running"}


@router.get("/aesthetic/progress")
def scoring_progress(service: AestheticService = Depends(get_aesthetic_service)):
    """Get the progress of background aesthetic scoring."""
    return service.get_scoring_progress()
