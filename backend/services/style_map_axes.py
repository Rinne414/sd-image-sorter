"""Style map axes (slice S4e): what the two ends of each axis stand for.

The page shows PCA or UMAP coordinates of the map's representatives. Each of
the three axes gets, for its low and its high end:

- representative pictures: the ``REPS_PER_END`` pictures nearest the median of
  the outer ``REP_SHARE`` of the axis (a far outlier is never picked; later
  picks must look different from earlier ones, as regions do);
- labels: WD14 general tags that separate the outer ``END_SHARE`` at one end
  from the outer ``END_SHARE`` at the other end. The statistics are the
  regions' (``style_map_regions``): hypergeometric tail over TAGGED pictures
  only, one Benjamini-Hochberg correction over every admissible test of the
  map, and the same effect-size gate. A tag counts as admissible when it
  appears on at least ``TAG_MIN_COUNT`` pictures of the end it labels.

Rating, meta, artist and character tags never label an axis. Character names
say who is drawn, not how, and a name seen on a handful of pictures would
only pretend the axis means that character; ratings and meta tags (highres,
commentary, ...) are bookkeeping. ``weak`` is true when no tag separates the
two ends: the page then says there is no shared trait, it never invents one.
``strength`` is the largest rate difference between the two ends among the
reported tags (0 when weak).

Group counts are aggregated inside SQLite (one temp table of the grouped
pictures joined to ``tags``), so a 50k-point map reads ~10k result rows, not
millions. UMAP axes carry no direction (a fit may rotate or flip them); the
page says so, the numbers here are still true for the layout shown.
"""

from __future__ import annotations

import json
import re
import sqlite3
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np

import database as db
from exceptions import ValidationError
from services import style_map_umap
from services.style_map_regions import (
    SECOND_REPRESENTATIVE_MAX_COS,
    TAG_MAX_Q,
    TAG_MIN_COUNT,
    TAG_MIN_RATE,
    TAG_MIN_RATE_GAIN,
    TAG_MIN_RATIO,
    TAG_MIN_TAGGED,
    benjamini_hochberg,
    hypergeom_tail,
)

AXES_ALGO_VERSION = 1
AXIS_NAMES: Tuple[str, ...] = ("x", "y", "z")
AXES_LAYOUTS: Tuple[str, ...] = ("pca", "umap")
END_SHARE = 0.20
REP_SHARE = 0.10
REPS_PER_END = 3
LABELS_PER_END = 3
# Candidates looked up in the vocabulary (category, zh) per end before the
# final LABELS_PER_END survive the rating / meta / character filter.
CANDIDATES_PER_END = 12
# Tag counts are taken on at most this many pictures per end, evenly spread
# over the end's ranks (a 50k map has 10k per end; 4k of them already settle
# every comparison and keep the answer under a second). Smaller maps are
# counted whole.
END_SAMPLE_CAP = 4000
MIN_POINTS = 30
_REP_SEARCH = 200
EXCLUDED_CATEGORIES = frozenset({"meta", "rating", "artist", "character"})
# The tagger's own rating tags are stored as plain tag names.
RATING_TAGS = frozenset({"general", "sensitive", "questionable", "explicit"})
_KANA = re.compile(r"[぀-ヿ]")
_BITS = 6  # per axis: low end, high end


# --------------------------------------------------------------- geometry
def _end_rows(order: np.ndarray, share: float) -> Tuple[np.ndarray, np.ndarray]:
    size = max(1, int(round(len(order) * share)))
    return order[:size], order[-size:]


def _sample(rows: np.ndarray, cap: int = END_SAMPLE_CAP) -> np.ndarray:
    """At most cap of rows, evenly spaced over them."""
    if len(rows) <= cap:
        return rows
    return rows[np.linspace(0, len(rows) - 1, cap).astype(np.int64)]


def _pick_representatives(
    pool: np.ndarray,
    xyz: np.ndarray,
    ids: np.ndarray,
    features: Optional[np.ndarray],
) -> List[int]:
    """The pictures of ``pool`` nearest its median that differ from each
    other (cosine of the PCA features below the regions' limit)."""
    center = np.median(xyz[pool], axis=0)
    order = pool[np.argsort(((xyz[pool] - center) ** 2).sum(axis=1), kind="stable")]
    if features is None:
        return [int(ids[row]) for row in order[:REPS_PER_END]]
    picked: List[int] = []
    vectors: List[np.ndarray] = []
    for row in order[:_REP_SEARCH]:
        vector = np.asarray(features[int(row)], dtype=np.float32)
        norm = float(np.linalg.norm(vector)) or 1.0
        unit = vector / norm
        if all(
            float(unit @ other) < SECOND_REPRESENTATIVE_MAX_COS for other in vectors
        ):
            picked.append(int(row))
            vectors.append(unit)
            if len(picked) == REPS_PER_END:
                break
    for row in order:  # a tight pool: fill up with the nearest remaining
        if len(picked) >= REPS_PER_END:
            break
        if int(row) not in picked:
            picked.append(int(row))
    return [int(ids[row]) for row in picked]


# ------------------------------------------------------------- DB counts
_PACK_BITS = 31  # two group flags per SUM column: counts stay below 2**31
_PACK_MASK = (1 << _PACK_BITS) - 1


def _pack_flags(masks: np.ndarray) -> List[np.ndarray]:
    """Per column k, group 2k in the low and group 2k+1 in the high half."""
    wide = masks.astype(np.int64)
    return [
        ((wide >> (2 * k)) & 1) | (((wide >> (2 * k + 1)) & 1) << _PACK_BITS)
        for k in range(_BITS // 2)
    ]


def _unpack_sums(row: Sequence[int]) -> List[int]:
    out: List[int] = []
    for packed in row:
        packed = int(packed or 0)
        out += [packed & _PACK_MASK, packed >> _PACK_BITS]
    return out


_GROUP_SQL = (
    "SELECT t.tag, SUM(p.w0), SUM(p.w1), SUM(p.w2) FROM tags t {hint} "
    "JOIN axes_points p ON p.image_id = t.image_id GROUP BY t.tag"
)


def load_end_counts(
    ids: np.ndarray, masks: np.ndarray
) -> Tuple[List[int], Dict[str, List[int]]]:
    """(tagged pictures per end, picture count per tag and end) for the
    pictures whose ``masks`` bit ``axis * 2 + end`` is set.

    The group flags are packed into three integer columns of a temp table, so
    SQLite adds them up while it walks the covering index ``(tag, image_id)``
    in tag order: no sort of the millions of tag rows and ~8k result rows. A
    tag row counts whatever its source (tagger, sidecar, manual all say what
    the picture shows); a picture counts as tagged when it has any tag row.
    """
    chosen = np.flatnonzero(masks)
    columns = _pack_flags(masks[chosen])
    with db.get_db() as conn:
        conn.execute(
            "CREATE TEMP TABLE axes_points (image_id INTEGER PRIMARY KEY, "
            "w0 INTEGER NOT NULL, w1 INTEGER NOT NULL, w2 INTEGER NOT NULL)"
        )
        conn.executemany(
            "INSERT INTO axes_points (image_id, w0, w1, w2) VALUES (?, ?, ?, ?)",
            zip(ids[chosen].tolist(), *(column.tolist() for column in columns)),
        )
        tagged = conn.execute(
            "SELECT SUM(w0), SUM(w1), SUM(w2) FROM axes_points p WHERE EXISTS "
            "(SELECT 1 FROM tags t WHERE t.image_id = p.image_id)"
        ).fetchone()
        try:
            rows = conn.execute(
                _GROUP_SQL.format(hint="INDEXED BY idx_tags_tag_image")
            ).fetchall()
        except sqlite3.OperationalError:  # a library without that index
            rows = conn.execute(_GROUP_SQL.format(hint="")).fetchall()
        conn.execute("DROP TABLE axes_points")
    counts = {str(row[0]): _unpack_sums(tuple(row)[1:]) for row in rows}
    return _unpack_sums(tuple(tagged)), counts


def _has_other_category(tag: str) -> bool:
    """Some row stores this tag under a category other than general
    (character, rating, ...)."""
    with db.get_db() as conn:
        return (
            conn.execute(
                "SELECT 1 FROM tags WHERE tag = ? AND category IS NOT NULL "
                "AND category != 'general' LIMIT 1",
                (tag,),
            ).fetchone()
            is not None
        )


# ------------------------------------------------------------------ tags
def _separating_tests(
    tagged: Sequence[int], counts: Dict[str, List[int]]
) -> List[Dict[str, Any]]:
    """Every admissible (axis, end, tag) test with its p value; one BH family
    over all of them. The p value is only computed for tests that pass the
    effect-size gate (the others take p = 1, which can only make the family
    more conservative than testing them all)."""
    tests: List[Dict[str, Any]] = []
    for axis in range(3):
        n_low, n_high = tagged[axis * 2], tagged[axis * 2 + 1]
        if min(n_low, n_high) < TAG_MIN_TAGGED:
            continue
        for tag, values in counts.items():
            c_low, c_high = values[axis * 2], values[axis * 2 + 1]
            for end, count, other, n_end, n_other in (
                ("high", c_high, c_low, n_high, n_low),
                ("low", c_low, c_high, n_low, n_high),
            ):
                if count < TAG_MIN_COUNT:
                    continue
                rate, other_rate = count / n_end, other / n_other
                if rate <= other_rate:
                    continue
                ratio = rate / other_rate if other_rate > 0 else float("inf")
                strong = ratio >= TAG_MIN_RATIO or (
                    rate >= TAG_MIN_RATE and rate - other_rate >= TAG_MIN_RATE_GAIN
                )
                p = (
                    hypergeom_tail(count, n_low + n_high, c_low + c_high, n_end)
                    if strong
                    else 1.0
                )
                tests.append(
                    {
                        "axis": axis,
                        "end": end,
                        "tag": tag,
                        "count": count,
                        "tagged": n_end,
                        "rate": rate,
                        "other_rate": other_rate,
                        "ratio": ratio,
                        "p": p,
                    }
                )
    for test, q in zip(tests, benjamini_hochberg([test["p"] for test in tests])):
        test["q"] = q
    return [test for test in tests if test["q"] < TAG_MAX_Q]


def _vocabulary_view(tag: str) -> Tuple[str, Optional[str], bool]:
    """(category, Chinese display name or None, known to the vocabulary) from
    the bundled vocabulary; a Japanese-only alias is no Chinese name."""
    from services import tag_suggest_service

    try:
        category, zh, known = tag_suggest_service.tag_category_and_zh(tag)
    except Exception:  # vocabulary files missing: keep the tag, English only
        return "general", None, False
    return category, (None if zh and _KANA.search(zh) else zh), known


def _label_item(test: Dict[str, Any], zh: Optional[str]) -> Dict[str, Any]:
    return {
        "tag": test["tag"],
        "zh": zh,
        "count": test["count"],
        "tagged": test["tagged"],
        "rate": round(test["rate"], 3),
        "other_rate": round(test["other_rate"], 3),
        "gain": round(test["rate"] - test["other_rate"], 3),
        "ratio": round(min(test["ratio"], 999.0), 2),
        "q": float(f"{test['q']:.3g}"),
    }


def _is_label_candidate(tag: str, category: str, known: bool) -> bool:
    if tag in RATING_TAGS or category in EXCLUDED_CATEGORIES:
        return False
    # The covering scan cannot see the stored category: a tag the vocabulary
    # does not know (a custom character name) is checked against the table.
    return known or not _has_other_category(tag)


def _labels_for_end(tests: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    ranked = sorted(
        tests,
        key=lambda test: (test["other_rate"] - test["rate"], test["q"], test["tag"]),
    )
    labels: List[Dict[str, Any]] = []
    for test in ranked[:CANDIDATES_PER_END]:
        category, zh, known = _vocabulary_view(test["tag"])
        if not _is_label_candidate(test["tag"], category, known):
            continue
        labels.append(_label_item(test, zh))
        if len(labels) == LABELS_PER_END:
            break
    return labels


# ------------------------------------------------------------------ axes
def compute_axes(
    ids: np.ndarray, xyz: np.ndarray, *, features: Optional[np.ndarray] = None
) -> Dict[str, Any]:
    """Both ends of the three axes of one displayed layout."""
    n = len(ids)
    empty_end = {"representatives": [], "tags": [], "size": 0, "tagged": 0}
    axes: Dict[str, Any] = {
        name: {
            "low": dict(empty_end),
            "high": dict(empty_end),
            "weak": True,
            "strength": 0.0,
        }
        for name in AXIS_NAMES
    }
    if n < MIN_POINTS:
        return axes
    masks = np.zeros(n, dtype=np.uint8)
    for axis in range(3):
        order = np.argsort(xyz[:, axis], kind="stable")
        low, high = _end_rows(order, END_SHARE)
        masks[_sample(low)] |= 1 << (axis * 2)
        masks[_sample(high)] |= 1 << (axis * 2 + 1)
        pool_low, pool_high = _end_rows(order, REP_SHARE)
        for end, pool, rows in (
            ("low", pool_low, low),
            ("high", pool_high, high),
        ):
            axes[AXIS_NAMES[axis]][end] = {
                "representatives": _pick_representatives(pool, xyz, ids, features),
                "tags": [],
                "size": int(len(rows)),
                "tagged": 0,
            }
    tagged, counts = load_end_counts(ids, masks)
    passing = _separating_tests(tagged, counts)
    for axis in range(3):
        entry = axes[AXIS_NAMES[axis]]
        entry["low"]["tagged"] = tagged[axis * 2]
        entry["high"]["tagged"] = tagged[axis * 2 + 1]
        for end in ("low", "high"):
            entry[end]["tags"] = _labels_for_end(
                [t for t in passing if t["axis"] == axis and t["end"] == end]
            )
        reported = entry["low"]["tags"] + entry["high"]["tags"]
        entry["weak"] = not reported
        entry["strength"] = max((item["gain"] for item in reported), default=0.0)
    return axes


def axes_of_points(
    points: Sequence[Sequence[Any]],
    *,
    xyz: Optional[np.ndarray] = None,
    features: Optional[np.ndarray] = None,
) -> Dict[str, Any]:
    """Axes of one cached ``points`` payload ([id, x, y, z, members, ...]
    rows); ``xyz`` overrides the PCA coordinates with the displayed UMAP
    layout (same row order). Tags come from the current library's DB."""
    ids = np.asarray([int(point[0]) for point in points], dtype=np.int64)
    if xyz is None:
        xyz = np.array(
            [[point[1], point[2], point[3]] for point in points], dtype=np.float64
        ).reshape(-1, 3)
    xyz = np.asarray(xyz, dtype=np.float64).reshape(-1, 3)
    if features is not None and len(features) != len(ids):
        features = None
    return {
        "algo_version": AXES_ALGO_VERSION,
        "points": int(len(ids)),
        "axes": compute_axes(ids, xyz, features=features),
    }


def axes_body(
    points_payload: bytes,
    *,
    space: str,
    layout: str,
    xyz: Optional[np.ndarray] = None,
    features: Optional[np.ndarray] = None,
) -> bytes:
    """The axes response for one cached points payload, as JSON bytes WITHOUT
    the closing brace (the service appends the ``cached`` flag)."""
    result = json.loads(points_payload)
    points = result.get("points") or []
    payload = {
        "status": "ok" if points else "empty",
        "space": space,
        "layout": layout,
        "model_version": result.get("model_version"),
        **axes_of_points(points, xyz=xyz, features=features),
    }
    return json.dumps(payload, separators=(",", ":")).encode("utf-8")[:-1]


def require_layout(layout: Optional[str]) -> str:
    normalized = str(layout or "pca").strip().lower()
    if normalized not in AXES_LAYOUTS:
        raise ValidationError(
            f"Unknown layout {layout!r}; expected one of {', '.join(AXES_LAYOUTS)}",
            field="layout",
        )
    return normalized


class StyleMapAxesMixin:
    """``axes_json`` of StyleMapService. Shares the service's map handles,
    points cache, UMAP layouts and the regions cache (same layout key, a
    method of its own, stamped with the same label version, dropped with the
    layout)."""

    def axes_json(
        self,
        space: str,
        selection_token: Optional[str] = None,
        *,
        model_path: Optional[str] = None,
        map_id: Optional[str] = None,
        layout: str = "pca",
    ) -> bytes:
        """Axes of the map ``points`` last computed for this space and filter
        (or named by ``map_id``) on the coordinates ``layout`` names.
        ``not_started`` until points ran (or once the handle is gone);
        ``layout_not_ready`` for umap before its fit finished."""
        layout = require_layout(layout)
        normalized, key = self._resolve_map(space, selection_token, model_path, map_id)
        entry = self._cache_get(key) if key is not None else None
        with self._cache_lock:
            inputs = self._inputs.get(key)
        if entry is None or inputs is None:
            return self._axes_idle("not_started", normalized, layout)
        layout_key = self._layout_key(key)
        xyz = None
        if layout == "umap":
            ready = (
                self._ready_layout(layout_key, inputs.rep_ids)
                if style_map_umap.umap_available()
                else None
            )
            if ready is None:
                return self._axes_idle("layout_not_ready", normalized, layout)
            xyz = ready[1]
        body, cached = self._regions.get_or_build(
            layout_key,
            f"axes:{layout}",
            lambda: axes_body(
                entry[0],
                space=normalized,
                layout=layout,
                xyz=xyz,
                features=inputs.features,
            ),
        )
        return body + (b',"cached":true}' if cached else b',"cached":false}')

    @staticmethod
    def _axes_idle(status: str, space: str, layout: str) -> bytes:
        idle = {"status": status, "space": space, "layout": layout, "axes": {}}
        return json.dumps(idle, separators=(",", ":")).encode("utf-8")

    def axes(self, space: str, selection_token=None, **kwargs) -> Dict[str, Any]:
        """Dict form of :meth:`axes_json` (tests and in-process callers)."""
        return json.loads(self.axes_json(space, selection_token, **kwargs))
