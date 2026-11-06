"""Migration 066: which colour algorithm measured a picture's stored colours.

Pictures analysed before this column are version 0, the RGB way. They keep their
colours (sorting and filtering go on working) and count as needing analysis, so
the next colour analysis run measures them again with the HSV way
(hsv_palette.COLOR_ALGORITHM_VERSION).

Additive and idempotent: ADD COLUMN and CREATE INDEX only when absent; no row is
read or rewritten, so no VACUUM.
"""

from __future__ import annotations

import sqlite3

from migrations._schema_common import table_exists

VERSION = 66
NAME = "color_version"


def apply(conn: sqlite3.Connection) -> None:
    if not table_exists(conn, "images"):
        return
    existing = {
        str(row[1]) for row in conn.execute("PRAGMA table_info(images)").fetchall()
    }
    if "color_version" not in existing:
        conn.execute(
            "ALTER TABLE images ADD COLUMN color_version INTEGER NOT NULL DEFAULT 0"
        )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_images_color_version ON images(color_version)"
    )
