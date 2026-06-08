"""Unified backend boundary for AI tagging entry points.

The regular Gallery AI Tag job and Dataset Smart Tag job still keep their
specialized execution adapters, but public route starts/cancels/progress now go
through this coordinator so the app cannot run two heavyweight tagging jobs at
the same time.
"""

from __future__ import annotations

from typing import Any, Dict, Optional, TYPE_CHECKING

from fastapi import HTTPException

from services import smart_tag_service
from services.service_provider import ServiceProvider

if TYPE_CHECKING:  # pragma: no cover - imported for type checkers only
    from services.tagging_service import TagRequest, TaggingService


PIPELINE_OWNER = "unified-tagging"
LEGACY_ACTIVE_STATUSES = {"running", "cancelling"}
SMART_ACTIVE_STATUSES = {"queued", "running"}


def _with_owner(payload: Dict[str, Any], mode: str) -> Dict[str, Any]:
    out = dict(payload or {})
    out["pipeline_owner"] = PIPELINE_OWNER
    out["pipeline_mode"] = mode
    return out


def _legacy_status(legacy_service: "TaggingService") -> str:
    try:
        return str((legacy_service.get_progress() or {}).get("status") or "idle").lower()
    except Exception:
        return "idle"


def _active_smart_job():
    try:
        job = smart_tag_service.get_active_job()
    except Exception:
        return None
    if job is None:
        return None
    status = str(getattr(job, "status", "") or "").lower()
    return job if status in SMART_ACTIVE_STATUSES else None


class TaggingPipelineService:
    """Coordinator shared by `/api/tag/*` and `/api/smart-tag/*`."""

    def start_gallery_tagging(
        self,
        request: "TagRequest",
        background_tasks: Any,
        *,
        legacy_service: "TaggingService",
    ) -> Dict[str, Any]:
        active_smart = _active_smart_job()
        if active_smart is not None:
            job_id = str(getattr(active_smart, "job_id", "") or "").strip()
            suffix = f" ({job_id})" if job_id else ""
            raise HTTPException(
                status_code=409,
                detail=f"Smart Tag is already running{suffix}. Stop it before starting AI Tag.",
            )
        return _with_owner(
            legacy_service.start_tagging(request, background_tasks),
            "gallery-tag",
        )

    def get_gallery_progress(self, *, legacy_service: "TaggingService") -> Dict[str, Any]:
        return _with_owner(legacy_service.get_progress(), "gallery-tag")

    def cancel_gallery_tagging(self, *, legacy_service: "TaggingService") -> Dict[str, Any]:
        return _with_owner(legacy_service.cancel_tagging(), "gallery-tag")

    def start_smart_tagging(
        self,
        payload: Dict[str, Any],
        *,
        legacy_service: Optional["TaggingService"] = None,
    ) -> Dict[str, Any]:
        if legacy_service is not None and _legacy_status(legacy_service) in LEGACY_ACTIVE_STATUSES:
            raise RuntimeError("AI Tag is already running. Cancel it before starting Smart Tag.")
        return _with_owner(smart_tag_service.start_smart_tag_job(payload), "smart-tag")

    def get_smart_tag_progress(self, job_id: Optional[str] = None) -> Dict[str, Any]:
        job = smart_tag_service.get_job(job_id) if job_id else smart_tag_service.get_active_job()
        if job is None:
            return _with_owner({"status": "idle", "active": False}, "smart-tag")
        snapshot = job.snapshot()
        snapshot["active"] = job.status in SMART_ACTIVE_STATUSES
        return _with_owner(snapshot, "smart-tag")

    def cancel_smart_tagging(self) -> Dict[str, Any]:
        job = smart_tag_service.cancel_active_job()
        if job is None:
            raise HTTPException(status_code=404, detail="No active Smart Tag job to cancel.")
        return _with_owner(
            {"job_id": job.job_id, "status": job.status, "cancel_requested": True},
            "smart-tag",
        )


_tagging_pipeline_provider = ServiceProvider(TaggingPipelineService)


def get_tagging_pipeline_service() -> TaggingPipelineService:
    return _tagging_pipeline_provider.get()


def set_tagging_pipeline_service(service: Optional[TaggingPipelineService]) -> None:
    _tagging_pipeline_provider.set(service)
