"""Pin library_roots to long-lived workspaces (multi-library Phase 3).

A root folder is registered per library. The same disk path may appear in
more than one library; uniqueness is (library_id, path_key).
"""

from __future__ import annotations

from migrations._schema_common import table_exists

VERSION = 38
NAME = "library_roots_per_workspace"
MAIN_LIBRARY_ID = "main"


def apply(conn) -> bool:
    if not table_exists(conn, "library_roots"):
        return False

    cols = {
        str(row[1])
        for row in conn.execute("PRAGMA table_info(library_roots)").fetchall()
    }
    if "library_id" in cols:
        # Ensure composite unique index exists even on partially migrated DBs.
        conn.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS idx_library_roots_library_path_key
            ON library_roots(library_id, path_key)
            """
        )
        return False

    conn.execute(
        """
        CREATE TABLE library_roots_v38 (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT NOT NULL,
            path_key TEXT NOT NULL,
            library_id TEXT NOT NULL DEFAULT 'main',
            label TEXT,
            enabled INTEGER NOT NULL DEFAULT 1,
            added_at TEXT NOT NULL,
            last_scanned_at TEXT,
            UNIQUE(library_id, path_key)
        )
        """
    )
    conn.execute(
        """
        INSERT INTO library_roots_v38 (
            id, path, path_key, library_id, label, enabled, added_at, last_scanned_at
        )
        SELECT
            id, path, path_key, ?, label, enabled, added_at, last_scanned_at
        FROM library_roots
        """,
        (MAIN_LIBRARY_ID,),
    )
    conn.execute("DROP TABLE library_roots")
    conn.execute("ALTER TABLE library_roots_v38 RENAME TO library_roots")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_library_roots_enabled ON library_roots(enabled)"
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_library_roots_library_id
        ON library_roots(library_id)
        """
    )
    return True
