"""Near-duplicate GROUP scanning for the cleanup workflow (v3.5.0 Tier 1).

The old ``find_duplicates`` endpoint returns ranked PAIRS, is synchronous,
and refuses libraries above DUPLICATE_SYNC_MAX_EMBEDDINGS (Debt-17). The
cleanup workflow needs the whole library organized into GROUPS with a
suggested keeper, so users can review side-by-side and clear the rest.

This service runs as a bulk background job (progress + cancel via
``bulk_job_service``):

1. Load every CLIP embedding (id + vector) and L2-normalize.
2. Find neighbor pairs >= threshold — via the optional hnswlib ANN when
   available (sub-quadratic), else an exact chunked matmul over the upper
   triangle. Both paths are streamed and cancellable; there is NO size cap.
3. Partition exact threshold edges into direct-neighbor groups. Every suggested
   loser must have a direct edge to the keeper that remains; transitive chains
   are never destructive suggestions.
4. Enrich members with metadata and rank each group: highest
   (user_rating, aesthetic_score, resolution, file_size) first — that
   member becomes the suggested keeper.
5. Persist the full result to ``<state>/duplicate-groups.json`` so the
   review UI can page through it and survive restarts.

Deletion is deliberately NOT implemented here — the frontend feeds the
checked ids to the existing trash-backed delete pipeline.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, TypeAlias

import numpy as np

logger = logging.getLogger(__name__)

DEFAULT_THRESHOLD = 0.95
MIN_THRESHOLD = 0.80
MAX_THRESHOLD = 0.999
_ANN_NEIGHBOR_K = 24          # neighbors fetched per item on the ANN path
_MATMUL_CHUNK = 512           # rows per chunk on the exact path
_GROUP_CANCEL_CHECK_INTERVAL = 256
_RESULT_VERSION = 2
_STATE_FILENAME = "duplicate-groups.json"

_SCAN_LOCK = threading.Lock()
_ACTIVE_JOB_ID: Optional[str] = None

SimilarityPair: TypeAlias = tuple[int, int, float]
NeighborMap: TypeAlias = Dict[int, Dict[int, float]]
DirectNeighborGroup: TypeAlias = tuple[List[int], float]
CancellationCheck: TypeAlias = Callable[[], bool]


class DuplicateGroupPersistenceError(RuntimeError):
    """Raised when the completed duplicate scan cannot be stored atomically."""


def _state_path() -> Path:
    import config

    return Path(config.get_state_dir()) / _STATE_FILENAME


# ---------------------------------------------------------------------------
# Scan registration (one at a time)
# ---------------------------------------------------------------------------

def get_active_job_id() -> Optional[str]:
    with _SCAN_LOCK:
        return _ACTIVE_JOB_ID


def set_active_job_id(job_id: Optional[str]) -> bool:
    """Claim/release the single scan slot. Returns False if already claimed."""
    global _ACTIVE_JOB_ID
    with _SCAN_LOCK:
        if job_id is not None and _ACTIVE_JOB_ID is not None:
            return False
        _ACTIVE_JOB_ID = job_id
        return True


# ---------------------------------------------------------------------------
# Scan worker
# ---------------------------------------------------------------------------

def _load_embeddings(handle) -> tuple:
    """Return (ids, normalized_matrix) for all readable embedded images."""
    import database as db
    from similarity import bytes_to_embedding

    handle.set_progress(processed=0, total=100, message="正在读取嵌入向量 / Loading embeddings")
    with db.get_db() as conn:
        rows = conn.execute(
            """
            SELECT id, embedding FROM images
            WHERE embedding IS NOT NULL AND COALESCE(is_readable, 1) = 1
            ORDER BY id
            """
        ).fetchall()
    ids = [int(r[0]) for r in rows]
    if len(ids) < 2:
        return ids, None
    vectors = np.stack([bytes_to_embedding(r[1]) for r in rows]).astype(np.float32)
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return ids, vectors / norms


def _pairs_via_ann(
    matrix: np.ndarray, threshold: float, handle
) -> Optional[List[SimilarityPair]]:
    """Neighbor pairs via hnswlib. None → caller falls back to exact path."""
    import similarity_ann

    if not similarity_ann.hnswlib_available():
        return None
    n = matrix.shape[0]
    ann = similarity_ann.build_index(matrix, (n, n), None, persist=False)
    if ann is None:
        return None
    k = min(_ANN_NEIGHBOR_K, n)
    pairs: List[SimilarityPair] = []
    for i in range(n):
        if i % 512 == 0:
            if handle.cancelled:
                return pairs
            handle.set_progress(
                processed=20 + int(60 * i / max(1, n)), total=100,
                message=f"Searching neighbors {i}/{n}",
            )
        labels = ann.query(matrix[i], k)
        if labels is None:
            return None  # index unhealthy — redo exactly
        sims = matrix[labels] @ matrix[i]
        for j, sim in zip(labels.tolist(), sims.tolist()):
            if j > i and sim >= threshold:
                pairs.append((i, j, float(sim)))
    return pairs


def _pairs_exact(
    matrix: np.ndarray, threshold: float, handle
) -> List[SimilarityPair]:
    """Exact upper-triangle chunked matmul — no size cap, streamed."""
    n = matrix.shape[0]
    pairs: List[SimilarityPair] = []
    total_chunks = (n + _MATMUL_CHUNK - 1) // _MATMUL_CHUNK
    done_chunks = 0
    for i in range(0, n, _MATMUL_CHUNK):
        if handle.cancelled:
            return pairs
        chunk = matrix[i:i + _MATMUL_CHUNK]
        sims = chunk @ matrix[i:].T  # only columns >= i (upper triangle)
        rows_idx, cols_idx = np.nonzero(sims >= threshold)
        for ci, cj in zip(rows_idx.tolist(), cols_idx.tolist()):
            a, b = i + ci, i + cj
            if a < b:
                pairs.append((a, b, float(sims[ci, cj])))
        done_chunks += 1
        handle.set_progress(
            processed=20 + int(60 * done_chunks / max(1, total_chunks)), total=100,
            message=f"Comparing block {done_chunks}/{total_chunks}",
        )
    return pairs


def _rank_key(member: Dict[str, Any]) -> tuple:
    return (
        member.get("user_rating") or 0,
        member.get("aesthetic_score") or 0.0,
        (member.get("width") or 0) * (member.get("height") or 0),
        member.get("file_size") or 0,
        -(member.get("id") or 0),  # stable: older image wins final ties
    )


def _build_neighbor_map(pairs: List[SimilarityPair]) -> NeighborMap:
    neighbors: NeighborMap = {}
    for first, second, similarity in pairs:
        if first == second:
            continue
        first_neighbors = neighbors.setdefault(first, {})
        second_neighbors = neighbors.setdefault(second, {})
        first_neighbors[second] = max(first_neighbors.get(second, 0.0), similarity)
        second_neighbors[first] = max(second_neighbors.get(first, 0.0), similarity)
    return neighbors


def _partition_direct_neighbor_groups(
    ids: List[int],
    neighbors: NeighborMap,
    metadata: Dict[int, Dict[str, Any]],
    is_cancelled: CancellationCheck,
) -> Optional[List[DirectNeighborGroup]]:
    """Return disjoint keeper-first groups backed by direct similarity edges."""
    remaining = {
        index
        for index in neighbors
        if 0 <= index < len(ids) and ids[index] in metadata
    }
    ranked = sorted(
        remaining,
        key=lambda index: _rank_key(metadata[ids[index]]),
        reverse=True,
    )
    rank_positions = {index: position for position, index in enumerate(ranked)}
    groups: List[DirectNeighborGroup] = []

    for position, keeper in enumerate(ranked):
        if position % _GROUP_CANCEL_CHECK_INTERVAL == 0 and is_cancelled():
            return None
        if keeper not in remaining:
            continue
        direct_losers = sorted(
            (
                neighbor
                for neighbor in neighbors.get(keeper, {})
                if neighbor != keeper and neighbor in remaining
            ),
            key=rank_positions.__getitem__,
        )
        remaining.remove(keeper)
        if not direct_losers:
            continue

        remaining.difference_update(direct_losers)
        minimum_similarity = min(
            neighbors[keeper][loser] for loser in direct_losers
        )
        groups.append(([keeper, *direct_losers], minimum_similarity))

    return None if is_cancelled() else groups


def _build_groups(
    ids: List[int], pairs: List[SimilarityPair], handle
) -> Optional[List[Dict[str, Any]]]:
    import database as db

    handle.set_progress(processed=85, total=100, message="Clustering groups")
    if handle.cancelled:
        return None
    neighbors = _build_neighbor_map(pairs)
    member_ids = [
        ids[index]
        for index in neighbors
        if 0 <= index < len(ids)
    ]
    if not member_ids:
        return []

    meta: Dict[int, Dict[str, Any]] = {}
    with db.get_db() as conn:
        for start in range(0, len(member_ids), 900):
            if handle.cancelled:
                return None
            batch = member_ids[start:start + 900]
            placeholders = ",".join("?" * len(batch))
            for row in conn.execute(
                f"""
                SELECT id, path, filename, width, height, file_size,
                       aesthetic_score, user_rating
                FROM images WHERE id IN ({placeholders})
                """,
                batch,
            ).fetchall():
                meta[int(row[0])] = {
                    "id": int(row[0]),
                    "path": row[1],
                    "filename": row[2],
                    "width": row[3],
                    "height": row[4],
                    "file_size": row[5],
                    "aesthetic_score": row[6],
                    "user_rating": row[7],
                }

    def is_cancelled() -> bool:
        return bool(handle.cancelled)

    partitioned = _partition_direct_neighbor_groups(
        ids,
        neighbors,
        meta,
        is_cancelled,
    )
    if partitioned is None:
        return None

    groups: List[Dict[str, Any]] = []
    for group_index, (member_indices, minimum_similarity) in enumerate(partitioned):
        if group_index % _GROUP_CANCEL_CHECK_INTERVAL == 0 and handle.cancelled:
            return None
        entries = [dict(meta[ids[index]]) for index in member_indices]
        for pos, entry in enumerate(entries):
            entry["suggested_keep"] = pos == 0
        groups.append({
            "similarity": round(minimum_similarity, 4),
            "members": entries,
        })

    if handle.cancelled:
        return None
    groups.sort(key=lambda g: (len(g["members"]), g["similarity"]), reverse=True)
    for gi, group in enumerate(groups):
        group["group_id"] = gi
    return groups


def run_duplicate_scan(handle, threshold: float = DEFAULT_THRESHOLD) -> None:
    """Bulk-job worker: scan the whole library into duplicate groups."""
    try:
        threshold = max(MIN_THRESHOLD, min(MAX_THRESHOLD, float(threshold)))
        ids, matrix = _load_embeddings(handle)
        if matrix is None:
            if handle.cancelled:
                return
            result = _empty_result(threshold, embedded_count=len(ids))
            _persist(result)
            handle.set_result({"summary": result["summary"]})
            return
        if handle.cancelled:
            return

        handle.set_progress(processed=20, total=100, message="Searching neighbors")
        pairs = _pairs_via_ann(matrix, threshold, handle)
        if pairs is None:
            pairs = _pairs_exact(matrix, threshold, handle)
        if handle.cancelled:
            return

        groups = _build_groups(ids, pairs, handle)
        if groups is None or handle.cancelled:
            return
        redundant = sum(len(g["members"]) - 1 for g in groups)
        reclaimable = sum(
            m.get("file_size") or 0
            for g in groups for m in g["members"] if not m["suggested_keep"]
        )
        result = {
            "version": _RESULT_VERSION,
            "scanned_at": time.time(),
            "threshold": threshold,
            "summary": {
                "embedded_count": len(ids),
                "group_count": len(groups),
                "redundant_count": redundant,
                "reclaimable_bytes": int(reclaimable),
                "threshold": threshold,
            },
            "groups": groups,
        }
        if handle.cancelled:
            return
        _persist(result)
        handle.set_progress(processed=100, total=100, message="Done")
        handle.set_result({"summary": result["summary"]})
    finally:
        set_active_job_id(None)


def _empty_result(threshold: float, embedded_count: int) -> Dict[str, Any]:
    return {
        "version": _RESULT_VERSION,
        "scanned_at": time.time(),
        "threshold": threshold,
        "summary": {
            "embedded_count": embedded_count,
            "group_count": 0,
            "redundant_count": 0,
            "reclaimable_bytes": 0,
            "threshold": threshold,
        },
        "groups": [],
    }


# ---------------------------------------------------------------------------
# Persisted results
# ---------------------------------------------------------------------------

def _persist(result: Dict[str, Any]) -> None:
    path = _state_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(result, separators=(",", ":")), encoding="utf-8")
        os.replace(tmp, path)
    except OSError as exc:
        raise DuplicateGroupPersistenceError(
            f"Failed to persist duplicate groups to {path}: {exc}"
        ) from exc


def load_result() -> Optional[Dict[str, Any]]:
    path = _state_path()
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if (
            not isinstance(data, dict)
            or data.get("version") != _RESULT_VERSION
            or not isinstance(data.get("groups"), list)
        ):
            return None
        return data
    except Exception as exc:
        logger.warning("Failed to load duplicate groups state: %s", exc)
        return None


def get_groups_page(offset: int = 0, limit: int = 50) -> Dict[str, Any]:
    """Page through the last persisted scan (group-level pagination)."""
    data = load_result()
    if data is None:
        return {
            "available": False,
            "summary": None,
            "groups": [],
            "total_groups": 0,
            "offset": 0,
            "limit": limit,
            "has_more": False,
        }
    groups = data.get("groups") or []
    offset = max(0, int(offset))
    limit = max(1, min(int(limit), 200))
    page = groups[offset:offset + limit]
    return {
        "available": True,
        "scanned_at": data.get("scanned_at"),
        "threshold": data.get("threshold"),
        "summary": data.get("summary"),
        "groups": page,
        "total_groups": len(groups),
        "offset": offset,
        "limit": limit,
        "has_more": offset + len(page) < len(groups),
    }
