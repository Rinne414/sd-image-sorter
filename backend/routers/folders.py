"""Folders of the library: ``POST /api/folders/rename``.

The work is ``services/folder_rename.py``. Refused while a scan or a move is
running, because both read and write the paths this changes.
"""

from __future__ import annotations

import logging
from typing import Any, Dict

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from services import folder_rename
from services.sorting_models import SCAN_ACTIVE_STATUSES
from utils.path_validation import normalize_user_path, validate_folder_path

logger = logging.getLogger("sd-image-sorter")
router = APIRouter(prefix="/api/folders", tags=["folders"])

_BUSY_STATUSES = {"running", "cancelling"}
_REFUSAL_STATUS = {"folder_missing": 404, "name_taken": 409, "in_use": 409}


class RenameFolderRequest(BaseModel):
    path: str = Field(
        ..., min_length=1, max_length=4096, description="The folder to rename"
    )
    new_name: str = Field(
        ...,
        min_length=1,
        max_length=255,
        description="Its new name (a name, not a path)",
    )


def _busy_reason() -> str:
    """What is running that a rename must wait for, or an empty string."""
    from routers.sorting import get_sorting_service

    service = get_sorting_service()
    if (
        service.get_scan_progress().get("status") in SCAN_ACTIVE_STATUSES
        or service.is_scan_worker_active()
    ):
        return "A scan is running. Rename the folder when it has finished."
    if service.get_move_progress().get("status") in _BUSY_STATUSES:
        return "A move is running. Rename the folder when it has finished."
    if service.get_batch_move_progress().get("status") in _BUSY_STATUSES:
        return "A move is running. Rename the folder when it has finished."
    return ""


@router.post("/rename", summary="Rename a folder and keep its pictures in the library")
def rename(request: RenameFolderRequest) -> Dict[str, Any]:
    """Rename the folder on disk; every picture in it (at any depth) keeps its tags, rating and place in sets."""
    folder = normalize_user_path(request.path)
    ok, problem = validate_folder_path(folder)
    if not ok:
        raise HTTPException(
            status_code=400, detail=problem or "The folder cannot be used."
        )
    busy = _busy_reason()
    if busy:
        raise HTTPException(status_code=409, detail={"code": "busy", "message": busy})
    try:
        result = folder_rename.rename_folder(folder, request.new_name)
    except folder_rename.FolderRenameError as exc:
        raise HTTPException(
            status_code=_REFUSAL_STATUS.get(exc.code, 400),
            detail={"code": exc.code, "message": str(exc)},
        ) from exc
    if result["roots"]:
        # A watched root moved with the folder: the watcher follows the new path.
        from services.folder_watch import get_folder_watch_service

        get_folder_watch_service().reload()
    logger.info(
        "Renamed a library folder: %d pictures, %d roots repointed",
        result["pictures"],
        result["roots"],
    )
    return result
