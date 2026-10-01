"""Style map UMAP layout (slice S2b.1): optional install group, Model Center
card, background layout job, disk cache and the layout-status route.

umap-learn is NOT installed in the dev/CI environment (it is an optional
install group), so every test here runs against a fake ``umap`` / ``numba``
module; the real library is exercised by a scratchpad smoke run only.
"""

from __future__ import annotations

import json
import sys
import threading
import time
import types
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

import optional_dependencies as deps
from db_style_vectors import pack_style_vector
from services import style_map_service, style_map_umap

REPO_ROOT = Path(__file__).resolve().parents[2]
DIM = 64


# ------------------------------------------------------------------ helpers
def _random_units(n: int, seed: int = 0, dim: int = DIM) -> np.ndarray:
    rng = np.random.default_rng(seed)
    x = rng.normal(size=(n, dim)).astype(np.float32)
    return x / np.linalg.norm(x, axis=1, keepdims=True)


def _make_images(test_db, tmp_path, count: int, prefix: str = "img") -> list[int]:
    ids = []
    for index in range(count):
        path = tmp_path / f"{prefix}{index}.png"
        Image.new("RGB", (8, 8), (index * 30 % 255, 90, 120)).save(path)
        ids.append(
            test_db.add_image(
                path=str(path), filename=path.name, content_fingerprint=f"fp{index}"
            )
        )
    return ids


def _store_kaloscope(test_db, image_ids, vectors):
    from artist_identifier import kaloscope_style_vector_model_version

    version = kaloscope_style_vector_model_version(None)
    with test_db.get_db() as conn:
        for image_id, vector in zip(image_ids, vectors):
            blob, dim, dtype = pack_style_vector(vector)
            conn.execute(
                "INSERT OR REPLACE INTO image_style_vectors "
                "(image_id, space, model_version, content_fingerprint, dim, dtype, vector, updated_at) "
                "VALUES (?, 'kaloscope', ?, ?, ?, ?, ?, strftime('%Y-%m-%d %H:%M:%f', 'now'))",
                (image_id, version, f"fp{image_ids.index(image_id)}", dim, dtype, blob),
            )


@pytest.fixture
def state_dir(tmp_path, monkeypatch):
    target = tmp_path / "state"
    target.mkdir()
    monkeypatch.setattr(style_map_umap, "get_state_dir", lambda: str(target))
    return target


@pytest.fixture
def fake_umap(monkeypatch):
    """A stand-in umap-learn: deterministic 3-D output, records its calls; may block or fail."""
    record = {"calls": [], "threads": [], "block": None, "fail": False, "fits": 0}
    module = types.ModuleType("umap")
    module.__version__ = "fake-0"

    class UMAP:
        def __init__(self, **kwargs):
            self.kwargs = kwargs
            record["calls"].append(kwargs)

        def fit_transform(self, x):
            x = np.asarray(x, dtype=np.float32)
            record["fits"] += 1
            record["last_input_shape"] = tuple(x.shape)
            if record["block"] is not None:
                record["block"].wait(10)
            if record["fail"]:
                raise RuntimeError("fake umap exploded")
            width = min(3, x.shape[1])
            out = np.zeros((len(x), 3), dtype=np.float32)
            out[:, :width] = x[:, :width]
            return out * 7.0  # not in [-1, 1]: the service must rescale

    module.UMAP = UMAP
    monkeypatch.setitem(sys.modules, "umap", module)
    numba = types.ModuleType("numba")
    numba.get_num_threads = lambda: 12
    numba.set_num_threads = lambda n: record["threads"].append(int(n))
    monkeypatch.setitem(sys.modules, "numba", numba)
    # The probe wants the whole install group importable, not just umap.
    for name in deps.GROUP_IMPORTS["umap"]:
        if name not in sys.modules:
            monkeypatch.setitem(sys.modules, name, types.ModuleType(name))
    return record


def _fake_inputs(n: int, seed: int):
    """UMAP inputs of a made-up map (ids 1..n), for queue tests without a DB."""
    rng = np.random.default_rng(seed)
    return style_map_service._MapInputs(
        np.arange(1, n + 1, dtype=np.int64),
        rng.normal(size=(n, style_map_umap.UMAP_INPUT_DIM)).astype(np.float16),
    )


def _fake_key(tag: str) -> tuple:
    return ("main", "kaloscope", "v", f"members-{tag}", (1, 2, "t"))


def _wait_layout(service, timeout: float = 10.0) -> None:
    thread = service._umap_thread
    if thread is not None:
        thread.join(timeout)
        assert not thread.is_alive(), "layout job did not finish in time"


# ------------------------------------------------------------- layout job
class TestLayoutJob:
    def test_without_umap_points_stay_pca_and_say_how_to_install(
        self, test_db, tmp_path, state_dir, monkeypatch
    ):
        monkeypatch.setattr(style_map_umap, "umap_available", lambda: False)
        ids = _make_images(test_db, tmp_path, 30)
        _store_kaloscope(test_db, ids, _random_units(30, seed=1))
        service = style_map_service.StyleMapService()
        result = service.points("kaloscope")
        assert result["method"] == "pca"
        assert result["umap"]["status"] == "unavailable"
        assert result["umap"]["install"]["model_id"] == "style-map-umap"
        assert any(
            p.startswith("umap-learn") for p in result["umap"]["install"]["packages"]
        )
        assert service._umap_thread is None

    def test_first_call_returns_pca_and_starts_the_job(
        self, test_db, tmp_path, state_dir, fake_umap
    ):
        # 100 points > DIM: the PCA has every axis, so the UMAP input is
        # really truncated to UMAP_INPUT_DIM columns.
        ids = _make_images(test_db, tmp_path, 100)
        vectors = _random_units(100, seed=2)
        _store_kaloscope(test_db, ids, vectors)
        service = style_map_service.StyleMapService()

        first = service.points("kaloscope")
        assert first["method"] == "pca"
        assert first["umap"]["status"] in ("queued", "computing")
        assert first["umap"]["points"] == 100
        _wait_layout(service)

        second = service.points("kaloscope")
        assert second["method"] == "umap"
        assert second["umap"]["status"] == "ready"
        assert second["umap"]["source"] in ("memory", "disk")
        assert [p[0] for p in second["points"]] == [p[0] for p in first["points"]]
        assert [p[4] for p in second["points"]] == [p[4] for p in first["points"]]
        assert all(-1.0 <= v <= 1.0 for p in second["points"] for v in p[1:4])
        assert max(abs(v) for p in second["points"] for v in p[1:4]) == pytest.approx(
            1.0, abs=1e-3
        )
        assert second["explained_variance"] == first["explained_variance"]

        call = fake_umap["calls"][0]
        assert call["n_components"] == 3
        assert call["n_neighbors"] == style_map_umap.UMAP_N_NEIGHBORS
        assert call["metric"] == style_map_umap.UMAP_METRIC
        assert call["random_state"] == style_map_umap.UMAP_RANDOM_STATE
        assert fake_umap["last_input_shape"] == (
            100,
            min(style_map_umap.UMAP_INPUT_DIM, DIM),
        )
        assert fake_umap["threads"] == [style_map_service.STYLE_MAP_BLAS_THREADS]

    def test_layout_only_uses_representatives(
        self, test_db, tmp_path, state_dir, fake_umap
    ):
        ids = _make_images(test_db, tmp_path, 30)
        vectors = _random_units(30, seed=3)
        rng = np.random.default_rng(4)
        vectors[5] = vectors[2] + 0.01 * rng.normal(
            size=DIM
        )  # near-duplicate of ids[2]
        vectors[9] = np.eye(DIM)[0] * 3 + 0.1 * vectors[9]  # unlocatable
        vectors /= np.linalg.norm(vectors, axis=1, keepdims=True)
        _store_kaloscope(test_db, ids, vectors)
        service = style_map_service.StyleMapService()
        first = service.points("kaloscope")
        _wait_layout(service)
        assert fake_umap["last_input_shape"][0] == 28  # 30 - 1 merged - 1 unlocatable
        second = service.points("kaloscope")
        assert second["method"] == "umap"
        assert second["unlocatable"] == [ids[9]]
        assert dict((p[0], p[4]) for p in second["points"])[ids[2]] == 2

    def test_too_few_points_is_pca_only(self, test_db, tmp_path, state_dir, fake_umap):
        ids = _make_images(test_db, tmp_path, 5)
        _store_kaloscope(test_db, ids, _random_units(5, seed=5))
        service = style_map_service.StyleMapService()
        result = service.points("kaloscope")
        assert result["method"] == "pca"
        assert result["umap"]["status"] == "too_few_points"
        assert result["umap"]["min_points"] == style_map_umap.UMAP_MIN_POINTS
        assert service._umap_thread is None and fake_umap["fits"] == 0
        status = service.layout_status("kaloscope")
        assert status["umap"]["status"] == "too_few_points"

    def test_layout_status_follows_the_job(
        self, test_db, tmp_path, state_dir, fake_umap
    ):
        ids = _make_images(test_db, tmp_path, 30)
        _store_kaloscope(test_db, ids, _random_units(30, seed=6))
        service = style_map_service.StyleMapService()
        assert service.layout_status("kaloscope")["umap"]["status"] == "not_started"
        service.points("kaloscope")
        _wait_layout(service)
        status = service.layout_status("kaloscope")
        assert status["umap"]["status"] == "ready"
        assert status["method"] == "umap"
        assert status["umap"]["elapsed_s"] >= 0

    def test_ready_layout_survives_a_restart_through_the_disk_cache(
        self, test_db, tmp_path, state_dir, fake_umap
    ):
        ids = _make_images(test_db, tmp_path, 30)
        _store_kaloscope(test_db, ids, _random_units(30, seed=7))
        service = style_map_service.StyleMapService()
        service.points("kaloscope")
        _wait_layout(service)
        ready = service.points("kaloscope")
        files = sorted((state_dir / "style-map").glob("*.npz"))
        assert len(files) == 1
        meta = json.loads(files[0].with_suffix(".json").read_text(encoding="utf-8"))
        assert meta["method"] == "umap" and meta["space"] == "kaloscope"
        assert meta["umap"]["n_neighbors"] == style_map_umap.UMAP_N_NEIGHBORS
        assert meta["umap"]["input_dim"] == style_map_umap.UMAP_INPUT_DIM

        fresh = (
            style_map_service.StyleMapService()
        )  # a new process would start like this
        again = fresh.points("kaloscope")
        assert again["method"] == "umap" and again["umap"]["source"] == "disk"
        assert again["points"] == ready["points"]
        assert fresh._umap_thread is None and fake_umap["fits"] == 1

    def test_changed_vectors_invalidate_the_layout(
        self, test_db, tmp_path, state_dir, fake_umap
    ):
        ids = _make_images(test_db, tmp_path, 30)
        _store_kaloscope(test_db, ids, _random_units(30, seed=8))
        service = style_map_service.StyleMapService()
        service.points("kaloscope")
        _wait_layout(service)
        assert service.points("kaloscope")["method"] == "umap"

        _store_kaloscope(test_db, ids[:1], _random_units(1, seed=9))
        after = service.points("kaloscope")
        assert after["method"] == "pca"
        assert after["umap"]["status"] in ("queued", "computing")
        _wait_layout(service)
        assert service.points("kaloscope")["method"] == "umap"
        assert fake_umap["fits"] == 2

    def test_disk_cache_keeps_only_the_newest_layouts(
        self, test_db, tmp_path, state_dir, fake_umap
    ):
        ids = _make_images(test_db, tmp_path, 30)
        service = style_map_service.StyleMapService()
        for round_index in range(style_map_umap.LAYOUT_CACHE_KEEP_PER_MAP + 2):
            _store_kaloscope(test_db, ids[:1], _random_units(1, seed=100 + round_index))
            _store_kaloscope(
                test_db, ids[1:], _random_units(29, seed=200 + round_index)
            )
            service.points("kaloscope")
            _wait_layout(service)
            time.sleep(0.02)
        files = sorted((state_dir / "style-map").glob("*.npz"))
        assert len(files) == style_map_umap.LAYOUT_CACHE_KEEP_PER_MAP
        assert all(f.with_suffix(".json").exists() for f in files)

    def test_single_flight_and_no_duplicate_fit(
        self, test_db, tmp_path, state_dir, fake_umap
    ):
        """Reviewer's probe: while a fit is blocked, repeated requests for the
        same map and one for another map start no second fit and no second
        worker; after the block lifts, exactly one more fit runs."""
        from services.image_service import ImageService

        ids = _make_images(test_db, tmp_path, 40)
        with test_db.get_db() as conn:
            conn.execute(
                f"UPDATE images SET generator = 'nai' WHERE id IN ({','.join(str(i) for i in ids[:25])})"
            )
        _store_kaloscope(test_db, ids, _random_units(40, seed=10))
        service = style_map_service.StyleMapService()
        fake_umap["block"] = threading.Event()
        service.points("kaloscope")
        for _ in range(50):  # until the worker has picked the job up
            if fake_umap["fits"]:
                break
            time.sleep(0.02)
        for _ in range(3):  # the same map again while it is being fitted
            assert service.points("kaloscope")["umap"]["status"] == "computing"
            assert service.layout_status("kaloscope")["umap"]["status"] == "computing"
        assert len(service._umap_queue) == 0, "the running map must not be re-queued"
        token = ImageService().create_selection_token(generators=["nai"])[
            "selection_token"
        ]
        service.points("kaloscope", selection_token=token)  # a second map
        assert len(service._umap_queue) == 1
        time.sleep(0.5)  # give any extra worker time to start fitting
        workers = [t for t in threading.enumerate() if t.name == "style-map-umap"]
        assert fake_umap["fits"] == 1 and len(workers) == 1
        fake_umap["block"].set()
        for worker in workers:
            worker.join(10)
        for _ in range(40):
            if not service._umap_running:
                break
            time.sleep(0.05)
        assert fake_umap["fits"] == 2
        assert service.points("kaloscope")["method"] == "umap"
        assert service.points("kaloscope", selection_token=token)["method"] == "umap"

    def test_queue_keeps_the_worker_alive_and_fits_the_newest(
        self, state_dir, fake_umap
    ):
        """40 maps requested while the first fit is blocked: the job history
        must not evict queued jobs (that killed the worker), the queue keeps
        only the newest maps, and a later request still gets fitted."""
        service = style_map_service.StyleMapService()
        fake_umap["block"] = threading.Event()
        keys = [_fake_key(str(i)) for i in range(40)]
        for index, key in enumerate(keys):
            service._umap_state(key, _fake_inputs(30, index), retry=False)
        assert len(service._umap_queue) <= style_map_service._QUEUE_LIMIT
        fake_umap["block"].set()
        service._umap_thread.join(10)
        assert not service._umap_running
        # the first (computing) map plus the newest queued ones
        assert fake_umap["fits"] == 1 + style_map_service._QUEUE_LIMIT
        newest = service._layout_key(keys[-1])
        assert service._umap_jobs[newest].status == "ready"
        # an evicted map is simply not started; asking again queues it afresh
        dropped = service._umap_state(keys[5], _fake_inputs(30, 5), retry=False)
        assert dropped["status"] in ("queued", "computing")
        service._umap_thread.join(10)
        assert fake_umap["fits"] == 2 + style_map_service._QUEUE_LIMIT
        assert not service._umap_running

    def test_job_history_never_evicts_unfinished_jobs(self, state_dir, fake_umap):
        """The history cap only drops ready/failed records: a queued job whose
        record disappears would never run (the worker looks it up by key)."""
        service = style_map_service.StyleMapService()
        with service._umap_lock:
            for index in range(5):  # oldest records: still queued
                key = service._layout_key(_fake_key(f"queued-{index}"))
                service._umap_jobs[key] = style_map_service._LayoutJob(
                    key, np.arange(30), None, status="queued"
                )
                service._umap_queue.append(key)
            for index in range(style_map_service._JOB_HISTORY + 10):
                key = service._layout_key(_fake_key(f"done-{index}"))
                service._umap_jobs[key] = style_map_service._LayoutJob(
                    key, np.arange(30), None, status="ready"
                )
            service._trim_jobs()
            statuses = [job.status for job in service._umap_jobs.values()]
        assert statuses.count("queued") == len(service._umap_queue)
        assert all(service._umap_jobs.get(key) for key in service._umap_queue)
        assert len(service._umap_jobs) <= style_map_service._JOB_HISTORY + len(
            service._umap_queue
        )

    def test_worker_survives_a_missing_job_record(self, state_dir, fake_umap):
        service = style_map_service.StyleMapService()
        fake_umap["block"] = threading.Event()
        first = _fake_key("a")
        service._umap_state(first, _fake_inputs(30, 1), retry=False)
        second = _fake_key("b")
        service._umap_state(second, _fake_inputs(30, 2), retry=False)
        with service._umap_lock:
            service._umap_jobs.pop(service._layout_key(second))  # record vanished
        fake_umap["block"].set()
        service._umap_thread.join(10)
        assert not service._umap_running
        third = service._umap_state(_fake_key("c"), _fake_inputs(30, 3), retry=False)
        assert third["status"] in ("queued", "computing")
        service._umap_thread.join(10)
        assert fake_umap["fits"] == 2 and not service._umap_running

    @pytest.mark.parametrize("damage", ["zero-bytes", "truncated"])
    def test_damaged_layout_cache_falls_back_to_pca_and_refits(
        self, test_db, tmp_path, state_dir, fake_umap, damage
    ):
        """After a power loss the npz can be empty or cut short: the map must
        still answer (PCA), drop the damaged pair and queue a new fit."""
        ids = _make_images(test_db, tmp_path, 30)
        _store_kaloscope(test_db, ids, _random_units(30, seed=4))
        service = style_map_service.StyleMapService()
        service.points("kaloscope")
        _wait_layout(service)
        npz = next((state_dir / "style-map").glob("*.npz"))
        raw = npz.read_bytes()
        npz.write_bytes(b"" if damage == "zero-bytes" else raw[: len(raw) // 2])

        fresh = style_map_service.StyleMapService()  # a new process
        out = fresh.points("kaloscope")
        assert out["method"] == "pca" and len(out["points"]) == 30
        assert out["umap"]["status"] in ("queued", "computing")
        assert not npz.exists() and not npz.with_suffix(".json").exists()
        _wait_layout(fresh)
        assert fresh.points("kaloscope")["method"] == "umap"
        assert fake_umap["fits"] == 2

    def test_status_first_then_points_does_not_lose_points(
        self, test_db, tmp_path, state_dir, fake_umap
    ):
        """Reviewer's probe: a disk layout under the same key with fewer
        representatives (an older build) must never be drawn."""
        ids = _make_images(test_db, tmp_path, 30)
        _store_kaloscope(test_db, ids, _random_units(30, seed=3))
        probe = style_map_service.StyleMapService()
        _n, _m, _i, key = probe._map_key("kaloscope", None)
        style_map_umap.store_layout(
            probe._layout_key(key),
            np.asarray(ids[:20], dtype=np.int64),
            np.full((20, 3), 0.5, np.float32),
            1.0,
        )
        service = style_map_service.StyleMapService()
        assert service.layout_status("kaloscope")["umap"]["status"] == "ready"
        out = service.points("kaloscope")
        assert out["method"] == "pca" and len(out["points"]) == 30
        assert sum(p[4] for p in out["points"]) == 30
        assert out["umap"]["status"] in ("queued", "computing")
        _wait_layout(service)
        ready = service.points("kaloscope")
        assert ready["method"] == "umap" and len(ready["points"]) == 30

    def test_layout_key_carries_the_map_rules(self, state_dir):
        from services import style_map_math

        layout_key = style_map_service.StyleMapService._layout_key(_fake_key("k"))
        flat = repr(layout_key)
        assert str(style_map_math.STYLE_MAP_ALGO_VERSION) in flat
        assert str(style_map_math.NEAR_DUPLICATE_COS) in flat
        assert str(style_map_math.UNLOCATABLE_MAX_COMPONENT) in flat

    def test_ready_response_bytes_are_cached(
        self, test_db, tmp_path, state_dir, fake_umap
    ):
        ids = _make_images(test_db, tmp_path, 30)
        _store_kaloscope(test_db, ids, _random_units(30, seed=21))
        service = style_map_service.StyleMapService()
        service.points("kaloscope")
        _wait_layout(service)
        first = service.points_json("kaloscope")
        _n, _m, _i, key = service._map_key("kaloscope", None)
        with service._umap_lock:
            body = service._rendered[service._layout_key(key)]
        assert first.startswith(body[:-1]) or first.startswith(body)
        assert service.points_json("kaloscope") == first

    def test_prune_removes_tmp_and_orphan_files(self, state_dir, fake_umap):
        directory = state_dir / "style-map"
        directory.mkdir()
        (directory / "leftover.npz.tmp").write_bytes(b"x")
        (directory / "leftover.json.tmp").write_bytes(b"x")
        (directory / "orphan.npz").write_bytes(b"x")  # npz without its json
        (directory / "lonely.json").write_text(
            "{}", encoding="utf-8"
        )  # json without npz
        style_map_umap.store_layout(
            _fake_key("p"),
            np.arange(1, 31, dtype=np.int64),
            np.zeros((30, 3), np.float32),
            1.0,
        )
        names = sorted(p.name for p in directory.iterdir())
        assert len(names) == 2 and all(
            not n.startswith(("leftover", "orphan", "lonely")) for n in names
        )

    def test_umap_available_needs_every_group_module(self, monkeypatch):
        for name in deps.GROUP_IMPORTS["umap"]:
            monkeypatch.setitem(sys.modules, name, types.ModuleType(name))
        assert style_map_umap.umap_available() is True
        monkeypatch.delitem(sys.modules, "llvmlite")
        monkeypatch.setattr(
            style_map_umap.importlib.util,
            "find_spec",
            lambda name: None if name == "llvmlite" else object(),
        )
        assert style_map_umap.umap_available() is False

    def test_second_map_queued_while_the_worker_exits_still_gets_fitted(
        self, state_dir, fake_umap
    ):
        """Reviewer's lost-wakeup probe: a map queued in the window between
        the worker seeing an empty queue and clearing its running flag must
        not wait forever."""
        first, second = _fake_key("w1"), _fake_key("w2")
        service = style_map_service.StyleMapService()
        window = threading.Event()
        inner = threading.Lock()

        class ExitWindowLock:
            """Pause the worker right after it leaves the 'queue is empty'
            block (first job done), before any later locked section."""

            def __enter__(self):
                inner.acquire()
                return self

            def __exit__(self, *exc):
                caller = sys._getframe(1).f_code.co_name
                first_job = service._umap_jobs.get(service._layout_key(first))
                hit = (
                    threading.current_thread().name == "style-map-umap"
                    and caller == "_umap_worker"
                    and not service._umap_queue
                    and first_job is not None
                    and first_job.status == "ready"
                    and not window.is_set()
                )
                inner.release()
                if hit:
                    window.set()
                    time.sleep(0.3)
                return False

        service._umap_lock = ExitWindowLock()
        service._umap_state(first, _fake_inputs(30, 1), retry=False)
        assert window.wait(10)
        service._umap_state(second, _fake_inputs(30, 2), retry=False)  # in the window
        # No status polls while waiting: the map must be picked up by a
        # worker on its own, not rescued by the self-heal in _umap_state.
        second_job = service._umap_jobs[service._layout_key(second)]
        for _ in range(100):
            if second_job.status == "ready":
                break
            time.sleep(0.05)
        assert second_job.status == "ready" and fake_umap["fits"] == 2
        assert (
            service._umap_state(second, _fake_inputs(30, 2), retry=False)["status"]
            == "ready"
        )

    def test_old_worker_exiting_does_not_clear_a_newer_workers_flag(
        self, state_dir, fake_umap
    ):
        """Reverse race: a map queued after the worker's clean return (flag
        down) but before its finally starts worker B; the old worker's exit
        must leave B's flag alone (no second worker, no lost flag)."""
        first, second = _fake_key("r1"), _fake_key("r2")
        service = style_map_service.StyleMapService()
        window = threading.Event()
        inner = threading.Lock()

        class ExitWindowLock:
            """Pause the worker right after its clean return released the lock."""

            def __enter__(self):
                inner.acquire()
                return self

            def __exit__(self, *exc):
                caller = sys._getframe(1).f_code.co_name
                hit = (
                    threading.current_thread().name == "style-map-umap"
                    and caller == "_umap_worker"
                    and not service._umap_running
                    and not window.is_set()
                )
                inner.release()
                if hit:
                    window.set()
                    time.sleep(0.4)
                return False

        service._umap_lock = ExitWindowLock()
        service._umap_state(first, _fake_inputs(30, 1), retry=False)
        assert window.wait(10)
        fake_umap["block"] = threading.Event()  # worker B's fit will wait
        service._umap_state(second, _fake_inputs(30, 2), retry=False)  # starts B
        time.sleep(0.8)  # the old worker's finally has run by now
        workers = [t for t in threading.enumerate() if t.name == "style-map-umap"]
        assert len(workers) == 1 and workers[0].is_alive()
        assert service._umap_running is True
        assert fake_umap["fits"] == 2  # B started the second fit, nobody else did
        fake_umap["block"].set()
        workers[0].join(10)
        assert fake_umap["fits"] == 2
        assert service._umap_jobs[service._layout_key(second)].status == "ready"
        assert service._umap_running is False

    def test_exception_in_the_worker_hands_the_queue_to_a_new_worker(
        self, state_dir, fake_umap, monkeypatch
    ):
        service = style_map_service.StyleMapService()
        real_run_job = service._run_job
        calls = {"n": 0}

        def run_job(layout_key, job):
            calls["n"] += 1
            if calls["n"] == 1:
                raise RuntimeError("worker crashed outside the job guard")
            return real_run_job(layout_key, job)

        monkeypatch.setattr(service, "_run_job", run_job)
        fake_umap["block"] = threading.Event()  # keep the first job on the queue...
        first, second = _fake_key("x1"), _fake_key("x2")
        service._umap_state(first, _fake_inputs(30, 1), retry=False)
        service._umap_state(second, _fake_inputs(30, 2), retry=False)
        fake_umap["block"].set()  # ...long enough for the second to be queued
        deadline = time.time() + 10
        while time.time() < deadline:
            job = service._umap_jobs.get(service._layout_key(second))
            if job is not None and job.status == "ready":
                break
            time.sleep(0.05)
        assert service._umap_jobs[service._layout_key(second)].status == "ready"
        assert calls["n"] == 2 and fake_umap["fits"] == 1
        for _ in range(50):
            if not service._umap_running:
                break
            time.sleep(0.05)
        assert service._umap_running is False

    def test_polling_a_queued_map_restarts_a_dead_worker(self, state_dir, fake_umap):
        """A queued job whose worker is gone (flag down, nothing running) is
        picked up again by the next status request instead of waiting forever."""
        service = style_map_service.StyleMapService()
        key = _fake_key("orphan")
        inputs = _fake_inputs(30, 3)
        layout_key = service._layout_key(key)
        with service._umap_lock:
            service._umap_jobs[layout_key] = style_map_service._LayoutJob(
                layout_key, inputs.rep_ids, inputs.features
            )
            service._umap_queue.append(layout_key)
            service._umap_running = False  # the worker that should run it is dead
        assert service._umap_state(key, inputs, retry=False)["status"] in (
            "queued",
            "computing",
        )
        assert service._umap_thread is not None
        service._umap_thread.join(10)
        assert service._umap_state(key, inputs, retry=False)["status"] == "ready"
        assert fake_umap["fits"] == 1

    def test_failure_is_reported_and_refresh_retries(
        self, test_db, tmp_path, state_dir, fake_umap
    ):
        ids = _make_images(test_db, tmp_path, 30)
        _store_kaloscope(test_db, ids, _random_units(30, seed=11))
        service = style_map_service.StyleMapService()
        fake_umap["fail"] = True
        service.points("kaloscope")
        _wait_layout(service)
        failed = service.points("kaloscope")
        assert failed["method"] == "pca"
        assert failed["umap"]["status"] == "failed"
        assert "exploded" in failed["umap"]["error"]
        assert service._umap_thread is None or not service._umap_thread.is_alive()

        fake_umap["fail"] = False
        retried = service.points("kaloscope", refresh=True)
        assert retried["umap"]["status"] in ("queued", "computing")
        _wait_layout(service)
        assert service.points("kaloscope")["method"] == "umap"


class TestBlasBudget:
    @staticmethod
    def _blas_threads() -> list[int]:
        from threadpoolctl import threadpool_info

        return [
            int(info["num_threads"])
            for info in threadpool_info()
            if info["user_api"] == "blas"
        ]

    def test_budget_is_shared_between_threads_and_restored_once(self):
        """Reviewer's interleave: A enters, B enters, A leaves (B still
        computing on 4 threads), B leaves (baseline back). The baseline is
        pinned to 7 so an earlier test leaving the process at 4 cannot mask
        a budget that fails to restore."""
        from threadpoolctl import threadpool_limits

        from services.style_map_math import STYLE_MAP_BLAS_THREADS, blas_budget

        if not self._blas_threads():
            pytest.skip("no BLAS library loaded in this interpreter")
        baseline = 7
        with threadpool_limits(limits=baseline, user_api="blas"):
            before = self._blas_threads()
            assert before == [baseline] * len(before)
            a_in, b_in, a_out = threading.Event(), threading.Event(), threading.Event()
            seen: dict = {}

            def thread_a():
                with blas_budget():
                    a_in.set()
                    b_in.wait(5)
                a_out.set()

            def thread_b():
                a_in.wait(5)
                with blas_budget():
                    b_in.set()
                    a_out.wait(5)
                    seen["b_after_a_left"] = self._blas_threads()

            a, b = threading.Thread(target=thread_a), threading.Thread(target=thread_b)
            a.start(), b.start(), a.join(5), b.join(5)
            assert seen["b_after_a_left"] == [STYLE_MAP_BLAS_THREADS] * len(before)
            assert self._blas_threads() == before


class TestRoute:
    def test_layout_status_route(self, test_client, tmp_path, monkeypatch):
        from routers import style_map as style_map_router

        monkeypatch.setattr(style_map_umap, "umap_available", lambda: False)
        style_map_router.set_style_map_service(style_map_service.StyleMapService())
        try:
            ids = _make_images(test_client.test_db, tmp_path, 3)
            _store_kaloscope(test_client.test_db, ids, _random_units(3, seed=12))
            response = test_client.get(
                "/api/style-map/layout-status", params={"space": "kaloscope"}
            )
            assert response.status_code == 200, response.text
            body = response.json()
            assert body["method"] == "pca"
            assert body["umap"]["status"] == "unavailable"
            points = test_client.get(
                "/api/style-map/points", params={"space": "kaloscope"}
            ).json()
            assert points["umap"]["status"] == "unavailable"
            bad = test_client.get(
                "/api/style-map/layout-status", params={"space": "dino"}
            )
            assert bad.status_code == 400
        finally:
            style_map_router.set_style_map_service(None)
