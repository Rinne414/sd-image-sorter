"""Read a picture on this computer by its location.

For a drop or paste that carried the picture's location instead of the
picture (QQ and other chat apps copy ``<img src="file://...">``): the page
sends the location, gets the picture back and handles it like a dropped file.
"""

from __future__ import annotations

from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from app_security import require_own_page
from services.local_picture import (
    LocalPictureError,
    media_type_of,
    resolve_local_picture,
)

router = APIRouter(prefix="/api", tags=["local-picture"])


class LocalPictureRequest(BaseModel):
    path: str = Field(..., min_length=1, max_length=8192)


@router.post(
    "/local-picture",
    summary="Read a picture on this computer by its location",
    responses={
        200: {"description": "The picture file", "content": {"image/png": {}}},
        400: {"description": "Not a full file location on this computer"},
        403: {"description": "Not this program's own page"},
        404: {"description": "No file at that location"},
        415: {"description": "Not a picture extension"},
        422: {"description": "The file is not a readable picture"},
    },
)
def read_local_picture(body: LocalPictureRequest, request: Request) -> FileResponse:
    """``path`` is a Windows or POSIX path or a ``file://`` URL. Answers the picture bytes."""
    require_own_page(request, "read a picture by its location")
    try:
        picture = resolve_local_picture(body.path)
    except LocalPictureError as error:
        raise HTTPException(
            status_code=error.status_code, detail=error.detail()
        ) from error
    return FileResponse(
        picture,
        media_type=media_type_of(picture),
        headers={
            "Cache-Control": "no-store",
            "X-Picture-Name": quote(picture.name, safe=""),
        },
    )
