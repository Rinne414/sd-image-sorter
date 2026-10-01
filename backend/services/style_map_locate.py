"""Style map: find one picture on the map (slice S4f).

Two lookups that both answer in the coordinates of the map the page shows
(named by ``map_id``, never another library or an evicted map):

- ``near_json``: the nearest pictures of a LIBRARY picture, ranked by its
  stored vector (Kaloscope ``image_style_vectors`` or the CLIP embedding), so
  nothing is uploaded and no model runs. The answer is the dropped-picture
  answer of ``style_map_query`` plus ``self``: where that picture itself is.
- ``locate_json``: the pictures of the map that match a Gallery search. The
  search is the Gallery's own filter contract (a selection token), so the
  grammar is the Gallery's; the matches are intersected with every picture the
  map's dots stand for (merged members included) and come back with their dots.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np

import database as db
from exceptions import ImageNotFoundError
from library_context import current_library_sql
from services.style_map_query import (
    DEFAULT_K,
    WEAK_THRESHOLDS,
    build_answer,
    not_started_answer,
    rank_by_cosine,
)

MAX_RESULTS = 50
_XYZ = Tuple[float, float, float]


def _library_filenames(ids: Sequence[int]) -> Dict[int, str]:
    """id -> file name of the given pictures that belong to the CURRENT
    library; an id of another library is simply absent."""
    if not ids:
        return {}
    clause, params = current_library_sql()
    marks = ",".join("?" * len(ids))
    with db.get_db() as conn:
        rows = conn.execute(
            f"SELECT id, filename FROM images WHERE id IN ({marks}) AND {clause}",
            [*(int(value) for value in ids), *params],
        ).fetchall()
    return {int(row[0]): str(row[1] or "") for row in rows}


def _dump(body: Dict[str, Any]) -> bytes:
    return json.dumps(body, separators=(",", ":")).encode("utf-8")


def _position(coords: Dict[int, _XYZ], image_id: int) -> Dict[str, Optional[float]]:
    xyz = coords.get(image_id)
    return {axis: (xyz[n] if xyz else None) for n, axis in enumerate("xyz")}


def _self_entry(
    image_id: int,
    filename: str,
    coords: Dict[int, _XYZ],
    merged: set,
    unlocated: set,
) -> Dict[str, Any]:
    """Where the asked picture is: on its own dot, on its group's dot (merged),
    in the filter without a dot, or outside the filter."""
    located = image_id in coords
    return {
        "id": int(image_id),
        "filename": filename,
        "in_filter": located or image_id in unlocated,
        "located": located,
        "merged": image_id in merged,
        **_position(coords, image_id),
    }


def _not_started_near(space: str) -> Dict[str, Any]:
    return {**not_started_answer(space), "self": None}


def _not_started_locate(space: str) -> Dict[str, Any]:
    return {
        "status": "not_started",
        "space": space,
        "total": 0,
        "results": [],
        "outside_filter": 0,
        "without_data": 0,
    }


def split_matches(
    matched: Sequence[int],
    mapped_ids: np.ndarray,
    filter_ids: Optional[np.ndarray],
) -> Tuple[List[int], int, int]:
    """(matches on the map in the given order, matches hidden by the Gallery
    filter, matches in the filter that have no style data and so no dot)."""
    asked = np.asarray(list(matched), dtype=np.int64)
    if asked.size == 0:
        return [], 0, 0
    on_map = np.isin(asked, mapped_ids)
    rest = asked[~on_map]
    if filter_ids is None or rest.size == 0:
        return asked[on_map].tolist(), int(rest.size), 0
    in_filter = np.isin(rest, filter_ids)
    return (
        asked[on_map].tolist(),
        int((~in_filter).sum()),
        int(in_filter.sum()),
    )


class StyleMapLocateMixin:
    """``near_json`` and ``locate_json`` of StyleMapService, built on the
    service's map registry, displayed coordinates and member placement."""

    def near_json(
        self,
        space: str,
        image_id: int,
        *,
        selection_token: Optional[str] = None,
        map_id: Optional[str] = None,
        k: int = DEFAULT_K,
        model_path: Optional[str] = None,
    ) -> bytes:
        """The ``k`` pictures nearest to library picture ``image_id`` on the
        map. ``not_started`` for a map this process does not hold,
        ``no_vector`` (nothing ranked) when the picture has no vector in this
        space; an id that is not in the library is an ImageNotFoundError."""
        normalized, key = self._resolve_map(space, selection_token, model_path, map_id)
        entry = self._cache_get(key) if key is not None else None
        if entry is None:
            return _dump(_not_started_near(normalized))
        names = _library_filenames([image_id])
        if image_id not in names:
            raise ImageNotFoundError(image_id=image_id)
        own_ids, own = self._load_vectors(normalized, key[2], [image_id])
        if own_ids.size == 0:
            body = _not_started_near(normalized)
            body.update(
                status="no_vector",
                model_version=key[2],
                self={"id": int(image_id), "filename": names[image_id]},
            )
            return _dump(body)
        ids, matrix = self._library_matrix(normalized, key[2])
        ranked = [
            pair
            for pair in rank_by_cosine(own[0], ids, matrix, int(k) + 1)
            if pair[0] != image_id
        ][: max(1, int(k))]
        coords, merged, unlocated = self._place_members(
            key,
            [(image_id, 1.0), *ranked],
            self._displayed_coords(key, entry[0]),
        )
        body = build_answer(
            ranked,
            coords,
            filenames=_library_filenames([i for i, _ in ranked]),
            weak_threshold=WEAK_THRESHOLDS[normalized],
            model_version=key[2],
            merged=merged,
            unlocated=unlocated,
        )
        me = _self_entry(image_id, names[image_id], coords, merged, unlocated)
        body["self"] = me
        body["query"] = (
            {axis: round(me[axis], 3) for axis in "xyz"} if me["located"] else None
        )
        return _dump(body)

    def locate_json(
        self,
        space: str,
        search_token: str,
        *,
        selection_token: Optional[str] = None,
        map_id: Optional[str] = None,
        model_path: Optional[str] = None,
        limit: int = MAX_RESULTS,
    ) -> bytes:
        """The pictures of the map matching the Gallery search named by
        ``search_token`` (newest first, at most ``limit`` up to
        ``MAX_RESULTS``), each with its dot. ``total`` counts every match on
        the map; ``outside_filter`` and ``without_data`` say why a search
        that finds nothing on the map does match the library."""
        normalized, key = self._resolve_map(space, selection_token, model_path, map_id)
        entry = self._cache_get(key) if key is not None else None
        if entry is None:
            return _dump(_not_started_locate(normalized))
        matched = self._filtered_ids(self._contract(search_token))
        with self._cache_lock:
            inputs = self._inputs.get(key)
        if inputs is None:  # evicted between the two lookups
            return _dump(_not_started_locate(normalized))
        mapped = inputs.member_ids if inputs.member_ids is not None else inputs.rep_ids
        on_map, outside, without_data = split_matches(
            matched, mapped, inputs.filter_ids
        )
        shown = on_map[: max(1, min(int(limit), MAX_RESULTS))]
        coords, merged, _unlocated = self._place_members(
            key, [(i, 1.0) for i in shown], self._displayed_coords(key, entry[0])
        )
        names = _library_filenames(shown)
        results = [
            {
                "id": int(i),
                "filename": names.get(i, ""),
                **_position(coords, i),
                "merged": i in merged,
            }
            for i in shown
            if i in coords
        ]
        return _dump(
            {
                "status": "ok",
                "space": normalized,
                "total": len(on_map),
                "results": results,
                "outside_filter": outside,
                "without_data": without_data,
            }
        )
