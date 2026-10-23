"""Collect pictures from inside the program: paste a picture, paste a picture
address, and read where a collected picture came from."""

from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, HTTPException, Path as FastAPIPath, Request
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile

from db_collected_sources import get_collected_source
from app_security import require_own_page
from library_context import get_current_library_id
from services.collect_download import DownloadError, site_root
from services.collect_importer import collect_stream, collect_url
from services.collect_service import CollectError, CollectSource

router = APIRouter(prefix="/api/collect", tags=["collect"])


class PasteUrlRequest(BaseModel):
    url: str = Field(..., min_length=1, max_length=8192)


def _http_error(exc: CollectError | DownloadError) -> HTTPException:
    return HTTPException(status_code=exc.status_code, detail=exc.detail())


@router.post("/paste", summary="Save a pasted picture into today's collected folder")
async def collect_paste(request: Request) -> Dict[str, Any]:
    """Multipart: ``file`` = the picture from the clipboard (any size)."""
    require_own_page(request, "save a pasted picture")
    form = await request.form()
    upload = form.get("file")
    if not isinstance(upload, UploadFile):
        raise HTTPException(
            status_code=400,
            detail={
                "code": "collect_no_file",
                "message": "A 'file' part with the picture is required.",
            },
        )
    try:
        return await run_in_threadpool(
            collect_stream,
            upload.file,
            upload.filename or "pasted",
            CollectSource(via="paste"),
            get_current_library_id(),
        )
    except (CollectError, DownloadError) as exc:
        raise _http_error(exc) from exc


@router.post("/url", summary="Download a picture from a pasted address and save it")
def collect_pasted_url(body: PasteUrlRequest, request: Request) -> Dict[str, Any]:
    require_own_page(request, "download a picture by its address")
    try:
        return collect_url(
            body.url,
            referer=site_root(body.url),
            source=CollectSource(via="url", source_url=body.url),
            library_id=get_current_library_id(),
        )
    except (CollectError, DownloadError) as exc:
        raise _http_error(exc) from exc


@router.get("/source/{image_id}", summary="Where a collected picture came from")
def collected_source(
    image_id: int = FastAPIPath(..., ge=1, le=2_147_483_647),
) -> Dict[str, Any]:
    """``source`` is null for a picture that was not collected."""
    return {"source": get_collected_source(image_id)}
