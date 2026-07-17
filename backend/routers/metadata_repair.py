"""Metadata L3 repair endpoints: parse-health counts + bulk re-parse job.

Companion to ``services.metadata_repair_service``. The health endpoint feeds
the settings-page coverage row; the reparse endpoint replays stored raw
envelopes (and files, as fallback) through the current parser inside the
shared bulk-job machinery — poll ``GET /api/bulk-jobs/{job_id}``.
"""
from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel, Field

from services import metadata_repair_service
from services.bulk_job_service import (
    BulkJobHandle,
    JOB_KIND_REPARSE_METADATA,
    TERMINAL_STATUSES,
    get_bulk_job_service,
)

router = APIRouter(prefix="/api", tags=["metadata-repair"])


class ReparseRequest(BaseModel):
    scope: str = Field(
        default="missing_prompt",
        description="Which rows to retry. Only 'missing_prompt' is supported.",
    )


@router.get(
    "/metadata/health",
    summary="Per-generator prompt-parse coverage",
    description="""
Counts, per generator, how many indexed images have no positive prompt and
how many of those carry a stored raw metadata envelope (re-parseable without
the original file). Drives the settings-page "metadata health" row.
    """,
)
def get_metadata_health():
    """Return parse-coverage counters for the settings health row."""
    return metadata_repair_service.get_metadata_health()


@router.post(
    "/metadata/reparse",
    summary="Re-parse missing-prompt images through the current parser",
    description="""
Starts a background job that retries every readable image whose prompt is
empty: first by replaying the raw metadata envelope stored at scan time,
then by re-parsing the file itself if it still exists. Poll
`GET /api/bulk-jobs/{job_id}`; only one re-parse runs at a time (409
otherwise). Result counts: recovered / still_missing / used_raw /
used_file / missing_source.
    """,
)
def start_reparse(request: ReparseRequest, background_tasks: BackgroundTasks):
    """Kick off the background metadata re-parse job."""
    if request.scope != "missing_prompt":
        raise HTTPException(status_code=422, detail="Unsupported scope")
    service = get_bulk_job_service()
    job_id = service.create_job(JOB_KIND_REPARSE_METADATA, message="Queued")
    if not metadata_repair_service.claim_active_job_id(job_id):
        rejected_job = service.cancel_job(job_id)
        if rejected_job is None:
            raise RuntimeError(
                f"Metadata re-parse job disappeared before rejection: job_id={job_id}"
            )
        raise HTTPException(status_code=409, detail="A metadata re-parse is already running")

    def _worker(handle: BulkJobHandle) -> None:
        metadata_repair_service.run_reparse_job(handle)

    def _run_job() -> None:
        try:
            service.run_job(job_id, _worker)
        finally:
            metadata_repair_service.release_active_job_id(job_id)

    background_tasks.add_task(_run_job)
    return {"job_id": job_id}


@router.get(
    "/metadata/reparse-status",
    summary="Get the active metadata re-parse job id (if any)",
)
def get_reparse_status():
    """Return the running job's id so a reopened UI can re-attach."""
    job_id = metadata_repair_service.get_active_job_id()
    job = get_bulk_job_service().get_job(job_id) if job_id else None
    active = bool(job is not None and job["status"] not in TERMINAL_STATUSES)
    return {"active": active, "job_id": job_id if active else None, "job": job}
