"""PATCH /images/{image_id}/note: the user's own note on a picture.

Registers on the shared ``router`` of routers/images.py (import the facade,
not this module).
"""

from typing import Optional

from fastapi import HTTPException, Path as FastAPIPath
from pydantic import BaseModel, Field

import database as db
from db_images_write_attributes import MAX_NOTE_CHARS
from routers.images import router


class ImageNoteRequest(BaseModel):
    # Empty text (or null) clears the note.
    note: Optional[str] = Field(default=None, max_length=MAX_NOTE_CHARS)


@router.patch("/images/{image_id}/note", summary="Write the note of a picture")
def set_image_note(
    request: ImageNoteRequest,
    image_id: int = FastAPIPath(..., ge=1, le=2_147_483_647),
):
    """Store the user's note on one picture and return what was stored.

    The note is found by the Gallery's text search, like a caption.
    """
    if not db.set_image_note(image_id, request.note):
        raise HTTPException(status_code=404, detail="Image not found")
    image = db.get_image_by_id(image_id) or {}
    return {"image_id": image_id, "note": image.get("note") or ""}
