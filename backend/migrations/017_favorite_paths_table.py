"""Migration 017: favorite_paths table (rescan-proof Favorites).

Favorites used to live only in ``collection_items``, keyed by the image row id
with ``ON DELETE CASCADE`` — so a library Clear (``DELETE FROM images``) or any
removal/rescan that re-IDs an image silently deleted the user's hearts. This
table anchors a favorite to its FILE PATH instead, with no foreign key to
``images``, so it survives clears/rescans: a re-scanned file with the same path
resolves back to a favorite automatically (no scan hook needed).

``path_key`` is the case-folded image path (``lower(images.path)``, matching the
``idx_images_path_lower`` index and the library_roots ``path_key`` convention) so
an equality JOIN re-links a favorite to whatever row id the file currently has.
``added_at`` is SQLite datetime text, e.g. ``2026-06-07 12:00:00``. Existing
favorites are backfilled from the current Favorites collection (best-effort).
"""
from __future__ import annotations

import sqlite3


VERSION = 17
NAME = "favorite_paths_table"


def apply(conn: sqlite3.Connection) -> None:
    """Create favorite_paths and backfill it from existing favorites (idempotent)."""
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS favorite_paths (
            path_key TEXT PRIMARY KEY,
            added_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
        """
    )

    # Best-effort backfill from any pre-existing Favorites collection items so
    # users upgrading don't lose their current hearts. On a brand-new database
    # these tables exist but hold no favorites yet -> this is a no-op.
    tables = {
        row[0]
        for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
    }
    if {"collection_items", "collections", "images"} <= tables:
        conn.execute(
            """
            INSERT OR IGNORE INTO favorite_paths (path_key, added_at)
            SELECT lower(COALESCE(i.path, ci.copied_path)),
                   COALESCE(ci.added_at, datetime('now'))
            FROM collection_items ci
            JOIN collections c ON c.id = ci.collection_id
            LEFT JOIN images i ON i.id = ci.source_image_id
            WHERE c.slug = 'favorites'
              AND COALESCE(i.path, ci.copied_path) IS NOT NULL
              AND COALESCE(i.path, ci.copied_path) != ''
            """
        )
