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

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, ConfigDict

from services.smart_tag_service import (
    get_caption_results_page,
    get_job,
)
from services.tagging_pipeline_service import (
    TaggingPipelineService,
    get_tagging_pipeline_service,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/smart-tag", tags=["smart-tag"])
SMART_TAG_MAX_EXPLICIT_SOURCES = 5_000_000


def get_legacy_tagging_service_for_smart_tag():
    from routers.tags import get_tagging_service

    return get_tagging_service()


class SmartTagStartRequest(BaseModel):
    """Body for POST /api/smart-tag/start.

    image_ids and/or image_paths is required; everything else has a sensible
    default for a LoRA-ready smart caption pass.
    """
    model_config = ConfigDict(extra="ignore")

    image_ids: List[int] = Field(default_factory=list, max_length=SMART_TAG_MAX_EXPLICIT_SOURCES)
    selection_token: Optional[str] = Field(default=None, min_length=1, max_length=16384)
    image_paths: List[str] = Field(default_factory=list, max_length=SMART_TAG_MAX_EXPLICIT_SOURCES)
    dataset_scan_token: Optional[str] = Field(default=None, min_length=1, max_length=128)
    dataset_manifest_token: Optional[str] = Field(default=None, min_length=1, max_length=128)
    dataset_session_token: Optional[str] = Field(default=None, min_length=1, max_length=128)
    scan_token: Optional[str] = Field(default=None, min_length=1, max_length=128)
    session_token: Optional[str] = Field(default=None, min_length=1, max_length=128)
    training_purpose: str = "general"
    trigger_word: str = ""
    merge_strategy: str = "replace"
    auto_strip_noise: bool = True
    skip_existing: bool = True
    enable_wd14: bool = True
    enable_vlm: bool = True
    tagger_model: str = ""
    use_gpu: bool = True
    general_threshold: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    character_threshold: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    copyright_threshold: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    max_tags_per_image: Optional[int] = Field(default=None, ge=0, le=2000)
    natural_language_mode: str = "vlm"
    # v3.2.2 T-power-PR2 (D): multi-tagger consensus.
    taggers: List[Dict[str, Any]] = Field(default_factory=list)
    consensus_min: int = Field(default=2, ge=1, le=10)
    consensus_skip_categories: List[str] = Field(
        default_factory=lambda: ["character", "copyright"]
    )
    # v3.4.3: ToriiGate generation parameters.
    toriigate_caption_length: str = Field(default="detailed", pattern="^(brief|detailed)$")
    toriigate_max_new_tokens: int = Field(default=0, ge=0, le=1024)
    toriigate_grounding: bool = True


@router.post("/start")
def start(
    request: SmartTagStartRequest,
    pipeline: TaggingPipelineService = Depends(get_tagging_pipeline_service),
    legacy_service: Any = Depends(get_legacy_tagging_service_for_smart_tag),
) -> Dict[str, Any]:
    payload = request.model_dump()
    try:
        snapshot = pipeline.start_smart_tagging(
            payload,
            legacy_service=legacy_service,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        # v3.4.1: a busy AI runtime now QUEUES the job (the snapshot above
        # carries status="queued" + pipeline_queued=true). RuntimeError only
        # remains for the fail-closed path — a sibling job's status was
        # unknowable, so the start was refused. 409 keeps that visible
        # without treating it as a server error.
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        logger.exception("smart-tag start failed")
        raise HTTPException(status_code=500, detail=f"smart-tag start failed: {exc}") from exc
    return snapshot


@router.get("/progress")
def progress(
    job_id: Optional[str] = None,
    pipeline: TaggingPipelineService = Depends(get_tagging_pipeline_service),
) -> Dict[str, Any]:
    """Return the snapshot for either ``job_id`` or the active job.

    If neither matches we return ``{"status": "idle"}`` so the frontend
    can treat the response as the canonical "no run is active" signal
    without a 404 round-trip.
    """
    return pipeline.get_smart_tag_progress(job_id)


@router.get("/results")
def results(
    job_id: str,
    offset: int = 0,
    limit: int = 1000,
) -> Dict[str, Any]:
    """Return path-source caption results for a completed Smart Tag job."""
    job = get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Smart Tag job not found.")
    return get_caption_results_page(job, offset=offset, limit=limit)


@router.post("/cancel")
def cancel(
    pipeline: TaggingPipelineService = Depends(get_tagging_pipeline_service),
) -> Dict[str, Any]:
    return pipeline.cancel_smart_tagging()
