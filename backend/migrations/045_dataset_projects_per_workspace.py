"""Pin Dataset Maker projects to long-lived library workspaces."""

from __future__ import annotations

from migrations._schema_common import table_exists

VERSION = 45
NAME = "dataset_projects_per_workspace"
MAIN_LIBRARY_ID = "main"


def apply(conn) -> bool:
    if not table_exists(conn, "dataset_projects"):
        return False

    cols = {
        str(row[1])
        for row in conn.execute("PRAGMA table_info(dataset_projects)").fetchall()
    }
    if "library_id" not in cols:
        conn.execute(
            "ALTER TABLE dataset_projects "
            "ADD COLUMN library_id TEXT NOT NULL DEFAULT 'main'"
        )

    conn.execute("DROP INDEX IF EXISTS uq_dataset_projects_active_name_key")
    conn.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS uq_dataset_projects_library_active_name_key
        ON dataset_projects(library_id, name_key)
        WHERE archived_at IS NULL
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_dataset_projects_library_id
        ON dataset_projects(library_id)
        """
    )
    # ADD COLUMN rewrites no rows: no VACUUM of the whole database.
    return False
