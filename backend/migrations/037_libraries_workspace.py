"""Long-lived multi-library workspaces (product narrative 2026-08).

Each library is a durable workspace. Images gain library_id (default ``main``).
Process-lifetime gallery_session_images is unrelated and stays unused for UX.
"""

from __future__ import annotations

from migrations._schema_common import table_exists

VERSION = 37
NAME = "libraries_workspace"
MAIN_LIBRARY_ID = "main"


def apply(conn) -> bool:
    changed = False

    if not table_exists(conn, "libraries"):
        conn.execute(
            """
            CREATE TABLE libraries (
                id TEXT PRIMARY KEY NOT NULL,
                name TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                is_default INTEGER NOT NULL DEFAULT 0
                    CHECK (is_default IN (0, 1))
            )
            """
        )
        changed = True

    conn.execute(
        """
        INSERT OR IGNORE INTO libraries (id, name, is_default)
        VALUES (?, 'Main library', 1)
        """,
        (MAIN_LIBRARY_ID,),
    )

    cols = {
        str(row[1])
        for row in conn.execute("PRAGMA table_info(images)").fetchall()
    }
    if "library_id" not in cols:
        conn.execute(
            "ALTER TABLE images ADD COLUMN library_id TEXT NOT NULL DEFAULT 'main'"
        )
        changed = True

    conn.execute(
        """
        UPDATE images
        SET library_id = ?
        WHERE library_id IS NULL OR TRIM(library_id) = ''
        """,
        (MAIN_LIBRARY_ID,),
    )

    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_images_library_id_id
        ON images(library_id, id)
        """
    )
    return changed
