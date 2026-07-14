"""Smart Tag job-state record + per-job bookkeeping helpers.

Owns SmartTagJobState (the polled progress snapshot) and the small
job-counter helpers (_record_job_error / _completion_message /
_fail_missing_source). The job REGISTRY (_jobs / _active_job_id /
_jobs_lock) deliberately lives in pipeline.py instead: the functions that
rebind those globals via `global` statements must share one namespace.

Split verbatim out of services/smart_tag_service.py.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


SMART_TAG_MAX_ERRORS = 50
SMART_TAG_RECENT_RESULT_LIMIT = 25


# ---------------------------------------------------------------------------
# Job tracking (synchronous worker thread, polled progress)
# ---------------------------------------------------------------------------


@dataclass
class SmartTagJobState:
    """Minimal job-state record for a single Smart Tag run.

    The shape mirrors the existing TaggingService progress payload
    (status / current / total / message / errors) so the frontend can
    reuse the same progress-rendering helpers.
    """
    job_id: str
    status: str = "queued"  # queued | running | completed | warning | failed | cancelled
    stage: str = ""  # "" | "tagging" | "vlm" (legacy single-pass leaves this blank)
    total: int = 0
    processed: int = 0
    succeeded: int = 0
    failed: int = 0
    # skip_existing: DB-backed images dropped because they were already
    # tagged (images.tagged_at set). Counted into ``processed`` so N/M
    # progress still completes; surfaced separately for the UI.
    skipped: int = 0
    message: str = ""
    started_at: float = field(default_factory=time.time)
    finished_at: Optional[float] = None
    cancel_requested: bool = False
    last_caption_preview: str = ""
    errors: List[Dict[str, str]] = field(default_factory=list)
    caption_result_count: int = 0
    recent_caption_results: List[Dict[str, str]] = field(default_factory=list)
    caption_results_path: Optional[str] = None
    _caption_results_handle: Any = field(default=None, repr=False, compare=False)
    settings: Dict[str, Any] = field(default_factory=dict)
    # Fix M2: how many tags the auto-strip filter has removed across all
    # processed images. Surfaced in the snapshot so the UI can show
    # "Auto-stripped N noise tags" feedback for the active job.
    noise_stripped_count: int = 0
    # Fix M1: per-phase completion (0.0-1.0). Lets the frontend render one
    # smooth bar across the tagging->vlm transition instead of snapping
    # back to 0% when the next phase begins. ``total``/``processed`` keep
    # image-count semantics so "Cancelled at N/M" stays meaningful.
    phase_completion: float = 0.0

    def snapshot(self) -> Dict[str, Any]:
        return {
            "job_id": self.job_id,
            "status": self.status,
            "stage": self.stage,
            "total": self.total,
            "processed": self.processed,
            "succeeded": self.succeeded,
            "failed": self.failed,
            "skipped": self.skipped,
            "message": self.message,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "last_caption_preview": self.last_caption_preview,
            "errors": list(self.errors[-25:]),  # tail-cap so payload stays small
            "caption_result_count": self.caption_result_count,
            "recent_caption_results": list(self.recent_caption_results[-SMART_TAG_RECENT_RESULT_LIMIT:]),
            "settings": dict(self.settings),
            "noise_stripped_count": self.noise_stripped_count,
            "phase_completion": float(self.phase_completion),
        }


def _record_job_error(job: SmartTagJobState, source_key: str, message: str) -> None:
    job.errors.append({"image_id": str(source_key), "error": message})
    if len(job.errors) > SMART_TAG_MAX_ERRORS:
        del job.errors[:-SMART_TAG_MAX_ERRORS]


def _completion_message(job: SmartTagJobState) -> str:
    """Terminal success message, mentioning skip_existing drops when any."""
    message = f"Done. {job.succeeded} ok, {job.failed} failed."
    if job.skipped:
        message = (
            f"Done. {job.succeeded} ok, {job.failed} failed, "
            f"{job.skipped} skipped (already tagged)."
        )
    return message


def _fail_missing_source(job: SmartTagJobState, source_key: str) -> None:
    """Record a source whose file path could not be resolved as a failure."""
    job.failed += 1
    _record_job_error(job, str(source_key), "Image path not found")
    job.processed += 1
    if job.total > 0:
        job.phase_completion = min(1.0, job.processed / job.total)
