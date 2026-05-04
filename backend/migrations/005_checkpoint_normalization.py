from __future__ import annotations

import sqlite3

from migrations._schema_common import table_exists
from utils.model_names import normalize_checkpoint_name


VERSION = 5
NAME = "checkpoint_normalization"


def apply(conn: sqlite3.Connection) -> None:
    """Add and backfill the normalized checkpoint field used by filters and facets."""
    if not table_exists(conn, "images"):
        return

    existing_columns = {
        row[1]
        for row in conn.execute("PRAGMA table_info(images)").fetchall()
    }
    if "checkpoint_normalized" not in existing_columns:
        conn.execute("ALTER TABLE images ADD COLUMN checkpoint_normalized TEXT")

    rows = conn.execute("SELECT id, checkpoint FROM images").fetchall()
    for row in rows:
        conn.execute(
            "UPDATE images SET checkpoint_normalized = ? WHERE id = ?",
            (normalize_checkpoint_name(row[1]), row[0]),
        )

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_images_checkpoint_normalized "
        "ON images(checkpoint_normalized COLLATE NOCASE) "
        "WHERE checkpoint_normalized IS NOT NULL"
    )
