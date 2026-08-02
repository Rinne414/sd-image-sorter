"""Long-lived multi-library (workspace) API."""

from __future__ import annotations

from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import db_libraries as libdb
from library_context import MAIN_LIBRARY_ID, get_current_library_id

router = APIRouter(prefix="/api/libraries", tags=["libraries"])


class CreateLibraryBody(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class RenameLibraryBody(BaseModel):
    name: str = Field(min_length=1, max_length=80)


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
