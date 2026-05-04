from __future__ import annotations

import sqlite3

from migrations._schema_common import add_missing_legacy_image_columns, create_full_schema


VERSION = 1
NAME = "baseline"


def apply(conn: sqlite3.Connection) -> None:
    """Create the current baseline schema for fresh or partially initialized DBs."""
    add_missing_legacy_image_columns(conn)
    create_full_schema(conn)
