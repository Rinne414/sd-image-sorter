from __future__ import annotations

import sqlite3

from migrations._schema_common import table_exists


VERSION = 3
NAME = "legacy_backfills"


def apply(conn: sqlite3.Connection) -> None:
    """
    Backfill legacy defaults and normalize derived lookup tables once per DB.
    """
    if not table_exists(conn, "images"):
        return

    conn.execute("UPDATE images SET is_readable = 1 WHERE is_readable IS NULL")
    conn.execute("UPDATE images SET metadata_status = 'complete' WHERE metadata_status IS NULL")

    if not table_exists(conn, "image_loras"):
        return

    from database import extract_lora_names

    rows = conn.execute(
        "SELECT id, loras, prompt FROM images WHERE loras IS NOT NULL OR prompt LIKE '%<lora:%'"
    ).fetchall()
    for row in rows:
        for lora_name in extract_lora_names(row[1] or "", row[2] or ""):
            conn.execute(
                "INSERT OR IGNORE INTO image_loras (image_id, lora_name) VALUES (?, ?)",
                (row[0], lora_name),
            )
