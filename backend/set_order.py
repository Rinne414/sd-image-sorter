"""Show a set of pictures in the order the set was made.

"Search by meaning" hands the Gallery the closest pictures as one set. The
Gallery's sorts (date, name, size...) throw the ranking away, so the closest
match could be anywhere on the page. ``sort_by=set_order`` keeps it: pictures
come in the order they were put into the set (the order of ``collection_items``
rows), which for a described set is closest first.

The set travels in a context variable set by the listing request, like the
random order's seed (``random_order.py``): the ORDER BY builder is called deep
inside query code that takes no such argument. With no set, the order falls
back to the newest-first default, so the sort is harmless on a view that is
not a set.
"""

from __future__ import annotations

from contextvars import ContextVar
from typing import Optional

from db_query_columns import _DEFAULT_ORDER_CLAUSE

_collection_id: ContextVar[int] = ContextVar("gallery_set_order_collection", default=0)

# A picture that is not in the set (it cannot be listed under the set's own
# filter, but another filter might ask for this sort) goes after every member.
_AFTER_ALL = 9223372036854775807


def use_collection(collection_id: Optional[int]) -> None:
    """Name the set for the rest of this request (None or a bad id: no set)."""
    try:
        value = int(collection_id or 0)
    except (TypeError, ValueError):
        value = 0
    _collection_id.set(value if value > 0 else 0)


def order_clause() -> str:
    """The ORDER BY clause: the set's own order, else newest first."""
    collection_id = _collection_id.get()
    if collection_id <= 0:
        return _DEFAULT_ORDER_CLAUSE
    # The id is an integer this module made itself, never request text.
    position = (
        "COALESCE((SELECT MIN(ci.id) FROM collection_items ci "
        f"WHERE ci.collection_id = {int(collection_id)} AND ci.source_image_id = i.id), {_AFTER_ALL})"
    )
    return f"{position} ASC, i.id ASC"
