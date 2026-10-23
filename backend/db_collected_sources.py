"""Where a collected picture came from (migration 064, table ``collected_sources``).

A picture saved from a web page or pasted into the program keeps the picture's
address, the page it was on, the page title, when it was collected and how.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from db_core import get_db

VIA_VALUES = frozenset({"extension", "paste", "url"})


def record_collected_source(
    image_id: int,
    *,
    source_url: Optional[str],
    page_url: Optional[str],
    page_title: Optional[str],
    collected_at: str,
    via: str,
) -> None:
    """Store (or replace) the source of one picture."""
    if via not in VIA_VALUES:
        raise ValueError(f"Unknown collect route: {via!r}")
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO collected_sources
                (image_id, source_url, page_url, page_title, collected_at, via)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(image_id) DO UPDATE SET
                source_url = excluded.source_url,
                page_url = excluded.page_url,
                page_title = excluded.page_title,
                collected_at = excluded.collected_at,
                via = excluded.via
            """,
            (int(image_id), source_url, page_url, page_title, collected_at, via),
        )


def get_collected_source(image_id: int) -> Optional[Dict[str, Any]]:
    """The stored source of one picture, or None when it was not collected."""
    with get_db() as conn:
        row = conn.execute(
            """
            SELECT image_id, source_url, page_url, page_title, collected_at, via
            FROM collected_sources WHERE image_id = ?
            """,
            (int(image_id),),
        ).fetchone()
    return dict(row) if row else None
