"""Tests for the optional hnswlib ANN top-k bypass (v3.3.2 Phase 1, slice 4b).

``top_k_similar`` is a SEPARATE entry point from the exact paginated search, for
the workbench / dedup "k nearest" use case. These tests pin:
  1. correct exact-scored nearest neighbors WITH and WITHOUT hnswlib,
  2. exclude_id and allowed_ids scoping,
  3. the ANN index persists, reloads without rebuild, and invalidates,
  4. graceful fallback when hnswlib is unavailable.

The conftest autouse fixture ``_isolate_similarity_index_dir`` redirects the
persist dir to each test's tmp_path, so the index dir is tmp_path/similarity-index.
"""
from __future__ import annotations

import contextlib
import sqlite3

import numpy as np
import pytest

import similarity as similarity_module
import similarity_ann


class _SqliteDb:
    """Minimal db stand-in backed by a real on-disk SQLite file."""

    def __init__(self, path: str):
        self._path = path

    @contextlib.contextmanager
    def get_db(self):
        conn = sqlite3.connect(self._path)
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()


def _make_db(tmp_path, rows):
    """rows = (id, path, filename, vector, is_readable)."""
    db_path = str(tmp_path / "ann.db")
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        CREATE TABLE images (
            id INTEGER PRIMARY KEY,
            path TEXT,
            filename TEXT,
            embedding BLOB,
            is_readable INTEGER DEFAULT 1
        )
        """
    )
    for img_id, path, filename, vector, is_readable in rows:
        blob = similarity_module.embedding_to_bytes(np.asarray(vector, dtype=np.float32))
        conn.execute(
            "INSERT INTO images (id, path, filename, embedding, is_readable) VALUES (?, ?, ?, ?, ?)",
            (img_id, path, filename, blob, is_readable),
        )
    conn.commit()
    conn.close()
    return _SqliteDb(db_path)


_ROWS = [
    (1, "/img/q.png", "q.png", [1.0, 0.0, 0.0, 0.0], 1),
    (2, "/img/near.png", "near.png", [0.98, 0.10, 0.0, 0.0], 1),
    (3, "/img/mid.png", "mid.png", [0.70, 0.70, 0.0, 0.0], 1),
    (4, "/img/far.png", "far.png", [0.0, 1.0, 0.0, 0.0], 1),
    (5, "/img/opp.png", "opp.png", [-1.0, 0.0, 0.0, 0.0], 1),
    (6, "/img/unreadable.png", "unreadable.png", [0.99, 0.01, 0.0, 0.0], 0),
]

_QUERY = np.asarray([1.0, 0.0, 0.0, 0.0], dtype=np.float32)

requires_hnswlib = pytest.mark.skipif(
    not similarity_ann.hnswlib_available(),
    reason="hnswlib not installed",
)


def test_top_k_exact_without_ann(tmp_path, monkeypatch):
    db = _make_db(tmp_path, _ROWS)
    monkeypatch.setattr(similarity_module, "SIMILARITY_VECTOR_CACHE_ENABLED", True)
    monkeypatch.setattr(similarity_module, "SIMILARITY_ANN_ENABLED", False)
    index = similarity_module.SimilarityIndex(db)

    results = index.top_k_similar(_QUERY, k=3, exclude_id=1)
    ids = [r["id"] for r in results]

    assert ids == [2, 3, 4]          # nearest-first, exact order
    assert 1 not in ids              # query excluded
    assert 6 not in ids              # unreadable never cached
    assert results[0]["similarity"] == pytest.approx(0.9948, abs=1e-3)
    assert index._ann is None        # ANN disabled → never built


def test_top_k_respects_allowed_ids(tmp_path, monkeypatch):
    db = _make_db(tmp_path, _ROWS)
    monkeypatch.setattr(similarity_module, "SIMILARITY_VECTOR_CACHE_ENABLED", True)
    index = similarity_module.SimilarityIndex(db)

    results = index.top_k_similar(_QUERY, k=10, allowed_ids={3, 4})
    assert [r["id"] for r in results] == [3, 4]  # only scoped members, mid before far


def test_top_k_falls_back_without_hnswlib(tmp_path, monkeypatch):
    db = _make_db(tmp_path, _ROWS)
    monkeypatch.setattr(similarity_module, "SIMILARITY_VECTOR_CACHE_ENABLED", True)
    monkeypatch.setattr(similarity_module, "SIMILARITY_ANN_ENABLED", True)
    # Simulate hnswlib being absent even if it happens to be installed.
    monkeypatch.setattr(similarity_ann, "hnswlib_available", lambda: False)
    index = similarity_module.SimilarityIndex(db)

    results = index.top_k_similar(_QUERY, k=3, exclude_id=1)
    assert [r["id"] for r in results] == [2, 3, 4]
    assert index._ann is None        # never built without hnswlib


@requires_hnswlib
def test_top_k_uses_ann_when_available(tmp_path, monkeypatch):
    db = _make_db(tmp_path, _ROWS)
    monkeypatch.setattr(similarity_module, "SIMILARITY_VECTOR_CACHE_ENABLED", True)
    monkeypatch.setattr(similarity_module, "SIMILARITY_ANN_ENABLED", True)
    index = similarity_module.SimilarityIndex(db)

    results = index.top_k_similar(_QUERY, k=2, exclude_id=1)
    assert index._ann is not None                  # ANN index built + used
    assert [r["id"] for r in results] == [2, 3]
    assert results[0]["similarity"] == pytest.approx(0.9948, abs=1e-3)


@requires_hnswlib
def test_ann_index_persists_and_loads(tmp_path, monkeypatch):
    db = _make_db(tmp_path, _ROWS)
    monkeypatch.setattr(similarity_module, "SIMILARITY_VECTOR_CACHE_ENABLED", True)
    monkeypatch.setattr(similarity_module, "SIMILARITY_ANN_ENABLED", True)

    index_a = similarity_module.SimilarityIndex(db)
    index_a.top_k_similar(_QUERY, k=3, exclude_id=1)

    index_dir = tmp_path / "similarity-index"
    assert (index_dir / "ann.hnsw").exists()
    assert (index_dir / "ann-meta.json").exists()

    # A fresh index must LOAD the persisted ANN, not rebuild it.
    index_b = similarity_module.SimilarityIndex(db)

    def _must_not_build(*_args, **_kwargs):
        raise AssertionError("expected persisted ANN load, not a build")

    monkeypatch.setattr(similarity_ann, "build_index", _must_not_build)
    results = index_b.top_k_similar(_QUERY, k=2, exclude_id=1)

    assert index_b._ann is not None
    assert [r["id"] for r in results] == [2, 3]


@requires_hnswlib
def test_invalidate_clears_ann_index(tmp_path, monkeypatch):
    db = _make_db(tmp_path, _ROWS)
    monkeypatch.setattr(similarity_module, "SIMILARITY_VECTOR_CACHE_ENABLED", True)
    monkeypatch.setattr(similarity_module, "SIMILARITY_ANN_ENABLED", True)
    index = similarity_module.SimilarityIndex(db)
    index.top_k_similar(_QUERY, k=3, exclude_id=1)

    index_dir = tmp_path / "similarity-index"
    assert (index_dir / "ann.hnsw").exists()
    assert index._ann is not None

    index.invalidate_vector_cache()
    assert index._ann is None
    assert not (index_dir / "ann.hnsw").exists()
    assert not (index_dir / "ann-meta.json").exists()


@requires_hnswlib
def test_ann_top_k_matches_exact_on_small_data(tmp_path, monkeypatch):
    rng = np.random.default_rng(12345)
    rows = []
    for i in range(1, 31):
        vec = rng.standard_normal(8).astype(np.float32)
        rows.append((i, f"/img/{i}.png", f"{i}.png", vec.tolist(), 1))
    db = _make_db(tmp_path, rows)
    monkeypatch.setattr(similarity_module, "SIMILARITY_VECTOR_CACHE_ENABLED", True)

    query = rng.standard_normal(8).astype(np.float32)

    monkeypatch.setattr(similarity_module, "SIMILARITY_ANN_ENABLED", False)
    exact = similarity_module.SimilarityIndex(db).top_k_similar(query, k=5)

    monkeypatch.setattr(similarity_module, "SIMILARITY_ANN_ENABLED", True)
    ann = similarity_module.SimilarityIndex(db).top_k_similar(query, k=5)

    assert [r["id"] for r in ann] == [r["id"] for r in exact]
    for a, e in zip(ann, exact):
        assert a["similarity"] == pytest.approx(e["similarity"], abs=1e-4)
