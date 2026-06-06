"""Migration 016: library_roots table (v3.3.2 Library Navigation — multi-root foundation).

Records the folders the user has added as image sources, independent of the
images currently indexed under them. This is the persistent backbone for:
  - multi-root library management (list / add / remove / rescan roots), and
  - idle background auto-refresh (which folders to re-scan to pick up new files).

A root is identified case-insensitively by ``path_key`` (lowercased, forward-slash
normalized path) so the same folder isn't registered twice on case-insensitive
filesystems (Windows). ``added_at`` / ``last_scanned_at`` are ISO-8601 text, e.g.
``2026-06-06T12:00:00``. Removing a root never touches indexed image rows.
"""
from __future__ import annotations

import sqlite3


VERSION = 16
NAME = "library_roots_table"


def apply(conn: sqlite3.Connection) -> None:
    """Create the library_roots table + supporting index (idempotent)."""
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS library_roots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT NOT NULL,
            path_key TEXT NOT NULL UNIQUE,
            label TEXT,
            enabled INTEGER NOT NULL DEFAULT 1,
            added_at TEXT NOT NULL,
            last_scanned_at TEXT
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_library_roots_enabled ON library_roots(enabled)"
    )
