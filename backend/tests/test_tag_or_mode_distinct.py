"""Tag "any of" mode (tag_mode=or) lists each matching image once.

An image carrying two of the requested tags used to come back twice from the
gallery list and the selection queries (one row per matching tag), while the
count said otherwise. V4's search line sends tag_mode=or for ``tag:a|b``.
"""

from __future__ import annotations

from types import ModuleType

from utils.pagination_cursor import decode_image_cursor


def _seed(database: ModuleType) -> None:
    with database.get_db() as conn:
        for index in range(1, 5):
            conn.execute(
                "INSERT INTO images (path, filename, generator, created_at) VALUES (?, ?, 'nai', ?)",
                (
                    f"/or-mode/i{index}.png",
                    f"i{index}.png",
                    f"2026-01-0{index} 00:00:00",
                ),
            )
        conn.execute(
            "INSERT INTO tags (image_id, tag, confidence) VALUES "
            "(1, 'cat_ears', 1), (1, 'fox_ears', 1), (2, 'cat_ears', 1), (3, 'fox_ears', 1), (4, 'smile', 1)"
        )


def test_paginated_list_has_each_image_once(test_db: ModuleType) -> None:
    _seed(test_db)
    page = test_db.get_images_paginated(
        tags=["cat_ears", "fox_ears"], tag_mode="or", limit=50
    )
    ids = [row["id"] for row in page["images"]]
    assert sorted(ids) == [1, 2, 3]
    assert len(ids) == len(set(ids))
    assert page["total"] == 3


def test_paginated_list_pages_do_not_repeat(test_db: ModuleType) -> None:
    _seed(test_db)
    seen: list[int] = []
    cursor = None
    for _ in range(5):
        page = test_db.get_images_paginated(
            tags=["cat_ears", "fox_ears"],
            tag_mode="or",
            limit=1,
            cursor_id=cursor.image_id if cursor else None,
            cursor_sort_value=cursor.sort_value if cursor else None,
            cursor_is_opaque=cursor.is_opaque if cursor else False,
        )
        seen.extend(row["id"] for row in page["images"])
        if not page.get("has_more"):
            break
        cursor = decode_image_cursor(page["next_cursor"])
    assert seen == [3, 2, 1]


def test_unpaged_query_has_each_image_once(test_db: ModuleType) -> None:
    _seed(test_db)
    ids = [
        row["id"]
        for row in test_db.get_images(tags=["cat_ears", "fox_ears"], tag_mode="or")
    ]
    assert sorted(ids) == [1, 2, 3]


def test_and_mode_is_unchanged(test_db: ModuleType) -> None:
    _seed(test_db)
    page = test_db.get_images_paginated(
        tags=["cat_ears", "fox_ears"], tag_mode="and", limit=50
    )
    assert [row["id"] for row in page["images"]] == [1]
