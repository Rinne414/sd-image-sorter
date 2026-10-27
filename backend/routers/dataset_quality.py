"""Picture quality hints for the dataset Check step (blur and flat colour).

``POST /api/dataset/quality`` answers at once with what is already scored and,
when pictures are still unscored, starts one background bulk job for them (poll
``GET /api/bulk-jobs/{job_id}``, then ask again). Review only: the pictures are
listed with their numbers and never changed, moved or deleted.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from services import image_quality_service as quality
from services.bulk_job_service import (
    JOB_KIND_IMAGE_QUALITY,
    TERMINAL_STATUSES,
    BulkJobAlreadyRunningError,
    BulkJobHandle,
    get_bulk_job_service,
)
from services.dataset_session.scan_sources import scan_source_paths
from services.image_quality_scores import (
    BLUR_REVIEW_BELOW,
    FLAT_REVIEW_ABOVE,
    SCORES_VERSION,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["dataset"])


class DatasetQualityRequest(BaseModel):
    """Request body for ``POST /api/dataset/quality``."""

    model_config = ConfigDict(extra="ignore")

    image_ids: List[int] = Field(default_factory=list)
    image_paths: List[str] = Field(default_factory=list)
    # A large folder import goes by its scan ({scan_token, exclude_paths}).
    dataset_scan_tokens: List[Dict[str, Any]] = Field(default_factory=list)
    # False: only read what is scored already, never start a job.
    start: bool = True
    blur_below: float = Field(default=BLUR_REVIEW_BELOW, ge=0.0, le=100_000.0)
    flat_above: float = Field(default=FLAT_REVIEW_ABOVE, gt=0.0, le=1.0)


def _active_job_id() -> Optional[str]:
    for job in get_bulk_job_service().list_jobs(active_only=True):
        if (
            job["kind"] == JOB_KIND_IMAGE_QUALITY
            and job["status"] not in TERMINAL_STATUSES
        ):
            return str(job["job_id"])
    return None


@router.post(
    "/dataset/quality",
    summary="Possibly blurry and very flat pictures, scored in the background",
    description=(
        "Scores every picture on the CPU (Laplacian variance, edge share, "
        "flat-colour share on a grey copy of at most 512 px), keeps the numbers "
        "in a cache, and lists the pictures that look possibly blurry or very "
        "flat. Unscored pictures are scored by one bulk job (`job_id`; poll "
        "`/api/bulk-jobs/{job_id}`, then ask again). `started` is false when "
        "an earlier job is still running (its `job_id` is returned). Review "
        "only: nothing is changed or deleted."
    ),
)
def post_dataset_quality(
    payload: DatasetQualityRequest, background_tasks: BackgroundTasks
) -> Dict[str, Any]:
    if (
        not payload.image_ids
        and not payload.image_paths
        and not payload.dataset_scan_tokens
    ):
        raise HTTPException(
            status_code=400,
            detail="Quality check needs image_ids, image_paths or dataset_scan_tokens.",
        )
    try:
        scan_paths = scan_source_paths(payload.dataset_scan_tokens)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    try:
        targets, gone = quality.resolve_targets(
            payload.image_ids, [*payload.image_paths, *scan_paths]
        )
        state = quality.tally(targets, gone=gone)
    except Exception as exc:
        logger.exception("Dataset quality lookup failed")
        raise HTTPException(
            status_code=500, detail="Quality check failed. / 画质检查失败。"
        ) from exc

    job_id: Optional[str] = None
    started = False
    if state.pending and payload.start:
        service = get_bulk_job_service()
        try:
            job_id = service.create_single_flight_job(
                JOB_KIND_IMAGE_QUALITY,
                total=len(state.pending),
                message="Queued picture quality scoring",
                queued_cancel_result={"scored": 0, "unreadable": 0, "cancelled": True},
            )
            started = True
            pending = list(state.pending)

            def worker(handle: BulkJobHandle) -> None:
                quality.run_scoring_job(handle, pending)

            background_tasks.add_task(service.run_job, job_id, worker)
        except BulkJobAlreadyRunningError as exc:
            job_id = exc.active_job_id
    elif state.pending:
        job_id = _active_job_id()

    return {
        "scores_version": SCORES_VERSION,
        "total": state.total,
        "scored": len(state.scored),
        "pending": len(state.pending),
        "unreadable": state.unreadable,
        "missing": state.missing,
        "job_id": job_id,
        "started": started,
        "thresholds": {
            "blur_below": payload.blur_below,
            "flat_above": payload.flat_above,
        },
        "items": quality.flagged_items(
            state.scored,
            blur_below=payload.blur_below,
            flat_above=payload.flat_above,
        ),
    }
