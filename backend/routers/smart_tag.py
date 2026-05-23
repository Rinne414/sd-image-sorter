"""FastAPI router for the Smart Tag wizard.

Endpoints:
    POST /api/smart-tag/start      - validate input, queue a worker thread, return job snapshot
    GET  /api/smart-tag/progress   - poll the active or named job
    POST /api/smart-tag/cancel     - request cancellation of the active job

The router is intentionally thin - the heavy lifting lives in
``services/smart_tag_service.py``. That separation matches the rest of
the codebase (router validates / serializes, service does work).
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, ConfigDict

from services.smart_tag_service import (
    cancel_active_job,
    get_active_job,
    get_job,
    start_smart_tag_job,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/smart-tag", tags=["smart-tag"])


class SmartTagStartRequest(BaseModel):
    """Body for POST /api/smart-tag/start.

    image_ids is required; everything else has a sensible default that
    matches LoraHub's "Style LoRA, replace, auto-strip noise" preset.
    """
    model_config = ConfigDict(extra="ignore")

    image_ids: List[int] = Field(..., min_length=1, max_length=50_000)
    training_purpose: str = "general"
    trigger_word: str = ""
    merge_strategy: str = "replace"
    auto_strip_noise: bool = True
    skip_existing: bool = True
    enable_wd14: bool = True
    enable_vlm: bool = True
    tagger_model: str = ""
    use_gpu: bool = True
    general_threshold: float = 0.35
    character_threshold: float = 0.85


@router.post("/start")
def start(request: SmartTagStartRequest) -> Dict[str, Any]:
    payload = request.model_dump()
    try:
        snapshot = start_smart_tag_job(payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        # An active job already exists. 409 conflict is the right code so
        # the frontend can show "another run is in progress" without
        # treating it as a server error.
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        logger.exception("smart-tag start failed")
        raise HTTPException(status_code=500, detail=f"smart-tag start failed: {exc}") from exc
    return snapshot


@router.get("/progress")
def progress(job_id: Optional[str] = None) -> Dict[str, Any]:
    """Return the snapshot for either ``job_id`` or the active job.

    If neither matches we return ``{"status": "idle"}`` so the frontend
    can treat the response as the canonical "no run is active" signal
    without a 404 round-trip.
    """
    job = get_job(job_id) if job_id else get_active_job()
    if job is None:
        return {"status": "idle", "active": False}
    snapshot = job.snapshot()
    snapshot["active"] = job.status in ("queued", "running")
    return snapshot


@router.post("/cancel")
def cancel() -> Dict[str, Any]:
    job = cancel_active_job()
    if job is None:
        raise HTTPException(status_code=404, detail="No active Smart Tag job to cancel.")
    return {"job_id": job.job_id, "status": job.status, "cancel_requested": True}
