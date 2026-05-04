from __future__ import annotations

import sqlite3

from migrations._schema_common import table_exists


VERSION = 4
NAME = "image_time_semantics"


def apply(conn: sqlite3.Connection) -> None:
    """
    Split legacy created_at semantics into stable library order time and
    current source-file mtime while preserving created_at as a compatibility
    mirror of library_order_time.
    """
    if not table_exists(conn, "images"):
        return

    existing_columns = {
        row[1]
        for row in conn.execute("PRAGMA table_info(images)").fetchall()
    }

    if "library_order_time" not in existing_columns:
        conn.execute("ALTER TABLE images ADD COLUMN library_order_time DATETIME")
    if "source_file_mtime" not in existing_columns:
        conn.execute("ALTER TABLE images ADD COLUMN source_file_mtime DATETIME")

    conn.execute(
        """
        UPDATE images
        SET library_order_time = COALESCE(library_order_time, created_at),
            source_file_mtime = COALESCE(source_file_mtime, created_at),
            created_at = COALESCE(library_order_time, created_at)
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_images_library_order_time ON images(library_order_time DESC)"
    )
