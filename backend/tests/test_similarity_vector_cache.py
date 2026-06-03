"""Parity + behavior tests for the vectorized similarity cache (PERF-1).

The streaming heap scan is the long-standing, battle-tested ranking path. The
new in-memory matrix cache is a pure accelerator, so its single most important
property is *identical results*. These tests pin that parity on a real SQLite
database across thresholds, pagination, exclusion, tie-breaks, and zero-vector
queries, and verify the cache build / invalidation contract.
"""
from __future__ import annotations

import contextlib
import json
import sqlite3
from typing import Sequence, Tuple

import numpy as np
import pytest

import similarity as similarity_module


class _SqliteDb:
    """Minimal db stand-in backed by a real on-disk SQLite file.

    Mirrors the production ``db.get_db()`` contract: a context manager yielding
    a connection that exposes ``.cursor()``.
    """

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


def _make_db(tmp_path, rows: Sequence[Tuple[int, str, str, Sequence[float], int]]) -> _SqliteDb:
    """Create a temp images DB. rows = (id, path, filename, vector, is_readable)."""
    db_path = str(tmp_path / "vec_cache.db")
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


def _assert_result_parity(cached: dict, streamed: dict) -> None:
    assert [r["id"] for r in cached["results"]] == [r["id"] for r in streamed["results"]]
    assert cached["total"] == streamed["total"]
    assert cached["has_more"] == streamed["has_more"]
    for c, s in zip(cached["results"], streamed["results"]):
        assert c["similarity"] == pytest.approx(s["similarity"], abs=1e-4)
        assert c["path"] == s["path"]
        assert c["filename"] == s["filename"]


_ROWS = [
    (1, "/img/query.png", "query.png", [1.0, 0.0, 0.0, 0.0], 1),
    (2, "/img/near.png", "near.png", [0.98, 0.10, 0.0, 0.0], 1),
    (3, "/img/mid.png", "mid.png", [0.70, 0.70, 0.0, 0.0], 1),
    (4, "/img/far.png", "far.png", [0.0, 1.0, 0.0, 0.0], 1),
    (5, "/img/opp.png", "opp.png", [-1.0, 0.0, 0.0, 0.0], 1),
    (6, "/img/unreadable.png", "unreadable.png", [0.99, 0.01, 0.0, 0.0], 0),
]


def _both_indexes(db, monkeypatch):
    """Build a cache-disabled (streaming) and cache-enabled index over the same db."""
    monkeypatch.setattr(similarity_module, "SIMILARITY_VECTOR_CACHE_ENABLED", False)
    streaming = similarity_module.SimilarityIndex(db)
    monkeypatch.setattr(similarity_module, "SIMILARITY_VECTOR_CACHE_ENABLED", True)
    cached = similarity_module.SimilarityIndex(db)
    return streaming, cached


@pytest.mark.parametrize(
    "threshold,limit,offset",
    [
        (0.1, 10, 0),
        (0.5, 10, 0),
        (0.0, 10, 0),
        (-1.0, 10, 0),  # everything except the excluded id and unreadable
        (0.1, 2, 0),
        (0.1, 2, 1),    # pagination
        (0.99, 10, 0),  # very tight — likely only the nearest
    ],
)
def test_cache_matches_streaming_search_by_id(tmp_path, monkeypatch, threshold, limit, offset):
    db = _make_db(tmp_path, _ROWS)
    streaming, cached = _both_indexes(db, monkeypatch)

    base = streaming.search_by_id(1, limit=limit, threshold=threshold, offset=offset)
    got = cached.search_by_id(1, limit=limit, threshold=threshold, offset=offset)

    _assert_result_parity(got, base)
    # The cached index must actually have used the cache (not silently fallen back).
    assert cached._vector_cache is not None


def test_cache_excludes_query_and_unreadable(tmp_path, monkeypatch):
    db = _make_db(tmp_path, _ROWS)
    _, cached = _both_indexes(db, monkeypatch)

    result = cached.search_by_id(1, limit=10, threshold=-1.0)
    ids = [r["id"] for r in result["results"]]

    assert 1 not in ids          # query image excluded
    assert 6 not in ids          # is_readable = 0 excluded entirely
    assert set(ids) == {2, 3, 4, 5}


def test_cache_tiebreak_is_id_ascending(tmp_path, monkeypatch):
    # Two identical vectors → identical similarity → must order by id ascending,
    # matching the streaming heap's (-id) tiebreak.
    rows = [
        (1, "/img/q.png", "q.png", [1.0, 0.0], 1),
        (10, "/img/a.png", "a.png", [0.5, 0.5], 1),
        (20, "/img/b.png", "b.png", [0.5, 0.5], 1),
        (30, "/img/c.png", "c.png", [0.5, 0.5], 1),
    ]
    db = _make_db(tmp_path, rows)
    streaming, cached = _both_indexes(db, monkeypatch)

    base = streaming.search_by_id(1, limit=10, threshold=0.1)
    got = cached.search_by_id(1, limit=10, threshold=0.1)

    assert [r["id"] for r in got["results"]] == [10, 20, 30]
    _assert_result_parity(got, base)


def test_zero_query_vector_returns_empty(tmp_path, monkeypatch):
    rows = [
        (1, "/img/zero.png", "zero.png", [0.0, 0.0, 0.0], 1),
        (2, "/img/a.png", "a.png", [1.0, 0.0, 0.0], 1),
    ]
    db = _make_db(tmp_path, rows)
    streaming, cached = _both_indexes(db, monkeypatch)

    base = streaming.search_by_id(1, limit=10, threshold=0.0)
    got = cached.search_by_id(1, limit=10, threshold=0.0)

    assert got["results"] == []
    assert got["total"] == 0
    _assert_result_parity(got, base)


def test_cache_is_reused_across_searches(tmp_path, monkeypatch):
    db = _make_db(tmp_path, _ROWS)
    monkeypatch.setattr(similarity_module, "SIMILARITY_VECTOR_CACHE_ENABLED", True)
    index = similarity_module.SimilarityIndex(db)

    index.search_by_id(1, limit=5, threshold=0.1)
    first_cache = index._vector_cache
    assert first_cache is not None

    index.search_by_id(2, limit=5, threshold=0.1)
    # Same signature → same cached object instance reused, not rebuilt.
    assert index._vector_cache is first_cache


def test_cache_rebuilds_when_row_count_changes(tmp_path, monkeypatch):
    db = _make_db(tmp_path, _ROWS)
    monkeypatch.setattr(similarity_module, "SIMILARITY_VECTOR_CACHE_ENABLED", True)
    index = similarity_module.SimilarityIndex(db)

    index.search_by_id(1, limit=10, threshold=-1.0)
    before = index._vector_cache
    assert before is not None
    assert 7 not in set(before["ids"].tolist())

    # Insert a brand-new readable embedding → signature (count, max_id) changes.
    with db.get_db() as conn:
        blob = similarity_module.embedding_to_bytes(np.asarray([0.95, 0.05, 0.0, 0.0], dtype=np.float32))
        conn.execute(
            "INSERT INTO images (id, path, filename, embedding, is_readable) VALUES (?, ?, ?, ?, ?)",
            (7, "/img/new.png", "new.png", blob, 1),
        )

    result = index.search_by_id(1, limit=10, threshold=-1.0)
    assert index._vector_cache is not before          # rebuilt
    assert 7 in [r["id"] for r in result["results"]]   # new row now searchable


def test_invalidate_vector_cache_clears_cache(tmp_path, monkeypatch):
    db = _make_db(tmp_path, _ROWS)
    monkeypatch.setattr(similarity_module, "SIMILARITY_VECTOR_CACHE_ENABLED", True)
    index = similarity_module.SimilarityIndex(db)

    index.search_by_id(1, limit=5, threshold=0.1)
    assert index._vector_cache is not None

    index.invalidate_vector_cache()
    assert index._vector_cache is None


def test_disabled_flag_skips_cache(tmp_path, monkeypatch):
    db = _make_db(tmp_path, _ROWS)
    monkeypatch.setattr(similarity_module, "SIMILARITY_VECTOR_CACHE_ENABLED", False)
    index = similarity_module.SimilarityIndex(db)

    result = index.search_by_id(1, limit=5, threshold=0.1)
    # Search still works (via streaming) but the cache is never populated.
    assert index._vector_cache is None
    assert result["total"] >= 1


def test_signature_undeterminable_falls_back(tmp_path, monkeypatch):
    db = _make_db(tmp_path, _ROWS)
    monkeypatch.setattr(similarity_module, "SIMILARITY_VECTOR_CACHE_ENABLED", True)
    index = similarity_module.SimilarityIndex(db)

    # Force the signature probe to fail → must fall back to streaming, not crash.
    monkeypatch.setattr(index, "_compute_embedding_signature", lambda: None)
    result = index.search_by_id(1, limit=5, threshold=0.1)

    assert index._vector_cache is None
    assert result["total"] >= 1


# ---------------------------------------------------------------------------
# Scoped search (v3.3.1): restrict results to a collection / Favorites subset.
# allowed_ids is the index-level primitive the service derives from a
# collection_id. These pin: (1) only members are returned, ranked, (2) the
# cached and streaming paths agree on the scoped result, (3) exclude_id still
# applies on top of the scope.
# ---------------------------------------------------------------------------

def test_scoped_search_returns_only_members_ranked(tmp_path, monkeypatch):
    db = _make_db(tmp_path, _ROWS)
    streaming, cached = _both_indexes(db, monkeypatch)

    # Subset "collection" = ids {3, 4} (mid + far). Query is id 1 (excluded).
    allowed = {3, 4}
    base = streaming.search_by_id(1, limit=10, threshold=-1.0, allowed_ids=allowed)
    got = cached.search_by_id(1, limit=10, threshold=-1.0, allowed_ids=allowed)

    ids = [r["id"] for r in got["results"]]
    assert set(ids) == {3, 4}            # only collection members
    assert ids == [3, 4]                 # mid (higher sim to query) before far
    assert got["total"] == 2
    # Cached and streaming scoped results must be identical.
    _assert_result_parity(got, base)
    assert cached._vector_cache is not None


def test_scoped_search_excludes_query_image(tmp_path, monkeypatch):
    db = _make_db(tmp_path, _ROWS)
    _, cached = _both_indexes(db, monkeypatch)

    # Collection contains the query image itself (1) plus 2 and 3.
    allowed = {1, 2, 3}
    result = cached.search_by_id(1, limit=10, threshold=-1.0, allowed_ids=allowed)
    ids = [r["id"] for r in result["results"]]

    assert 1 not in ids                  # query image still excluded inside scope
    assert set(ids) == {2, 3}
    assert result["total"] == 2


def test_scoped_search_empty_when_no_members_embedded(tmp_path, monkeypatch):
    db = _make_db(tmp_path, _ROWS)
    streaming, cached = _both_indexes(db, monkeypatch)

    # Scope only references the unreadable row (6, is_readable=0) → no candidates.
    allowed = {6}
    base = streaming.search_by_id(1, limit=10, threshold=-1.0, allowed_ids=allowed)
    got = cached.search_by_id(1, limit=10, threshold=-1.0, allowed_ids=allowed)

    assert got["results"] == []
    assert got["total"] == 0
    assert got["has_more"] is False
    _assert_result_parity(got, base)


def test_scoped_search_pagination_matches(tmp_path, monkeypatch):
    db = _make_db(tmp_path, _ROWS)
    streaming, cached = _both_indexes(db, monkeypatch)

    allowed = {2, 3, 4, 5}
    # Page through the scoped set one result at a time; cache must match streaming.
    for offset in range(0, 4):
        base = streaming.search_by_id(1, limit=1, threshold=-1.0, offset=offset, allowed_ids=allowed)
        got = cached.search_by_id(1, limit=1, threshold=-1.0, offset=offset, allowed_ids=allowed)
        _assert_result_parity(got, base)
        assert base["total"] == 4


# ---------------------------------------------------------------------------
# On-disk persistence of the exact vector cache (v3.3.2 Phase 1).
#
# The conftest autouse fixture _isolate_similarity_index_dir points
# similarity.get_state_dir() at this test's tmp_path, so the index dir is
# tmp_path / "similarity-index". Persistence is a pure cold-start accelerator:
# the loaded matrix is the SAME normalized matrix, so results never change, and
# any disk problem must transparently fall back to an in-RAM rebuild.
# ---------------------------------------------------------------------------

def _index_dir(tmp_path):
    return tmp_path / "similarity-index"


def test_vector_cache_persists_to_disk(tmp_path, monkeypatch):
    db = _make_db(tmp_path, _ROWS)
    monkeypatch.setattr(similarity_module, "SIMILARITY_VECTOR_CACHE_ENABLED", True)
    index = similarity_module.SimilarityIndex(db)

    index.search_by_id(1, limit=5, threshold=0.1)

    index_dir = _index_dir(tmp_path)
    assert (index_dir / "matrix.npy").exists()
    assert (index_dir / "ids.npy").exists()
    assert (index_dir / "meta.json").exists()
    meta = json.loads((index_dir / "meta.json").read_text(encoding="utf-8"))
    assert meta["dim"] == 4
    assert len(meta["signature"]) == 2
    assert len(meta["paths"]) == len(meta["filenames"])
    # _ROWS has 5 readable embeddings (id 6 is unreadable, excluded from the cache).
    assert len(meta["paths"]) == 5


def test_persisted_cache_loaded_without_rebuild(tmp_path, monkeypatch):
    db = _make_db(tmp_path, _ROWS)
    monkeypatch.setattr(similarity_module, "SIMILARITY_VECTOR_CACHE_ENABLED", True)

    index_a = similarity_module.SimilarityIndex(db)
    base = index_a.search_by_id(1, limit=10, threshold=-1.0)  # builds + persists

    index_b = similarity_module.SimilarityIndex(db)

    def _must_not_rebuild(*_args, **_kwargs):
        raise AssertionError("expected persisted cache load, not a rebuild")

    monkeypatch.setattr(index_b, "_build_vector_cache", _must_not_rebuild)
    got = index_b.search_by_id(1, limit=10, threshold=-1.0)

    assert index_b._vector_cache is not None
    assert [r["id"] for r in got["results"]] == [r["id"] for r in base["results"]]
    assert got["total"] == base["total"]


def test_persisted_cache_signature_mismatch_is_ignored(tmp_path, monkeypatch):
    db = _make_db(tmp_path, _ROWS)
    monkeypatch.setattr(similarity_module, "SIMILARITY_VECTOR_CACHE_ENABLED", True)
    index_a = similarity_module.SimilarityIndex(db)
    index_a.search_by_id(1, limit=10, threshold=-1.0)  # persists signature of _ROWS

    # A new readable embedding changes (count, max_id) → stale disk is ignored.
    with db.get_db() as conn:
        blob = similarity_module.embedding_to_bytes(np.asarray([0.9, 0.1, 0.0, 0.0], dtype=np.float32))
        conn.execute(
            "INSERT INTO images (id, path, filename, embedding, is_readable) VALUES (?, ?, ?, ?, ?)",
            (7, "/img/new.png", "new.png", blob, 1),
        )

    index_b = similarity_module.SimilarityIndex(db)
    result = index_b.search_by_id(1, limit=10, threshold=-1.0)
    assert 7 in [r["id"] for r in result["results"]]  # rebuilt from fresh rows


def test_invalidate_deletes_persisted_files(tmp_path, monkeypatch):
    db = _make_db(tmp_path, _ROWS)
    monkeypatch.setattr(similarity_module, "SIMILARITY_VECTOR_CACHE_ENABLED", True)
    index = similarity_module.SimilarityIndex(db)
    index.search_by_id(1, limit=5, threshold=0.1)

    index_dir = _index_dir(tmp_path)
    assert (index_dir / "matrix.npy").exists()

    index.invalidate_vector_cache()
    assert index._vector_cache is None
    assert not (index_dir / "matrix.npy").exists()
    assert not (index_dir / "ids.npy").exists()
    assert not (index_dir / "meta.json").exists()


def test_corrupt_persisted_cache_falls_back_to_rebuild(tmp_path, monkeypatch):
    db = _make_db(tmp_path, _ROWS)
    monkeypatch.setattr(similarity_module, "SIMILARITY_VECTOR_CACHE_ENABLED", True)
    index_a = similarity_module.SimilarityIndex(db)
    base = index_a.search_by_id(1, limit=10, threshold=-1.0)

    # Corrupt the on-disk matrix; signature meta still matches.
    (_index_dir(tmp_path) / "matrix.npy").write_bytes(b"not a valid npy payload")

    index_b = similarity_module.SimilarityIndex(db)
    got = index_b.search_by_id(1, limit=10, threshold=-1.0)

    assert [r["id"] for r in got["results"]] == [r["id"] for r in base["results"]]
    assert got["total"] == base["total"]
