"""A batch item's censored copy as a binary upload, for pictures of any size.

The same one-write rule as the JSON save (services.batch_service.save_censored_copy):
the copy is written to a staging file, replaces the previous copy inside the
database transaction that records it together with the item state, and any
failure up to the commit puts the previous copy back. Only the transport and
the limits differ: the bytes come as they are (PNG or lossless WebP, no
base64), there is no 40 MB / 40 MP cap, and only Pillow's decompression-bomb
limit (Image.MAX_IMAGE_PIXELS) refuses a picture.
"""

from __future__ import annotations

import json
import re
from io import BytesIO
from typing import Any

from fastapi import HTTPException
from PIL import Image, UnidentifiedImageError

import db_batches as batch_db
from services import batch_workdir
from services.batch_service import _item_response
from services.censor.output_io import _normalize_censor_source

ACCEPTED_FORMATS = {"PNG", "WEBP"}
# Fast PNG compression: the copy is a working file; the export writes the final files.
COPY_COMPRESS_LEVEL = 1


def item_state_fields(raw: str | None) -> dict[str, Any]:
    """The item_state column change: none when the part is absent, NULL for JSON null."""
    if raw is None:
        return {}
    try:
        state = json.loads(raw)
    except ValueError as exc:
        raise HTTPException(
            status_code=400, detail="item_state is not valid JSON"
        ) from exc
    if state is not None and not isinstance(state, dict):
        raise HTTPException(
            status_code=400, detail="item_state must be a JSON object or null"
        )
    return {"item_state_json": None if state is None else json.dumps(state)}


def _too_many_pixels(pixels: int) -> HTTPException:
    limit = Image.MAX_IMAGE_PIXELS
    return HTTPException(
        status_code=413,
        detail=(
            f"The picture has {pixels:,} pixels; a censored copy may have at most "
            f"{limit:,} (the decompression-bomb limit)."
        ),
    )


def _pixels_in(error: Exception) -> int:
    found = re.search(r"\((\d+) pixels\)", str(error))
    return int(found.group(1)) if found else 0


def decode_upload(data: bytes) -> Image.Image:
    """A detached RGB/RGBA raster with no metadata, or a clear 400/413."""
    if not data:
        raise HTTPException(status_code=400, detail="The upload has no picture in it")
    try:
        with Image.open(BytesIO(data)) as opened:
            limit = Image.MAX_IMAGE_PIXELS
            pixels = opened.width * opened.height
            # Between the limit and twice it Pillow only warns: refuse there too.
            if limit and pixels > limit:
                raise _too_many_pixels(pixels)
            if opened.format not in ACCEPTED_FORMATS:
                raise HTTPException(
                    status_code=400, detail="The copy must be a PNG or WebP picture"
                )
            opened.load()
            image = _normalize_censor_source(opened)
    except Image.DecompressionBombError as exc:
        raise _too_many_pixels(_pixels_in(exc)) from exc
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError) as exc:
        raise HTTPException(
            status_code=400, detail="The upload is not a readable picture"
        ) from exc
    image.info = {}
    return image


def save_censored_upload(
    batch_id: int, image_id: int, data: bytes, item_state: str | None
) -> dict[str, Any]:
    """Write the uploaded copy and (when sent) the item state as one change: both or neither."""
    batch_db.read_item(batch_id, image_id)
    fields_state = item_state_fields(item_state)
    image = decode_upload(data)
    relative_path = batch_workdir.censored_relative_path(image_id)
    target = batch_workdir.resolve_censored_path(batch_id, relative_path)
    if target is None:
        raise RuntimeError(
            f"Censored copy path for image {image_id} left batch {batch_id}"
        )
    copy = batch_workdir.StagedCopy(target)
    fields = {"censored_path": relative_path, **fields_state}
    try:
        copy.staged.parent.mkdir(parents=True, exist_ok=True)
        image.save(copy.staged, format="PNG", compress_level=COPY_COMPRESS_LEVEL)
        row = batch_db.update_item(
            batch_id, image_id, fields, before_commit=copy.swap_in
        )
    except BaseException:
        copy.roll_back()
        raise
    copy.finish()
    return _item_response(batch_id, row)
