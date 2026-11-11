"""Pick N pictures that differ most: variety first, oddities last."""

from __future__ import annotations

import numpy as np

from services import varied_pick


def _clusters(sizes, spread=0.01, seed=7):
    """Rows grouped around well-separated directions; returns (vectors, cluster number per row)."""
    rng = np.random.default_rng(seed)
    centres = np.eye(len(sizes) + 2, dtype=np.float32)
    rows, labels = [], []
    for cluster, size in enumerate(sizes):
        for _ in range(size):
            rows.append(
                centres[cluster]
                + rng.normal(0, spread, centres.shape[1]).astype(np.float32)
            )
            labels.append(cluster)
    return np.stack(rows), labels


def test_one_picture_from_every_group_before_a_second_from_any():
    vectors, labels = _clusters([40, 5, 12, 3])

    picked = varied_pick.pick_indexes(vectors, 4)

    assert sorted(labels[row] for row in picked) == [0, 1, 2, 3]
    # The first pick is a typical picture: one of the biggest group.
    assert labels[picked[0]] == 0


def test_asking_for_all_or_more_returns_every_picture_once():
    vectors, _labels = _clusters([3, 2])
    assert sorted(varied_pick.pick_indexes(vectors, 5)) == [0, 1, 2, 3, 4]
    assert sorted(varied_pick.pick_indexes(vectors, 50)) == [0, 1, 2, 3, 4]
    assert varied_pick.pick_indexes(vectors, 0) == []
    assert varied_pick.pick_indexes(np.zeros((0, 4), dtype=np.float32), 3) == []


def test_the_odd_ones_wait_until_the_ordinary_pictures_are_used():
    vectors, labels = _clusters([30, 30])
    odd = np.zeros((2, vectors.shape[1]), dtype=np.float32)
    odd[0, -1] = 1.0  # like nothing else: a screenshot, a broken render
    odd[1, -2] = 1.0
    vectors = np.vstack([vectors, odd])

    picked = varied_pick.pick_indexes(vectors, 6)

    assert not {60, 61} & set(picked)
    assert {labels[row] for row in picked} == {0, 1}
    # Asked for everything, they do come: nothing is dropped.
    assert {60, 61} <= set(varied_pick.pick_indexes(vectors, 62))


def test_the_same_pile_gives_the_same_pick():
    vectors, _labels = _clusters([20, 20, 20])
    assert varied_pick.pick_indexes(vectors, 9) == varied_pick.pick_indexes(
        vectors.copy(), 9
    )


def test_pictures_without_a_vector_are_counted_not_guessed(monkeypatch):
    vectors, _labels = _clusters([4, 4])
    stored = {10 + row: vectors[row] for row in range(8)}
    stored[99] = np.ones(
        7, dtype=np.float32
    )  # an index of another model: cannot be compared
    monkeypatch.setattr(
        varied_pick, "_vectors", lambda ids: {i: stored[i] for i in ids if i in stored}
    )

    picked, left_out = varied_pick.pick_varied(
        [10, 11, 12, 13, 14, 15, 16, 17, 50, 51, 99], 2
    )

    assert len(picked) == 2 and set(picked) <= set(range(10, 18))
    assert {(p - 10) // 4 for p in picked} == {0, 1}
    assert left_out == 3
    assert varied_pick.pick_varied([50, 51], 2) == ([], 2)
