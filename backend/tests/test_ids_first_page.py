"""A shuffled page fetched ids-first is the page the single statement gave."""

from __future__ import annotations

import pytest

import db_ids_first_page
import random_order


@pytest.fixture
def library(test_db, tmp_path):
    ids = []
    for n in range(60):
        ids.append(
            test_db.add_image(
                path=str(tmp_path / f"p{n:03d}.png"),
                filename=f"p{n:03d}.png",
                generator="comfyui" if n % 3 else "nai",
                width=8,
                height=8,
            )
        )
    yield test_db
    random_order.use_seed(0)


def _one_statement(monkeypatch):
    """The listing as it was: whole rows sorted in one statement."""

    def plain(cursor, query, select_cols, params, order_clause, limit, offset=None):
        tail = " LIMIT ?" if offset is None else " LIMIT ? OFFSET ?"
        page = [limit] if offset is None else [limit, offset]
        cursor.execute(f"{query} ORDER BY {order_clause}{tail}", [*params, *page])
        return cursor.fetchall()

    monkeypatch.setattr(db_ids_first_page, "fetch_page", plain)


@pytest.mark.parametrize("seed", [0, 7, 123456])
@pytest.mark.parametrize("filters", [{}, {"generators": ["nai"]}])
def test_the_gallery_page_is_the_same_page(library, monkeypatch, seed, filters):
    random_order.use_seed(seed)
    fast = library.get_images_paginated(sort_by="random", limit=25, **filters)

    _one_statement(monkeypatch)
    random_order.use_seed(seed)
    slow = library.get_images_paginated(sort_by="random", limit=25, **filters)

    assert [image["id"] for image in fast["images"]] == [
        image["id"] for image in slow["images"]
    ]
    assert fast["has_more"] == slow["has_more"]
    assert fast["images"][0].keys() == slow["images"][0].keys()


@pytest.mark.parametrize("offset", [0, 20, 55, 200])
def test_a_page_further_down_is_the_same_page(library, monkeypatch, offset):
    random_order.use_seed(99)
    fast = library.get_images(sort_by="random", limit=10, offset=offset)

    _one_statement(monkeypatch)
    random_order.use_seed(99)
    slow = library.get_images(sort_by="random", limit=10, offset=offset)

    assert [image["id"] for image in fast] == [image["id"] for image in slow]


def test_another_shape_of_query_runs_as_one_statement(library):
    from db_core import get_db

    with get_db() as conn:
        rows = db_ids_first_page.fetch_page(
            conn.cursor(), "SELECT id FROM images", "i.id", [], "id ASC", 5
        )

    assert len(rows) == 5
