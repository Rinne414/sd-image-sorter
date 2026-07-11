"""Migration 025: tag_bulk_ops undo journal (FE-2s).

Bulk tag operations (find-replace / add / remove / cleanup) rewrite the
full tag list of every affected image and were irreversible. Each applied
(non-dry-run) op now journals, per modified image, the complete tag rows
BEFORE the write plus a digest of the rows after it, so
POST /api/tags/bulk/undo/{op_id} can restore the prior state and detect
images that changed again since the op (conflict -> skipped unless force).
The undo run itself is journaled, which makes redo possible.
"""
from __future__ import annotations

import sqlite3

VERSION = 25
NAME = "tag_bulk_ops_journal"


def apply(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS tag_bulk_ops (
            id TEXT PRIMARY KEY,
            operation TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            scope_source TEXT,
            params_json TEXT,
            images_affected INTEGER NOT NULL DEFAULT 0,
            journal_gz BLOB,
            truncated INTEGER NOT NULL DEFAULT 0,
            undone_at TEXT,
            undo_op_id TEXT
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_tag_bulk_ops_created ON tag_bulk_ops(created_at)"
    )
