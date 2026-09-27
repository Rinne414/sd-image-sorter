"""The cached tag counts notice tags written by another process.

Tag autocomplete answers from the cached per-library tag counts (8e4c2ea).
A tag written outside this server (a script, or V3.5 and V4 on the same
database) stayed invisible for up to the cache lifetime. Before the cache is
used, a cheap marker (highest tag row id, tag row count, image count of the
library) is compared with the one the cache was built at.
"""

from __future__ import annotations

import sqlite3

import database as db
import db_core


def _outside(sql: str, params: tuple = ()) -> None:
    conn = sqlite3.connect(db.DATABASE_PATH)
    try:
        conn.execute(sql, params)
        conn.commit()
    finally:
        conn.close()


def test_a_tag_written_by_another_process_is_found_at_once(test_db):
    image_id = db.add_image(path="/test/outside-a.png", filename="outside-a.png")
    db.add_tags(image_id, [{"tag": "inside_tag", "confidence": 0.9}])
    assert db.search_tags("inside")["total"] == 1  # cache built

    _outside(
        "INSERT INTO tags (image_id, tag, confidence) VALUES (?, 'outside_written_tag', 0.9)",
        (image_id,),
    )
    assert [item["tag"] for item in db.search_tags("outside_written")["tags"]] == [
        "outside_written_tag"
    ]

    _outside("DELETE FROM tags WHERE tag = 'outside_written_tag'")
    assert db.search_tags("outside_written")["total"] == 0


def test_an_image_moved_to_another_library_elsewhere_leaves_the_counts(test_db):
    image_id = db.add_image(path="/test/outside-move.png", filename="outside-move.png")
    db.add_tags(image_id, [{"tag": "moving_tag", "confidence": 0.9}])
    assert db.search_tags("moving")["total"] == 1

    _outside("UPDATE images SET library_id = 'elsewhere' WHERE id = ?", (image_id,))
    assert db.search_tags("moving")["total"] == 0


def test_without_changes_the_cached_counts_are_reused(test_db):
    image_id = db.add_image(path="/test/outside-b.png", filename="outside-b.png")
    db.add_tags(image_id, [{"tag": "steady_tag", "confidence": 0.9}])

    first = db.get_all_tags()
    second = db.get_all_tags()

    assert second is first
    assert db_core._tags_cache_data is first
