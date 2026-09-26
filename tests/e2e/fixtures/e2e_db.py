"""SQL helpers for the E2E fixtures' own scripts.

The app deletes images with foreign keys on: their tags, scores, prompt words,
LoRAs, batch and collection items go with them (ON DELETE CASCADE), and a
dataset item keeps its row with image_id NULL (ON DELETE SET NULL). A fixture
script's plain sqlite3 connection has foreign keys off, so a bare
``DELETE FROM images`` left those rows behind, and tag-count tests then passed
or failed by what earlier specs left (6b-fix3).

``delete_images`` does what the cascade does, explicitly, so it works on any
connection and inside a transaction that is already open (where turning
foreign keys on would be ignored). The tables come from the schema itself, so
a new table that points at images is covered without editing this file.
``image_path_identities`` has no foreign key: its own trigger clears it.
"""

from __future__ import annotations

import sqlite3
from typing import List, Sequence, Tuple, Union

Db = Union[sqlite3.Connection, sqlite3.Cursor]


def image_references(db: Db) -> List[Tuple[str, str, str]]:
    """(table, column, on_delete) for every foreign key that points at images.id."""
    tables = [
        row[0]
        for row in db.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
        ).fetchall()
    ]
    refs = []
    for table in tables:
        for fk in db.execute(f"PRAGMA foreign_key_list('{table}')").fetchall():
            # fk: id, seq, parent table, child column, parent column, on_update, on_delete, match
            if fk[2] == "images" and fk[4] in (None, "id"):
                refs.append((table, fk[3], str(fk[6] or "NO ACTION").upper()))
    return refs


def delete_images(db: Db, where: str, params: Sequence[object] = ()) -> int:
    """Delete the images matching ``where`` and, first, every row that points at them.

    CASCADE rows are deleted, SET NULL columns are cleared, and rows of a key
    without either (NO ACTION / RESTRICT) are deleted too, so the image delete
    never fails on them. Returns how many images were deleted.
    """
    args = tuple(params)
    matching = f"SELECT id FROM images WHERE {where}"
    for table, column, on_delete in image_references(db):
        if on_delete == "SET NULL":
            db.execute(
                f'UPDATE "{table}" SET "{column}" = NULL WHERE "{column}" IN ({matching})',
                args,
            )
        else:
            db.execute(f'DELETE FROM "{table}" WHERE "{column}" IN ({matching})', args)
    return db.execute(f"DELETE FROM images WHERE {where}", args).rowcount
