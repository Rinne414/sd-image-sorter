"""Fixing duplicate rating tags refreshes the cached tag counts at once.

Tag autocomplete answers from the cached per-library tag counts (8e4c2ea).
fix_rating_tags deleted tag rows without dropping that cache, so the removed
rating tags kept showing (with their old counts) for up to 60 seconds.
"""

from __future__ import annotations

import database as db
from services.tagging_service import TaggingService


def _insert_rating(image_id: int, tag: str, confidence: float) -> None:
    with db.get_db() as conn:
        conn.execute(
            "INSERT INTO tags (image_id, tag, confidence, category) VALUES (?, ?, ?, 'rating')",
            (image_id, tag, confidence),
        )
        conn.commit()


def test_removed_rating_tags_leave_the_tag_search_at_once(test_db):
    image_id = db.add_image(path="/test/fix-cache.png", filename="fix-cache.png")
    _insert_rating(image_id, "general", 0.9)
    _insert_rating(image_id, "sensitive", 0.4)
    db.search_tags("sensitive")  # warm the cached counts
    assert db.search_tags("sensitive")["total"] == 1

    TaggingService().fix_rating_tags()

    assert db.search_tags("sensitive")["total"] == 0
    assert [item["tag"] for item in db.search_tags("general")["tags"]] == ["general"]
