"""Style map regions (slice S3b.1): what a corner of the map stands for.

The displayed layout (PCA or UMAP coordinates of the representatives) is
split into k regions with a fixed-seed k-means; each region gets one or two
representative pictures (closest to its centre, the second one visibly
different from the first) and, when the evidence is strong enough, labels:

- WD14 style tags from a whitelist (``STYLE_TAG_WHITELIST``), counted over
  the region's TAGGED pictures only (an untagged picture says nothing), and
  reported when the tag is at least ``TAG_MIN_RATIO`` times as frequent as
  in the whole map and a hypergeometric tail test rejects chance
  (``TAG_MAX_P``). The test is written with ``math.lgamma`` so every install
  (core or full) computes the same numbers.
- artists: the Style Finder's confident tier only (top-1 >= 0.20, never
  ``undefined``); the region's top artist is reported when it covers
  ``ARTIST_MIN_SHARE`` of the region's confident pictures.

Pure numpy / stdlib; StyleMapService feeds it the layout and the DB rows.
"""

from __future__ import annotations

import json
import math
import threading
from collections import Counter, OrderedDict
from typing import (
    Any,
    Callable,
    Dict,
    Iterable,
    List,
    Mapping,
    Optional,
    Sequence,
    Set,
    Tuple,
)

import numpy as np

import database as db
from artist_identifier import ARTIST_CONFIDENT_THRESHOLD

_ID_CHUNK = 500

REGIONS_ALGO_VERSION = 1
K_MIN = 6
K_MAX = 12
MIN_POINTS_PER_REGION = 5
KMEANS_ITERATIONS = 50
# Representative 2 must differ from representative 1 by at least this much
# (cosine of the PCA features), or the region shows one picture only.
SECOND_REPRESENTATIVE_MAX_COS = 0.9
TAG_MIN_COUNT = 4
TAG_MIN_TAGGED = 10
# Significance: Benjamini-Hochberg over every admissible (region, tag) test
# of the map, q below this. Effect size: the region's rate is TAG_MIN_RATIO
# times the map's, OR (for styles that are a large share of the whole map,
# where the ratio cannot reach 3) the rate is at least TAG_MIN_RATE and
# TAG_MIN_RATE_GAIN above the map's.
TAG_MAX_Q = 0.01
TAG_MIN_RATIO = 3.0
TAG_MIN_RATE = 0.6
TAG_MIN_RATE_GAIN = 0.25
TAG_LABEL_LIMIT = 2
# Artists: at least ARTIST_MIN_HIGH confident pictures in the region and at
# least ARTIST_MIN_HIGH_SHARE of the region's points, then the top artist
# needs ARTIST_MIN_COUNT pictures and ARTIST_MIN_SHARE of the confident ones.
ARTIST_MIN_HIGH = 5
ARTIST_MIN_HIGH_SHARE = 0.05
ARTIST_MIN_COUNT = 3
ARTIST_MIN_SHARE = 0.25
ARTIST_LABEL_LIMIT = 2

# WD14 general tags that describe rendering / medium rather than subject.
# Names for the page live in the language packs as stylemap.tag.<tag>.
STYLE_TAG_WHITELIST: Tuple[str, ...] = (
    "blurry",
    "comic",
    "monochrome",
    "greyscale",
    "chibi",
    "realistic",
    "3d",
    "photorealistic",
    "sketch",
    "halftone",
    "pixel_art",
    "lineart",
    "flat_color",
    "traditional_media",
    "watercolor_(medium)",
    "painting_(medium)",
    "oil_painting_(medium)",
    "cel_shading",
    "pastel_colors",
    "limited_palette",
    "retro_artstyle",
    "anime_screencap",
    "official_art",
    "game_cg",
    "screentone",
    "ink_(medium)",
    "marker_(medium)",
)
STYLE_TAG_SET = frozenset(STYLE_TAG_WHITELIST)


# ------------------------------------------------------------------- math
def _log_choose(n: int, k: int) -> float:
    if k < 0 or k > n:
        return -math.inf
    return math.lgamma(n + 1) - math.lgamma(k + 1) - math.lgamma(n - k + 1)


def hypergeom_tail(count: int, total: int, successes: int, draws: int) -> float:
    """P(X >= count) for X ~ Hypergeometric(total, successes, draws).

    ``draws`` pictures taken from ``total`` of which ``successes`` carry the
    tag; the chance that ``count`` or more of the drawn ones carry it. Summed
    in log space with ``math.lgamma`` (no scipy) so every install agrees.
    """
    total, successes, draws, count = int(total), int(successes), int(draws), int(count)
    if count <= 0:
        return 1.0
    upper = min(successes, draws)
    if count > upper or total <= 0:
        return 0.0
    denominator = _log_choose(total, draws)
    acc = 0.0
    for value in range(count, upper + 1):
        acc += math.exp(
            _log_choose(successes, value)
            + _log_choose(total - successes, draws - value)
            - denominator
        )
    return min(1.0, acc)


def benjamini_hochberg(p_values: Sequence[float]) -> List[float]:
    """BH-adjusted q values, in the input order (each q >= its p, capped at 1)."""
    m = len(p_values)
    if m == 0:
        return []
    order = sorted(range(m), key=lambda index: p_values[index])
    q_sorted = [0.0] * m
    running = 1.0
    for rank in range(m, 0, -1):
        index = order[rank - 1]
        running = min(running, p_values[index] * m / rank)
        q_sorted[rank - 1] = running
    q_values = [0.0] * m
    for rank, index in enumerate(order):
        q_values[index] = q_sorted[rank]
    return q_values


def pick_k(count: int) -> int:
    """Regions for ``count`` points: ~sqrt(n/30) clamped to 6..12, but never
    more than one region per ``MIN_POINTS_PER_REGION`` points (tiny maps get
    one region rather than one per dot)."""
    if count <= 0:
        return 0
    k = min(K_MAX, max(K_MIN, int(round(math.sqrt(count / 30.0)))))
    return max(1, min(k, count // MIN_POINTS_PER_REGION))


def kmeans(
    x: np.ndarray, k: int, *, seed: int = 0, iterations: int = KMEANS_ITERATIONS
) -> Tuple[np.ndarray, np.ndarray]:
    """Plain k-means (k-means++ seeding, fixed seed): (labels, centers)."""
    x = np.asarray(x, dtype=np.float32)
    n = len(x)
    rng = np.random.default_rng(seed)
    centers = np.empty((k, x.shape[1]), dtype=np.float32)
    centers[0] = x[rng.integers(n)]
    closest = ((x - centers[0]) ** 2).sum(axis=1)
    for j in range(1, k):
        weights = closest / closest.sum() if closest.sum() > 0 else np.full(n, 1.0 / n)
        centers[j] = x[rng.choice(n, p=weights)]
        closest = np.minimum(closest, ((x - centers[j]) ** 2).sum(axis=1))
    labels = np.zeros(n, dtype=np.int64)
    for _ in range(iterations):
        distances = ((x[:, None, :] - centers[None, :, :]) ** 2).sum(axis=2)
        new_labels = distances.argmin(axis=1)
        new_centers = centers.copy()
        for j in range(k):
            members = x[new_labels == j]
            if len(members):
                new_centers[j] = members.mean(axis=0)
        done = np.array_equal(new_labels, labels) and np.allclose(new_centers, centers)
        labels, centers = new_labels, new_centers
        if done:
            break
    return labels, centers


# ----------------------------------------------------------------- labels
def _style_tag_counts(
    image_ids: Iterable[int], tags_by_image: Mapping[int, Set[str]]
) -> Counter:
    counts: Counter = Counter()
    for image_id in image_ids:
        for tag in tags_by_image.get(image_id, ()):
            if tag in STYLE_TAG_SET:
                counts[tag] += 1
    return counts


def tag_labels_for_regions(
    regions_ids: Sequence[Sequence[int]],
    *,
    tags_by_image: Mapping[int, Set[str]],
    tagged_ids: Set[int],
    limit: int = TAG_LABEL_LIMIT,
) -> List[List[Dict[str, Any]]]:
    """Per region, the whitelisted style tags that are over-represented in it.

    Only pictures that carry any tag count, on both sides of the comparison:
    a picture the tagger never saw is not "without monochrome". Every
    admissible (region, tag) test of the map goes through one BH correction,
    so a map with many regions and tags does not collect chance labels.
    """
    labels: List[List[Dict[str, Any]]] = [[] for _ in regions_ids]
    tagged_total = len(tagged_ids)
    if tagged_total == 0:
        return labels
    global_counts = _style_tag_counts(tagged_ids, tags_by_image)
    tests: List[Tuple[int, str, int, int, float, float, float]] = []
    for index, region_ids in enumerate(regions_ids):
        region_tagged = [i for i in region_ids if i in tagged_ids]
        if len(region_tagged) < TAG_MIN_TAGGED:
            continue
        for tag, count in _style_tag_counts(region_tagged, tags_by_image).items():
            if count < TAG_MIN_COUNT:
                continue
            overall = global_counts[tag]
            rate = count / len(region_tagged)
            base = overall / tagged_total
            p = hypergeom_tail(count, tagged_total, overall, len(region_tagged))
            tests.append((index, tag, count, len(region_tagged), rate, base, p))
    for (index, tag, count, tagged, rate, base, p), q in zip(
        tests, benjamini_hochberg([test[6] for test in tests])
    ):
        if q >= TAG_MAX_Q:
            continue
        ratio = rate / base if base > 0 else math.inf
        strong = ratio >= TAG_MIN_RATIO or (
            rate >= TAG_MIN_RATE and rate - base >= TAG_MIN_RATE_GAIN
        )
        if not strong:
            continue
        labels[index].append(
            {
                "tag": tag,
                "count": count,
                "tagged": tagged,
                "rate": round(rate, 3),
                "ratio": round(min(ratio, 999.0), 2),
                "p": float(f"{p:.3g}"),
                "q": float(f"{q:.3g}"),
            }
        )
    for hits in labels:
        hits.sort(key=lambda hit: (hit["q"], -hit["count"], hit["tag"]))
        del hits[limit:]
    return labels


def region_tag_labels(
    region_ids: Sequence[int],
    *,
    tags_by_image: Mapping[int, Set[str]],
    tagged_ids: Set[int],
    limit: int = TAG_LABEL_LIMIT,
) -> List[Dict[str, Any]]:
    """One region on its own (its tests are the whole BH family)."""
    return tag_labels_for_regions(
        [region_ids], tags_by_image=tags_by_image, tagged_ids=tagged_ids, limit=limit
    )[0]


def region_artist_labels(
    region_ids: Sequence[int],
    *,
    predictions_by_image: Mapping[int, Tuple[str, float]],
    limit: int = ARTIST_LABEL_LIMIT,
) -> List[Dict[str, Any]]:
    """Artists that dominate the region's CONFIDENT predictions (the Style
    Finder's high tier); the low tier is a guess and never counts, and a
    handful of confident pictures in a big region says nothing about it."""
    confident: Counter = Counter()
    high_total = 0
    for image_id in region_ids:
        prediction = predictions_by_image.get(image_id)
        if not prediction:
            continue
        artist, confidence = prediction
        if (
            not artist
            or artist == "undefined"
            or float(confidence) < ARTIST_CONFIDENT_THRESHOLD
        ):
            continue
        high_total += 1
        confident[str(artist)] += 1
    region_size = max(1, len(region_ids))
    if high_total < ARTIST_MIN_HIGH or high_total < ARTIST_MIN_HIGH_SHARE * region_size:
        return []
    labels = []
    for artist, count in confident.most_common(limit):
        share = count / high_total
        if count >= ARTIST_MIN_COUNT and share >= ARTIST_MIN_SHARE:
            labels.append(
                {
                    "artist": artist,
                    "count": count,
                    "high_total": high_total,
                    "share": round(share, 3),
                }
            )
    return labels


# ---------------------------------------------------------------- regions
def _representatives(
    member_rows: np.ndarray,
    xyz: np.ndarray,
    center: np.ndarray,
    ids: np.ndarray,
    features: Optional[np.ndarray],
) -> List[int]:
    order = member_rows[
        np.argsort(((xyz[member_rows] - center) ** 2).sum(axis=1), kind="stable")
    ]
    first = int(order[0])
    picks = [int(ids[first])]
    if features is None or len(order) < 2:
        return picks
    anchor = np.asarray(features[first], dtype=np.float32)
    anchor_norm = float(np.linalg.norm(anchor)) or 1.0
    for row in order[1:]:
        candidate = np.asarray(features[int(row)], dtype=np.float32)
        cos = float(anchor @ candidate) / (
            anchor_norm * (float(np.linalg.norm(candidate)) or 1.0)
        )
        if cos < SECOND_REPRESENTATIVE_MAX_COS:
            picks.append(int(ids[int(row)]))
            break
    return picks


def compute_regions(
    ids: Iterable[int],
    xyz: np.ndarray,
    members: Iterable[int],
    *,
    features: Optional[np.ndarray] = None,
    tags_by_image: Optional[Mapping[int, Set[str]]] = None,
    tagged_ids: Optional[Set[int]] = None,
    predictions_by_image: Optional[Mapping[int, Tuple[str, float]]] = None,
    seed: int = 0,
) -> Dict[str, Any]:
    """Regions of one displayed map: geometry, representatives and labels."""
    ids = np.asarray(list(ids), dtype=np.int64)
    xyz = np.asarray(xyz, dtype=np.float32)
    members = np.asarray(list(members), dtype=np.int64)
    n = len(ids)
    k = pick_k(n)
    if k == 0:
        return {
            "k": 0,
            "seed": seed,
            "algo_version": REGIONS_ALGO_VERSION,
            "regions": [],
        }
    labels, centers = kmeans(xyz, k, seed=seed)
    tags_by_image = tags_by_image or {}
    tagged_ids = tagged_ids or set()
    predictions_by_image = predictions_by_image or {}
    regions = []
    regions_ids: List[List[int]] = []
    for region in range(k):
        rows = np.flatnonzero(labels == region)
        if len(rows) == 0:
            continue
        region_ids = [int(value) for value in ids[rows]]
        regions_ids.append(region_ids)
        regions.append(
            {
                "id": region,
                "center": [round(float(value), 3) for value in centers[region]],
                "size": int(len(rows)),
                "members_total": int(members[rows].sum()),
                "representatives": _representatives(
                    rows, xyz, centers[region], ids, features
                ),
                "tagged": sum(1 for image_id in region_ids if image_id in tagged_ids),
                "artists": region_artist_labels(
                    region_ids, predictions_by_image=predictions_by_image
                ),
            }
        )
    for region, tags in zip(
        regions,
        tag_labels_for_regions(
            regions_ids, tags_by_image=tags_by_image, tagged_ids=tagged_ids
        ),
    ):
        region["tags"] = tags
    regions.sort(key=lambda item: -item["size"])
    return {
        "k": k,
        "seed": seed,
        "algo_version": REGIONS_ALGO_VERSION,
        "regions": regions,
    }


# ------------------------------------------------------------ DB context
def _chunks(ids: Sequence[int]) -> Iterable[List[int]]:
    for start in range(0, len(ids), _ID_CHUNK):
        yield [int(value) for value in ids[start : start + _ID_CHUNK]]


def load_label_context(
    ids: Sequence[int],
) -> Tuple[Dict[int, Set[str]], Set[int], Dict[int, Tuple[str, float]]]:
    """What the DB knows about these pictures: whitelisted style tags per
    picture, the pictures the tagger has seen at all (any tagger row), and
    the Style Finder's prediction per picture."""
    tags_by_image: Dict[int, Set[str]] = {}
    tagged: Set[int] = set()
    predictions: Dict[int, Tuple[str, float]] = {}
    with db.get_db() as conn:
        for chunk in _chunks(ids):
            placeholders = ",".join("?" * len(chunk))
            for image_id, tag in conn.execute(
                "SELECT image_id, tag FROM tags "
                f"WHERE source = 'tagger' AND image_id IN ({placeholders})",
                chunk,
            ):
                tagged.add(int(image_id))
                if tag in STYLE_TAG_SET:
                    tags_by_image.setdefault(int(image_id), set()).add(str(tag))
            for image_id, artist, confidence in conn.execute(
                "SELECT image_id, artist, confidence FROM artist_predictions "
                f"WHERE image_id IN ({placeholders})",
                chunk,
            ):
                predictions[int(image_id)] = (
                    str(artist or ""),
                    float(confidence or 0.0),
                )
    return tags_by_image, tagged, predictions


def label_version() -> Tuple[int, ...]:
    """What the labels are computed from: a fingerprint of the tags and
    artist_predictions tables. Any tagging run, Style Finder batch or manual
    tag edit changes it (ids are autoincrement, so a replaced row moves the
    maximum even when the count stays). Two aggregate scans, no id list."""
    with db.get_db() as conn:
        tags = conn.execute("SELECT COUNT(*), MAX(id) FROM tags").fetchone()
        predictions = conn.execute(
            "SELECT COUNT(*), MAX(id), SUM(id) FROM artist_predictions"
        ).fetchone()
    return tuple(int(value or 0) for value in (*tags, *predictions))


class RegionsCache:
    """Regions bodies per (layout key, method), each stamped with the label
    version it was computed from; a hit whose labels moved on is rebuilt.
    One build at a time: a second request for the same map waits for the
    first and then takes its result (the points cache does the same)."""

    def __init__(self, capacity: int) -> None:
        self._entries: "OrderedDict[tuple, Dict[str, tuple]]" = OrderedDict()
        self._lock = threading.Lock()
        self._capacity = capacity

    def drop(self, layout_key: tuple) -> None:
        with self._lock:
            self._entries.pop(layout_key, None)

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()

    def get_or_build(
        self,
        layout_key: tuple,
        method: str,
        build: Callable[[], bytes],
        *,
        refresh: bool = False,
    ) -> Tuple[bytes, bool]:
        """(body, cached): the current body for this map and method."""
        with self._lock:
            version = label_version()
            hit = self._entries.get(layout_key, {}).get(method)
            if hit is not None and hit[0] == version and not refresh:
                return hit[1], True
            body = build()
            self._entries.setdefault(layout_key, {})[method] = (version, body)
            self._entries.move_to_end(layout_key)
            while len(self._entries) > self._capacity:
                self._entries.popitem(last=False)
            return body, False


def regions_body(
    points_payload: bytes,
    *,
    space: str,
    method: str,
    xyz: Optional[np.ndarray] = None,
    features: Optional[np.ndarray] = None,
) -> bytes:
    """The regions response for one cached points payload, as JSON bytes
    WITHOUT the closing brace (the service appends the ``cached`` flag)."""
    result = json.loads(points_payload)
    payload = {
        "status": result.get("status", "ok"),
        "space": space,
        "method": method,
        "model_version": result.get("model_version"),
        **regions_of_points(result.get("points") or [], xyz=xyz, features=features),
    }
    return json.dumps(payload, separators=(",", ":")).encode("utf-8")[:-1]


def regions_of_points(
    points: Sequence[Sequence[Any]],
    *,
    xyz: Optional[np.ndarray] = None,
    features: Optional[np.ndarray] = None,
    seed: int = 0,
) -> Dict[str, Any]:
    """Regions of one cached ``points`` payload ([id, x, y, z, members, ...]
    rows); ``xyz`` overrides the PCA coordinates with the displayed UMAP
    layout. Tags and artists come from the current library's DB."""
    ids = [int(point[0]) for point in points]
    members = [int(point[4]) for point in points]
    if xyz is None:
        xyz = np.array(
            [[point[1], point[2], point[3]] for point in points], dtype=np.float32
        ).reshape(-1, 3)
    if features is not None and len(features) != len(ids):
        features = None
    tags_by_image, tagged_ids, predictions = load_label_context(ids)
    return compute_regions(
        ids,
        xyz,
        members,
        features=features,
        tags_by_image=tags_by_image,
        tagged_ids=tagged_ids,
        predictions_by_image=predictions,
        seed=seed,
    )
