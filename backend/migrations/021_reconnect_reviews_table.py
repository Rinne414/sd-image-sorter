"""Migration 021: reconnect_reviews table (Roadmap-C — missing-file repair review).

Persists the *ambiguous* matches produced by a missing-file reconnect run so the
user can review them and explicitly pick / merge / skip later, instead of the
ambiguous group being silently dropped in memory.

One row per ambiguous discovered file: ``found_path`` is the file on disk that
matched several missing library rows by name+size, and ``candidate_ids`` is the
JSON int array of those competing image ids. Rows start ``status='pending'``;
a confirm action flips them to ``status='resolved'`` with ``resolution`` set to
one of pick / merge / skip (or ``status='conflict'`` when the found path turns
out to already be indexed as another row).

``run_started_at`` is the reconnect run's wall-clock start (epoch seconds) so a
fresh run can clear its own previous pending snapshot while keeping resolved
history. Indexes support the ``status``-scoped listing and id-ordered pruning.
"""
from __future__ import annotations

import sqlite3


VERSION = 21
NAME = "reconnect_reviews_table"


def apply(conn: sqlite3.Connection) -> None:
    """Create the reconnect_reviews table + supporting indexes (idempotent)."""
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS reconnect_reviews (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            filename TEXT NOT NULL,
            found_path TEXT NOT NULL,
            candidate_ids TEXT NOT NULL,
            candidate_count INTEGER NOT NULL,
            run_started_at REAL NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            resolution TEXT,
            chosen_image_id INTEGER,
            resolved_at REAL
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_reconnect_reviews_status ON reconnect_reviews(status, id)"
    )
