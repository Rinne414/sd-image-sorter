"""GET /images/{image_id}/changes: what changed from another picture.

Registers on the shared ``router`` of routers/images.py (import the facade,
not this module). Two path segments after the id, so it cannot shadow or be
shadowed by ``GET /images/{image_id}``.
"""

from typing import Any, Dict, Optional

from fastapi import HTTPException, Path as FastAPIPath, Query

import database as db
from db_query_columns import _LIBRARY_ORDER_SQL
from routers.images import router
from services import generation_diff


def _picture_before(image_id: int) -> Optional[Dict[str, Any]]:
    """The picture made just before this one: the nearest earlier one that carries a prompt."""
    # The picture's own time is read in the same query, in the form the column stores it.
    # A picture with no recorded time counts as the oldest, so ids alone order such pictures.
    when = f"COALESCE({_LIBRARY_ORDER_SQL}, 0)"
    own_time = f"(SELECT {when} FROM images i WHERE i.id = :id)"
    conn = db.get_connection()
    try:
        row = conn.execute(
            f"""
            SELECT i.id FROM images i
            WHERE COALESCE(i.prompt, '') != ''
              AND ({when} < {own_time} OR ({when} = {own_time} AND i.id < :id))
            ORDER BY {when} DESC, i.id DESC
            LIMIT 1
            """,
            {"id": image_id},
        ).fetchone()
    finally:
        conn.close()
    return db.get_image_by_id(int(row[0])) if row else None


@router.get(
    "/images/{image_id}/changes",
    summary="What changed from another picture",
)
def get_image_changes(
    image_id: int = FastAPIPath(..., ge=1, le=2_147_483_647),
    against: Optional[int] = Query(
        default=None,
        ge=1,
        le=2_147_483_647,
        description="The picture to compare with; left out: the picture made just before this one",
    ),
):
    """Prompt words, settings and LoRAs that differ between two pictures.

    ``previous`` is false with no ``before`` when there is no earlier picture
    with generation data to compare with.
    """
    image = db.get_image_by_id(image_id)
    if not image:
        raise HTTPException(status_code=404, detail="Image not found")
    if against is not None:
        other = db.get_image_by_id(against)
        if not other:
            raise HTTPException(
                status_code=404, detail="The picture to compare with was not found"
            )
    else:
        other = _picture_before(image_id)
        if other is None:
            return {
                "after": {"id": image["id"], "filename": image.get("filename")},
                "before": None,
                "comparable": False,
            }
    return {**generation_diff.compare(other, image), "picked": against is not None}
