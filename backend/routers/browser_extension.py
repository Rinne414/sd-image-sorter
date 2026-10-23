"""Browser extension endpoints.

``/api/ext/*`` is the extension's own lane (``app_security`` lets an
extension origin in here and nowhere else; everything except ping and the
pairing request needs an approved token). ``/api/browser-extension/*`` is for
the program's own page: answer a pairing request, list and revoke paired
browsers, prepare the folders to install from.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile

from app_diagnostics import _open_path_in_file_manager as open_in_file_manager
from app_info import APP_VERSION
from app_security import EXT_TOKEN_HEADER, own_page_rejection, require_own_page
from library_context import get_current_library_id
from services.browser_extension_package import TARGETS, prepare_install_folders
from services.collect_download import DownloadError
from services.collect_importer import collect_stream, collect_url, get_collect_importer
from services.collect_service import CollectError, CollectSource
from services.ext_pairing import PairingError, get_pairing_registry

ext_router = APIRouter(prefix="/api/ext", tags=["browser-extension"])
router = APIRouter(prefix="/api/browser-extension", tags=["browser-extension"])

APP_NAME = "SD Image Sorter"
# Page metadata sent with a picture is a few short strings.
MAX_META_PART_BYTES = 1024 * 1024


class PairRequest(BaseModel):
    token: str = Field(..., min_length=32, max_length=128)
    name: str = Field("", max_length=200)
    browser: str = Field("other", max_length=20)


class CollectUrlRequest(BaseModel):
    image_url: str = Field(..., min_length=1, max_length=8192)
    page_url: Optional[str] = Field(None, max_length=8192)
    page_title: Optional[str] = Field(None, max_length=2000)


class DecideRequest(BaseModel):
    allow: bool


class OpenFolderRequest(BaseModel):
    browser: str = Field(..., max_length=20)


def _token(request: Request) -> Optional[str]:
    return request.headers.get(EXT_TOKEN_HEADER)


def _http_error(exc: CollectError | DownloadError) -> HTTPException:
    return HTTPException(status_code=exc.status_code, detail=exc.message)


# Extension lane ------------------------------------------------------------


@ext_router.post(
    "/ping", summary="Is the program running, and is this extension paired"
)
def ext_ping(request: Request) -> Dict[str, Any]:
    state = get_pairing_registry().state_for(
        _token(request), request.headers.get("origin")
    )
    return {"app": APP_NAME, "version": APP_VERSION, "pairing": state}


@ext_router.post("/pair", summary="Ask the user to pair this extension")
def ext_pair(body: PairRequest, request: Request) -> Dict[str, Any]:
    try:
        pairing = get_pairing_registry().request(
            origin=request.headers.get("origin"),
            name=body.name,
            browser=body.browser,
            token=body.token,
        )
    except PairingError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"id": pairing.id, "state": pairing.state}


@ext_router.post("/pair/status", summary="The user's answer to a pairing request")
def ext_pair_status(request: Request) -> Dict[str, Any]:
    state = get_pairing_registry().state_for(
        _token(request), request.headers.get("origin")
    )
    return {"state": state}


def _meta_from_text(text: Optional[str]) -> Dict[str, Any]:
    try:
        meta = json.loads(text or "{}")
    except ValueError as exc:
        raise HTTPException(
            status_code=400, detail="The picture details are not JSON."
        ) from exc
    return meta if isinstance(meta, dict) else {}


@ext_router.post("/collect", summary="Save a picture the extension downloaded")
async def ext_collect(request: Request) -> Dict[str, Any]:
    """Multipart: ``file`` = the picture bytes (any size); ``meta`` = JSON with
    source_url, page_url, page_title and filename."""
    form = await request.form(max_part_size=MAX_META_PART_BYTES)
    upload = form.get("file")
    if not isinstance(upload, UploadFile):
        raise HTTPException(
            status_code=400, detail="A 'file' part with the picture is required."
        )
    meta_part = form.get("meta")
    meta = _meta_from_text(meta_part if isinstance(meta_part, str) else None)
    source = CollectSource(
        via="extension",
        source_url=meta.get("source_url"),
        page_url=meta.get("page_url"),
        page_title=meta.get("page_title"),
    )
    library_id = get_collect_importer().ui_library()
    try:
        return await run_in_threadpool(
            collect_stream,
            upload.file,
            meta.get("filename") or upload.filename,
            source,
            library_id,
        )
    except (CollectError, DownloadError) as exc:
        raise _http_error(exc) from exc


@ext_router.post(
    "/collect-url", summary="Download a picture by its address and save it"
)
def ext_collect_url(body: CollectUrlRequest) -> Dict[str, Any]:
    """Fallback when the extension could not fetch the picture: the program
    downloads it with the page as Referer (no browser cookies)."""
    source = CollectSource(
        via="extension",
        source_url=body.image_url,
        page_url=body.page_url,
        page_title=body.page_title,
    )
    try:
        return collect_url(
            body.image_url,
            referer=body.page_url,
            source=source,
            library_id=get_collect_importer().ui_library(),
        )
    except (CollectError, DownloadError) as exc:
        raise _http_error(exc) from exc


# The program's own page -------------------------------------------------------


@router.get(
    "/state", summary="Pairing requests waiting for an answer, and collect progress"
)
def extension_state() -> Dict[str, Any]:
    importer = get_collect_importer()
    # The page polls this with its library header: collected pictures from
    # the extension go to the library the user is looking at.
    importer.note_ui_library(get_current_library_id())
    return {"pending": get_pairing_registry().pending(), "collect": importer.status()}


@router.get("/paired", summary="Browsers paired with this program")
def extension_paired() -> Dict[str, Any]:
    return {"paired": get_pairing_registry().paired()}


@router.post("/pairings/{pairing_id}/decide", summary="Allow or deny a pairing request")
def extension_decide(
    pairing_id: str, body: DecideRequest, request: Request
) -> Dict[str, Any]:
    rejection = own_page_rejection(request)
    if rejection:
        raise HTTPException(
            status_code=403, detail="Only this program's own page can pair a browser."
        )
    decided = get_pairing_registry().decide(pairing_id, body.allow)
    if decided is None:
        raise HTTPException(
            status_code=404,
            detail="This request is no longer waiting. Ask again from the extension.",
        )
    return decided


@router.delete("/pairings/{pairing_id}", summary="Revoke a paired browser")
def extension_revoke(pairing_id: str, request: Request) -> Dict[str, Any]:
    require_own_page(request, "revoke a paired browser")
    if not get_pairing_registry().revoke(pairing_id):
        raise HTTPException(status_code=404, detail="This browser is not paired.")
    return {"revoked": pairing_id}


@router.post(
    "/install-folders", summary="Prepare the folders to load the extension from"
)
async def extension_install_folders() -> Dict[str, Any]:
    try:
        return await run_in_threadpool(prepare_install_folders)
    except OSError as exc:
        raise HTTPException(
            status_code=503, detail=f"The extension folders could not be written: {exc}"
        ) from exc


@router.post("/open-folder", summary="Show an extension folder in the file manager")
async def extension_open_folder(body: OpenFolderRequest) -> Dict[str, Any]:
    if body.browser not in TARGETS:
        raise HTTPException(status_code=400, detail="Unknown browser.")
    folders = await run_in_threadpool(prepare_install_folders)
    if not await run_in_threadpool(open_in_file_manager, Path(folders[body.browser])):
        raise HTTPException(
            status_code=501, detail="No file manager is available on this computer."
        )
    return {"status": "ok", "path": folders[body.browser]}
