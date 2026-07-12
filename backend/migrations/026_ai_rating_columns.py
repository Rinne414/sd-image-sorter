"""Migration 026: first-class AI rating columns on images.

BE-3 (tagger/editor master plan Phase 1). The tagger's rating verdict
(general/sensitive/questionable/explicit) was persisted only as a tag row,
so every rating filter/sort probed the tags table — the gallery's rating
sort ran 4 correlated EXISTS per image. ``ai_rating`` (+ confidence)
denormalizes the winning verdict onto images:

* single write seam — ``db_tags._sync_ai_rating`` re-derives the columns
  after every tag replace, so bulk edits, bulk-undo and re-tagging can
  never drift from the tag rows;
* the rating tag row keeps being written (dual-write) — export templates,
  the Separation Console and the health check still read rows;
* backfill picks the highest-confidence rating row per image, severity
  (explicit > questionable > sensitive > general) breaking ties — the same
  rule ``_sync_ai_rating`` applies on live writes.
"""
from __future__ import annotations

import sqlite3

from migrations._schema_common import table_exists


VERSION = 26
NAME = "ai_rating_columns"

_RATING_PRIORITY_SQL = (
    "CASE tag WHEN 'explicit' THEN 0 WHEN 'questionable' THEN 1 "
    "WHEN 'sensitive' THEN 2 ELSE 3 END"
)


def _column_exists(conn: sqlite3.Connection, table: str, column: str) -> bool:
    cursor = conn.execute(f"PRAGMA table_info({table})")
    return any(row[1] == column for row in cursor.fetchall())


def apply(conn: sqlite3.Connection) -> None:
    """Add ai_rating / ai_rating_confidence + backfill from tag rows (idempotent)."""
    if not table_exists(conn, "images"):
        return

    cursor = conn.cursor()
    needs_backfill = False
    if not _column_exists(conn, "images", "ai_rating"):
        cursor.execute("ALTER TABLE images ADD COLUMN ai_rating TEXT")
        needs_backfill = True
    if not _column_exists(conn, "images", "ai_rating_confidence"):
        cursor.execute("ALTER TABLE images ADD COLUMN ai_rating_confidence REAL")
        needs_backfill = True
    cursor.execute(
        "CREATE INDEX IF NOT EXISTS idx_images_ai_rating "
        "ON images(ai_rating) WHERE ai_rating IS NOT NULL"
    )

    if not needs_backfill or not table_exists(conn, "tags"):
        return

    cursor.execute(
        f"""
        UPDATE images SET
            ai_rating = (
                SELECT tag FROM tags
                WHERE image_id = images.id
                  AND tag IN ('general', 'sensitive', 'questionable', 'explicit')
                ORDER BY confidence DESC, {_RATING_PRIORITY_SQL}
                LIMIT 1
            ),
            ai_rating_confidence = (
                SELECT confidence FROM tags
                WHERE image_id = images.id
                  AND tag IN ('general', 'sensitive', 'questionable', 'explicit')
                ORDER BY confidence DESC, {_RATING_PRIORITY_SQL}
                LIMIT 1
            )
        WHERE EXISTS (
            SELECT 1 FROM tags
            WHERE image_id = images.id
              AND tag IN ('general', 'sensitive', 'questionable', 'explicit')
        )
        """
    )
