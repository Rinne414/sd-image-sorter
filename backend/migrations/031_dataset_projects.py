"""Persist named Dataset Maker projects and their ordered Library items."""
from __future__ import annotations

import sqlite3

from migrations._schema_common import table_exists


VERSION = 31
NAME = "dataset_projects"


def apply(conn: sqlite3.Connection) -> bool:
    """Add durable projects without coupling them to the restart-cleared session."""
    projects_exists = table_exists(conn, "dataset_projects")
    items_exists = table_exists(conn, "dataset_project_items")
    if projects_exists != items_exists:
        raise RuntimeError(
            "Cannot migrate Dataset projects: dataset project tables are only partially present"
        )

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS dataset_projects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL CHECK (TRIM(name) != ''),
            name_key TEXT NOT NULL CHECK (name_key != ''),
            revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
            archived_at TEXT,
            created_at TEXT NOT NULL DEFAULT (
                STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
            ),
            updated_at TEXT NOT NULL DEFAULT (
                STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
            )
        )
        """
    )
    conn.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS uq_dataset_projects_active_name_key
        ON dataset_projects(name_key)
        WHERE archived_at IS NULL
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_dataset_projects_archived_updated
        ON dataset_projects(archived_at, updated_at DESC, id DESC)
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS dataset_project_items (
            project_id INTEGER NOT NULL
                REFERENCES dataset_projects(id) ON DELETE CASCADE,
            position INTEGER NOT NULL CHECK (position >= 0),
            source_image_id INTEGER NOT NULL CHECK (source_image_id > 0),
            image_id INTEGER REFERENCES images(id) ON DELETE SET NULL,
            PRIMARY KEY (project_id, position),
            UNIQUE (project_id, source_image_id),
            CHECK (image_id IS NULL OR image_id = source_image_id)
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_dataset_project_items_image_id
        ON dataset_project_items(image_id)
        """
    )
    return not projects_exists
