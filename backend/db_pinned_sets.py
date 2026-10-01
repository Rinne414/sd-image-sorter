"""Pinned picture sets: a hidden collection that stands for "these pictures".

The Style Map's "view in Gallery" needs the Gallery to show exactly the
pictures a box selection covered. Instead of a new Gallery filter (which every
copy of the filter contract would have to carry), the ids are stored as a
collection whose slug starts with ``~`` (``slugify`` can never produce one), so
the existing ``collection_id`` filter does the rest. ``list_collections``
leaves these out; only the newest ``PINNED_KEEP`` per library are kept.

Imports only db_core / db_collections helpers (no ``database`` facade).
"""

from __future__ import annotations

import uuid
from typing import Any, Dict, List, Optional

from db_collections import PINNED_SLUG_PREFIX, _library_clause
from db_core import get_db

PINNED_KEEP = 8
PINNED_NAME = "Style Map selection"
_CHUNK = 500


def create_pinned_set(image_ids: List[int]) -> Dict[str, Any]:
    """Store the pictures (those that exist in the active library) as a hidden
    collection; returns ``{"id", "count"}``. Older sets beyond the newest
    ``PINNED_KEEP`` of this library are removed."""
    ids = list(dict.fromkeys(int(image_id) for image_id in image_ids))
    lib_sql, lib_params = _library_clause()
    img_sql, img_params = _library_clause()
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO collections (slug, name, folder_path, library_id) VALUES (?, ?, ?, ?)",
            (f"{PINNED_SLUG_PREFIX}{uuid.uuid4().hex}", PINNED_NAME, "", lib_params[0]),
        )
        set_id = int(cursor.lastrowid)
        for start in range(0, len(ids), _CHUNK):
            chunk = ids[start : start + _CHUNK]
            marks = ",".join("?" * len(chunk))
            cursor.execute(
                "INSERT OR IGNORE INTO collection_items (collection_id, source_image_id, copied_path) "
                f"SELECT ?, id, path FROM images WHERE id IN ({marks}) AND {img_sql}",
                [set_id, *chunk, *img_params],
            )
        cursor.execute(
            "SELECT COUNT(*) FROM collection_items WHERE collection_id = ?", (set_id,)
        )
        count = int(cursor.fetchone()[0])
        cursor.execute(
            f"SELECT id FROM collections WHERE slug LIKE ? AND {lib_sql} ORDER BY id DESC",
            (f"{PINNED_SLUG_PREFIX}%", *lib_params),
        )
        stale = [int(row[0]) for row in cursor.fetchall()][PINNED_KEEP:]
        for old in stale:
            cursor.execute(
                "DELETE FROM collection_items WHERE collection_id = ?", (old,)
            )
            cursor.execute("DELETE FROM collections WHERE id = ?", (old,))
    return {"id": set_id, "count": count}


def get_pinned_set(set_id: int) -> Optional[Dict[str, Any]]:
    """``{"id", "count"}`` of a pinned set of the active library; None when it
    is gone, belongs to another library, or is an ordinary collection."""
    lib_sql, lib_params = _library_clause()
    img_sql, img_params = _library_clause("i.library_id")
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            f"SELECT 1 FROM collections WHERE id = ? AND slug LIKE ? AND {lib_sql}",
            (int(set_id), f"{PINNED_SLUG_PREFIX}%", *lib_params),
        )
        if cursor.fetchone() is None:
            return None
        cursor.execute(
            "SELECT COUNT(*) FROM collection_items ci JOIN images i ON i.id = ci.source_image_id "
            f"WHERE ci.collection_id = ? AND {img_sql}",
            (int(set_id), *img_params),
        )
        return {"id": int(set_id), "count": int(cursor.fetchone()[0])}
