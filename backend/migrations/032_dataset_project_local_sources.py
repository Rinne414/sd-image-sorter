"""Persist local file sources in ordered Dataset Maker projects."""
from __future__ import annotations

import sqlite3

from migrations._schema_common import table_exists


VERSION = 32
NAME = "dataset_project_local_sources"


def _column_names(conn: sqlite3.Connection, table: str) -> set[str]:
    return {
        str(row[1])
        for row in conn.execute(f"PRAGMA table_info({table})").fetchall()
    }


def apply(conn: sqlite3.Connection) -> bool:
    """Upgrade Library-only project membership to a strict mixed-source union."""
    items_exists = table_exists(conn, "dataset_project_items")
    sources_exists = table_exists(conn, "dataset_project_local_sources")
    items_are_mixed = items_exists and "item_type" in _column_names(
        conn,
        "dataset_project_items",
    )

    if sources_exists and items_are_mixed:
        return False
    if not items_exists:
        raise RuntimeError(
            "Cannot migrate Dataset project local sources: "
            "dataset_project_items is missing"
        )
    if sources_exists or items_are_mixed:
        raise RuntimeError(
            "Cannot migrate Dataset project local sources: schema is partially upgraded"
        )

    conn.execute(
        """
        CREATE TABLE dataset_project_local_sources (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL
                REFERENCES dataset_projects(id) ON DELETE CASCADE,
            path TEXT NOT NULL CHECK (path != ''),
            path_key TEXT NOT NULL CHECK (path_key != ''),
            size INTEGER NOT NULL CHECK (size >= 0),
            mtime_ns TEXT NOT NULL CHECK (
                mtime_ns GLOB '[0-9]*'
                AND mtime_ns NOT GLOB '*[^0-9]*'
                AND (mtime_ns = '0' OR mtime_ns NOT LIKE '0%')
            ),
            device TEXT NOT NULL CHECK (
                device GLOB '[0-9]*'
                AND device NOT GLOB '*[^0-9]*'
                AND (device = '0' OR device NOT LIKE '0%')
            ),
            inode TEXT NOT NULL CHECK (
                inode GLOB '[0-9]*'
                AND inode NOT GLOB '*[^0-9]*'
                AND (inode = '0' OR inode NOT LIKE '0%')
            ),
            UNIQUE (project_id, path_key),
            UNIQUE (project_id, id)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE dataset_project_items_v32 (
            project_id INTEGER NOT NULL
                REFERENCES dataset_projects(id) ON DELETE CASCADE,
            position INTEGER NOT NULL CHECK (position >= 0),
            item_type TEXT NOT NULL CHECK (item_type IN ('library', 'local')),
            source_image_id INTEGER,
            image_id INTEGER REFERENCES images(id) ON DELETE SET NULL,
            local_source_id INTEGER,
            PRIMARY KEY (project_id, position),
            FOREIGN KEY (project_id, local_source_id)
                REFERENCES dataset_project_local_sources(project_id, id)
                ON DELETE CASCADE,
            CHECK (
                (
                    item_type = 'library'
                    AND source_image_id IS NOT NULL
                    AND source_image_id > 0
                    AND local_source_id IS NULL
                    AND (image_id IS NULL OR image_id = source_image_id)
                )
                OR
                (
                    item_type = 'local'
                    AND source_image_id IS NULL
                    AND image_id IS NULL
                    AND local_source_id IS NOT NULL
                )
            )
        )
        """
    )
    conn.execute(
        """
        INSERT INTO dataset_project_items_v32 (
            project_id, position, item_type, source_image_id, image_id,
            local_source_id
        )
        SELECT project_id, position, 'library', source_image_id, image_id, NULL
        FROM dataset_project_items
        """
    )
    conn.execute("DROP TABLE dataset_project_items")
    conn.execute(
        "ALTER TABLE dataset_project_items_v32 RENAME TO dataset_project_items"
    )
    conn.execute(
        """
        CREATE UNIQUE INDEX uq_dataset_project_items_library_source
        ON dataset_project_items(project_id, source_image_id)
        WHERE item_type = 'library'
        """
    )
    conn.execute(
        """
        CREATE UNIQUE INDEX uq_dataset_project_items_local_source
        ON dataset_project_items(project_id, local_source_id)
        WHERE item_type = 'local'
        """
    )
    conn.execute(
        """
        CREATE INDEX idx_dataset_project_items_image_id
        ON dataset_project_items(image_id)
        """
    )
    return True
