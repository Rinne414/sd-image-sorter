"""Which library pictures a sort already put somewhere (migration 051).

Auto-Separate and Manual Sort record every picture they copied or moved, so
Manual Sort can leave those out of its queue ("auto-sort first, hand-sort the
rest"). One row per picture: the latest sort wins, and a Manual Sort undo
gives back the row its action replaced.

Imports only db_core (no ``database`` facade).
"""

from __future__ import annotations

from typing import Any, Dict, Iterable, Optional, Set

from db_core import get_db

SOURCE_AUTO_SEPARATE = "auto_separate"
SOURCE_MANUAL_SORT = "manual_sort"
VALID_SOURCES = frozenset({SOURCE_AUTO_SEPARATE, SOURCE_MANUAL_SORT})
VALID_OPERATIONS = frozenset({"copy", "move"})


def mark_image_sorted(image_id: int, source: str, operation: str) -> None:
    """Record that ``image_id`` was copied or moved by ``source`` just now."""
    if source not in VALID_SOURCES:
        raise ValueError(f"unknown sort source: {source!r}")
    if operation not in VALID_OPERATIONS:
        raise ValueError(f"unknown sort operation: {operation!r}")
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO sorted_images (image_id, source, operation, sorted_at)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(image_id) DO UPDATE SET
                source = excluded.source,
                operation = excluded.operation,
                sorted_at = excluded.sorted_at
            """,
            (int(image_id), source, operation),
        )


def get_sorted_mark(image_id: int) -> Optional[Dict[str, Any]]:
    """Return ``{"source", "operation", "sorted_at"}`` or None if never sorted."""
    with get_db() as conn:
        row = conn.execute(
            "SELECT source, operation, sorted_at FROM sorted_images WHERE image_id = ?",
            (int(image_id),),
        ).fetchone()
    if row is None:
        return None
    return {"source": row[0], "operation": row[1], "sorted_at": row[2]}


def restore_sorted_mark(image_id: int, mark: Optional[Dict[str, Any]]) -> None:
    """Put back the mark a later sort replaced; None means "was not sorted"."""
    with get_db() as conn:
        if mark is None:
            conn.execute(
                "DELETE FROM sorted_images WHERE image_id = ?", (int(image_id),)
            )
            return
        conn.execute(
            """
            INSERT OR REPLACE INTO sorted_images (image_id, source, operation, sorted_at)
            VALUES (?, ?, ?, ?)
            """,
            (int(image_id), mark["source"], mark["operation"], mark["sorted_at"]),
        )


def sorted_ids_among(image_ids: Iterable[int]) -> Set[int]:
    """Return the ids in ``image_ids`` that a sort already put somewhere."""
    wanted = {int(image_id) for image_id in image_ids}
    if not wanted:
        return set()
    with get_db() as conn:
        rows = conn.execute("SELECT image_id FROM sorted_images").fetchall()
    return {int(row[0]) for row in rows} & wanted
