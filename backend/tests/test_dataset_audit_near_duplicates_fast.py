"""The dataset audit's full near-duplicate check must stay usable on big sets.

The pairwise pass was pure Python (about 90 s for 20k hashes and ~10 min for
50k, inside one request, no cancel). The numpy pass must give exactly the same groups as the Python
pass, including invalid, empty and different-length hashes.
"""

from __future__ import annotations

import random

import pytest

from services import dataset_audit_service as audit


def _random_hashes(seed: int, count: int) -> list:
    rng = random.Random(seed)
    base = [rng.getrandbits(64) for _ in range(count // 4)]
    hashes: list = []
    for index in range(count):
        roll = rng.random()
        if roll < 0.05:
            hashes.append(None)
        elif roll < 0.08:
            hashes.append("not-hex")
        elif roll < 0.12:
            hashes.append(f"{rng.getrandbits(16):04x}")  # shorter digest
        elif roll < 0.15:
            hashes.append(f"{rng.getrandbits(128):032x}")  # longer digest
        else:
            value = rng.choice(base)
            for _ in range(rng.randint(0, 12)):
                value ^= 1 << rng.randrange(64)
            hashes.append(f"{value:016x}" if index % 7 else f"{value:016X}")
    return hashes


@pytest.mark.parametrize("seed", [1, 2, 3])
@pytest.mark.parametrize("phash_max", [0, 4, 10])
def test_numpy_pass_groups_exactly_like_the_python_pass(seed, phash_max):
    hashes = _random_hashes(seed, 600)

    fast = audit._near_duplicate_clusters_numpy(hashes, phash_max)
    slow = audit._near_duplicate_clusters_python(hashes, phash_max)

    assert fast == slow
    assert fast, "the fixture should produce some groups"


def test_full_check_on_twenty_thousand_hashes_finishes_quickly():
    import time

    hashes = _random_hashes(7, 20_000)
    rows = [{"image_id": i + 1, "abs_path": f"/d/{i}.png", "phash_hex": h} for i, h in enumerate(hashes)]

    started = time.perf_counter()
    groups = audit._build_duplicate_groups(rows, 6, full=True)
    elapsed = time.perf_counter() - started

    assert groups
    # The Python pass needs minutes here; the numpy pass a few seconds.
    assert elapsed < 30, f"full near-duplicate check took {elapsed:.1f}s"
