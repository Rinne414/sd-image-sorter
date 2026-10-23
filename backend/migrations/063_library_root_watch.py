"""Migration 063: a per-root "watch" switch for library roots.

``watch`` = 1 means the folder is watched while the app runs: new or changed
pictures under it are indexed within seconds, without pressing Scan. It is off
for every existing root, so nothing starts watching on its own after an
upgrade; the user turns it on per folder.

Additive and idempotent: ADD COLUMN only when absent; no row is read or
rewritten, so no VACUUM.
"""

from __future__ import annotations

import sqlite3

from migrations._schema_common import table_exists

VERSION = 63
NAME = "library_root_watch"


def apply(conn: sqlite3.Connection) -> None:
    if not table_exists(conn, "library_roots"):
        return
    existing = {
        str(row[1])
        for row in conn.execute("PRAGMA table_info(library_roots)").fetchall()
    }
    if "watch" not in existing:
        conn.execute(
            "ALTER TABLE library_roots ADD COLUMN watch INTEGER NOT NULL DEFAULT 0"
        )
