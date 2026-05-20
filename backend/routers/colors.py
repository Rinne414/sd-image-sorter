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
    limit: int = Field(default=5000, ge=1, le=50000)  # Cap to prevent runaway analysis


def _resolve_image_path(image: Dict[str, Any]) -> str:
    image_path = str((image or {}).get("path") or "")
    resolved_path = resolve_existing_indexed_image_path(image_path, backend_file=__file__)
    if not resolved_path:
        raise HTTPException(404, "Image file not found on disk")
    return resolved_path


@router.post("/analyze")
async def start_analysis(request: AnalyzeRequest):
    """Start batch color analysis. Returns immediately; poll /progress."""
    with _state_lock:
        if _state["running"]:
            raise HTTPException(409, "Color analysis already in progress")

        # Resolve target image list
        if request.image_ids is not None:
            target_ids = list(request.image_ids)[:request.limit]
        else:
            missing = db.get_images_missing_color_data(limit=request.limit)
            target_ids = [m["id"] for m in missing]

        _state.update({
            "running": True,
            "cancel_requested": False,
            "total": len(target_ids),
            "completed": 0,
            "failed": 0,
            "current_image": "",
        })

    asyncio.create_task(_run_analysis(target_ids))
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
async def analyze_single(image_id: int):
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
