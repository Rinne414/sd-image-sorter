"""Wander: batches that are like the start, never repeat, and drift on."""

from __future__ import annotations

import random

import numpy as np

from services import wander


def _library(groups=4, per_group=10, seed=3):
    """Pictures in well-separated groups; ids 1.., file names by group."""
    rng = np.random.default_rng(seed)
    rows, names = [], []
    for group in range(groups):
        centre = np.zeros(groups + 2, dtype=np.float32)
        centre[group] = 1.0
        for n in range(per_group):
            vector = centre + rng.normal(0, 0.02, centre.shape).astype(np.float32)
            rows.append(vector / np.linalg.norm(vector))
            names.append(f"g{group}-{n}.png")
    return np.arange(1, len(rows) + 1), names, np.stack(rows)


def test_a_batch_is_like_its_start_and_names_where_to_go_next():
    ids, names, matrix = _library()

    batch = wander.step(ids, names, matrix, 1, [], 5, random.Random(1))

    assert batch["start"] == {"id": 1, "filename": "g0-0.png"}
    assert [image["filename"][:2] for image in batch["images"]] == ["g0"] * 5
    assert 1 not in [image["id"] for image in batch["images"]]
    likeness = [image["similarity"] for image in batch["images"]]
    assert likeness == sorted(likeness, reverse=True)
    assert batch["next_start_id"] == batch["images"][-1]["id"]
    assert batch["left"] == 39 - 5


def test_a_walk_never_shows_a_picture_twice_and_ends_when_all_were_seen():
    ids, names, matrix = _library()
    rng = random.Random(7)
    seen, start = [], 1
    for _ in range(20):
        batch = wander.step(ids, names, matrix, start, seen, 6, rng)
        shown = [image["id"] for image in batch["images"]]
        if not shown:
            break
        assert not set(shown) & set(seen)
        seen.extend([batch["start"]["id"], *shown])
        start = batch["next_start_id"]

    assert sorted(set(seen)) == list(range(1, 41))
    # Everything seen: the walk says so instead of repeating.
    assert wander.step(ids, names, matrix, start, seen, 6, rng)["images"] == []


def test_the_walk_leaves_its_first_group_once_that_group_is_used_up():
    ids, names, matrix = _library()
    rng = random.Random(2)
    first = wander.step(ids, names, matrix, 1, [], 9, rng)
    seen = [1, *(image["id"] for image in first["images"])]

    second = wander.step(ids, names, matrix, first["next_start_id"], seen, 5, rng)

    assert all(image["filename"][:2] != "g0" for image in second["images"])


def test_no_start_begins_at_a_picture_not_seen_yet():
    ids, names, matrix = _library(groups=2, per_group=3)

    batch = wander.step(ids, names, matrix, None, [1, 2, 3], 2, random.Random(0))

    assert batch["start"]["id"] in (4, 5, 6)
    assert {image["id"] for image in batch["images"]} <= {4, 5, 6}
    # A start that is not in the index is treated the same way.
    assert wander.step(ids, names, matrix, 999, [], 2, random.Random(0))["start"][
        "id"
    ] in range(1, 7)


def test_the_endpoint_says_to_build_the_index_when_there_is_none(test_client):
    answer = test_client.post(
        "/api/similarity/wander", json={"seen_ids": [], "count": 12}
    )

    assert answer.status_code == 409
    assert "Similar page" in answer.text
