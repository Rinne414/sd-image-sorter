"""Style map points (slice S2a): a 3-D PCA layout of the filtered library.

``points()`` turns the current Gallery filter (a selection token, the same
contract every "act on the matches" path reads) into one point per picture:

1. the filtered image ids come from ``database.iter_filtered_image_id_chunks``
   with ``selection_contract_db_filters`` -- no second filter parser;
2. the vectors are read for those ids only (``image_style_vectors`` for
   ``kaloscope``, ``images.embedding`` for ``clip``) and unit-normalised;
3. pictures whose unit vector is dominated by one component (> 0.5) are
   reported as ``unlocatable`` and kept out of the fit (Kaloscope answers a
   few broken pictures with one activation of ~1e8);
4. pictures connected by cosine > 0.95 links form one group (single linkage)
   represented by the smallest id -- the candidate search runs in a PCA
   projection with an exact bound, so no true pair is missed, and every
   candidate is confirmed in full dimension without gathering a row per pair;
5. PCA to three axes (fitted on every placeable picture, shared with the
   candidate search), scaled to [-1, 1].

Results are cached as JSON bytes per (library, space, model version, filter,
member ids, vector version); one layout is computed at a time and a
concurrent request for the same key waits for it instead of recomputing.
"""

from __future__ import annotations

import hashlib
import json
import logging
import threading
import time
from collections import OrderedDict
from typing import Any, Dict, List, Optional

import numpy as np
from threadpoolctl import threadpool_limits

import database as db
from artist_identifier import kaloscope_style_vector_model_version
from config import CLIP_MODEL_NAME
from db_style_vectors import unpack_style_vector
from exceptions import ValidationError
from library_context import get_current_library_id
from services.image.selection import selection_contract_db_filters
from similarity_math import bytes_to_embedding

logger = logging.getLogger(__name__)

STYLE_MAP_SPACES = ("kaloscope", "clip")
STYLE_MAP_METHOD = "pca"
NEAR_DUPLICATE_COS = 0.95
UNLOCATABLE_MAX_COMPONENT = 0.5
POINT_DECIMALS = 3
POINTS_LAYOUT = ["id", "x", "y", "z", "members"]
# BLAS threads for the map's matmuls, applied only while a layout is computed
# (owner's choice: the rest of the process keeps its default threads).
STYLE_MAP_BLAS_THREADS = 4
_CANDIDATE_DIM = 256
_BOUND_MARGIN = 1e-3  # float32 slack on the candidate bound
_BLOCK_ROWS = 1024
# Rows per candidate slab. Small slabs keep the (rows x n) gram and mask
# tiny and let the "already grouped" filter run between slabs.
_SUB_ROWS = 128
# k-means clusters used only to order the candidate-search walk.
_CLUSTER_ORDER_K = 64
_ID_CHUNK = 500
_ID_PAGE = 5000
_CACHE_ENTRIES = 8
_COV_BLOCK_ROWS = 8192
# Above this share of remaining columns, confirm against the contiguous slice
# instead of gathering the candidate columns (a gather would copy them).
_GATHER_SHARE = 0.5


# ------------------------------------------------------------------ pure math
def unit_rows(x: np.ndarray) -> np.ndarray:
    x = np.asarray(x, dtype=np.float32)
    norms = np.linalg.norm(x, axis=1, keepdims=True)
    return x / np.maximum(norms, 1e-8)


def find_unlocatable(
    x: np.ndarray, max_component: float = UNLOCATABLE_MAX_COMPONENT
) -> np.ndarray:
    """Rows of a unit matrix that one component dominates (cannot be placed)."""
    if len(x) == 0:
        return np.zeros(0, dtype=bool)
    return np.abs(x).max(axis=1) > max_component


def _top_components(x: np.ndarray, k: int) -> tuple[np.ndarray, np.ndarray, float]:
    """Top-k principal directions of ``x`` (rows), all eigenvalues and total variance."""
    n, d = x.shape
    mean = x.mean(axis=0)
    if n <= d:
        _u, s, vt = np.linalg.svd(x - mean, full_matrices=False)
        eig = s.astype(np.float64) ** 2
        comps = vt[:k]
    else:
        # Covariance accumulated block by block in float32 BLAS: no centered
        # or float64 copy of the whole matrix (50k x 2048 would be 800 MB each).
        cov = np.zeros((d, d), dtype=np.float64)
        for start in range(0, n, _COV_BLOCK_ROWS):
            block = x[start : start + _COV_BLOCK_ROWS] - mean
            cov += block.T @ block
        w, v = np.linalg.eigh(cov)
        order = np.argsort(w)[::-1]
        eig = np.maximum(w[order], 0.0)
        comps = v[:, order[:k]].T
    comps = np.ascontiguousarray(comps, dtype=np.float32)
    # Deterministic sign: the largest loading of each axis points positive.
    for row in comps:
        pivot = int(np.argmax(np.abs(row)))
        if row[pivot] < 0:
            row *= -1
    return comps, eig, float(eig.sum())


def _find_roots(parent: np.ndarray, idx: np.ndarray) -> np.ndarray:
    """Vectorised find with pointer jumping (no path compression needed)."""
    roots = parent[idx]
    while True:
        above = parent[roots]
        if np.array_equal(above, roots):
            return roots
        roots = above


def _union_pairs(parent: np.ndarray, i: np.ndarray, j: np.ndarray) -> None:
    """Union every (i, j) pair; the smallest index of a group stays its root.

    Min-label propagation over the pairs' roots until stable, all in numpy:
    no Python loop per pair, and no scipy (not part of the core install).
    """
    if i.size == 0:
        return
    ri = _find_roots(parent, i)
    rj = _find_roots(parent, j)
    nodes = np.unique(np.concatenate([ri, rj]))
    while True:
        before = parent[nodes].copy()
        low = np.minimum(parent[ri], parent[rj])
        np.minimum.at(parent, ri, low)
        np.minimum.at(parent, rj, low)
        parent[nodes] = parent[parent[nodes]]
        if np.array_equal(parent[nodes], before):
            return


def _cluster_order(
    proj: np.ndarray, k: int = _CLUSTER_ORDER_K, iterations: int = 6
) -> np.ndarray:
    """A permutation that walks the rows cluster by cluster (k-means on ``proj``).

    Deterministic (fixed seed); small inputs keep their order. Only the walk
    order of the candidate search depends on it, never the result.
    """
    n = len(proj)
    if n <= 4 * k:
        return np.arange(n)
    rng = np.random.default_rng(0)
    centers = proj[rng.choice(n, k, replace=False)].astype(np.float32)
    labels = np.zeros(n, dtype=np.int64)
    for _ in range(iterations):
        # argmin |p - c|^2 == argmax (p.c - |c|^2 / 2)
        scores = proj @ centers.T - 0.5 * (centers**2).sum(axis=1)[None, :]
        labels = np.argmax(scores, axis=1)
        counts = np.bincount(labels, minlength=k)
        sums = np.zeros_like(centers)
        np.add.at(sums, labels, proj)
        filled = counts > 0
        centers[filled] = sums[filled] / counts[filled, None]
    return np.argsort(labels, kind="stable")


def merge_near_duplicates(
    ids: np.ndarray,
    x: np.ndarray,
    *,
    threshold: float = NEAR_DUPLICATE_COS,
    candidate_dim: int = _CANDIDATE_DIM,
    block_rows: int = _BLOCK_ROWS,
    components: Optional[np.ndarray] = None,
    stats: Optional[Dict[str, Any]] = None,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Single-linkage groups over cosine > ``threshold``; the smallest id represents a group.

    Returns ``(rep_ids, rep_rows, members)`` sorted by representative id, where
    ``rep_rows`` indexes the input ``x``. Candidates come from a
    ``candidate_dim`` PCA projection (``components`` may be passed in) with
    the exact bound ``p_i.p_j >= threshold - |q_i||q_j|`` (p = projected part,
    q = dropped part, loosened per block to the block's largest |q| and by a
    float32 margin), then every candidate is confirmed in full dimension with
    one block matmul against the candidate columns -- never a gathered row
    per pair -- so the result equals an all-pairs search.
    """
    ids = np.asarray(ids, dtype=np.int64)
    x = np.asarray(x, dtype=np.float32)
    n = len(ids)
    if n == 0:
        empty = np.zeros(0, dtype=np.int64)
        return empty, empty.copy(), empty.copy()
    order = np.argsort(ids, kind="stable")
    if np.array_equal(order, np.arange(n)):
        xs = x  # already id-sorted: no 400 MB copy for a 50k library
    else:
        xs = x[order]
    if n == 1:
        return ids[order], order, np.ones(1, dtype=np.int64)

    d = xs.shape[1]
    k = min(int(candidate_dim), d, n)
    if k < d:
        if components is not None and components.shape[0] >= k:
            comps = np.ascontiguousarray(components[:k], dtype=np.float32)
        else:
            comps, _eig, _total = _top_components(xs, k)
        proj = xs @ comps.T  # p_i (retained part), not re-normalised
        retained = (proj.astype(np.float64) ** 2).sum(axis=1)
        dropped = np.sqrt(np.maximum(1.0 - retained, 0.0))  # float64 |q_i|
    else:
        proj = xs
        dropped = np.zeros(n, dtype=np.float64)

    # Walk the rows in cluster order (a cheap k-means on the projection), so a
    # slab's candidate columns concentrate in a few clusters instead of being
    # spread over the whole library: the confirmation then gathers thousands
    # of columns per slab, not all of them. Grouping is order-independent and
    # the representative is still the smallest id of each group.
    perm = _cluster_order(proj)
    pp = proj[perm]
    dp = dropped[perm]
    parent = np.arange(n, dtype=np.int64)
    candidates = 0
    confirmed = 0
    sub_rows = max(1, min(int(block_rows), _SUB_ROWS))
    for start in range(0, n, block_rows):
        stop = min(start + block_rows, n)
        width = stop - start
        # Upper triangle only: this block's rows against columns start..n.
        # One big matmul per block keeps BLAS efficient; the confirmation
        # below walks the block in small slabs.
        gram = pp[start:stop] @ pp[start:].T  # (b, n - start)
        bound = (
            threshold - _BOUND_MARGIN - float(dp[start:stop].max()) * dp[start:]
        ).astype(np.float32)
        mask = gram >= bound
        del gram
        mask[:, :width] &= np.triu(np.ones((width, width), dtype=bool), 1)
        for s0 in range(start, stop, sub_rows):
            s1 = min(s0 + sub_rows, stop)
            rows = s1 - s0
            # Columns before s0 are already False (upper triangle).
            sub = mask[s0 - start : s1 - start, s0 - start :]
            # Pairs already in one group need no confirmation: without this,
            # a library of near-duplicates confirms and unions every pair of
            # every slab, and the hit arrays grow with n^2 (reviewer probe:
            # 24k points -> 1.9 GB). Roots are refreshed per slab because the
            # previous slab's unions change them.
            roots = _find_roots(parent, np.arange(s0, n))
            sub = sub & (roots[:rows, None] != roots[None, :])
            cols = np.nonzero(sub.any(axis=0))[0]
            if cols.size == 0:
                continue
            candidates += int(np.count_nonzero(sub))
            # Full-dimension confirmation as ONE matmul against the candidate
            # columns (or the contiguous slice when most columns are candidates).
            slab = xs[perm[s0:s1]]
            if cols.size > _GATHER_SHARE * (n - s0):
                full = slab @ xs[perm[s0:]].T
                hit_r, hit_c = np.nonzero(sub & (full > threshold))
            else:
                full = slab @ xs[perm[s0 + cols]].T
                hit_r, hit_local = np.nonzero(sub[:, cols] & (full > threshold))
                hit_c = cols[hit_local]
            del full, sub
            if hit_r.size == 0:
                continue
            confirmed += int(hit_r.size)
            _union_pairs(parent, hit_r + s0, hit_c + s0)
        del mask

    roots = _find_roots(parent, np.arange(n))  # in walk order
    # Representative = smallest id of the group = smallest id-sorted row.
    min_sorted_row = np.full(n, n, dtype=np.int64)
    np.minimum.at(min_sorted_row, roots, perm)
    group_roots = np.unique(roots)
    rep_sorted_rows = min_sorted_row[group_roots]
    by_id = np.argsort(rep_sorted_rows, kind="stable")
    rep_sorted_rows = rep_sorted_rows[by_id]
    members = np.bincount(roots, minlength=n)[group_roots][by_id]
    if stats is not None:
        stats.update(
            {
                "candidate_pairs": candidates,
                "duplicate_pairs": confirmed,
                "candidate_dim": k,
            }
        )
    return ids[order][rep_sorted_rows], order[rep_sorted_rows], members.astype(np.int64)


def pca_layout(
    x: np.ndarray,
    *,
    components: Optional[np.ndarray] = None,
    eigenvalues: Optional[np.ndarray] = None,
    total_variance: Optional[float] = None,
) -> tuple[np.ndarray, List[float]]:
    """3-D PCA coordinates scaled to [-1, 1] and the explained-variance ratios.

    With ``components`` (and their eigenvalues) the axes come from a fit made
    elsewhere -- the service fits once on every placeable picture and reuses
    the axes for the candidate search and this layout.
    """
    x = np.asarray(x, dtype=np.float32)
    n = len(x)
    if n < 2:
        return np.zeros((n, 3), dtype=np.float32), [0.0, 0.0, 0.0]
    if components is None or eigenvalues is None or total_variance is None:
        comps, eig, total = _top_components(x, 3)
    else:
        comps, eig, total = (
            np.asarray(components[:3], dtype=np.float32),
            np.asarray(eigenvalues),
            float(total_variance),
        )
    xyz = x @ comps.T - x.mean(axis=0) @ comps.T  # no centered copy of x
    if xyz.shape[1] < 3:
        xyz = np.pad(xyz, ((0, 0), (0, 3 - xyz.shape[1])))
    peak = float(np.abs(xyz).max()) or 1.0
    xyz = (xyz / peak).astype(np.float32)
    ratios = [float(v) / total if total > 0 else 0.0 for v in eig[:3]]
    ratios += [0.0] * (3 - len(ratios))
    return xyz, [round(r, 4) for r in ratios]


# ------------------------------------------------------------------- service
class StyleMapService:
    """Computes and caches the 3-D layout of the filtered library."""

    def __init__(self) -> None:
        self._cache: "OrderedDict[tuple, tuple[bytes, int]]" = OrderedDict()
        self._stamp = 0
        self._cache_lock = threading.Lock()
        self._compute_lock = threading.Lock()
        self.last_stats: Dict[str, Any] = {}

    # ---------------------------------------------------------------- inputs
    @staticmethod
    def _require_space(space: str) -> str:
        normalized = str(space or "").strip().lower()
        if normalized not in STYLE_MAP_SPACES:
            raise ValidationError(
                f"Unknown style space {space!r}; expected one of {', '.join(STYLE_MAP_SPACES)}",
                field="space",
            )
        return normalized

    @staticmethod
    def _contract(selection_token: Optional[str]) -> Dict[str, Any]:
        """The Gallery filter contract; the whole library when no token is given."""
        if not selection_token:
            return {}
        from services.image_service import ImageService

        return ImageService()._decode_selection_token(selection_token)

    @staticmethod
    def _model_version(space: str) -> str:
        if space == "clip":
            return f"clip:{CLIP_MODEL_NAME}"
        return kaloscope_style_vector_model_version(None)

    @staticmethod
    def _vector_version(space: str, model_version: str) -> tuple:
        """Changes whenever a vector of this space is added, removed or rewritten.

        Count + sum of ids catches adds/removes/swaps; MAX(updated_at) (written
        by the upsert with millisecond precision) catches a rewrite of an
        existing row, even inside the same second. clip has no timestamp: its
        signature is count + sum + max id, like the Similarity cache's own.
        """
        with db.get_db() as conn:
            if space == "clip":
                # A recomputed embedding follows a rescan that saw new pixels,
                # which rewrites source_mtime_ns / source_size (the clear in
                # between also blanks content_fingerprint); those move the sums.
                row = conn.execute(
                    "SELECT COUNT(*), SUM(id), MAX(id), "
                    "SUM(COALESCE(source_mtime_ns, 0)), SUM(COALESCE(source_size, 0)), "
                    "SUM(content_fingerprint IS NULL) "
                    "FROM images WHERE embedding IS NOT NULL"
                ).fetchone()
            else:
                row = conn.execute(
                    "SELECT COUNT(*), SUM(image_id), MAX(updated_at) FROM image_style_vectors "
                    "WHERE space = ? AND model_version = ?",
                    ("kaloscope", model_version),
                ).fetchone()
        return tuple(
            int(v) if isinstance(v, (int, float)) else str(v or "") for v in row
        )

    @staticmethod
    def _member_hash(ids: List[int]) -> str:
        """The filtered picture set itself (sorted ids), not just its size."""
        digest = hashlib.sha256()
        digest.update(np.asarray(sorted(ids), dtype=np.int64).tobytes())
        return digest.hexdigest()

    # ----------------------------------------------------------------- cache
    def _cache_get(self, key: tuple) -> Optional[tuple[bytes, int]]:
        """(payload, stamp); the stamp orders cache writes for refresh de-duplication."""
        with self._cache_lock:
            entry = self._cache.get(key)
            if entry is not None:
                self._cache.move_to_end(key)
            return entry

    def _cache_put(self, key: tuple, value: bytes) -> None:
        with self._cache_lock:
            self._stamp += 1
            self._cache[key] = (value, self._stamp)
            self._cache.move_to_end(key)
            while len(self._cache) > _CACHE_ENTRIES:
                self._cache.popitem(last=False)

    def clear_cache(self) -> None:
        with self._cache_lock:
            self._cache.clear()

    # ------------------------------------------------------------------ main
    @staticmethod
    def _with_cached_flag(payload: bytes, cached: bool) -> bytes:
        return payload[:-1] + (b',"cached":true}' if cached else b',"cached":false}')

    def points_json(
        self,
        space: str,
        selection_token: Optional[str] = None,
        *,
        refresh: bool = False,
    ) -> bytes:
        """The response as JSON bytes (what the route returns); ``refresh`` skips the cache read."""
        normalized = self._require_space(space)
        contract = self._contract(selection_token)
        model_version = self._model_version(normalized)
        ids = self._filtered_ids(contract)
        key = (
            get_current_library_id(),
            normalized,
            model_version,
            self._member_hash(ids),
            self._vector_version(normalized, model_version),
        )
        if not refresh:
            entry = self._cache_get(key)
            if entry is not None:
                return self._with_cached_flag(entry[0], True)
        with self._cache_lock:
            waited_since = self._stamp
        with self._compute_lock:
            entry = self._cache_get(key)
            # A refresh that queued behind another computation of the same
            # map takes that fresh result instead of recomputing it again.
            if entry is not None and (not refresh or entry[1] > waited_since):
                return self._with_cached_flag(entry[0], True)
            with threadpool_limits(limits=STYLE_MAP_BLAS_THREADS, user_api="blas"):
                result = self._compute(normalized, model_version, ids)
            payload = json.dumps(result, separators=(",", ":")).encode("utf-8")
            self._cache_put(key, payload)
        return self._with_cached_flag(payload, False)

    def points(
        self,
        space: str,
        selection_token: Optional[str] = None,
        *,
        refresh: bool = False,
    ) -> Dict[str, Any]:
        """Dict form of :meth:`points_json` (tests and in-process callers)."""
        return json.loads(self.points_json(space, selection_token, refresh=refresh))

    # --------------------------------------------------------------- compute
    def _filtered_ids(self, contract: Dict[str, Any]) -> List[int]:
        ids: List[int] = []
        for chunk in db.iter_filtered_image_id_chunks(
            chunk_size=_ID_PAGE,
            sort_by="newest",
            **selection_contract_db_filters(contract),
        ):
            ids.extend(int(value) for value in chunk)
        return ids

    def _load_vectors(
        self, space: str, model_version: str, ids: List[int]
    ) -> tuple[np.ndarray, np.ndarray]:
        """(vector_ids, matrix) for the ids that have a usable vector, id order.

        The raw blobs are collected first (about 4 KB each), sorted by id and
        decoded straight into one preallocated float32 matrix, so a 50k
        library costs one 400 MB matrix plus the transient blobs, not a list
        of arrays plus stack, normalise and sort copies.
        """
        blobs: List[tuple[int, Any]] = []
        with db.get_db() as conn:
            for start in range(0, len(ids), _ID_CHUNK):
                chunk = ids[start : start + _ID_CHUNK]
                placeholders = ",".join("?" * len(chunk))
                if space == "clip":
                    cursor = conn.execute(
                        f"SELECT id, embedding FROM images "
                        f"WHERE embedding IS NOT NULL AND id IN ({placeholders})",
                        chunk,
                    )
                    blobs.extend((int(row[0]), (row[1], None, None)) for row in cursor)
                else:
                    cursor = conn.execute(
                        f"SELECT image_id, dim, dtype, vector FROM image_style_vectors "
                        f"WHERE space = 'kaloscope' AND model_version = ? AND image_id IN ({placeholders})",
                        [model_version, *chunk],
                    )
                    blobs.extend(
                        (int(row[0]), (row[3], int(row[1]), str(row[2])))
                        for row in cursor
                    )
        if not blobs:
            return np.zeros(0, dtype=np.int64), np.zeros((0, 0), dtype=np.float32)
        blobs.sort(key=lambda item: item[0])

        def decode(payload) -> np.ndarray:
            raw, dim, dtype = payload
            if dim is None:
                return bytes_to_embedding(raw)
            return unpack_style_vector(raw, dim, dtype)

        width = int(decode(blobs[0][1]).size)
        matrix = np.empty((len(blobs), width), dtype=np.float32)
        found_ids: List[int] = []
        filled = 0
        for image_id, payload in blobs:
            vector = np.asarray(decode(payload), dtype=np.float32).reshape(-1)
            if vector.size != width or not np.all(np.isfinite(vector)):
                logger.warning(
                    "Style map: image %s vector unusable (%d dims, expected %d)",
                    image_id,
                    vector.size,
                    width,
                )
                continue
            matrix[filled] = vector
            found_ids.append(image_id)
            filled += 1
        del blobs
        matrix = matrix[:filled]
        norms = np.linalg.norm(matrix, axis=1, keepdims=True)
        matrix /= np.maximum(norms, 1e-8)
        # blobs were sorted by id, so matrix rows are already in id order.
        return np.asarray(found_ids, dtype=np.int64), matrix

    def _compute(
        self, space: str, model_version: str, ids: List[int]
    ) -> Dict[str, Any]:
        timings: Dict[str, Any] = {}
        t0 = time.perf_counter()
        base = {
            "space": space,
            "method": STYLE_MAP_METHOD,
            "model_version": model_version,
            "total_images": len(ids),
            "missing_vectors": len(ids),
            "unlocatable": [],
            "merged_away": 0,
            "explained_variance": [0.0, 0.0, 0.0],
            "points_layout": list(POINTS_LAYOUT),
            "points": [],
        }
        if not ids:
            return {**base, "status": "empty"}
        vector_ids, matrix = self._load_vectors(space, model_version, ids)
        timings["read_s"] = round(time.perf_counter() - t0, 3)
        base["missing_vectors"] = len(ids) - len(vector_ids)
        if len(vector_ids) == 0:
            return {**base, "status": "no_vectors"}

        unlocatable = find_unlocatable(matrix)
        base["unlocatable"] = [int(value) for value in vector_ids[unlocatable]]
        if unlocatable.any():
            keep_ids = vector_ids[~unlocatable]
            keep = matrix[~unlocatable]
        else:
            keep_ids, keep = vector_ids, matrix  # nothing to drop: no copy
        del matrix
        if len(keep_ids) == 0:
            return {**base, "status": "no_vectors"}

        # One covariance + eigh for both the candidate search and the layout.
        t1 = time.perf_counter()
        n, d = keep.shape
        comps, eig, total = _top_components(keep, min(max(_CANDIDATE_DIM, 3), d, n))
        timings["pca_fit_s"] = round(time.perf_counter() - t1, 3)

        t2 = time.perf_counter()
        merge_stats: Dict[str, Any] = {}
        rep_ids, rep_rows, members = merge_near_duplicates(
            keep_ids, keep, components=comps, stats=merge_stats
        )
        timings["merge_s"] = round(time.perf_counter() - t2, 3)
        timings.update(merge_stats)

        t3 = time.perf_counter()
        xyz, explained = pca_layout(
            keep[rep_rows], components=comps, eigenvalues=eig, total_variance=total
        )
        del keep
        timings["layout_s"] = round(time.perf_counter() - t3, 3)
        xyz = np.round(xyz.astype(np.float64), POINT_DECIMALS)
        points = [
            [int(image_id), float(x), float(y), float(z), int(count)]
            for image_id, (x, y, z), count in zip(
                rep_ids.tolist(), xyz.tolist(), members.tolist()
            )
        ]
        timings["total_s"] = round(time.perf_counter() - t0, 3)
        timings["points"] = len(points)
        self.last_stats = timings
        logger.info(
            "Style map (%s): %d ids, %d points, %s",
            space,
            len(ids),
            len(points),
            timings,
        )
        return {
            **base,
            "status": "ok",
            "merged_away": int(len(keep_ids) - len(rep_ids)),
            "explained_variance": explained,
            "points": points,
        }
