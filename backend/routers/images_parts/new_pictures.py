"""GET /new-pictures: the pictures made after a moment the caller remembers.

"New" goes by the picture's own time (the file's first-seen time, the key the
newest-first order uses), not by when it was last indexed: a re-read or a
re-tag must not make an old picture new again.

The caller keeps the marker: ``newest_time`` of one answer is the ``after`` of
the next, passed back unchanged, so the comparison is always between two values
the column itself produced.

Registers on the shared ``router`` of routers/images.py (import the facade,
not this module).
"""

from typing import Any, Dict, Optional

from fastapi import Query

import database as db
from db_query_columns import _LIBRARY_ORDER_SQL
from library_context import current_library_sql
from routers.images import router


def pictures_after(after: Optional[str]) -> Dict[str, Any]:
    """Ids of the open library's pictures newer than ``after``, newest first."""
    in_library, library_params = current_library_sql("i.library_id")
    where = [in_library]
    params: list = [*library_params]
    if after:
        where.append(f"{_LIBRARY_ORDER_SQL} > ?")
        params.append(after)
    conn = db.get_connection()
    try:
        rows = conn.execute(
            f"""
            SELECT i.id, {_LIBRARY_ORDER_SQL} AS made
            FROM images i
            WHERE {" AND ".join(where)}
            ORDER BY made DESC, i.id DESC
            """,
            params,
        ).fetchall()
        newest = conn.execute(
            f"SELECT MAX({_LIBRARY_ORDER_SQL}) FROM images i WHERE {in_library}",
            library_params,
        ).fetchone()
    finally:
        conn.close()
    return {
        "after": after or None,
        "ids": [int(row[0]) for row in rows],
        "count": len(rows),
        # The library's newest picture, whether or not anything is new: the next marker.
        "newest_time": str(newest[0]) if newest and newest[0] is not None else None,
    }


@router.get("/new-pictures", summary="Pictures made after a remembered moment")
def get_new_pictures(
    after: Optional[str] = Query(
        default=None,
        max_length=40,
        description="A `newest_time` from an earlier answer, or a `YYYY-MM-DD HH:MM:SS` local time. Without it, every picture counts.",
    ),
):
    """The open library's pictures newer than ``after`` and the marker for next time."""
    return pictures_after(after)
