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
3. Union-find the pairs into groups.
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
from typing import Any, Dict, List, Optional

import numpy as np

logger = logging.getLogger(__name__)

DEFAULT_THRESHOLD = 0.95
MIN_THRESHOLD = 0.80
MAX_THRESHOLD = 0.999
_ANN_NEIGHBOR_K = 24          # neighbors fetched per item on the ANN path
_MATMUL_CHUNK = 512           # rows per chunk on the exact path
_STATE_FILENAME = "duplicate-groups.json"

_SCAN_LOCK = threading.Lock()
_ACTIVE_JOB_ID: Optional[str] = None


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
# Union-find
# ---------------------------------------------------------------------------

class _UnionFind:
    def __init__(self, size: int) -> None:
        self.parent = list(range(size))

    def find(self, x: int) -> int:
        root = x
        while self.parent[root] != root:
            root = self.parent[root]
        while self.parent[x] != root:
            self.parent[x], x = root, self.parent[x]
        return root

    def union(self, a: int, b: int) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[rb] = ra


# ---------------------------------------------------------------------------
# Scan worker
# ---------------------------------------------------------------------------

def _load_embeddings(handle) -> tuple:
    """Return (ids, normalized_matrix) for all readable embedded images."""
    import database as db
    from similarity import bytes_to_embedding

    handle.set_progress(processed=0, total=100, message="Loading embeddings")
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


def _pairs_via_ann(matrix: np.ndarray, threshold: float, handle) -> Optional[List[tuple]]:
    """Neighbor pairs via hnswlib. None → caller falls back to exact path."""
    import similarity_ann

    if not similarity_ann.hnswlib_available():
        return None
    n = matrix.shape[0]
    ann = similarity_ann.build_index(matrix, (n, n), None, persist=False)
    if ann is None:
        return None
    k = min(_ANN_NEIGHBOR_K, n)
    pairs: List[tuple] = []
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


def _pairs_exact(matrix: np.ndarray, threshold: float, handle) -> List[tuple]:
    """Exact upper-triangle chunked matmul — no size cap, streamed."""
    n = matrix.shape[0]
    pairs: List[tuple] = []
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


def _build_groups(ids: List[int], pairs: List[tuple], handle) -> List[Dict[str, Any]]:
    import database as db

    handle.set_progress(processed=85, total=100, message="Clustering groups")
    uf = _UnionFind(len(ids))
    best_sim: Dict[int, float] = {}
    for a, b, sim in pairs:
        uf.union(a, b)
    for a, b, sim in pairs:
        root = uf.find(a)
        best_sim[root] = max(best_sim.get(root, 0.0), sim)

    clusters: Dict[int, List[int]] = {}
    for idx in range(len(ids)):
        root = uf.find(idx)
        clusters.setdefault(root, []).append(idx)

    member_ids = [ids[i] for members in clusters.values() if len(members) > 1 for i in members]
    if not member_ids:
        return []

    meta: Dict[int, Dict[str, Any]] = {}
    with db.get_db() as conn:
        for start in range(0, len(member_ids), 900):
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

    groups: List[Dict[str, Any]] = []
    for root, members in clusters.items():
        if len(members) < 2:
            continue
        entries = [meta[ids[i]] for i in members if ids[i] in meta]
        if len(entries) < 2:
            continue
        entries.sort(key=_rank_key, reverse=True)
        for pos, entry in enumerate(entries):
            entry["suggested_keep"] = pos == 0
        groups.append({
            "similarity": round(best_sim.get(root, 0.0), 4),
            "members": entries,
        })

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
        redundant = sum(len(g["members"]) - 1 for g in groups)
        reclaimable = sum(
            m.get("file_size") or 0
            for g in groups for m in g["members"] if not m["suggested_keep"]
        )
        result = {
            "version": 1,
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
        _persist(result)
        handle.set_progress(processed=100, total=100, message="Done")
        handle.set_result({"summary": result["summary"]})
    finally:
        set_active_job_id(None)


def _empty_result(threshold: float, embedded_count: int) -> Dict[str, Any]:
    return {
        "version": 1,
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
    except Exception as exc:
        logger.warning("Failed to persist duplicate groups: %s", exc)


def load_result() -> Optional[Dict[str, Any]]:
    path = _state_path()
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict) or "groups" not in data:
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
