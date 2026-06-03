"""Optional hnswlib ANN index for fast approximate top-k similarity.

hnswlib is an **optional** accelerator for the workbench / dedup "find the k
nearest images" use case, where approximate top-k is acceptable. It is NOT used
by the paginated, exact ``search_by_id`` / ``search_by_upload`` path — that keeps
the exact vector-cache matmul as its source of truth so its ``total`` /
``has_more`` / ``allowed_ids`` contract stays exact.

This module never hard-depends on hnswlib: when it is not installed,
``hnswlib_available()`` returns ``False`` and every build/load returns ``None``,
so callers transparently fall back to the exact cache. The index stores
L2-normalized vectors in ``cosine`` space with labels = row indices into the
caller's parallel id/path/filename arrays, so the caller re-scores the returned
candidates EXACTLY from its own matrix (hnswlib only *picks* candidates).

Persisted alongside the vector cache under ``STATE_DIR/similarity-index/`` and
keyed on the same cheap ``(count, max_id)`` signature, so any row add/delete
invalidates by mismatch and a re-embed invalidates explicitly via the owner's
``invalidate_vector_cache()``.
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Optional, Tuple

import numpy as np

logger = logging.getLogger(__name__)

_ANN_FILE = "ann.hnsw"
_ANN_META = "ann-meta.json"

# Build/query parameters. Generous defaults favor recall over index size; these
# are an accelerator, not a cap, and small libraries query effectively exactly.
_HNSW_M = 16
_HNSW_EF_CONSTRUCTION = 200
_HNSW_EF_QUERY_MIN = 64


def hnswlib_available() -> bool:
    """Return True when the optional hnswlib dependency can be imported."""
    try:
        import hnswlib  # noqa: F401
        return True
    except Exception:
        return False


def _index_path(index_dir) -> Path:
    return Path(index_dir) / _ANN_FILE


def _meta_path(index_dir) -> Path:
    return Path(index_dir) / _ANN_META


class AnnIndex:
    """Thin handle around a built/loaded hnswlib index plus its identity."""

    def __init__(self, handle, dim: int, count: int, signature: Tuple[int, int]):
        self._handle = handle
        self.dim = int(dim)
        self.count = int(count)
        self.signature = signature

    def query(self, query_unit: np.ndarray, k: int) -> Optional[np.ndarray]:
        """Return up to ``k`` candidate row labels (np.int64), or None on failure."""
        try:
            k = max(1, min(int(k), self.count))
            self._handle.set_ef(max(_HNSW_EF_QUERY_MIN, k))
            vector = np.ascontiguousarray(query_unit, dtype=np.float32).reshape(1, -1)
            labels, _distances = self._handle.knn_query(vector, k=k)
            return np.asarray(labels[0], dtype=np.int64)
        except Exception as exc:
            logger.debug("[Similarity ANN] query failed: %s", exc)
            return None


def build_index(
    matrix: np.ndarray,
    signature: Tuple[int, int],
    index_dir,
    *,
    persist: bool = True,
) -> Optional[AnnIndex]:
    """Build an hnswlib index over the (already L2-normalized) matrix.

    Returns None when hnswlib is unavailable, the matrix is empty, or any build
    step fails — the caller then falls back to the exact path.
    """
    try:
        import hnswlib
    except Exception:
        return None
    try:
        rows = int(matrix.shape[0]) if matrix.ndim == 2 else 0
        dim = int(matrix.shape[1]) if matrix.ndim == 2 else 0
        if rows == 0 or dim == 0:
            return None
        handle = hnswlib.Index(space="cosine", dim=dim)
        handle.init_index(max_elements=rows, ef_construction=_HNSW_EF_CONSTRUCTION, M=_HNSW_M)
        handle.add_items(np.ascontiguousarray(matrix, dtype=np.float32), np.arange(rows))
        handle.set_ef(_HNSW_EF_QUERY_MIN)
        ann = AnnIndex(handle, dim, rows, signature)
        if persist:
            _persist_index(handle, dim, rows, signature, index_dir)
        return ann
    except Exception as exc:
        logger.debug("[Similarity ANN] build failed: %s", exc)
        return None


def load_index(signature: Tuple[int, int], index_dir) -> Optional[AnnIndex]:
    """Load a persisted index iff hnswlib is present and the signature matches."""
    try:
        import hnswlib
    except Exception:
        return None
    try:
        meta_path = _meta_path(index_dir)
        index_path = _index_path(index_dir)
        if not (meta_path.exists() and index_path.exists()):
            return None
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        stored_sig = meta.get("signature")
        if (
            not isinstance(stored_sig, list)
            or len(stored_sig) != 2
            or (int(stored_sig[0]), int(stored_sig[1])) != signature
        ):
            return None
        dim = int(meta.get("dim", 0))
        count = int(meta.get("count", 0))
        if dim <= 0 or count <= 0:
            return None
        handle = hnswlib.Index(space="cosine", dim=dim)
        handle.load_index(str(index_path), max_elements=count)
        return AnnIndex(handle, dim, count, signature)
    except Exception as exc:
        logger.debug("[Similarity ANN] load failed: %s", exc)
        return None


def _persist_index(handle, dim: int, count: int, signature: Tuple[int, int], index_dir) -> None:
    """Best-effort atomic persist of the index + signature meta."""
    try:
        directory = Path(index_dir)
        directory.mkdir(parents=True, exist_ok=True)
        tmp_index = directory / (_ANN_FILE + ".tmp")
        handle.save_index(str(tmp_index))
        os.replace(tmp_index, _index_path(directory))
        _meta_path(directory).write_text(
            json.dumps(
                {
                    "dim": int(dim),
                    "count": int(count),
                    "signature": [int(signature[0]), int(signature[1])],
                }
            ),
            encoding="utf-8",
        )
    except Exception as exc:
        logger.debug("[Similarity ANN] persist failed: %s", exc)
        delete_index(index_dir)


def delete_index(index_dir) -> None:
    """Best-effort removal of any persisted ANN files (incl. temp writes)."""
    try:
        directory = Path(index_dir)
        for name in (_ANN_FILE, _ANN_META, _ANN_FILE + ".tmp"):
            target = directory / name
            if target.exists():
                target.unlink()
    except Exception as exc:
        logger.debug("[Similarity ANN] delete failed: %s", exc)
