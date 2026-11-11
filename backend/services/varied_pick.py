"""Pick the N pictures that differ most from one another.

Cutting a pile of candidates down to a training set by eye is slow, and the
eye keeps near-duplicates. This picks for variety from the similarity vectors
the library already has: start at the most typical picture, then keep adding
the picture least like anything picked so far (farthest-point sampling).

One guard: a picture that resembles nothing else in the pile (a screenshot, a
broken render) would otherwise be picked first. Such isolated pictures are held
back until the others are used up. A small group of look-alikes is not
isolated: its members have each other.
"""

from __future__ import annotations

from typing import Dict, List, Sequence, Tuple

import numpy as np

import database as db
from similarity_math import bytes_to_embedding

# Above this many pictures the "nothing resembles it" check (every picture against
# every other) is skipped: the pick is then plain farthest-point sampling.
ISOLATION_CHECK_MAX = 20000
_ID_CHUNK = 900
_ROW_CHUNK = 1024


def _isolated(unit: np.ndarray) -> np.ndarray:
    """Which rows have no near neighbour at all, judged against the pile itself.

    For every picture: how like it is to the picture most like it. A small
    group of look-alikes scores high here (they have each other), so a rare
    but real kind of picture is not mistaken for an oddity. A row counts as
    isolated when that score falls below the usual range of the pile (the
    lower Tukey fence).
    """
    total = len(unit)
    if total < 8 or total > ISOLATION_CHECK_MAX:
        return np.zeros(total, dtype=bool)
    closest = np.empty(total, dtype=np.float32)
    for start in range(0, total, _ROW_CHUNK):
        block = unit[start : start + _ROW_CHUNK] @ unit.T
        block[np.arange(len(block)), np.arange(start, start + len(block))] = -np.inf
        closest[start : start + len(block)] = block.max(axis=1)
    low, high = np.percentile(closest, [25, 75])
    return closest < low - 1.5 * (high - low)


def pick_indexes(vectors: np.ndarray, count: int) -> List[int]:
    """Row numbers of ``count`` rows of ``vectors`` chosen for variety, in the order picked."""
    total = len(vectors)
    if total == 0 or count <= 0:
        return []
    if count >= total:
        return list(range(total))
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    unit = (vectors / np.where(norms == 0, 1.0, norms)).astype(np.float32)
    centre = unit.mean(axis=0)
    centre_norm = np.linalg.norm(centre)
    typical = unit @ (centre / centre_norm if centre_norm else centre)

    held_back = _isolated(unit)
    first = int(np.argmax(np.where(held_back, -np.inf, typical)))
    picked = [first]
    taken = np.zeros(total, dtype=bool)
    taken[first] = True
    # For every picture: how like it is to the most similar picture picked so far.
    nearest = unit @ unit[first]
    while len(picked) < count:
        open_rows = ~taken & ~held_back
        if not open_rows.any():
            open_rows = ~taken
        choice = int(np.argmin(np.where(open_rows, nearest, np.inf)))
        picked.append(choice)
        taken[choice] = True
        nearest = np.maximum(nearest, unit @ unit[choice])
    return picked


def _vectors(image_ids: Sequence[int]) -> Dict[int, np.ndarray]:
    found: Dict[int, np.ndarray] = {}
    with db.get_db() as conn:
        for start in range(0, len(image_ids), _ID_CHUNK):
            chunk = list(image_ids[start : start + _ID_CHUNK])
            marks = ",".join("?" for _ in chunk)
            rows = conn.execute(
                f"SELECT id, embedding FROM images WHERE id IN ({marks}) AND embedding IS NOT NULL",
                chunk,
            ).fetchall()
            for row in rows:
                found[int(row["id"])] = bytes_to_embedding(row["embedding"])
    return found


def pick_varied(image_ids: Sequence[int], count: int) -> Tuple[List[int], int]:
    """``(picked ids in pick order, how many of the given pictures had no vector)``."""
    wanted = list(dict.fromkeys(int(image_id) for image_id in image_ids))
    vectors = _vectors(wanted)
    usable = [image_id for image_id in wanted if image_id in vectors]
    if not usable:
        return [], len(wanted)
    # Vectors of another length (an index built by an older model) cannot be compared with the rest.
    length = len(vectors[usable[0]])
    usable = [image_id for image_id in usable if len(vectors[image_id]) == length]
    matrix = np.stack([vectors[image_id] for image_id in usable]).astype(np.float32)
    return [usable[row] for row in pick_indexes(matrix, count)], len(wanted) - len(
        usable
    )
