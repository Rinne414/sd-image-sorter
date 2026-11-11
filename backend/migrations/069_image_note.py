"""Migration 069: a note the user writes on a picture.

Adds ``images.note`` (nullable text): why a picture was kept, what to fix,
whom it is for. The column is additive, so no existing row is read or
rewritten.

The note is searched with the prompt and the caption, so it joins the text
search index of migration 067: the two triggers that write a picture's index
row are created again with the note in them (067 reads whether the column
exists, so a later rebuild of the index keeps the note as well). Index rows
that already exist stay as they are: no picture has a note yet.

Idempotent. A database without the search index (an SQLite build without the
trigram tokenizer) gets only the column and keeps scanning.
"""

from __future__ import annotations

import importlib.util
import sqlite3
from pathlib import Path

from migrations._schema_common import table_exists

VERSION = 69
NAME = "image_note"

_TEXT_FTS = "image_text_fts"


def _column_exists(conn: sqlite3.Connection, table: str, column: str) -> bool:
    cursor = conn.execute(f"PRAGMA table_info({table})")
    return any(row[1] == column for row in cursor.fetchall())


def _search_index_migration():
    """Migration 067 as a module (its file name starts with a digit, so no plain import)."""
    path = Path(__file__).with_name("067_search_index.py")
    spec = importlib.util.spec_from_file_location(
        "migrations.runtime_067_search_index_for_069", path
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def apply(conn: sqlite3.Connection) -> None:
    if not table_exists(conn, "images"):
        return
    if not _column_exists(conn, "images", "note"):
        conn.execute("ALTER TABLE images ADD COLUMN note TEXT")
    if not table_exists(conn, _TEXT_FTS):
        return
    # The triggers were made before the column existed: make them again, with the note.
    conn.execute(f"DROP TRIGGER IF EXISTS trg_{_TEXT_FTS}_insert")
    conn.execute(f"DROP TRIGGER IF EXISTS trg_{_TEXT_FTS}_update")
    _search_index_migration()._create_text_index(conn)
