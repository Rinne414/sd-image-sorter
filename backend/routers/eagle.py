"""Bring an Eagle library in: look first, then import in the background.

``POST /api/eagle/preview`` reads the library and says what would come over.
``POST /api/eagle/import`` starts the import; ``GET /api/eagle/import`` reports
how far it is and, at the end, what it did. One import runs at a time.

The reading is ``services/eagle_library.py``, the writing
``services/eagle_import.py``. The pictures are indexed where Eagle keeps them.
"""

from __future__ import annotations

import logging
import threading
from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from library_context import (
    get_current_library_id,
    reset_current_library_id,
    set_current_library_id,
)
from services import eagle_import, eagle_library
from utils.path_validation import normalize_user_path, validate_folder_path

logger = logging.getLogger("sd-image-sorter")
router = APIRouter(prefix="/api/eagle", tags=["eagle"])

_lock = threading.Lock()
_state: Dict[str, Any] = {"status": "idle"}


class EagleRequest(BaseModel):
    path: str = Field(
        ...,
        min_length=1,
        max_length=4096,
        description="The Eagle library folder (<Name>.library)",
    )


def _checked_folder(raw: str) -> str:
    folder = normalize_user_path(raw)
    ok, problem = validate_folder_path(folder)
    if not ok:
        raise HTTPException(
            status_code=400, detail=problem or "The folder cannot be used."
        )
    return folder


@router.post("/preview", summary="What an Eagle library holds")
def preview(request: EagleRequest) -> Dict[str, Any]:
    """Counts of items, tags, stars, notes and folders, and what would be passed over."""
    folder = _checked_folder(request.path)
    try:
        return eagle_library.summarize(folder)
    except eagle_library.NotAnEagleLibraryError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _run(folder: str, library_id: str) -> None:
    token = set_current_library_id(library_id)
    try:

        def progress(step: str, current: int, total: int) -> None:
            with _lock:
                _state.update(step=step, current=current, total=total)

        result = eagle_import.run_import(folder, progress=progress)
        with _lock:
            _state.update(status="done", result=result)
    except Exception as exc:  # the job's own boundary: report it, never lose it
        logger.exception("Eagle import failed")
        with _lock:
            _state.update(status="error", error=str(exc))
    finally:
        reset_current_library_id(token)


@router.post("/import", summary="Start bringing an Eagle library in")
def start_import(request: EagleRequest) -> Dict[str, Any]:
    """Index the pictures in place and bring stars, notes, tags, folders and sources over."""
    folder = _checked_folder(request.path)
    try:
        root = str(eagle_library.resolve_library_root(folder))
    except eagle_library.NotAnEagleLibraryError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    with _lock:
        if _state.get("status") == "running":
            raise HTTPException(
                status_code=409, detail="An Eagle import is already running."
            )
        _state.clear()
        _state.update(status="running", library=root, step="index", current=0, total=0)
    threading.Thread(
        target=_run,
        args=(root, get_current_library_id()),
        name="eagle-import",
        daemon=True,
    ).start()
    return current_import()


@router.get("/import", summary="How far the Eagle import is")
def current_import() -> Dict[str, Any]:
    """``status`` is idle, running, done (with ``result``) or error (with ``error``)."""
    with _lock:
        return dict(_state)


def reset_for_tests(state: Optional[Dict[str, Any]] = None) -> None:
    with _lock:
        _state.clear()
        _state.update(state or {"status": "idle"})
