"""Color analysis API router (v3.2.1).

Provides endpoints to:
- Run batch color analysis on images missing color data (lazy backfill)
- Get color analysis status
- Get color statistics for the library
"""
from __future__ import annotations

import asyncio
import logging
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import database as db
from color_analyzer import analyze_image_colors
from utils.source_paths import resolve_existing_indexed_image_path

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/colors", tags=["colors"])


_state_lock = threading.Lock()
_state: Dict[str, Any] = {
    "running": False,
    "cancel_requested": False,
    "total": 0,
    "completed": 0,
    "failed": 0,
    "current_image": "",
}


class AnalyzeRequest(BaseModel):
    image_ids: Optional[List[int]] = None  # None = all images missing data
    selection_token: Optional[str] = None  # v3.2.1: alternative to image_ids for filtered selections
    limit: int = Field(default=5000, ge=1, le=50000)  # Cap to prevent runaway analysis


def _resolve_image_path(image: Dict[str, Any]) -> str:
    image_path = str((image or {}).get("path") or "")
    resolved_path = resolve_existing_indexed_image_path(image_path, backend_file=__file__)
    if not resolved_path:
        raise HTTPException(404, "Image file not found on disk")
    return resolved_path


# Strong reference to the fire-and-forget analysis task. The event loop only
# keeps weak references, so without this a garbage-collected task would
# silently stop mid-run and leave running=True forever.
_analysis_task: Optional["asyncio.Task"] = None


def _set_analysis_task(task: Optional["asyncio.Task"]) -> None:
    """Retain the analysis task so it cannot be garbage-collected."""
    global _analysis_task
    _analysis_task = task
    if task is not None and hasattr(task, "add_done_callback"):
        task.add_done_callback(_on_analysis_task_done)


def _on_analysis_task_done(task: "asyncio.Task") -> None:
    global _analysis_task
    _analysis_task = None
    exc = None if task.cancelled() else task.exception()
    if exc is None and not task.cancelled():
        return
    if exc is not None:
        logger.error("Color analysis task crashed: %s", exc)
    # The task died before _run_analysis could reset the flag; release it so
    # the next start is not rejected by a ghost run.
    with _state_lock:
        _state["running"] = False
        _state["current_image"] = ""


def _resolve_target_ids(request: AnalyzeRequest) -> List[int]:
    """Resolve the concrete image-id list for a batch run.

    Selection-token expansion snapshots EVERY matching id to a temp file
    before the first chunk yields (ImageService._iter_selection_token_snapshot_chunks),
    so on 80k+ libraries this must run in a worker thread, never on the event
    loop and never while holding _state_lock (it would block all progress polls).
    """
    if request.image_ids is not None:
        return list(request.image_ids)[:request.limit]
    if request.selection_token:
        # v3.2.1: expand selection token into a concrete id list. Keep it
        # capped at `limit` so the cancel + progress UI don't run for
        # hours on huge filtered sets.
        from services.image_service import ImageService
        decoder = ImageService()
        target_ids: List[int] = []
        for chunk in decoder._iter_selection_token_snapshot_chunks(
            request.selection_token, chunk_size=500
        ):
            remaining = request.limit - len(target_ids)
            if remaining <= 0:
                break
            target_ids.extend(chunk[:remaining])
        return target_ids
    missing = db.get_images_missing_color_data(limit=request.limit)
    return [m["id"] for m in missing]


@router.post("/analyze")
async def start_analysis(request: AnalyzeRequest):
    """Start batch color analysis. Returns immediately; poll /progress."""
    with _state_lock:
        if _state["running"]:
            raise HTTPException(409, "Color analysis already in progress")
        # Claim the slot atomically before the (potentially slow) id
        # resolution below so two concurrent starts cannot both pass the
        # check. /progress shows running=True with total=0 while resolving.
        _state.update({
            "running": True,
            "cancel_requested": False,
            "total": 0,
            "completed": 0,
            "failed": 0,
            "current_image": "",
        })

    try:
        target_ids = await asyncio.to_thread(_resolve_target_ids, request)
    except BaseException:
        # Release the claimed slot on any resolution failure (including an
        # HTTPException from a bad selection token).
        with _state_lock:
            _state["running"] = False
        raise

    with _state_lock:
        _state["total"] = len(target_ids)

    _set_analysis_task(asyncio.create_task(_run_analysis(target_ids)))
    return {"status": "started", "total": len(target_ids)}


@router.get("/progress")
async def get_progress():
    with _state_lock:
        return dict(_state)


@router.post("/cancel")
async def cancel_analysis():
    with _state_lock:
        if not _state["running"]:
            raise HTTPException(400, "No analysis in progress")
        _state["cancel_requested"] = True
    return {"status": "cancel_requested"}


@router.get("/missing-count")
async def missing_count():
    """How many images still need color analysis; also includes total readable count."""
    return {
        "missing": db.count_images_missing_color_data(),
        "total": db.count_all_image_ids(),
    }


@router.post("/analyze-single/{image_id}")
def analyze_single(image_id: int):
    """Analyze a single image immediately (synchronous)."""
    image = db.get_image_by_id(image_id)
    if not image:
        raise HTTPException(404, "Image not found")

    image_path = _resolve_image_path(image)

    color_data = analyze_image_colors(image_path)
    if not color_data:
        raise HTTPException(500, "Color analysis failed")

    db.update_image_colors(image_id, color_data)
    return {"status": "ok", "color_data": color_data}


async def _run_analysis(image_ids: List[int]) -> None:
    """Run color analysis in a thread pool to avoid blocking event loop."""
    loop = asyncio.get_running_loop()

    for image_id in image_ids:
        with _state_lock:
            if _state["cancel_requested"]:
                break

        try:
            image = db.get_image_by_id(image_id)
            if not image:
                with _state_lock:
                    _state["failed"] += 1
                continue

            image_path = str(image.get("path") or "")
            with _state_lock:
                _state["current_image"] = Path(image_path).name if image_path else ""

            resolved_image_path = resolve_existing_indexed_image_path(image_path, backend_file=__file__)
            if not resolved_image_path:
                with _state_lock:
                    _state["failed"] += 1
                continue

            # Run analysis in thread pool (CPU-bound)
            color_data = await loop.run_in_executor(None, analyze_image_colors, resolved_image_path)

            if color_data:
                # DB write is fast, can run in main thread
                db.update_image_colors(image_id, color_data)
                with _state_lock:
                    _state["completed"] += 1
            else:
                with _state_lock:
                    _state["failed"] += 1

        except Exception as e:
            logger.warning(f"Color analysis failed for image {image_id}: {e}")
            with _state_lock:
                _state["failed"] += 1

    with _state_lock:
        _state["running"] = False
        _state["current_image"] = ""
