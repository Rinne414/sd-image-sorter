"""Migration 014: Add indexes for aesthetic/saturation sort-filter and a
LOWER(tag) expression index for exclude-tag/rating filters.

Background
==========
Gallery sorts/filters on ``aesthetic_score`` and ``color_saturation`` and the
per-item exclude-tag / exclude-rating filters previously had no supporting
index, forcing full scans on large libraries.

* ``idx_images_aesthetic_score`` / ``idx_images_color_saturation`` are partial
  indexes (``WHERE col IS NOT NULL``) matching the existing partial-index style
  in ``_schema_common.INDEX_STATEMENTS`` (e.g. ``idx_images_checkpoint``). Both
  columns are nullable until backfill, and every aesthetic/saturation filter
  condition is already gated by ``col IS NOT NULL`` (see ``_apply_aesthetic_filter``
  / ``_apply_color_filter`` in ``db_query.py``), so a partial index is both
  smaller and a perfect match for those predicates.

* ``idx_tags_lower_tag`` is an expression index on ``LOWER(tag)`` so the
  ``NOT EXISTS (... WHERE LOWER(tag) IN (...))`` exclude filters (PERF-5) can use
  an index instead of scanning ``tags``.

Notes
=====
* ``avg_brightness``, ``color_temperature``, ``brightness_distribution`` and
  ``brightness_skew`` indexes already exist (migration 010); they are not
  re-created here.
* All statements use ``IF NOT EXISTS`` so the migration is idempotent and safe to
  re-run. ``schema_version`` is advanced to 14 by the migration runner.
"""
from __future__ import annotations

import sqlite3

from migrations._schema_common import table_exists


VERSION = 14
NAME = "perf_filter_indexes"


def _column_exists(conn: sqlite3.Connection, table: str, column: str) -> bool:
    cursor = conn.execute(f"PRAGMA table_info({table})")
    return any(row[1] == column for row in cursor.fetchall())


def apply(conn: sqlite3.Connection) -> None:
    """Add aesthetic/saturation partial indexes and a LOWER(tag) index (idempotent).

    The in-order migration runner guarantees migration 010 (which adds the
    ``color_saturation`` column) has already run by the time this executes, so the
    column normally exists. The ``_column_exists`` guards keep this migration safe
    even on a DB where the color columns are not present yet.
    """
    cursor = conn.cursor()

    if table_exists(conn, "images"):
        if _column_exists(conn, "images", "aesthetic_score"):
            cursor.execute(
                "CREATE INDEX IF NOT EXISTS idx_images_aesthetic_score "
                "ON images(aesthetic_score) WHERE aesthetic_score IS NOT NULL"
            )
        if _column_exists(conn, "images", "color_saturation"):
            cursor.execute(
                "CREATE INDEX IF NOT EXISTS idx_images_color_saturation "
                "ON images(color_saturation) WHERE color_saturation IS NOT NULL"
            )

    if table_exists(conn, "tags"):
        cursor.execute(
            "CREATE INDEX IF NOT EXISTS idx_tags_lower_tag ON tags(LOWER(tag))"
        )
