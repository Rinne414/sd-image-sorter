"""Characterization pins for ``similarity.py`` (step 0 of the god-file split).

These pins lock the CURRENT observable behavior of ``backend/similarity.py`` at
the seams a verbatim byte-tiling split would most easily break. They are a
safety net, not new coverage — they deliberately overlap the existing
``test_similarity_vector_cache.py`` / ``test_similarity_ann.py`` /
``test_resource_safety.py`` suites where a seam is load-bearing, and pin the
seam *as a seam* (patch on the module, observe through the deepest consumer).

Hard rules honored here (machine-state isolation, commit 0edbb81 precedent):
  * NEVER load fastembed / CLIP / ONNX. Every model entry point
    (``_get_embed_model``, ``_get_text_embed_model``, ``embed_image_file``,
    ``embed_image_pil``, ``embed_text``) is either short-circuited via a
    pre-seeded singleton or replaced with a monkeypatch stub.
  * NEVER touch the real state dir. The conftest autouse fixture
    ``_isolate_similarity_index_dir`` already redirects ``similarity.get_state_dir``
    to a per-test tmp dir; pins that need the persist path re-patch it explicitly.
  * All module-global mutation goes through ``monkeypatch.setattr`` so nothing
    leaks between tests.
"""

from __future__ import annotations

import contextlib
import os
import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Sequence

import numpy as np
import pytest
from fastapi import BackgroundTasks

import similarity as similarity_module
import similarity_ann


# ---------------------------------------------------------------------------
# Minimal real-SQLite db stand-in (mirrors production db.get_db()).
# ---------------------------------------------------------------------------


class _SqliteDb:
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


def _make_db(tmp_path, rows: Sequence[tuple]) -> _SqliteDb:
    """rows = (id, path, filename, vector_or_None, is_readable)."""
    db_path = str(tmp_path / "similarity_pins.db")
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        CREATE TABLE images (
            id INTEGER PRIMARY KEY,
            path TEXT,
            filename TEXT,
            embedding BLOB,
            content_fingerprint TEXT,
            is_readable INTEGER DEFAULT 1
        )
        """
    )
    for img_id, path, filename, vector, is_readable in rows:
        blob = (
            None
            if vector is None
            else similarity_module.embedding_to_bytes(
                np.asarray(vector, dtype=np.float32)
            )
        )
        conn.execute(
            "INSERT INTO images (id, path, filename, embedding, is_readable) VALUES (?, ?, ?, ?, ?)",
            (img_id, path, filename, blob, is_readable),
        )
    conn.commit()
    conn.close()
    return _SqliteDb(db_path)


_ROWS = [
    (1, "/img/query.png", "query.png", [1.0, 0.0, 0.0, 0.0], 1),
    (2, "/img/near.png", "near.png", [0.98, 0.10, 0.0, 0.0], 1),
    (3, "/img/mid.png", "mid.png", [0.70, 0.70, 0.0, 0.0], 1),
    (4, "/img/far.png", "far.png", [0.0, 1.0, 0.0, 0.0], 1),
    (6, "/img/unreadable.png", "unreadable.png", [0.99, 0.01, 0.0, 0.0], 0),
]


# ===========================================================================
# Group A — module import surface / facade contract
#
# The split MUST keep every one of these names importable/patchable AS
# ``similarity.<name>`` because production code and tests reach them that way
# (from-imports, monkeypatch.setattr, and model_health's `from similarity
# import _embed_model`). A verbatim split that moves a name to a submodule
# without re-exporting it here silently breaks a patch site.
# ===========================================================================

_PUBLIC_SYMBOLS = [
    # exception classes (services.similarity_service imports 6 of these)
    "SimilarityError",
    "SimilarityImageNotFoundError",
    "SimilarityEmbeddingMissingError",
    "SimilarityInvalidImageError",
    "SimilarityInsufficientEmbeddingsError",
    "SimilarityDuplicateSearchTooLargeError",
    "SimilaritySearchWindowTooLargeError",
    # public functions
    "embedding_to_bytes",
    "bytes_to_embedding",
    "cosine_similarity",
    "embed_text",
    "embed_image_file",
    "embed_image_pil",
    "ensure_clip_model_ready",
    "get_similarity_index",
    "SimilarityIndex",
    # model entry points patched by test_routers
    "_get_embed_model",
    "_get_text_embed_model",
    # module-level singletons + shared lock
    "_embed_model",
    "_text_embed_model",
    "_index",
    "_embed_lock",
    # env-derived constants patched by tests
    "SIMILARITY_SEARCH_CHUNK_SIZE",
    "SIMILARITY_SEARCH_MAX_WINDOW",
    "SIMILARITY_VECTOR_CACHE_ENABLED",
    "SIMILARITY_ANN_ENABLED",
    "DUPLICATE_SYNC_MAX_EMBEDDINGS",
    "EMBEDDING_BATCH_SIZE",
    "DUPLICATE_CHUNK_SIZE",
    "SIMILARITY_DEFAULT_LIMIT",
    "SIMILARITY_DEFAULT_THRESHOLD",
    "DUPLICATE_THRESHOLD",
    "CLIP_MODEL_NAME",
    "CLIP_TEXT_MODEL_NAME",
    # seam imports patched by conftest / test_routers
    "get_state_dir",
    "get_clip_local_model_path",
    "resolve_existing_indexed_image_path",
    "verify_image_readable",
    "compute_image_content_fingerprint",
    # sibling module reference used for the ANN top-k bypass
    "similarity_ann",
]


@pytest.mark.parametrize("symbol", _PUBLIC_SYMBOLS)
def test_module_exposes_public_symbol(symbol):
    assert hasattr(similarity_module, symbol), (
        f"similarity.{symbol} must stay importable/patchable at module scope "
        "after the split (a from-import or monkeypatch site depends on it)."
    )


def test_exception_hierarchy_and_attributes():
    err = similarity_module.SimilarityError
    for name in _PUBLIC_SYMBOLS[1:7]:
        cls = getattr(similarity_module, name)
        assert issubclass(cls, err)
    assert issubclass(err, RuntimeError)

    assert similarity_module.SimilarityImageNotFoundError(7).image_id == 7
    assert similarity_module.SimilarityEmbeddingMissingError(9).image_id == 9
    insufficient = similarity_module.SimilarityInsufficientEmbeddingsError(1)
    assert insufficient.embedded_count == 1 and insufficient.minimum_required == 2
    too_large = similarity_module.SimilarityDuplicateSearchTooLargeError(10, 5)
    assert too_large.embedded_count == 10 and too_large.max_embeddings == 5
    window = similarity_module.SimilaritySearchWindowTooLargeError(6, 3)
    assert window.requested_window == 6 and window.max_window == 3


# ===========================================================================
# Group B — get_state_dir seam (SPLIT-KILLER; conftest.py:66)
#
# conftest patches ``similarity.get_state_dir`` for the WHOLE suite. If
# ``_get_index_dir`` (or _persist/_load) moves to a submodule that does its own
# `from config import get_state_dir`, that patch no longer reaches it and
# persistence escapes to the real STATE_DIR (machine-state pollution +
# cross-test contamination). Pin the patch surface at the deepest consumer.
# ===========================================================================


def test_get_index_dir_reads_module_level_get_state_dir(tmp_path, monkeypatch):
    custom = tmp_path / "custom-state"
    monkeypatch.setattr(similarity_module, "get_state_dir", lambda: str(custom))
    index = similarity_module.SimilarityIndex(_make_db(tmp_path, []))

    assert index._get_index_dir() == custom / "similarity-index"


def test_persist_writes_under_patched_state_dir(tmp_path, monkeypatch):
    state_root = tmp_path / "state-root"
    monkeypatch.setattr(similarity_module, "get_state_dir", lambda: str(state_root))
    monkeypatch.setattr(similarity_module, "SIMILARITY_VECTOR_CACHE_ENABLED", True)
    index = similarity_module.SimilarityIndex(_make_db(tmp_path, _ROWS))

    index.search_by_id(1, limit=5, threshold=0.1)

    assert (state_root / "similarity-index" / "matrix.npy").exists()


# ===========================================================================
# Group C — backend_file=__file__ anchor by value (line 484; intel a)
#
# embed_batch resolves each stored path via
# resolve_existing_indexed_image_path(..., backend_file=__file__). The __file__
# it passes is backend/similarity.py — the resolver anchors relative indexed
# paths against backend/. If the method moves to a submodule, its __file__
# changes and resolution silently shifts. Pin the anchor VALUE.
# ===========================================================================


def test_embed_batch_passes_similarity_file_as_backend_anchor(tmp_path, monkeypatch):
    db = _make_db(tmp_path, [(1, r"L:\datasets\a.png", "a.png", None, 1)])
    captured = {}

    def fake_resolve(primary_path, *, backend_file):
        captured["backend_file"] = backend_file
        return None  # skip → no verify/embed/db-write path is taken

    monkeypatch.setattr(similarity_module, "_get_embed_model", lambda: object())
    monkeypatch.setattr(
        similarity_module, "resolve_existing_indexed_image_path", fake_resolve
    )

    similarity_module.SimilarityIndex(db).embed_batch([1])

    anchor = captured["backend_file"]
    assert anchor == similarity_module.__file__
    assert os.path.basename(anchor) == "similarity.py"
    assert os.path.basename(os.path.dirname(anchor)) == "backend"


# ===========================================================================
# Group D — lazy singleton families + shared lock (intel c)
# ===========================================================================


def _install_blocking_index_constructor(
    monkeypatch: pytest.MonkeyPatch,
) -> tuple[threading.Event, threading.Event, threading.Event, dict[str, int]]:
    first_constructing = threading.Event()
    duplicate_constructed = threading.Event()
    release_first = threading.Event()
    count_lock = threading.Lock()
    counts = {"constructed": 0}

    class BlockingIndex:
        def __init__(self, db_module):
            self.db = db_module
            with count_lock:
                counts["constructed"] += 1
                construction_number = counts["constructed"]
            if construction_number == 1:
                first_constructing.set()
                if not release_first.wait(timeout=3):
                    raise RuntimeError("Timed out waiting to release first similarity index")
            else:
                duplicate_constructed.set()

        def get_progress(self):
            return {"running": False}

        def embed_batch(self, image_ids):
            return image_ids

    monkeypatch.setattr(similarity_module, "_index", None)
    monkeypatch.setattr(similarity_module, "SimilarityIndex", BlockingIndex)
    return first_constructing, duplicate_constructed, release_first, counts


def test_concurrent_get_similarity_index_constructs_once(monkeypatch):
    first_constructing, duplicate_constructed, release_first, counts = (
        _install_blocking_index_constructor(monkeypatch)
    )
    database_sentinel = object()

    with ThreadPoolExecutor(max_workers=2) as executor:
        first_future = executor.submit(
            similarity_module.get_similarity_index,
            database_sentinel,
        )
        try:
            assert first_constructing.wait(timeout=1)
            second_future = executor.submit(
                similarity_module.get_similarity_index,
                database_sentinel,
            )
            duplicate_observed = duplicate_constructed.wait(timeout=0.5)
        finally:
            release_first.set()

        first = first_future.result(timeout=3)
        second = second_future.result(timeout=3)

    assert duplicate_observed is False
    assert first is second
    assert counts == {"constructed": 1}


def test_concurrent_embed_starts_schedule_the_canonical_index(monkeypatch):
    from services import similarity_service as similarity_service_module

    first_constructing, duplicate_constructed, release_first, counts = (
        _install_blocking_index_constructor(monkeypatch)
    )
    monkeypatch.setattr(
        similarity_service_module,
        "get_similarity_index",
        similarity_module.get_similarity_index,
    )
    monkeypatch.setattr(
        similarity_service_module,
        "ensure_clip_model_ready",
        lambda: "fastembed:in-memory",
    )

    service = similarity_service_module.SimilarityService()
    first_tasks = BackgroundTasks()
    second_tasks = BackgroundTasks()

    with ThreadPoolExecutor(max_workers=2) as executor:
        first_future = executor.submit(service.embed_images, first_tasks, [1])
        try:
            assert first_constructing.wait(timeout=1)
            second_future = executor.submit(service.embed_images, second_tasks, [2])
            duplicate_observed = duplicate_constructed.wait(timeout=0.5)
        finally:
            release_first.set()

        first_result = first_future.result(timeout=3)
        second_result = second_future.result(timeout=3)

    canonical_index = similarity_module.get_similarity_index()
    scheduled_indexes = [
        first_tasks.tasks[0].func.__self__,
        second_tasks.tasks[0].func.__self__,
    ]

    assert first_result["status"] == "started"
    assert second_result["status"] == "started"
    assert duplicate_observed is False
    assert scheduled_indexes == [canonical_index, canonical_index]
    assert counts == {"constructed": 1}


def test_get_similarity_index_is_a_singleton(monkeypatch):
    monkeypatch.setattr(similarity_module, "_index", None)
    first = similarity_module.get_similarity_index(db_module="db-a")
    second = similarity_module.get_similarity_index(db_module="db-b")

    assert first is second
    # First db wins; the second call's db_module is ignored (current behavior).
    assert first.db == "db-a"


def test_module_index_global_is_the_patch_surface(monkeypatch):
    sentinel = object()
    monkeypatch.setattr(similarity_module, "_index", sentinel)
    # test_similarity_compare_near / test_duplicate_groups rebind `_index`
    # directly and expect get_similarity_index to return it.
    assert similarity_module.get_similarity_index() is sentinel


def test_get_embed_model_short_circuits_preseeded_singleton(monkeypatch):
    sentinel = object()
    monkeypatch.setattr(similarity_module, "_embed_model", sentinel)
    # Non-None singleton means fastembed is never imported/loaded.
    assert similarity_module._get_embed_model() is sentinel


def test_get_text_embed_model_short_circuits_preseeded_singleton(monkeypatch):
    sentinel = object()
    monkeypatch.setattr(similarity_module, "_text_embed_model", sentinel)
    assert similarity_module._get_text_embed_model() is sentinel


def test_embed_lock_is_a_lock_object():
    lock = similarity_module._embed_lock
    assert isinstance(lock, type(threading.Lock()))


def test_embed_batch_already_running_guard(tmp_path, monkeypatch):
    # The "already in progress" guard is taken under the module-shared
    # _embed_lock; pin the behavior so the split keeps a single coordinating
    # lock for the model singletons AND the embed job.
    index = similarity_module.SimilarityIndex(_make_db(tmp_path, []))
    index._progress["running"] = True

    result = index.embed_batch(None)
    assert result == {"error": "Embedding already in progress"}


def test_ensure_clip_model_ready_returns_local_path(monkeypatch):
    monkeypatch.setattr(similarity_module, "_get_embed_model", lambda: object())
    monkeypatch.setattr(
        similarity_module, "get_clip_local_model_path", lambda: "/models/clip/x"
    )

    assert similarity_module.ensure_clip_model_ready() == "/models/clip/x"


def test_ensure_clip_model_ready_in_memory_sentinel(monkeypatch):
    monkeypatch.setattr(similarity_module, "_get_embed_model", lambda: object())
    monkeypatch.setattr(similarity_module, "get_clip_local_model_path", lambda: None)

    # No local path + a model object with no introspectable dir → sentinel.
    assert similarity_module.ensure_clip_model_ready() == "fastembed:in-memory"


# ===========================================================================
# Group E — model_health cross-module read of similarity._embed_model
#
# model_health._clip_model_loaded() does `from similarity import _embed_model`
# each call to report CLIP runtime_loaded. The split MUST keep `_embed_model`
# readable as a similarity module attribute or model status silently breaks.
# ===========================================================================


def test_model_health_reads_similarity_embed_model_global(monkeypatch):
    import model_health

    monkeypatch.setattr(similarity_module, "_embed_model", None)
    assert model_health._clip_model_loaded() is False

    monkeypatch.setattr(similarity_module, "_embed_model", object())
    assert model_health._clip_model_loaded() is True


# ===========================================================================
# Group F — patched module constants are read LIVE (intel d)
# ===========================================================================


class _RecordingCursor:
    def __init__(self):
        self.fetchmany_sizes = []

    def execute(self, *_args, **_kwargs):
        return self

    def fetchmany(self, size):
        self.fetchmany_sizes.append(size)
        return []  # stop immediately


class _RecordingConn:
    def __init__(self, cursor):
        self._cursor = cursor

    def __enter__(self):
        return self

    def __exit__(self, *_a):
        return False

    def cursor(self):
        return self._cursor


class _RecordingDb:
    def __init__(self, cursor):
        self._cursor = cursor

    def get_db(self):
        return _RecordingConn(self._cursor)


def test_iter_chunks_uses_live_search_chunk_size(monkeypatch):
    monkeypatch.setattr(similarity_module, "SIMILARITY_SEARCH_CHUNK_SIZE", 7)
    cursor = _RecordingCursor()
    index = similarity_module.SimilarityIndex(_RecordingDb(cursor))

    list(index._iter_embedding_candidate_chunks())

    assert cursor.fetchmany_sizes == [7]


def test_normalize_window_uses_live_max_window(monkeypatch):
    monkeypatch.setattr(similarity_module, "SIMILARITY_SEARCH_MAX_WINDOW", 3)
    index = similarity_module.SimilarityIndex(_RecordingDb(_RecordingCursor()))

    with pytest.raises(similarity_module.SimilaritySearchWindowTooLargeError) as exc:
        index._normalize_similarity_window(limit=3, offset=1)
    assert exc.value.requested_window == 5
    assert exc.value.max_window == 3


def test_find_duplicates_reads_live_sync_max(tmp_path, monkeypatch):
    rows = [
        (i, f"/d/{i}.png", f"{i}.png", [1.0, 0.0, 0.0, 0.0], 1) for i in range(1, 4)
    ]
    db = _make_db(tmp_path, rows)
    monkeypatch.setattr(similarity_module, "DUPLICATE_SYNC_MAX_EMBEDDINGS", 2)
    index = similarity_module.SimilarityIndex(db)

    with pytest.raises(similarity_module.SimilarityDuplicateSearchTooLargeError) as exc:
        index.find_duplicates(threshold=0.9)
    assert exc.value.embedded_count == 3
    assert exc.value.max_embeddings == 2


def test_find_duplicates_insufficient_embeddings_raises(tmp_path, monkeypatch):
    db = _make_db(tmp_path, [(1, "/d/1.png", "1.png", [1.0, 0.0], 1)])
    index = similarity_module.SimilarityIndex(db)

    with pytest.raises(similarity_module.SimilarityInsufficientEmbeddingsError) as exc:
        index.find_duplicates(threshold=0.9)
    assert exc.value.embedded_count == 1


def test_find_duplicates_chunk_size_is_result_invariant(tmp_path, monkeypatch):
    rows = [
        (1, "/d/a.png", "a.png", [1.0, 0.0, 0.0, 0.0], 1),
        (2, "/d/b.png", "b.png", [1.0, 0.0, 0.0, 0.0], 1),
        (3, "/d/c.png", "c.png", [0.0, 1.0, 0.0, 0.0], 1),
    ]
    db = _make_db(tmp_path, rows)
    index = similarity_module.SimilarityIndex(db)

    monkeypatch.setattr(similarity_module, "DUPLICATE_CHUNK_SIZE", 500)
    big = index.find_duplicates(threshold=0.99, limit=10)
    monkeypatch.setattr(similarity_module, "DUPLICATE_CHUNK_SIZE", 1)
    small = index.find_duplicates(threshold=0.99, limit=10)

    def _pairs(result):
        return {
            tuple(sorted((p["image_a"]["id"], p["image_b"]["id"])))
            for p in result["duplicates"]
        }

    assert _pairs(big) == _pairs(small) == {(1, 2)}


def test_embed_batch_reads_live_embedding_batch_size(tmp_path, monkeypatch):
    rows = [(i, f"/e/{i}.png", f"{i}.png", None, 1) for i in range(1, 4)]
    db = _make_db(tmp_path, rows)
    monkeypatch.setattr(similarity_module, "EMBEDDING_BATCH_SIZE", 1)
    monkeypatch.setattr(similarity_module, "_get_embed_model", lambda: object())
    # Every path resolves to "missing" so no model inference/db-write runs.
    monkeypatch.setattr(
        similarity_module,
        "resolve_existing_indexed_image_path",
        lambda _p, *, backend_file: None,
    )
    index = similarity_module.SimilarityIndex(db)

    index.embed_batch([1, 2, 3])

    assert index.get_progress()["total_batches"] == 3


def test_vector_cache_disabled_flag_is_read_live(tmp_path, monkeypatch):
    monkeypatch.setattr(similarity_module, "SIMILARITY_VECTOR_CACHE_ENABLED", False)
    index = similarity_module.SimilarityIndex(_make_db(tmp_path, _ROWS))

    assert index._ensure_vector_cache() is None


# ===========================================================================
# Group G — ANN routing goes through the similarity_ann sibling (intel f)
# ===========================================================================


def _fake_cache():
    matrix = np.asarray([[1.0, 0.0], [0.0, 1.0]], dtype=np.float32)
    return {
        "matrix": matrix,
        "ids": np.asarray([1, 2], dtype=np.int64),
        "paths": ["/a.png", "/b.png"],
        "filenames": ["a.png", "b.png"],
        "dim": 2,
        "signature": (2, 2),
    }


def test_invalidate_vector_cache_routes_to_similarity_ann_delete(tmp_path, monkeypatch):
    index = similarity_module.SimilarityIndex(_make_db(tmp_path, []))
    calls = []
    monkeypatch.setattr(
        similarity_ann, "delete_index", lambda index_dir: calls.append(index_dir)
    )

    index.invalidate_vector_cache()

    assert calls == [index._get_index_dir()]
    assert index._vector_cache is None
    assert index._ann is None


def test_ensure_ann_index_none_when_ann_disabled(tmp_path, monkeypatch):
    monkeypatch.setattr(similarity_module, "SIMILARITY_ANN_ENABLED", False)
    index = similarity_module.SimilarityIndex(_make_db(tmp_path, []))

    assert index._ensure_ann_index(_fake_cache()) is None


def test_ensure_ann_index_none_when_hnswlib_unavailable(tmp_path, monkeypatch):
    monkeypatch.setattr(similarity_module, "SIMILARITY_ANN_ENABLED", True)
    monkeypatch.setattr(similarity_ann, "hnswlib_available", lambda: False)
    index = similarity_module.SimilarityIndex(_make_db(tmp_path, []))

    assert index._ensure_ann_index(_fake_cache()) is None


def test_ensure_ann_index_delegates_build_to_similarity_ann(tmp_path, monkeypatch):
    monkeypatch.setattr(similarity_module, "SIMILARITY_ANN_ENABLED", True)
    monkeypatch.setattr(similarity_ann, "hnswlib_available", lambda: True)
    monkeypatch.setattr(similarity_ann, "load_index", lambda *_a, **_k: None)
    sentinel = object()
    captured = {}

    def fake_build(matrix, signature, index_dir, *, persist):
        captured["signature"] = signature
        captured["persist"] = persist
        captured["dim"] = int(matrix.shape[1])
        return sentinel

    monkeypatch.setattr(similarity_ann, "build_index", fake_build)
    index = similarity_module.SimilarityIndex(_make_db(tmp_path, []))

    result = index._ensure_ann_index(_fake_cache())

    assert result is sentinel
    assert index._ann is sentinel
    assert captured["signature"] == (2, 2)
    assert captured["persist"] is True
    assert captured["dim"] == 2


# ===========================================================================
# Group H — SimilarityIndex direct construction + exception contracts (intel g)
# ===========================================================================


def test_similarity_index_direct_construction_defaults(tmp_path):
    db = _make_db(tmp_path, [])
    index = similarity_module.SimilarityIndex(db)

    assert index.db is db
    assert index._vector_cache is None
    assert index._ann is None
    progress = index.get_progress()
    assert progress["running"] is False
    assert progress["step"] == "idle"
    assert progress["recent_issues"] == []


def test_search_by_id_missing_image_raises(tmp_path):
    index = similarity_module.SimilarityIndex(_make_db(tmp_path, []))

    with pytest.raises(similarity_module.SimilarityImageNotFoundError) as exc:
        index.search_by_id(999)
    assert exc.value.image_id == 999


def test_search_by_id_missing_embedding_raises(tmp_path):
    db = _make_db(tmp_path, [(5, "/x/5.png", "5.png", None, 1)])
    index = similarity_module.SimilarityIndex(db)

    with pytest.raises(similarity_module.SimilarityEmbeddingMissingError) as exc:
        index.search_by_id(5)
    assert exc.value.image_id == 5


def test_search_by_upload_invalid_image_raises(tmp_path):
    index = similarity_module.SimilarityIndex(_make_db(tmp_path, []))

    with pytest.raises(similarity_module.SimilarityInvalidImageError):
        index.search_by_upload(b"definitely not an image")


def test_search_by_text_empty_when_embedder_returns_none(tmp_path, monkeypatch):
    monkeypatch.setattr(similarity_module, "embed_text", lambda _q: None)
    index = similarity_module.SimilarityIndex(_make_db(tmp_path, _ROWS))

    result = index.search_by_text("anything", limit=5, offset=2)

    assert result["results"] == []
    assert result["total"] == 0
    assert result["has_more"] is False
    assert result["offset"] == 2 and result["limit"] == 5


# ===========================================================================
# Group I — pure helper behavior (byte-tile-safe primitives)
# ===========================================================================


def test_embedding_bytes_roundtrip():
    vec = np.array([0.1, -0.2, 0.3], dtype=np.float32)
    restored = similarity_module.bytes_to_embedding(
        similarity_module.embedding_to_bytes(vec)
    )
    assert restored.dtype == np.float32
    np.testing.assert_allclose(restored, vec, rtol=0, atol=0)


def test_cosine_similarity_edges():
    a = np.array([1.0, 0.0], dtype=np.float32)
    b = np.array([0.0, 1.0], dtype=np.float32)
    zero = np.array([0.0, 0.0], dtype=np.float32)
    assert similarity_module.cosine_similarity(a, a) == pytest.approx(1.0)
    assert similarity_module.cosine_similarity(a, b) == pytest.approx(0.0)
    assert similarity_module.cosine_similarity(a, zero) == 0.0


# ===========================================================================
# Group J — safety invariants / dormant-bug guards
# ===========================================================================


def test_rank_candidate_rows_skips_dimension_mismatch():
    index = similarity_module.SimilarityIndex(None)
    query = np.array([1.0, 0.0], dtype=np.float32)
    mismatched = similarity_module.embedding_to_bytes(
        np.array([1.0, 0.0, 0.0], dtype=np.float32)
    )
    # A 3-dim candidate against a 2-dim query is skipped (shape guard), not crashed.
    assert (
        index._rank_candidate_rows(query, [(1, "/p.png", "p.png", mismatched)], -1.0)
        == []
    )


def test_rank_candidate_rows_zero_query_returns_empty():
    index = similarity_module.SimilarityIndex(None)
    good = similarity_module.embedding_to_bytes(np.array([1.0, 0.0], dtype=np.float32))
    assert (
        index._rank_candidate_rows(
            np.zeros(2, dtype=np.float32), [(1, "/p", "p", good)], -1.0
        )
        == []
    )


def test_top_k_similar_empty_on_dimension_mismatch(tmp_path, monkeypatch):
    monkeypatch.setattr(similarity_module, "SIMILARITY_VECTOR_CACHE_ENABLED", True)
    index = similarity_module.SimilarityIndex(_make_db(tmp_path, _ROWS))

    # Cache is dim-4; a dim-3 query cannot be scored → empty (no crash).
    assert index.top_k_similar(np.array([1.0, 0.0, 0.0], dtype=np.float32), k=3) == []


def test_search_by_id_ignores_unreadable_embedded_rows(tmp_path, monkeypatch):
    # Unreadable rows (is_readable=0) carry embeddings but must never surface.
    monkeypatch.setattr(similarity_module, "SIMILARITY_VECTOR_CACHE_ENABLED", False)
    index = similarity_module.SimilarityIndex(_make_db(tmp_path, _ROWS))

    result = index.search_by_id(1, limit=10, threshold=-1.0)
    ids = {r["id"] for r in result["results"]}
    assert 1 not in ids  # query excluded
    assert 6 not in ids  # unreadable excluded
    assert ids == {2, 3, 4}
