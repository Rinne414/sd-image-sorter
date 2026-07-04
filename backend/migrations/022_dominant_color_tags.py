"""Migration 022: dominant_color_tags column + backfill from existing JSON.

v3.5.0 completes the color filter: `color:red` style queries need a cheap
per-hue predicate, but the v3.2.1 color pass only stored the raw
``dominant_colors`` JSON (top-5 ``{hex, pct}`` entries) that nothing could
filter on. This adds ``dominant_color_tags`` — a comma-wrapped tag list
(",red,white,") matched with ``LIKE '%,red,%'`` — and backfills it for every
already-analyzed row **from the stored JSON alone**: classification is pure
math on the hex values, so the backfill never reopens image files and runs
in seconds even on large libraries.

Rows that were never color-analyzed (``dominant_colors IS NULL``) stay NULL
and get their tags when the normal scan/lazy color pass reaches them.
"""
from __future__ import annotations

import sqlite3

from migrations._schema_common import add_missing_legacy_image_columns


VERSION = 22
NAME = "dominant_color_tags"

_BATCH_SIZE = 5000


def apply(conn: sqlite3.Connection) -> None:
    add_missing_legacy_image_columns(conn)

    # Import here so the migration module stays importable even if the
    # analyzer moves; classification is pure-python (no PIL use on this path).
    from color_analyzer import dominant_color_tags_from_json

    last_id = 0
    while True:
        rows = conn.execute(
            """
            SELECT id, dominant_colors FROM images
            WHERE id > ? AND dominant_colors IS NOT NULL
              AND dominant_color_tags IS NULL
            ORDER BY id LIMIT ?
            """,
            (last_id, _BATCH_SIZE),
        ).fetchall()
        if not rows:
            break
        updates = []
        for row in rows:
            image_id, dominant_json = row[0], row[1]
            updates.append((dominant_color_tags_from_json(dominant_json), image_id))
            last_id = image_id
        conn.executemany(
            "UPDATE images SET dominant_color_tags = ? WHERE id = ?", updates
        )
