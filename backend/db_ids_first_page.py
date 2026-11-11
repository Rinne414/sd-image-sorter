"""A page of a shuffled gallery, without reading every picture's whole row.

The random order has no index: SQLite computes the shuffle value of every
picture that matches and sorts them. Asked for whole rows, it read each
picture's full record (prompts and metadata included) to do so: 0.76 s for
the first page of 100,000 pictures and 9 s for a page half-way down. Asked
for ids only, the same sort runs from an index (0.34 s and 0.42 s, measured
2026-11-12), and the rows of the one page are then fetched by id.
"""

from __future__ import annotations

import sqlite3
from typing import Any, List, Optional, Sequence


def fetch_page(
    cursor: sqlite3.Cursor,
    query: str,
    select_cols: str,
    params: Sequence[Any],
    order_clause: str,
    limit: int,
    offset: Optional[int] = None,
) -> List[sqlite3.Row]:
    """Rows of ``query`` in ``order_clause`` order: ids first, then their rows.

    ``query`` is the listing's ``SELECT {select_cols} FROM images i ... WHERE ...``
    without ORDER BY. Any other shape runs as one statement, as before.
    """
    head = f"SELECT {select_cols} FROM images i"
    tail = " LIMIT ?" if offset is None else " LIMIT ? OFFSET ?"
    page = [limit] if offset is None else [limit, offset]
    if not query.startswith(head):
        cursor.execute(f"{query} ORDER BY {order_clause}{tail}", [*params, *page])
        return cursor.fetchall()

    cursor.execute(
        f"SELECT i.id FROM images i{query[len(head) :]} ORDER BY {order_clause}{tail}",
        [*params, *page],
    )
    ids = [int(row[0]) for row in cursor.fetchall()]
    if not ids:
        return []
    cursor.execute(f"{head} WHERE i.id IN ({','.join(str(i) for i in set(ids))})")
    by_id = {int(row["id"]): row for row in cursor.fetchall()}
    return [by_id[i] for i in ids if i in by_id]
