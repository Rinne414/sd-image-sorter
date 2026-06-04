"""Migration 015: Add a user_rating column to the images table.

Adds an explicit, user-assigned 0-5 star rating (0 = unrated), Eagle-style and
independent of the AI WD14 "rating" tags (general/sensitive/questionable/
explicit). Stored as a NOT NULL INTEGER defaulting to 0 so existing rows read as
"unrated" and gallery sort/filter never has to special-case NULL.

A b-tree index supports ``ORDER BY user_rating`` and ``WHERE user_rating >= ?``
(the gallery "★≥N" filter) on large libraries.
"""
from __future__ import annotations

import sqlite3

from migrations._schema_common import table_exists


VERSION = 15
NAME = "user_rating_column"


def _column_exists(conn: sqlite3.Connection, table: str, column: str) -> bool:
    cursor = conn.execute(f"PRAGMA table_info({table})")
    return any(row[1] == column for row in cursor.fetchall())


def apply(conn: sqlite3.Connection) -> None:
    """Add the user_rating column + supporting index to images (idempotent)."""
    if not table_exists(conn, "images"):
        return

    cursor = conn.cursor()
    if not _column_exists(conn, "images", "user_rating"):
        # NOT NULL is allowed here because a DEFAULT is supplied, so existing
        # rows backfill to 0 (unrated) without a separate UPDATE pass.
        cursor.execute(
            "ALTER TABLE images ADD COLUMN user_rating INTEGER NOT NULL DEFAULT 0"
        )
    cursor.execute(
        "CREATE INDEX IF NOT EXISTS idx_images_user_rating ON images(user_rating)"
    )
