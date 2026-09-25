"""Binary uploads into a batch: the censored copy as a file (multipart).

Kept apart from routers/batches.py so the JSON routes stay as they are. The
form is read here with a larger limit for the ``item_state`` text part (the
editor's ops can carry detection masks); the picture part is a file, which
Starlette spools to disk whatever its size.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile

import db_batches as batch_db
from routers.batches import _raise_http_error
from services.batch_censored_upload import save_censored_upload

router = APIRouter(prefix="/api/batches", tags=["batches"])

# item_state is JSON text; masks of a very large picture can make it long.
MAX_STATE_BYTES = 64 * 1024 * 1024


async def _text_part(part: Any) -> str | None:
    if part is None:
        return None
    if isinstance(part, str):
        return part
    return (await part.read()).decode("utf-8")


@router.put(
    "/{batch_id}/items/{image_id}/censored/file",
    summary="Save an item's censored copy from an uploaded file",
)
async def put_batch_item_censored_file(
    batch_id: int, image_id: int, request: Request
) -> dict[str, Any]:
    """Multipart: ``file`` = the PNG or lossless WebP bytes; optional ``item_state`` = JSON text (object or null)."""
    form = await request.form(max_part_size=MAX_STATE_BYTES)
    upload = form.get("file")
    if not isinstance(upload, UploadFile):
        raise HTTPException(
            status_code=400, detail="A 'file' part with the picture is required"
        )
    data = await upload.read()
    try:
        item_state = await _text_part(form.get("item_state"))
    except UnicodeDecodeError as exc:
        raise HTTPException(
            status_code=400, detail="item_state is not UTF-8 text"
        ) from exc
    try:
        return await run_in_threadpool(
            save_censored_upload, batch_id, image_id, data, item_state
        )
    except batch_db.BatchError as error:
        _raise_http_error(error)
