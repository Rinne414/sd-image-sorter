"""Collections inside collections: where each one sits and the rules for moving.

A collection's ``parent_id`` (migration 068) is NULL at the top level or the id
of the collection it sits in. The rules live here, not in SQL constraints:

- the parent is a visible collection of the active library (not Favorites, not
  a hidden "~" set);
- a collection never moves under itself or one of its own sub-collections;
- Favorites stays at the top level;
- deleting a collection moves its sub-collections up one level, so deleting a
  parent never deletes anything below it.

A parent shows only its own pictures; nothing here changes membership.
"""

from __future__ import annotations

import sqlite3
from typing import Dict, Optional

from config import FAVORITES_COLLECTION_SLUG
from db_core import get_db

HIDDEN_SLUG_PREFIX = "~"


class CollectionTreeError(ValueError):
    """A move or create the tree rules refuse; the message says why."""


def _library_clause(column: str = "library_id"):
    from library_context import current_library_sql

    return current_library_sql(column)


def _visible_parents(cursor: sqlite3.Cursor) -> Dict[int, Optional[int]]:
    """id -> parent_id for every visible collection of the active library."""
    lib_sql, lib_params = _library_clause()
    cursor.execute(
        f"SELECT id, parent_id, slug FROM collections WHERE {lib_sql} AND slug NOT LIKE ?",
        (*lib_params, f"{HIDDEN_SLUG_PREFIX}%"),
    )
    return {
        int(row[0]): (int(row[1]) if row[1] is not None else None)
        for row in cursor.fetchall()
    }


def _slug_of(cursor: sqlite3.Cursor, collection_id: int) -> Optional[str]:
    lib_sql, lib_params = _library_clause()
    cursor.execute(
        f"SELECT slug FROM collections WHERE id = ? AND {lib_sql}",
        (collection_id, *lib_params),
    )
    row = cursor.fetchone()
    return None if row is None else str(row[0])


def check_parent(cursor: sqlite3.Cursor, parent_id: Optional[int]) -> None:
    """Refuse a parent that is missing, hidden or Favorites (None: top level, always fine)."""
    if parent_id is None:
        return
    slug = _slug_of(cursor, parent_id)
    if slug is None or slug.startswith(HIDDEN_SLUG_PREFIX):
        raise CollectionTreeError("That collection no longer exists. / 这个合集已经不在了。")
    if slug == FAVORITES_COLLECTION_SLUG:
        raise CollectionTreeError(
            "Favorites cannot hold other collections. / 收藏里不能放其他合集。"
        )


def _is_inside(
    parents: Dict[int, Optional[int]], candidate: int, ancestor: int
) -> bool:
    """True when ``candidate`` is ``ancestor`` or sits somewhere below it."""
    seen = set()
    node: Optional[int] = candidate
    while node is not None and node not in seen:
        if node == ancestor:
            return True
        seen.add(node)
        node = parents.get(node)
    return False


def move_collection(collection_id: int, parent_id: Optional[int]) -> bool:
    """Put a collection under ``parent_id`` (None: the top level). False when it does not exist."""
    with get_db() as conn:
        # Check and write in one write transaction: two moves at once (A into B,
        # B into A) cannot both pass the check and leave a loop.
        conn.execute("BEGIN IMMEDIATE")
        cursor = conn.cursor()
        slug = _slug_of(cursor, collection_id)
        if slug is None or slug.startswith(HIDDEN_SLUG_PREFIX):
            return False
        if slug == FAVORITES_COLLECTION_SLUG:
            if parent_id is None:
                return True
            raise CollectionTreeError("Favorites stays at the top level. / 收藏只能在最上层。")
        check_parent(cursor, parent_id)
        if parent_id is not None and _is_inside(
            _visible_parents(cursor), parent_id, collection_id
        ):
            raise CollectionTreeError(
                "A collection cannot go inside itself or one of its own sub-collections. / "
                "合集不能放进它自己或它下面的合集里。"
            )
        lib_sql, lib_params = _library_clause()
        cursor.execute(
            f"UPDATE collections SET parent_id = ? WHERE id = ? AND {lib_sql}",
            (parent_id, collection_id, *lib_params),
        )
        return cursor.rowcount > 0


def lift_children(cursor: sqlite3.Cursor, collection_id: int) -> None:
    """Before a collection is deleted: its sub-collections move up to its own parent."""
    lib_sql, lib_params = _library_clause()
    cursor.execute(
        f"SELECT parent_id FROM collections WHERE id = ? AND {lib_sql}",
        (collection_id, *lib_params),
    )
    row = cursor.fetchone()
    grandparent = row[0] if row is not None else None
    cursor.execute(
        f"UPDATE collections SET parent_id = ? WHERE parent_id = ? AND {lib_sql}",
        (grandparent, collection_id, *lib_params),
    )
