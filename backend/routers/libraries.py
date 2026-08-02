"""Long-lived multi-library (workspace) API."""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

import db_libraries as libdb
from library_context import MAIN_LIBRARY_ID, get_current_library_id

router = APIRouter(prefix="/api/libraries", tags=["libraries"])


class CreateLibraryBody(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class RenameLibraryBody(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class MoveImagesBody(BaseModel):
    image_ids: List[int] = Field(default_factory=list, max_length=5000)
    target_library_id: str = Field(min_length=1, max_length=64)


class ClaimPathsBody(BaseModel):
    paths: List[str] = Field(default_factory=list, max_length=500)
    target_library_id: Optional[str] = Field(default=None, max_length=64)


@router.get("")
def list_libraries() -> Dict[str, Any]:
    libdb.ensure_default_library()
    items = libdb.list_libraries()
    current = libdb.resolve_active_library_id(get_current_library_id())
    return {"libraries": items, "current_id": current}


@router.get("/current")
def get_current_library() -> Dict[str, Any]:
    libdb.ensure_default_library()
    current_id = libdb.resolve_active_library_id(get_current_library_id())
    lib = libdb.get_library(current_id)
    if lib is None:
        lib = libdb.get_library(MAIN_LIBRARY_ID)
    return {"library": lib, "current_id": current_id}


@router.post("")
def create_library(body: CreateLibraryBody) -> Dict[str, Any]:
    lib = libdb.create_library(body.name)
    return {"library": lib}


@router.post("/move-images")
def move_images(body: MoveImagesBody) -> Dict[str, Any]:
    """Reassign image rows to another library (path ownership moves, files stay)."""
    libdb.ensure_default_library()
    target = libdb.resolve_active_library_id(body.target_library_id)
    if libdb.get_library(target) is None:
        raise HTTPException(status_code=404, detail={"code": "library_not_found"})
    result = libdb.move_images_to_library(body.image_ids, target)
    return {"status": "ok", **result}


@router.post("/claim-paths")
def claim_paths(body: ClaimPathsBody) -> Dict[str, Any]:
    """Claim indexed paths into the target library (default: current)."""
    libdb.ensure_default_library()
    target = body.target_library_id or get_current_library_id()
    target = libdb.resolve_active_library_id(target)
    if libdb.get_library(target) is None:
        raise HTTPException(status_code=404, detail={"code": "library_not_found"})
    result = libdb.claim_paths_to_library(body.paths, target)
    return {"status": "ok", **result}


@router.get("/{library_id}/export")
def export_library(library_id: str, download: bool = True) -> Any:
    """Export index JSON for one library (paths + light metadata; files not copied)."""
    try:
        payload = libdb.export_library_index(library_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={"code": "library_not_found"}) from exc
    if not download:
        return payload
    body = json.dumps(payload, ensure_ascii=False, indent=2)
    safe_name = "".join(
        ch if ch.isalnum() or ch in ("-", "_") else "_"
        for ch in str(payload.get("library", {}).get("name") or library_id)
    )[:40] or "library"
    filename = f"library-export-{safe_name}.json"
    return Response(
        content=body.encode("utf-8"),
        media_type="application/json; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
        },
    )


@router.patch("/{library_id}")
def rename_library(library_id: str, body: RenameLibraryBody) -> Dict[str, Any]:
    try:
        lib = libdb.rename_library(library_id, body.name)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={"code": "library_not_found"}) from exc
    return {"library": lib}


@router.delete("/{library_id}")
def delete_library(library_id: str) -> Dict[str, Any]:
    try:
        result = libdb.delete_library(library_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={"code": "library_not_found"}) from exc
    except PermissionError as exc:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "default_library_protected",
                "message": "The main library cannot be deleted. Clear it instead.",
            },
        ) from exc
    return {"status": "ok", **result}
