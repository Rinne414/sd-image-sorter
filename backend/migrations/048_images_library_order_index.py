"""Index the gallery's default order so a page reads only the rows it shows.

The gallery sorts by ``COALESCE(library_order_time, created_at) DESC, id DESC``
within one library. Without a matching index SQLite read every row of the
library (the rows carry the raw workflow JSON) and sorted them to return 100:
about 50 ms per page on a 12.8k-image library. This expression index matches
that sort key exactly, so a page is an ordered index walk (measured 54 -> 0.3 ms,
same order). Keep the expression identical to db_images_paginate / query.
"""

from __future__ import annotations

from migrations._schema_common import table_exists

VERSION = 48
NAME = "images_library_order_index"


def apply(conn) -> bool:
    if not table_exists(conn, "images"):
        return False
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_images_lib_order "
        "ON images(library_id, COALESCE(library_order_time, created_at), id)"
    )
    return False
