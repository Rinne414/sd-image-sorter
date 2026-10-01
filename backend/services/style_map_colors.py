"""Style map point colours (slice S4a): one value per point of a cached map.

``GET /api/style-map/colors`` answers for the representatives of the map
``points`` last computed for the same space and filter, in point order, so the
page maps ids to dots without any layout knowledge:

- ``category`` fields (``generator``, ``folder``, ``artist``): ``values`` are
  indexes into ``legend`` (the ``CATEGORY_LIMIT`` largest categories by
  picture count, then one ``OTHER_KEY`` entry for the rest) or ``null`` when
  the picture has no value. A folder is the directory of ``images.path``
  (its full path is the key, its last segment the label); an artist is the
  Style Finder's stored prediction, ``undefined`` meaning none.
- ``scale`` fields (``aesthetic_score``, ``aesthetic_waifu``,
  ``aesthetic_anime``): ``values`` are the numbers themselves (``null`` for an
  unscored picture) and ``range`` is their min and max.

A merged near-duplicate group shows its representative's own value. The
answer is read fresh every time (tagging, scoring or a Style Finder batch
change it) and is never part of the cached points payload.
"""

from __future__ import annotations

import json
import posixpath
from collections import Counter
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import database as db

CATEGORY_FIELDS: Tuple[str, ...] = ("generator", "folder", "artist")
SCALE_FIELDS: Tuple[str, ...] = (
    "aesthetic_score",
    "aesthetic_waifu",
    "aesthetic_anime",
)
STYLE_MAP_COLOR_FIELDS: Tuple[str, ...] = CATEGORY_FIELDS + SCALE_FIELDS
CATEGORY_LIMIT = 12
OTHER_KEY = "__other__"
NO_ARTIST = "undefined"
SCALE_DECIMALS = 3
_ID_CHUNK = 500


def _chunks(ids: Sequence[int]) -> Iterable[List[int]]:
    for start in range(0, len(ids), _ID_CHUNK):
        yield [int(value) for value in ids[start : start + _ID_CHUNK]]


def folder_of(path: Optional[str]) -> Optional[str]:
    """The directory of a stored image path (either separator), no trailing
    slash; None for an empty path."""
    if not path:
        return None
    normalized = str(path).replace("\\", "/")
    head = posixpath.dirname(normalized.rstrip("/"))
    return head or None


def folder_label(folder: str) -> str:
    """What the legend shows for a folder: its last segment (the drive or
    root itself when there is nothing else)."""
    stripped = folder.rstrip("/")
    return posixpath.basename(stripped) or stripped or folder


def _raw_values(ids: Sequence[int], by: str) -> Dict[int, Any]:
    """Field value per image id, straight from the DB (missing ids absent)."""
    values: Dict[int, Any] = {}
    with db.get_db() as conn:
        for chunk in _chunks(ids):
            placeholders = ",".join("?" * len(chunk))
            if by == "artist":
                rows = conn.execute(
                    "SELECT image_id, artist FROM artist_predictions "
                    f"WHERE image_id IN ({placeholders})",
                    chunk,
                )
                for image_id, artist in rows:
                    name = str(artist or "").strip()
                    if name and name != NO_ARTIST:
                        values[int(image_id)] = name
                continue
            column = "path" if by == "folder" else by
            rows = conn.execute(
                f"SELECT id, {column} FROM images WHERE id IN ({placeholders})",
                chunk,
            )
            for image_id, value in rows:
                if by == "folder":
                    value = folder_of(value)
                elif by == "generator":
                    value = str(value).strip() if value else None
                if value is not None:
                    values[int(image_id)] = value
    return values


def category_colors(
    ids: Sequence[int], raw: Dict[int, Any], *, by: str, limit: int = CATEGORY_LIMIT
) -> Dict[str, Any]:
    """``values`` (legend index or None per id) and ``legend`` (largest
    ``limit`` categories by count, ties by key, then ``OTHER_KEY`` when any
    category was folded away)."""
    counts: Counter = Counter(raw[image_id] for image_id in ids if image_id in raw)
    ordered = sorted(counts.items(), key=lambda item: (-item[1], str(item[0])))
    kept = ordered[:limit]
    rest = ordered[limit:]
    index = {key: position for position, (key, _count) in enumerate(kept)}
    legend = [
        {
            "key": str(key),
            "label": folder_label(str(key)) if by == "folder" else str(key),
            "count": int(count),
        }
        for key, count in kept
    ]
    other_index: Optional[int] = None
    if rest:
        other_index = len(legend)
        legend.append(
            {"key": OTHER_KEY, "label": "", "count": int(sum(c for _k, c in rest))}
        )
    values: List[Optional[int]] = []
    for image_id in ids:
        value = raw.get(image_id)
        if value is None:
            values.append(None)
        else:
            values.append(index.get(value, other_index))
    return {"kind": "category", "values": values, "legend": legend, "range": None}


def scale_colors(ids: Sequence[int], raw: Dict[int, Any]) -> Dict[str, Any]:
    """``values`` (number or None per id) and ``range`` over the numbers;
    ``range`` is None when no picture has one."""
    values: List[Optional[float]] = []
    for image_id in ids:
        value = raw.get(image_id)
        try:
            number = float(value) if value is not None else None
        except (TypeError, ValueError):
            number = None
        if number is not None and number != number:  # NaN
            number = None
        values.append(round(number, SCALE_DECIMALS) if number is not None else None)
    present = [value for value in values if value is not None]
    span = [min(present), max(present)] if present else None
    return {"kind": "scale", "values": values, "legend": [], "range": span}


def require_color_field(by: str) -> str:
    from exceptions import ValidationError

    normalized = str(by or "").strip().lower()
    if normalized not in STYLE_MAP_COLOR_FIELDS:
        raise ValidationError(
            f"Unknown colour field {by!r}; expected one of "
            f"{', '.join(STYLE_MAP_COLOR_FIELDS)}",
            field="by",
        )
    return normalized


def colors_of_points(points: Sequence[Sequence[Any]], *, by: str) -> Dict[str, Any]:
    """Colour data for one cached ``points`` payload ([id, x, y, z, members,
    ...] rows): the representatives' own values, in point order."""
    by = require_color_field(by)
    ids = [int(point[0]) for point in points]
    raw = _raw_values(ids, by) if ids else {}
    if by in SCALE_FIELDS:
        body = scale_colors(ids, raw)
    else:
        body = category_colors(ids, raw, by=by)
    body["missing"] = sum(1 for value in body["values"] if value is None)
    return {"by": by, "ids": ids, **body}


class StyleMapColorsMixin:
    """``colors_json`` of StyleMapService, kept here so the service module
    stays within its size budget. Uses the service's own map key and points
    cache (``_map_key`` / ``_cache_get``), so the answer covers exactly the
    representatives of the map the page shows."""

    def colors_json(
        self,
        space: str,
        selection_token: Optional[str] = None,
        *,
        by: str,
        model_path: Optional[str] = None,
    ) -> bytes:
        """One value per point of the map ``points`` last computed for this
        space and filter: read fresh on every call, never cached with the
        layout; ``not_started`` (empty arrays) until points ran."""
        normalized, _model_version, _ids, key = self._map_key(
            space, selection_token, model_path
        )
        entry = self._cache_get(key)
        return colors_body(entry[0] if entry else None, space=normalized, by=by)

    def colors(self, space: str, selection_token=None, **kwargs) -> Dict[str, Any]:
        """Dict form of :meth:`colors_json` (tests and in-process callers)."""
        return json.loads(self.colors_json(space, selection_token, **kwargs))


def colors_body(points_payload: Optional[bytes], *, space: str, by: str) -> bytes:
    """The colours response as JSON bytes; ``not_started`` (empty arrays)
    when the map has not been computed in this process."""
    by = require_color_field(by)
    if points_payload is None:
        idle = {
            "status": "not_started",
            "space": space,
            "by": by,
            "kind": "scale" if by in SCALE_FIELDS else "category",
            "ids": [],
            "values": [],
            "legend": [],
            "range": None,
            "missing": 0,
        }
        return json.dumps(idle, separators=(",", ":")).encode("utf-8")
    result = json.loads(points_payload)
    payload = {
        "status": "ok",
        "space": space,
        "model_version": result.get("model_version"),
        **colors_of_points(result.get("points") or [], by=by),
    }
    return json.dumps(payload, separators=(",", ":")).encode("utf-8")
