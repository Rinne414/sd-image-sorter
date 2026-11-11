"""Wander: browse for ideas, batch by batch, drifting away from where you started.

A similarity search answers "more like this" and always shows the same
neighbours. Wandering is for looking around: from a starting picture it shows a
batch of pictures that are somewhat like it, never one already shown, and the
next batch starts from the least similar picture of this one, so the walk
drifts through the library instead of circling its start.

Each batch is drawn from a random sample of the pictures not shown yet (the
pool) and ranked by similarity to the current start. The pool is what keeps two
walks from the same picture different, and keeps a step cheap on a large
library: one matrix product over the pool, not over everything.

Uses the similarity index's vector cache; nothing is computed for pictures
that are not indexed.
"""

from __future__ import annotations

import random
from typing import Any, Dict, List, Optional, Sequence

import numpy as np

POOL_SIZE = 600


class NotIndexedError(RuntimeError):
    """The library has no similarity index to wander through."""


def step(
    ids: np.ndarray,
    filenames: Sequence[str],
    matrix: np.ndarray,
    start_id: Optional[int],
    seen_ids: Sequence[int],
    count: int,
    rng: random.Random,
) -> Dict[str, Any]:
    """One batch of the walk over the given vectors (rows are L2-normalised)."""
    row_of = {int(image_id): row for row, image_id in enumerate(ids)}
    seen = {int(image_id) for image_id in seen_ids}
    start_row = row_of.get(int(start_id)) if start_id is not None else None
    fresh = [row for image_id, row in row_of.items() if image_id not in seen]
    if start_row is None:
        # No start, or one that is not indexed: begin somewhere not seen yet.
        if not fresh:
            return {"start": None, "images": [], "next_start_id": None, "left": 0}
        start_row = rng.choice(fresh)
    start = {"id": int(ids[start_row]), "filename": str(filenames[start_row])}
    open_rows = [row for row in fresh if row != start_row]
    pool = rng.sample(open_rows, min(POOL_SIZE, len(open_rows)))
    if not pool:
        return {"start": start, "images": [], "next_start_id": None, "left": 0}
    likeness = matrix[pool] @ matrix[start_row]
    order = np.argsort(-likeness)[: max(1, int(count))]
    images: List[Dict[str, Any]] = [
        {
            "id": int(ids[pool[position]]),
            "filename": str(filenames[pool[position]]),
            "similarity": round(float(likeness[position]), 4),
        }
        for position in order
    ]
    return {
        "start": start,
        "images": images,
        # The least like the start among those shown: the walk moves on from there.
        "next_start_id": images[-1]["id"],
        "left": len(open_rows) - len(images),
    }


def next_batch(
    start_id: Optional[int],
    seen_ids: Sequence[int],
    count: int,
    rng: Optional[random.Random] = None,
) -> Dict[str, Any]:
    """The next batch for the open library, from its similarity index."""
    import database as db
    from similarity import get_similarity_index

    cache = get_similarity_index(db)._ensure_vector_cache()
    if not cache or len(cache.get("ids", [])) == 0:
        raise NotIndexedError(
            "The similarity index is empty. Build it on the Similar page first."
        )
    return step(
        cache["ids"],
        cache["filenames"],
        cache["matrix"],
        start_id,
        seen_ids,
        count,
        rng or random.Random(),
    )
