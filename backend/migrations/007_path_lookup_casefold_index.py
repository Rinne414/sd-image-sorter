from __future__ import annotations

import sqlite3

from migrations._schema_common import table_exists


VERSION = 7
NAME = "path_lookup_casefold_index"


def apply(conn: sqlite3.Connection) -> None:
    """Index case-folded paths used by Windows/WSL equivalent-path lookups."""
    if not table_exists(conn, "images"):
        return

    conn.execute("CREATE INDEX IF NOT EXISTS idx_images_path_lower ON images(LOWER(path))")
