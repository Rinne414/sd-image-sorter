"""POST /api/images/by-ids: gallery rows for a list of image ids, in that order.

Similarity search, duplicate review and other ranked views get image ids from
their own endpoints; this turns them into the same rows the gallery lists
(size, generator, rating), keeping the caller's order. Ids that are gone or
belong to another library are left out, so a stale list shows what still exists.
"""

from typing import Any, Dict, List

from fastapi import APIRouter
from pydantic import BaseModel, Field

import database as db
from library_context import current_library_sql

router = APIRouter(prefix="/api/images", tags=["images"])

MAX_IDS = 2000
_CHUNK = 500
_SUMMARY_COLUMNS = (
    "id, path, filename, generator, width, height, file_size, checkpoint, "
    "checkpoint_normalized, loras, user_rating, aesthetic_score, is_readable, "
    "metadata_status, created_at, library_order_time"
)


class ImagesByIdsRequest(BaseModel):
    image_ids: List[int] = Field(
        ..., max_length=MAX_IDS, description="Image ids, in the order wanted"
    )


def images_by_ids(image_ids: List[int]) -> List[Dict[str, Any]]:
    """Summary rows of the current library's images, in the order given, each once."""
    wanted: List[int] = []
    seen = set()
    for raw in image_ids:
        image_id = int(raw)
        if image_id > 0 and image_id not in seen:
            seen.add(image_id)
            wanted.append(image_id)
    if not wanted:
        return []
    lib_sql, lib_params = current_library_sql()
    found: Dict[int, Dict[str, Any]] = {}
    with db.get_db() as conn:
        for start in range(0, len(wanted), _CHUNK):
            batch = wanted[start : start + _CHUNK]
            placeholders = ",".join("?" * len(batch))
            rows = conn.execute(
                f"SELECT {_SUMMARY_COLUMNS} FROM images WHERE id IN ({placeholders}) AND {lib_sql}",
                (*batch, *lib_params),
            ).fetchall()
            for row in rows:
                found[int(row["id"])] = dict(row)
    return [found[image_id] for image_id in wanted if image_id in found]


@router.post(
    "/by-ids",
    summary="Gallery rows for a list of image ids",
    description="""
Return the gallery's summary rows (size, generator, rating, ...) for the given
image ids, in the order given. Ids that no longer exist or belong to another
library are left out. At most 2000 ids per request.
    """,
)
def get_images_by_ids(request: ImagesByIdsRequest) -> Dict[str, Any]:
    """Gallery rows for a ranked or hand-picked list of ids."""
    images = images_by_ids(request.image_ids)
    return {"images": images, "count": len(images)}
