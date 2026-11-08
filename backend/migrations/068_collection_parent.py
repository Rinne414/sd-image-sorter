"""Migration 068: a collection can sit inside another collection.

Adds ``collections.parent_id``: NULL for a top-level collection, otherwise the
id of the collection it sits in (same library). The column is additive and
nullable, so every existing collection becomes a top-level one and no row is
read, rewritten or cleared. There is deliberately no foreign key: SQLite cannot
add one without rebuilding the table (migration 046 had to park
collection_items to do that), and the rules a key would give are enforced in
``db_collection_tree``: a parent must exist in the same library, a collection
never moves under itself or its own sub-collections, and deleting a collection
moves its sub-collections up one level instead of deleting them.

The index serves the one query that walks the tree (children of a parent).
"""

from __future__ import annotations

import sqlite3

from migrations._schema_common import table_exists


VERSION = 68
NAME = "collection_parent"


def _column_exists(conn: sqlite3.Connection, table: str, column: str) -> bool:
    cursor = conn.execute(f"PRAGMA table_info({table})")
    return any(row[1] == column for row in cursor.fetchall())


def apply(conn: sqlite3.Connection) -> None:
    """Add collections.parent_id and its index (idempotent, additive)."""
    if not table_exists(conn, "collections"):
        return
    if not _column_exists(conn, "collections", "parent_id"):
        conn.execute("ALTER TABLE collections ADD COLUMN parent_id INTEGER")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_collections_parent ON collections(library_id, parent_id)"
    )
