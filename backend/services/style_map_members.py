"""Style map: the pictures hidden behind a merged dot (slice S4b).

The map draws one representative per near-duplicate group. ``_compute`` keeps
the group table beside the cached map (``member_ids`` ordered by group and
``member_offsets``, the same order as ``rep_ids``), so a box selection can
act on every picture the dots stand for and the nearest-picture query can
place a merged picture on its true group's dot instead of guessing by cosine.

Everything is looked up in the cached map named by the request, never in
another library or an evicted map.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional, Sequence

import numpy as np


def _rows_of(rep_ids: np.ndarray, asked: np.ndarray) -> np.ndarray:
    rows = np.searchsorted(rep_ids, asked)
    inside = rows < rep_ids.size
    rows, asked = rows[inside], asked[inside]
    return np.unique(rows[rep_ids[rows] == asked])


def expand(
    rep_ids: np.ndarray,
    member_ids: np.ndarray,
    offsets: np.ndarray,
    wanted: Sequence[int],
) -> List[int]:
    """Every member id (representatives included) of the wanted
    representatives, in map order. A wanted id that is not a representative
    of this map expands to nothing."""
    rows = _rows_of(rep_ids, np.asarray(list(wanted), dtype=np.int64))
    if rows.size == 0:
        return []
    parts = [member_ids[offsets[row] : offsets[row + 1]] for row in rows.tolist()]
    return np.concatenate(parts).tolist()


def owners(
    rep_ids: np.ndarray,
    member_ids: np.ndarray,
    offsets: np.ndarray,
    wanted: Sequence[int],
) -> Dict[int, int]:
    """member id -> the representative of its group, for the wanted ids that
    are in some group of the map (a representative owns itself)."""
    asked = np.asarray(list(wanted), dtype=np.int64)
    if asked.size == 0 or member_ids.size == 0:
        return {}
    order = np.argsort(member_ids, kind="stable")
    sorted_ids = member_ids[order]
    at = np.searchsorted(sorted_ids, asked)
    inside = at < sorted_ids.size
    at, asked = at[inside], asked[inside]
    found = sorted_ids[at] == asked
    positions = order[at[found]]
    group = np.searchsorted(offsets, positions, side="right") - 1
    return {int(m): int(rep_ids[g]) for m, g in zip(asked[found], group.tolist())}


class StyleMapMembersMixin:
    """``members_json`` of StyleMapService (kept out of the service module
    for its size budget). Uses the service's map handle registry and inputs
    store through ``_resolve_map`` / ``_cache_get`` / ``_inputs``."""

    def members_json(
        self,
        space: str,
        rep_ids: Sequence[int],
        selection_token: Optional[str] = None,
        *,
        model_path: Optional[str] = None,
        map_id: Optional[str] = None,
    ) -> bytes:
        """The ids behind the given representatives of the map the page shows
        (named by ``map_id``, else located from the filter). ``not_started``
        (no ids) when that map is not cached in this process or belongs to
        another library."""
        normalized, key = self._resolve_map(space, selection_token, model_path, map_id)
        inputs = None
        if key is not None and self._cache_get(key) is not None:
            with self._cache_lock:
                inputs = self._inputs.get(key)
        if inputs is None or inputs.member_ids is None:
            body: Dict[str, Any] = {
                "status": "not_started",
                "space": normalized,
                "ids": [],
            }
        else:
            ids = expand(
                inputs.rep_ids, inputs.member_ids, inputs.member_offsets, rep_ids
            )
            body = {"status": "ok", "space": normalized, "ids": ids}
        return json.dumps(body, separators=(",", ":")).encode("utf-8")

    def members(
        self, space: str, rep_ids: Sequence[int], selection_token=None, **kwargs
    ):
        """Dict form of :meth:`members_json` (tests and in-process callers)."""
        return json.loads(self.members_json(space, rep_ids, selection_token, **kwargs))
