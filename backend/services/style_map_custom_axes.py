"""Custom axes of the style map (slice S4g): the user decides what an axis means.

An axis is defined by two groups of example pictures, A (the low end) and B
(the high end). With unit style vectors, the direction is

    d = normalize(mean(B) - mean(A))

and a picture's coordinate is ``x . d`` with zero halfway between the two
groups' mean scores, scaled so the largest |coordinate| of the map is 1 (the
scale of the PCA layout). Axes without a definition keep the layout the page
shows (PCA, or the ready UMAP fit) with the custom coordinates regressed out
(Gram-Schmidt on the coordinate columns), so a custom axis is not repeated on
the others, and are scaled back to [-1, 1].

Each defined axis reports how well its examples agree with the direction they
define: leave-one-out, every example is removed in turn, the direction and the
midpoint are recomputed from the rest and the example must still fall on its
own side (``agree`` of ``total``). ``separable`` is true when at least
``SEPARABLE_SHARE`` of them do. Examples outside the current library, or
without a vector in this space, are listed in ``missing_ids`` and ignored; an
axis with fewer than ``MIN_EXAMPLES`` usable examples at an end is not applied
(``applied: false``, ``reason``). Two defined axes whose directions have
``|cos|`` above ``PARALLEL_COS`` raise a warning.

The coordinates of every point are one pass over its unit vectors (streamed in
chunks, nothing like the PCA map's covariance matrix is built), so the cost
is reading the vectors once and memory stays at one chunk.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np

import database as db
from exceptions import ValidationError
from library_context import current_library_sql
from services import style_map_umap
from services.style_map_axes import require_layout

AXIS_NAMES: Tuple[str, ...] = ("x", "y", "z")
MIN_EXAMPLES = 2
SEPARABLE_SHARE = 0.8
PARALLEL_COS = 0.9
_CHUNK = 2000
_ID_CHUNK = 500


# ------------------------------------------------------------------ math
def axis_direction(
    a_vectors: np.ndarray, b_vectors: np.ndarray
) -> Optional[Tuple[np.ndarray, float]]:
    """(unit direction A -> B, midpoint score) of two example groups, or None
    when their means coincide."""
    mean_a = a_vectors.mean(axis=0)
    mean_b = b_vectors.mean(axis=0)
    delta = mean_b - mean_a
    norm = float(np.linalg.norm(delta))
    if norm < 1e-8:
        return None
    direction = (delta / norm).astype(np.float32)
    middle = 0.5 * (float(mean_a @ direction) + float(mean_b @ direction))
    return direction, middle


def _loo_disagreements(own: np.ndarray, other_mean: np.ndarray) -> np.ndarray:
    """Per example of ``own``: True when it stays on its own side with itself
    left out. In closed form, no per-example refit: with ``w`` the own mean
    without example x and ``m`` the other mean, the direction is +-(m - w), the
    midpoint (w + m) / 2 and x stays on its side iff
    ``x.m - x.w - (m.m - w.w) / 2 < 0`` (the same for either end). Every term
    comes from a few dot products, so n examples cost O(n * D)."""
    n = len(own)
    if n < 2:
        return np.zeros(n, dtype=bool)
    total = own.sum(axis=0, dtype=np.float64)
    x = own.astype(np.float64)
    xs = x @ total
    xx = np.einsum("ij,ij->i", x, x)
    xm = x @ other_mean
    ss = float(total @ total)
    sm = float(total @ other_mean)
    mm = float(other_mean @ other_mean)
    xw = (xs - xx) / (n - 1)
    ww = (ss - 2.0 * xs + xx) / (n - 1) ** 2
    wm = (sm - xm) / (n - 1)
    separated = (mm - 2.0 * wm + ww) >= 1e-16  # the two means still differ (axis_direction's limit)
    return separated & ((xm - xw - 0.5 * (mm - ww)) < 0)


def leave_one_out(a_vectors: np.ndarray, b_vectors: np.ndarray) -> Tuple[int, int]:
    """(agree, total): examples that stay on their own side when they are left
    out of the direction and the midpoint (closed form, O(n * D))."""
    mean_a = a_vectors.mean(axis=0, dtype=np.float64)
    mean_b = b_vectors.mean(axis=0, dtype=np.float64)
    agree = int(_loo_disagreements(a_vectors, mean_b).sum())
    agree += int(_loo_disagreements(b_vectors, mean_a).sum())
    return agree, len(a_vectors) + len(b_vectors)


def residual_axes(base: np.ndarray, custom: Dict[int, np.ndarray]) -> np.ndarray:
    """Layout columns with the custom ones put in and the others regressed
    against them, each column scaled to peak |value| 1."""
    out = np.array(base, dtype=np.float64, copy=True)
    basis: List[np.ndarray] = []
    for axis, column in sorted(custom.items()):
        vector = np.asarray(column, dtype=np.float64)
        out[:, axis] = vector
        centred = vector - vector.mean()
        for earlier in basis:
            centred = centred - (centred @ earlier) * earlier
        norm = float(np.linalg.norm(centred))
        if norm > 1e-12:
            basis.append(centred / norm)
    for axis in range(out.shape[1]):
        if axis in custom:
            continue
        column = out[:, axis] - out[:, axis].mean()
        for vector in basis:
            column = column - (column @ vector) * vector
        peak = float(np.abs(column).max()) or 1.0
        out[:, axis] = column / peak
    return out


def parallel_pairs(directions: Dict[str, np.ndarray]) -> List[Dict[str, Any]]:
    names = sorted(directions)
    warnings = []
    for i, first in enumerate(names):
        for second in names[i + 1 :]:
            cos = abs(float(directions[first] @ directions[second]))
            if cos > PARALLEL_COS:
                warnings.append(
                    {
                        "code": "axes_parallel",
                        "axes": [first, second],
                        "cos": round(cos, 3),
                    }
                )
    return warnings


# ------------------------------------------------------------ validation
def parse_definitions(
    axes: Optional[Dict[str, Any]],
) -> Dict[str, Tuple[List[int], List[int]]]:
    """{axis: (a_ids, b_ids)} of the axes that are defined; 400 on a bad one."""
    definitions: Dict[str, Tuple[List[int], List[int]]] = {}
    for name, value in (axes or {}).items():
        if name not in AXIS_NAMES:
            raise ValidationError(
                f"Unknown axis {name!r}; expected x, y or z", field="axes"
            )
        if value is None:
            continue
        if not isinstance(value, dict):
            raise ValidationError(
                f"Axis {name}: expected an object like {{\"a\": [ids], \"b\": [ids]}}",
                field="axes",
            )
        a = _unique_ids(value.get("a"), name, "a")
        b = _unique_ids(value.get("b"), name, "b")
        both = sorted(set(a) & set(b))
        if both:
            raise ValidationError(
                f"Axis {name}: picture(s) {both[:5]} are in both boxes. "
                "A picture can only be an example of one box of an axis.",
                field="axes",
            )
        for end, ids in (("left", a), ("right", b)):
            if len(ids) < MIN_EXAMPLES:
                raise ValidationError(
                    f"Axis {name}: the {end} box needs at least {MIN_EXAMPLES} example pictures, got {len(ids)}",
                    field="axes",
                )
        definitions[name] = (a, b)
    return definitions


def _unique_ids(raw: Any, axis: str, end: str) -> List[int]:
    """The ids of one end, each once, in the order given; every item must be a
    whole number (a bool, a string or null is not an image id)."""
    if not isinstance(raw, (list, tuple)):
        raise ValidationError(
            f"Axis {axis}: end {end} must be a list of image ids", field="axes"
        )
    seen: set = set()
    ordered: List[int] = []
    for item in raw:
        if isinstance(item, bool) or not isinstance(item, int):
            raise ValidationError(
                f"Axis {axis}: {item!r} is not an image id", field="axes"
            )
        if item not in seen:
            seen.add(item)
            ordered.append(item)
    return ordered


def library_ids(ids: Sequence[int]) -> set:
    """The ids that exist in the CURRENT library (X-SD-Library-Id)."""
    clause, params = current_library_sql("library_id")
    found: set = set()
    with db.get_db() as conn:
        for start in range(0, len(ids), _ID_CHUNK):
            chunk = [int(i) for i in ids[start : start + _ID_CHUNK]]
            marks = ",".join("?" * len(chunk))
            rows = conn.execute(
                f"SELECT id FROM images WHERE {clause} AND id IN ({marks})",
                (*params, *chunk),
            )
            found.update(int(row[0]) for row in rows)
    return found


class StyleMapCustomAxesMixin:
    """``custom_axes_json`` of StyleMapService (uses its map handles, points
    cache, layouts and vector loader)."""

    def _example_vectors(
        self, space: str, model_version: str, ids: List[int]
    ) -> Tuple[Dict[int, np.ndarray], List[int]]:
        """({id: unit vector}, missing ids): missing = outside the current
        library or without a vector in this space."""
        in_library = library_ids(ids)
        found, matrix = self._load_vectors(space, model_version, sorted(in_library))
        vectors = {int(i): matrix[row] for row, i in enumerate(found)}
        missing = [i for i in ids if i not in vectors]
        return vectors, missing

    def _stream_scores(
        self,
        space: str,
        model_version: str,
        rep_ids: np.ndarray,
        directions: np.ndarray,
    ) -> np.ndarray:
        """directions (k x D) . every rep's unit vector, in rep_ids order
        (NaN for a picture whose vector vanished meanwhile)."""
        scores = np.full((len(directions), len(rep_ids)), np.nan, dtype=np.float64)
        for start in range(0, len(rep_ids), _CHUNK):
            chunk = rep_ids[start : start + _CHUNK]
            found, matrix = self._load_vectors(
                space, model_version, [int(i) for i in chunk]
            )
            if not len(found):
                continue
            position = {int(i): r for r, i in enumerate(chunk)}
            rows = np.asarray([position[int(i)] for i in found], dtype=np.int64)
            scores[:, start + rows] = directions @ matrix.T
        return scores

    def custom_axes_json(
        self,
        space: str,
        selection_token: Optional[str] = None,
        *,
        model_path: Optional[str] = None,
        map_id: Optional[str] = None,
        layout: str = "pca",
        axes: Optional[Dict[str, Any]] = None,
    ) -> bytes:
        layout = require_layout(layout)
        definitions = parse_definitions(axes)
        normalized, key = self._resolve_map(space, selection_token, model_path, map_id)
        entry = self._cache_get(key) if key is not None else None
        with self._cache_lock:
            inputs = self._inputs.get(key)
        if entry is None or inputs is None:
            return _idle("not_started", normalized, layout)
        points = json.loads(entry[0]).get("points") or []
        base = np.array([[p[1], p[2], p[3]] for p in points], dtype=np.float64).reshape(
            -1, 3
        )
        if layout == "umap":
            ready = (
                self._ready_layout(self._layout_key(key), inputs.rep_ids)
                if style_map_umap.umap_available()
                else None
            )
            if ready is None:
                return _idle("layout_not_ready", normalized, layout)
            base = np.asarray(ready[1], dtype=np.float64).reshape(-1, 3)
        rep_ids = np.asarray([int(p[0]) for p in points], dtype=np.int64)
        model_version = key[2]
        report: Dict[str, Any] = {name: None for name in AXIS_NAMES}
        directions: Dict[str, np.ndarray] = {}
        middles: Dict[str, float] = {}
        for name, (a_ids, b_ids) in definitions.items():
            report[name], found = self._define_axis(space, model_version, a_ids, b_ids)
            if found is not None:
                directions[name], middles[name] = found
        custom: Dict[int, np.ndarray] = {}
        if directions and len(rep_ids):
            order = sorted(directions)
            scores = self._stream_scores(
                space, model_version, rep_ids, np.stack([directions[n] for n in order])
            )
            for row, name in enumerate(order):
                column = scores[row] - middles[name]
                column = np.nan_to_num(column, nan=0.0)
                peak = float(np.abs(column).max()) or 1.0
                custom[AXIS_NAMES.index(name)] = column / peak
        coords = residual_axes(base, custom) if custom else base
        payload = {
            "status": "ok" if len(rep_ids) else "empty",
            "space": normalized,
            "layout": layout,
            "model_version": model_version,
            "ids": rep_ids.tolist(),
            "coords": np.round(coords, 4).tolist(),
            "axes": report,
            "warnings": parallel_pairs(directions),
        }
        return json.dumps(payload, separators=(",", ":")).encode("utf-8")

    def _define_axis(
        self, space: str, model_version: str, a_ids: List[int], b_ids: List[int]
    ) -> Tuple[Dict[str, Any], Optional[Tuple[np.ndarray, float]]]:
        vectors, missing = self._example_vectors(space, model_version, a_ids + b_ids)
        a_used = [i for i in a_ids if i in vectors]
        b_used = [i for i in b_ids if i in vectors]
        info: Dict[str, Any] = {
            "applied": False,
            "reason": None,
            "a_used": a_used,
            "b_used": b_used,
            "missing_ids": missing,
            "agree": 0,
            "total": len(a_used) + len(b_used),
            "separable": False,
        }
        if len(a_used) < MIN_EXAMPLES or len(b_used) < MIN_EXAMPLES:
            info["reason"] = "too_few_examples"
            return info, None
        a_vectors = np.stack([vectors[i] for i in a_used])
        b_vectors = np.stack([vectors[i] for i in b_used])
        found = axis_direction(a_vectors, b_vectors)
        if found is None:
            info["reason"] = "identical_ends"
            return info, None
        agree, total = leave_one_out(a_vectors, b_vectors)
        info.update(
            applied=True,
            agree=agree,
            total=total,
            separable=total > 0 and agree / total >= SEPARABLE_SHARE,
        )
        return info, found

    def custom_axes(self, space: str, selection_token=None, **kwargs) -> Dict[str, Any]:
        """Dict form of :meth:`custom_axes_json` (tests and in-process callers)."""
        return json.loads(self.custom_axes_json(space, selection_token, **kwargs))


def _idle(status: str, space: str, layout: str) -> bytes:
    body = {
        "status": status,
        "space": space,
        "layout": layout,
        "ids": [],
        "coords": [],
        "axes": {},
        "warnings": [],
    }
    return json.dumps(body, separators=(",", ":")).encode("utf-8")
