"""Missing-file repair review persistence (Roadmap-C).

Stores the *ambiguous* matches from a missing-file reconnect run so the user can
review and explicitly resolve them (pick / merge / skip) later. Each row pins a
found-on-disk file to the set of competing missing library-row ids by
name+size; the invariant is that none of those image rows are touched until the
user confirms.

Imports only from db_core / db_helpers / stdlib to avoid an import cycle with the
``database`` facade (mirrors db_library_roots.py / db_collections.py).
"""
from __future__ import annotations

import json
import time
from typing import Optional, List, Dict, Any

from db_core import get_db
from db_helpers import _row_to_dict


# Statuses a persisted review row can carry.
REVIEW_STATUS_PENDING = "pending"
REVIEW_STATUS_RESOLVED = "resolved"
REVIEW_STATUS_CONFLICT = "conflict"


def _row_to_review_dict(row: Any) -> Optional[Dict[str, Any]]:
    """Convert a raw row into a dict, decoding candidate_ids into a list of ints."""
    record = _row_to_dict(row)
    if record is None:
        return None
    raw_ids = record.get("candidate_ids")
    parsed: List[int] = []
    try:
        loaded = json.loads(raw_ids) if raw_ids else []
    except (TypeError, ValueError):
        loaded = []
    if isinstance(loaded, list):
        for value in loaded:
            try:
                parsed.append(int(value))
            except (TypeError, ValueError):
                continue
    record["candidate_ids"] = parsed
    return record


def add_reconnect_review(
    *,
    filename: str,
    found_path: str,
    candidate_ids: List[int],
    candidate_count: int,
    run_started_at: float,
) -> int:
    """Persist one pending ambiguous-match review row. Returns the new review id."""
    normalized_ids = []
    seen: set[int] = set()
    for value in candidate_ids or []:
        try:
            image_id = int(value)
        except (TypeError, ValueError):
            continue
        if image_id <= 0 or image_id in seen:
            continue
        seen.add(image_id)
        normalized_ids.append(image_id)

    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO reconnect_reviews (
                filename, found_path, candidate_ids, candidate_count,
                run_started_at, status
            )
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                str(filename or ""),
                str(found_path or ""),
                json.dumps(normalized_ids),
                int(candidate_count),
                float(run_started_at),
                REVIEW_STATUS_PENDING,
            ),
        )
        return int(cursor.lastrowid)


def delete_pending_reconnect_reviews() -> int:
    """Drop all still-pending review rows (called at the start of each run)."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "DELETE FROM reconnect_reviews WHERE status = ?",
            (REVIEW_STATUS_PENDING,),
        )
        return cursor.rowcount or 0


def prune_resolved_reconnect_reviews(keep: int = 500) -> int:
    """Keep only the newest ``keep`` non-pending (history) rows; delete the rest."""
    keep = max(0, int(keep))
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            DELETE FROM reconnect_reviews
            WHERE status != ?
              AND id NOT IN (
                  SELECT id FROM reconnect_reviews
                  WHERE status != ?
                  ORDER BY id DESC
                  LIMIT ?
              )
            """,
            (REVIEW_STATUS_PENDING, REVIEW_STATUS_PENDING, keep),
        )
        return cursor.rowcount or 0


def count_pending_reconnect_reviews() -> int:
    """Number of pending review rows currently persisted."""
    with get_db() as conn:
        row = conn.execute(
            "SELECT COUNT(*) FROM reconnect_reviews WHERE status = ?",
            (REVIEW_STATUS_PENDING,),
        ).fetchone()
        return int(row[0] or 0) if row else 0


def list_reconnect_reviews(
    *,
    status: Optional[str] = REVIEW_STATUS_PENDING,
    limit: int = 50,
    offset: int = 0,
) -> Dict[str, Any]:
    """Return ``{total, items}`` for reviews, optionally scoped to a status.

    ``status=None`` (or blank) lists every status. Newest first. ``candidate_ids``
    is decoded into a list of ints on each item.
    """
    normalized_limit = max(1, min(int(limit or 50), 500))
    normalized_offset = max(0, int(offset or 0))
    scope = str(status).strip() if status else ""

    where = ""
    params: List[Any] = []
    if scope:
        where = " WHERE status = ?"
        params.append(scope)

    with get_db() as conn:
        cursor = conn.cursor()
        total_row = cursor.execute(
            f"SELECT COUNT(*) FROM reconnect_reviews{where}", params
        ).fetchone()
        total = int(total_row[0] or 0) if total_row else 0

        cursor.execute(
            f"SELECT * FROM reconnect_reviews{where} ORDER BY id DESC LIMIT ? OFFSET ?",
            [*params, normalized_limit, normalized_offset],
        )
        items = [_row_to_review_dict(row) for row in cursor.fetchall()]

    return {"total": total, "items": items}


def get_reconnect_review(review_id: int) -> Optional[Dict[str, Any]]:
    """One review row by id (candidate_ids decoded), or ``None``."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM reconnect_reviews WHERE id = ?",
            (int(review_id),),
        )
        row = cursor.fetchone()
        return _row_to_review_dict(row) if row else None


def resolve_reconnect_review(
    review_id: int,
    *,
    status: str,
    resolution: Optional[str] = None,
    chosen_image_id: Optional[int] = None,
) -> bool:
    """Flip a review to a terminal status (resolved/conflict). True if a row changed."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            UPDATE reconnect_reviews
            SET status = ?, resolution = ?, chosen_image_id = ?, resolved_at = ?
            WHERE id = ?
            """,
            (
                str(status),
                resolution,
                int(chosen_image_id) if chosen_image_id is not None else None,
                time.time(),
                int(review_id),
            ),
        )
        return cursor.rowcount > 0
