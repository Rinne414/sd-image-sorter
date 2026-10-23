"""Folder watching endpoints: turn watching on per library root, read its status."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import database as db
from services.folder_watch import get_folder_watch_service

router = APIRouter(prefix="/api", tags=["folder-watch"])


class RootWatchRequest(BaseModel):
    watch: bool


class WatchPauseRequest(BaseModel):
    paused: bool


@router.patch(
    "/library-roots/{root_id}/watch",
    summary="Watch a library root",
    description=(
        "Turn folder watching on or off for one library root. While on, new or "
        "changed pictures under the folder are indexed within seconds, and files "
        "written while the app was closed are picked up when it starts."
    ),
)
def set_root_watch(root_id: int, request: RootWatchRequest):
    if db.get_library_root(root_id) is None:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "library_root_not_found",
                "message": "Library folder not found",
            },
        )
    db.set_library_root_watch(root_id, request.watch)
    get_folder_watch_service().reload()
    return db.get_library_root(root_id)


@router.get(
    "/watch/status",
    summary="Folder watching status",
    description=(
        "Per watched folder: mode (native events or polling for network folders), "
        "state (starting, catching_up, watching, missing, error), pictures "
        "imported since start. ``generation`` grows whenever pictures arrive, so "
        "a client can refresh the gallery when it changes."
    ),
)
def watch_status():
    return get_folder_watch_service().status()


@router.post(
    "/watch/pause",
    summary="Pause or resume all folder watching",
    description=(
        "Pause stops watching every folder at once; each folder keeps its own "
        "switch. Resume starts them again and first adds the pictures written "
        "while paused. A pause lasts until resumed or until the program restarts."
    ),
)
def pause_watching(request: WatchPauseRequest):
    service = get_folder_watch_service()
    service.set_paused(request.paused)
    return service.status()
