"""The gallery's random sort can be re-rolled, and one seed is one stable order."""

from __future__ import annotations

from pathlib import Path

import random_order


def _library(test_db, tmp_path: Path, count: int) -> list[int]:
    from PIL import Image

    ids = []
    for n in range(count):
        path = tmp_path / f"{n}.png"
        Image.new("RGB", (8, 8)).save(path)
        ids.append(test_db.add_image(path=str(path), filename=path.name, metadata_json="{}"))
    return ids


def _order(test_db, seed, limit=200, offset=0) -> list[int]:
    random_order.use_seed(seed)
    try:
        page = test_db.get_images(sort_by="random", limit=limit, offset=offset)
    finally:
        random_order.use_seed(None)
    rows = page if isinstance(page, list) else (page[0] if isinstance(page, tuple) else page["images"])
    return [row["id"] for row in rows]


def test_no_seed_keeps_the_historical_order_expression():
    assert random_order.order_sql(0) == "((i.id * 1103515245 + 12345) & 2147483647)"


def test_one_seed_is_one_order_and_another_seed_is_another(test_db, tmp_path):
    ids = _library(test_db, tmp_path, 60)

    first = _order(test_db, 12345)
    again = _order(test_db, 12345)
    other = _order(test_db, 54321)
    unseeded = _order(test_db, None)

    assert sorted(first) == sorted(ids)
    assert first == again
    assert other != first and sorted(other) == sorted(ids)
    assert unseeded != first
    # Not the same cycle started elsewhere: few pictures keep the same neighbour.
    following = {a: b for a, b in zip(first, first[1:])}
    kept = sum(1 for a, b in zip(other, other[1:]) if following.get(a) == b)
    assert kept < 6


def test_paging_a_seeded_shuffle_shows_every_picture_once(test_db, tmp_path):
    ids = _library(test_db, tmp_path, 45)

    pages = [_order(test_db, 777, limit=20, offset=start) for start in (0, 20, 40)]
    seen = [picture for page in pages for picture in page]

    assert sorted(seen) == sorted(ids)


def test_a_seed_outside_the_range_is_folded_into_it():
    random_order.use_seed(random_order.MAX_SEED + 5)
    try:
        assert 0 <= random_order.current_seed() <= random_order.MAX_SEED
    finally:
        random_order.use_seed(None)


def test_a_shuffle_has_no_fixed_stride(test_db, tmp_path):
    """One multiplication gave 133, 100, 67, 34, ...: the same step again and again."""
    _library(test_db, tmp_path, 147)

    for seed in (318770366, 1094695480, 441206410, 7):
        order = _order(test_db, seed)
        steps = [b - a for a, b in zip(order, order[1:])]
        most_common = max(steps.count(step) for step in set(steps))
        assert most_common < 12, (seed, order[:12])
