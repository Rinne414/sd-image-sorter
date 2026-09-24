"""Two first requests in a new library must not both fail on Favorites.

ensure_favorites_collection checks for the row, then inserts it. Two requests
that both miss the check used to hit UNIQUE(library_id, slug) and return 500.
"""

from __future__ import annotations

import db_collections
import db_libraries as libdb
from library_context import reset_current_library_id, set_current_library_id


def test_second_racing_insert_returns_the_existing_favorites(test_db, monkeypatch):
    libdb.ensure_default_library()
    other = libdb.create_library("Fresh")
    token = set_current_library_id(other["id"])
    try:
        # Both callers "see" no Favorites row, as two concurrent requests would.
        monkeypatch.setattr(db_collections, "get_collection_by_slug", lambda slug: None)
        first = db_collections.ensure_favorites_collection()
        second = db_collections.ensure_favorites_collection()
    finally:
        reset_current_library_id(token)

    assert first["id"] == second["id"]
    assert first["slug"] == db_collections.FAVORITES_COLLECTION_SLUG
