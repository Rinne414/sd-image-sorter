"""Unified backend boundary for AI tagging entry points.

The regular Gallery AI Tag job, the Dataset Smart Tag job, and the VLM
caption batch keep their specialized execution adapters, but public route
starts/cancels/progress now go through this coordinator so the app cannot
run two heavyweight tagging jobs at the same time.
"""

from __future__ import annotations

import logging
import threading
from typing import Any, Callable, Dict, Optional, TYPE_CHECKING

from fastapi import HTTPException

from services import smart_tag_service
from services.service_provider import ServiceProvider

if TYPE_CHECKING:  # pragma: no cover - imported for type checkers only
    from services.tagging_service import TagRequest, TaggingService


logger = logging.getLogger(__name__)

PIPELINE_OWNER = "unified-tagging"
LEGACY_ACTIVE_STATUSES = {"running", "cancelling"}
SMART_ACTIVE_STATUSES = {"queued", "running"}

# Held across every check+start path (gallery AI Tag / Smart Tag / VLM
# caption batch). Each underlying service keeps its own state lock, but those
# are independent, so without one shared start lock two simultaneous starts
# could each pass their cross-service checks (TOCTOU) and double-load
# multi-GB models onto the GPU.
_start_lock = threading.Lock()


def _with_owner(payload: Dict[str, Any], mode: str) -> Dict[str, Any]:
    out = dict(payload or {})
    out["pipeline_owner"] = PIPELINE_OWNER
    out["pipeline_mode"] = mode
    return out


def _legacy_busy_reason(legacy_service: Optional["TaggingService"], *, target: str) -> Optional[str]:
    """Return a conflict message if the gallery AI Tag job blocks ``target``.

    If the status probe itself fails we refuse the start (treat as busy):
    silently assuming "idle" could double-start two GPU tagging jobs.
    """
    if legacy_service is None:
        return None
    try:
        status = str((legacy_service.get_progress() or {}).get("status") or "idle").lower()
    except Exception:
        logger.exception("Could not determine AI Tag status; refusing to start %s", target)
        return (
            f"Could not determine AI Tag status, so {target} was not started "
            "to avoid running two tagging jobs at once. "
            "无法确认 AI 打标状态，已拒绝启动以避免同时运行两个打标任务。"
        )
    if status in LEGACY_ACTIVE_STATUSES:
        return f"AI Tag is already running. Cancel it before starting {target}."
    return None


def _active_smart_job():
    try:
        job = smart_tag_service.get_active_job()
    except Exception:
        return None
    if job is None:
        return None
    status = str(getattr(job, "status", "") or "").lower()
    return job if status in SMART_ACTIVE_STATUSES else None


def _smart_busy_detail(target: str) -> Optional[str]:
    """Return a conflict message if an active Smart Tag job blocks ``target``."""
    active_smart = _active_smart_job()
    if active_smart is None:
        return None
    job_id = str(getattr(active_smart, "job_id", "") or "").strip()
    suffix = f" ({job_id})" if job_id else ""
    return f"Smart Tag is already running{suffix}. Stop it before starting {target}."


def _vlm_batch_busy_reason() -> Optional[str]:
    """Return a conflict message if a running VLM caption batch blocks a start.

    Queries the vlm router through its narrow ``is_caption_batch_active``
    accessor instead of reaching into router internals. A failed probe
    refuses the start (same safe direction as ``_legacy_busy_reason``).
    """
    try:
        from routers.vlm import is_caption_batch_active

        active = bool(is_caption_batch_active())
    except Exception:
        logger.exception("Could not determine VLM caption batch status; refusing to start")
        return (
            "Could not determine VLM captioning status, so the job was not "
            "started to avoid running two tagging jobs at once. "
            "无法确认 VLM 批量打标状态，已拒绝启动以避免同时运行两个打标任务。"
        )
    if active:
        return (
            "VLM captioning is already running. Stop it before starting "
            "another tagging job. VLM 批量打标正在运行，请先停止后再开始其他打标任务。"
        )
    return None


class TaggingPipelineService:
    """Coordinator shared by `/api/tag/*`, `/api/smart-tag/*`, and `/api/vlm/caption-batch`."""

    def start_gallery_tagging(
        self,
        request: "TagRequest",
        background_tasks: Any,
        *,
        legacy_service: "TaggingService",
    ) -> Dict[str, Any]:
        with _start_lock:
            smart_detail = _smart_busy_detail("AI Tag")
            if smart_detail is not None:
                raise HTTPException(status_code=409, detail=smart_detail)
            vlm_reason = _vlm_batch_busy_reason()
            if vlm_reason is not None:
                raise HTTPException(status_code=409, detail=vlm_reason)
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
        with _start_lock:
            legacy_reason = _legacy_busy_reason(legacy_service, target="Smart Tag")
            if legacy_reason is not None:
                raise RuntimeError(legacy_reason)
            vlm_reason = _vlm_batch_busy_reason()
            if vlm_reason is not None:
                raise RuntimeError(vlm_reason)
            return _with_owner(smart_tag_service.start_smart_tag_job(payload), "smart-tag")

    def claim_vlm_caption_batch(
        self,
        claim: Callable[[], None],
        *,
        legacy_service: Optional["TaggingService"] = None,
    ) -> None:
        """Atomically check the other job kinds and claim the VLM batch slot.

        ``claim`` is the vlm router's own check-and-set: it raises
        HTTPException(409) if a caption batch is already running and
        otherwise marks the batch state as running. Running it under the
        shared start lock means a Smart Tag or AI Tag start can never
        interleave between these checks and the claim.
        """
        with _start_lock:
            smart_detail = _smart_busy_detail("VLM captioning")
            if smart_detail is not None:
                raise HTTPException(
                    status_code=409,
                    detail=f"{smart_detail} Smart Tag 正在运行，请先停止后再开始 VLM 批量打标。",
                )
            legacy_reason = _legacy_busy_reason(legacy_service, target="VLM captioning")
            if legacy_reason is not None:
                raise HTTPException(status_code=409, detail=legacy_reason)
            claim()

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
