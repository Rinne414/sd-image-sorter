"""Pure math of the style map: unit rows, unlocatable rows, PCA components,
exact near-duplicate merging (union-find over a bounded candidate search) and
the 3-D PCA layout. No database, no state; StyleMapService calls into here.
Moved verbatim from style_map_service.py (S2b.1 split)."""

from __future__ import annotations

import threading
from contextlib import contextmanager
from typing import Any, Dict, Iterator, List, Optional

import numpy as np
from threadpoolctl import threadpool_limits

# Bump when the merge / unlocatable / layout rules change: cached UMAP
# layouts are keyed on it, so an old build's layout is never drawn over a
# map whose representatives were chosen differently.
STYLE_MAP_ALGO_VERSION = 1
NEAR_DUPLICATE_COS = 0.95
UNLOCATABLE_MAX_COMPONENT = 0.5
POINT_DECIMALS = 3
POINTS_LAYOUT = ["id", "x", "y", "z", "members"]
# BLAS threads for the map's matmuls, applied only while a layout is computed
# (owner's choice: the rest of the process keeps its default threads).
STYLE_MAP_BLAS_THREADS = 4

_blas_lock = threading.Lock()
_blas_depth = 0
_blas_limiter: Optional[threadpool_limits] = None


@contextmanager
def blas_budget() -> Iterator[None]:
    """Cap the process's BLAS threads at ``STYLE_MAP_BLAS_THREADS`` while any
    map computation runs.

    threadpool_limits changes the whole process and each context restores
    what *it* saw on entry, so two overlapping contexts (a PCA request and
    the UMAP worker) would leave the cap wrong or permanent. One shared,
    reference-counted limiter: the first user applies the cap and remembers
    the original, the last one out restores it.
    """
    global _blas_depth, _blas_limiter
    with _blas_lock:
        if _blas_depth == 0:
            _blas_limiter = threadpool_limits(
                limits=STYLE_MAP_BLAS_THREADS, user_api="blas"
            )
        _blas_depth += 1
    try:
        yield
    finally:
        with _blas_lock:
            _blas_depth -= 1
            if _blas_depth == 0 and _blas_limiter is not None:
                limiter, _blas_limiter = _blas_limiter, None
                limiter.restore_original_limits()


_CANDIDATE_DIM = 256
_BOUND_MARGIN = 1e-3  # float32 slack on the candidate bound
_BLOCK_ROWS = 1024
# Rows per candidate slab. Small slabs keep the (rows x n) gram and mask
# tiny and let the "already grouped" filter run between slabs.
_SUB_ROWS = 128
# k-means clusters used only to order the candidate-search walk.
_CLUSTER_ORDER_K = 64
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
