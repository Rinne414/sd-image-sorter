"""Persist V4 batches: ordered, per-library groups of images with steps.

A batch is the one "group of images being worked on" concept of V4 (Pixiv
posts, datasets, custom groups). ``batch_items`` keeps the order, the per-item
output name and the censored working copy; ``batch_templates`` keeps saved
step/settings presets.

When an image row is deleted, its ``batch_items`` rows go with it
(``ON DELETE CASCADE``): the image no longer exists anywhere in the Library, so
no batch can show, censor or export it. Its censored working copy is removed
by the batch service the next time items are added to or removed from that
batch. A dataset batch links
to ``dataset_projects`` instead of copying it; deleting the project only
clears the link.
"""

from __future__ import annotations

import sqlite3

from migrations._schema_common import table_exists


VERSION = 60
NAME = "batches"


def _create_batches(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS batches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            library_id TEXT NOT NULL DEFAULT 'main',
            kind TEXT NOT NULL CHECK (kind IN ('pixiv', 'dataset', 'custom')),
            name TEXT NOT NULL CHECK (TRIM(name) != ''),
            steps_json TEXT NOT NULL DEFAULT '[]',
            settings_json TEXT NOT NULL DEFAULT '{}',
            current_step TEXT,
            dataset_project_id INTEGER
                REFERENCES dataset_projects(id) ON DELETE SET NULL,
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
        CREATE INDEX IF NOT EXISTS idx_batches_library_archived_updated
        ON batches(library_id, archived_at, updated_at DESC, id DESC)
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_batches_dataset_project_id
        ON batches(dataset_project_id)
        """
    )


def _create_batch_items(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS batch_items (
            batch_id INTEGER NOT NULL
                REFERENCES batches(id) ON DELETE CASCADE,
            image_id INTEGER NOT NULL
                REFERENCES images(id) ON DELETE CASCADE,
            position INTEGER NOT NULL CHECK (position >= 0),
            output_name TEXT,
            censored_path TEXT,
            censored_at TEXT,
            item_state_json TEXT,
            PRIMARY KEY (batch_id, image_id)
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_batch_items_batch_position
        ON batch_items(batch_id, position)
        """
    )
    # Deleting an image cascades here; without this index every deleted image
    # row would scan the whole table.
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_batch_items_image_id
        ON batch_items(image_id)
        """
    )


def _create_batch_templates(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS batch_templates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            library_id TEXT NOT NULL DEFAULT 'main',
            kind TEXT NOT NULL CHECK (kind IN ('pixiv', 'dataset', 'custom')),
            name TEXT NOT NULL CHECK (TRIM(name) != ''),
            steps_json TEXT NOT NULL DEFAULT '[]',
            settings_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL DEFAULT (
                STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
            )
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_batch_templates_library_kind
        ON batch_templates(library_id, kind)
        """
    )


def apply(conn: sqlite3.Connection) -> bool:
    """Create the batch tables; new empty tables need no VACUUM."""
    present = [
        table_exists(conn, name)
        for name in ("batches", "batch_items", "batch_templates")
    ]
    if any(present) and not all(present):
        raise RuntimeError(
            "Cannot migrate batches: batch tables are only partially present"
        )
    _create_batches(conn)
    _create_batch_items(conn)
    _create_batch_templates(conn)
    return False
