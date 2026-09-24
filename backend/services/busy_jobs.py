"""What is running right now, so a restart can ask before stopping it.

Best effort by design: every source is read on its own and one that cannot be
read is skipped. The answer only decides whether the user is asked "restart
anyway?"; it never blocks the restart.
"""

from __future__ import annotations

import logging
from typing import Callable, List

from fastapi import HTTPException

_log = logging.getLogger(__name__)

_MOVE_ACTIVE_STATUSES = {"running", "cancelling"}

# Internal job names mapped to the few plain ids the page words for people.
_PLAIN_IDS = {
    "scan": "scan",
    "gallery_tag": "tagging",
    "smart_tag": "tagging",
    "ai_queue": "tagging",
    "ai_dispatch": "tagging",
    "vlm_caption": "captions",
    "aesthetic": "aesthetic",
}
# AI runtime work that one of these already names is not listed twice.
_AI_WORK_IDS = {"tagging", "captions", "aesthetic"}


def _gallery_jobs() -> List[str]:
    """Scan, AI tagging, Gallery route jobs and aesthetic scoring.

    Reuses the Clear Gallery check, which reports running jobs through its 409.
    """
    from routers.sorting import (
        _get_aesthetic_service_for_clear,
        _get_tagging_service_for_clear,
        _require_clear_gallery_jobs_idle,
        get_sorting_service,
        get_tagging_pipeline_service,
    )

    try:
        _require_clear_gallery_jobs_idle(
            get_sorting_service(),
            _get_tagging_service_for_clear(),
            get_tagging_pipeline_service(),
            _get_aesthetic_service_for_clear(),
        )
    except HTTPException as exc:
        detail = exc.detail if isinstance(exc.detail, dict) else {}
        return [
            _PLAIN_IDS.get(str(job), "background_jobs")
            for job in detail.get("jobs") or []
        ]
    return []


def _file_moves() -> List[str]:
    from routers.sorting import get_sorting_service

    service = get_sorting_service()
    moving = (
        service.get_move_progress().get("status") in _MOVE_ACTIVE_STATUSES
        or service.get_batch_move_progress().get("status") in _MOVE_ACTIVE_STATUSES
    )
    return ["file_moves"] if moving else []


def _ai_runtime_jobs() -> List[str]:
    from ai_runtime_guard import get_ai_jobs_snapshot

    return ["ai"] if get_ai_jobs_snapshot().get("jobs") else []


def _bulk_jobs() -> List[str]:
    from services.bulk_job_service import get_bulk_job_service

    return (
        ["background_jobs"]
        if get_bulk_job_service().list_jobs(active_only=True)
        else []
    )


def _model_setup() -> List[str]:
    # Read through the module: routers.models rebinds _prepare_result.
    import routers.models as models_router
    from services.model_service import get_download_progress

    with models_router._prepare_lock:
        preparing = bool(models_router._prepare_result.get("active"))
    if preparing or get_download_progress().get("active"):
        return ["model_setup"]
    return []


_SOURCES: tuple[Callable[[], List[str]], ...] = (
    _gallery_jobs,
    _file_moves,
    _ai_runtime_jobs,
    _bulk_jobs,
    _model_setup,
)


def collect_busy_jobs() -> List[str]:
    """Plain ids of the jobs running now, without duplicates, in a stable order.

    Ids: scan, tagging, captions, aesthetic, file_moves, background_jobs,
    model_setup, ai.
    """
    jobs: List[str] = []
    for source in _SOURCES:
        try:
            jobs.extend(source())
        except Exception as exc:  # noqa: BLE001 - one unreadable source must not hide the rest
            _log.debug("Busy-job source %s could not be read: %s", source.__name__, exc)
    unique = list(dict.fromkeys(jobs))
    if "ai" in unique and _AI_WORK_IDS.intersection(unique):
        unique.remove("ai")
    return unique
