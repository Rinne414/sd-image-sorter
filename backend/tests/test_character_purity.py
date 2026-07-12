"""Tests for the CCIP character-purity feature (roadmap #9, v1).

No network and no real ONNX model files: the CCIP singleton is stubbed via
``character_purity_service._get_ccip`` so these tests cover the medoid math,
the background-job lifecycle, request validation, and failed-image counting.
"""

from __future__ import annotations

import threading
import time
from pathlib import Path

import numpy as np
import pytest

import ccip
import services.character_purity_service as purity_service


# ----------------------------- fakes / fixtures -----------------------------


class FakeCcip:
    """ONNX-free stand-in for ``ccip.CCIPModel``."""

    def __init__(self, *, diff_matrix=None, failed_paths=(), available=True):
        self.diff_matrix = diff_matrix
        self.failed_paths = set(failed_paths)
        self.available = available
        self.model_dir = Path("fake-ccip") / ccip.CCIP_MODEL_SUBDIR

    def missing_files(self):
        return [] if self.available else list(ccip.CCIP_MODEL_FILES)

    def is_available(self):
        return self.available

    def extract_features(self, paths, progress_callback=None, cancel_event=None):
        features = []
        failed_indices = []
        for index, path in enumerate(paths):
            if cancel_event is not None and cancel_event.is_set():
                raise ccip.CCIPCancelled()
            if str(path) in self.failed_paths:
                failed_indices.append(index)
            else:
                features.append(np.full(4, float(index), dtype=np.float32))
            if progress_callback:
                progress_callback(index + 1, len(paths))
        stacked = np.stack(features) if features else np.zeros((0, 0), dtype=np.float32)
        return stacked, failed_indices

    def pairwise_diff(self, features):
        count = int(features.shape[0])
        matrix = np.asarray(self.diff_matrix, dtype=np.float32)
        assert matrix.shape == (count, count), (
            f"test wiring error: diff matrix {matrix.shape} vs {count} extracted features"
        )
        return matrix


class BlockingCcip(FakeCcip):
    """Holds extract_features until released so tests can observe a live job."""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.started = threading.Event()
        self.release = threading.Event()

    def extract_features(self, paths, progress_callback=None, cancel_event=None):
        self.started.set()
        assert self.release.wait(timeout=5.0), "test never released the blocking job"
        if cancel_event is not None and cancel_event.is_set():
            raise ccip.CCIPCancelled()
        return super().extract_features(
            paths, progress_callback=progress_callback, cancel_event=cancel_event
        )


@pytest.fixture(autouse=True)
def _reset_purity_job_state():
    purity_service._reset_job_state_for_tests()
    yield
    purity_service._reset_job_state_for_tests()


@pytest.fixture
def purity_images(test_db, tmp_path: Path):
    """Three readable DB-backed image rows (contents never decoded — stubbed)."""
    import database as db

    image_ids = []
    for name in ("alpha.png", "beta.png", "gamma.png"):
        path = tmp_path / name
        path.write_bytes(b"fake image bytes")
        image_ids.append(db.add_image(path=str(path), filename=name))
    return {"image_ids": image_ids, "dir": tmp_path}


def _install_fake(monkeypatch, fake):
    monkeypatch.setattr(purity_service, "_get_ccip", lambda: fake)
    return fake


def _wait_for_job(test_client, job_id: str, timeout: float = 5.0):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        response = test_client.get(
            f"/api/dataset/character-purity/progress?job_id={job_id}"
        )
        assert response.status_code == 200
        last = response.json()
        if last["status"] in {"done", "failed", "cancelled"}:
            return last
        time.sleep(0.02)
    pytest.fail(f"character-purity job did not finish in time; last progress={last}")


# Row sums 0.45 / 0.47 / 0.82 -> medoid is index 0; only index 2 (0.40)
# exceeds the default 0.178 threshold.
DIFFS_3 = [
    [0.0, 0.05, 0.40],
    [0.05, 0.0, 0.42],
    [0.40, 0.42, 0.0],
]


# ------------------------------- medoid math -------------------------------


def test_medoid_from_diffs_picks_min_total_distance_and_flags_outliers():
    result = ccip.medoid_from_diffs(np.asarray(DIFFS_3), threshold=0.178)

    assert result["medoid_index"] == 0
    assert result["distances"] == pytest.approx([0.0, 0.05, 0.40])
    assert result["outlier_flags"] == [False, False, True]
    assert result["threshold"] == pytest.approx(0.178)


def test_medoid_from_diffs_threshold_moves_outlier_boundary():
    result = ccip.medoid_from_diffs(np.asarray(DIFFS_3), threshold=0.5)
    assert result["outlier_flags"] == [False, False, False]

    result = ccip.medoid_from_diffs(np.asarray(DIFFS_3), threshold=0.01)
    assert result["outlier_flags"] == [False, True, True]


def test_medoid_from_diffs_single_image_is_its_own_medoid():
    result = ccip.medoid_from_diffs(np.zeros((1, 1)), threshold=0.178)
    assert result["medoid_index"] == 0
    assert result["outlier_flags"] == [False]


def test_medoid_from_diffs_rejects_non_square_input():
    with pytest.raises(ValueError):
        ccip.medoid_from_diffs(np.zeros((2, 3)))
    with pytest.raises(ValueError):
        ccip.medoid_from_diffs(np.zeros((0, 0)))


# ------------------------------- validation --------------------------------


def test_start_with_empty_ids_returns_400_error_body(test_client, monkeypatch):
    _install_fake(monkeypatch, FakeCcip(diff_matrix=DIFFS_3))

    response = test_client.post("/api/dataset/character-purity", json={"image_ids": []})

    assert response.status_code == 400
    body = response.json()
    assert isinstance(body.get("error"), str) and body["error"]


def test_start_with_fewer_than_two_ids_returns_400(test_client, monkeypatch):
    _install_fake(monkeypatch, FakeCcip(diff_matrix=DIFFS_3))

    response = test_client.post(
        "/api/dataset/character-purity", json={"image_ids": [7]}
    )

    assert response.status_code == 400
    assert "2" in response.json()["error"]


def test_start_when_model_missing_returns_400(test_client, monkeypatch):
    _install_fake(monkeypatch, FakeCcip(diff_matrix=DIFFS_3, available=False))

    response = test_client.post(
        "/api/dataset/character-purity", json={"image_ids": [1, 2]}
    )

    assert response.status_code == 400
    assert "model" in response.json()["error"].lower()


def test_start_with_out_of_range_threshold_returns_400(test_client, monkeypatch):
    _install_fake(monkeypatch, FakeCcip(diff_matrix=DIFFS_3))

    response = test_client.post(
        "/api/dataset/character-purity",
        json={"image_ids": [1, 2], "threshold": 2.0},
    )

    assert response.status_code == 400


def test_progress_with_unknown_job_id_returns_404(test_client):
    response = test_client.get("/api/dataset/character-purity/progress?job_id=nope")
    # Idle store has job_id None -> matches any poll; run a job id mismatch
    # by seeding a fake finished job first.
    assert response.status_code == 200

    purity_service._JOB_PROGRESS["job_id"] = "someone-else"
    response = test_client.get("/api/dataset/character-purity/progress?job_id=nope")
    assert response.status_code == 404


# ----------------------------- model status --------------------------------


def test_status_reports_missing_files_and_threshold(test_client, monkeypatch):
    fake = _install_fake(monkeypatch, FakeCcip(diff_matrix=DIFFS_3, available=False))

    response = test_client.get("/api/dataset/character-purity/status")

    assert response.status_code == 200
    body = response.json()
    assert body["available"] is False
    assert body["missing_files"] == list(ccip.CCIP_MODEL_FILES)
    assert body["model_dir"] == str(fake.model_dir)
    assert body["default_threshold"] == pytest.approx(ccip.DEFAULT_THRESHOLD)
    assert body["preparing"] is False
    assert body["prepare_error"] is None
    assert set(body["download"]) == {"active", "filename", "downloaded", "total"}


def test_prepare_returns_ready_when_model_present(test_client, monkeypatch):
    _install_fake(monkeypatch, FakeCcip(diff_matrix=DIFFS_3, available=True))

    response = test_client.post("/api/dataset/character-purity/prepare")

    assert response.status_code == 200
    assert response.json()["status"] == "ready"


# ------------------------------ job lifecycle -------------------------------


def test_job_lifecycle_start_progress_done_shape(
    test_client, monkeypatch, purity_images
):
    _install_fake(monkeypatch, FakeCcip(diff_matrix=DIFFS_3))
    ids = purity_images["image_ids"]

    response = test_client.post(
        "/api/dataset/character-purity", json={"image_ids": ids}
    )
    assert response.status_code == 200
    started = response.json()
    assert started["status"] == "started"
    assert started["total"] == 3
    assert started["job_id"]

    progress = _wait_for_job(test_client, started["job_id"])
    assert progress["status"] == "done"
    assert progress["extracted"] == 3
    assert progress["failed"] == 0

    result = progress["result"]
    assert set(result) == {
        "medoid_image_id",
        "items",
        "threshold",
        "extracted",
        "failed",
    }
    assert result["medoid_image_id"] == ids[0]
    assert result["threshold"] == pytest.approx(ccip.DEFAULT_THRESHOLD)
    assert result["extracted"] == 3
    assert result["failed"] == 0

    # Items ranked worst-first, each with the pinned sub-shape.
    assert [item["image_id"] for item in result["items"]] == [ids[2], ids[1], ids[0]]
    assert [item["outlier"] for item in result["items"]] == [True, False, False]
    for item in result["items"]:
        assert set(item) == {"image_id", "distance", "outlier"}
    assert result["items"][0]["distance"] == pytest.approx(0.40)


def test_job_custom_threshold_reflags_outliers(test_client, monkeypatch, purity_images):
    _install_fake(monkeypatch, FakeCcip(diff_matrix=DIFFS_3))
    ids = purity_images["image_ids"]

    response = test_client.post(
        "/api/dataset/character-purity",
        json={"image_ids": ids, "threshold": 0.5},
    )
    assert response.status_code == 200

    progress = _wait_for_job(test_client, response.json()["job_id"])
    assert progress["status"] == "done"
    assert progress["result"]["threshold"] == pytest.approx(0.5)
    assert all(item["outlier"] is False for item in progress["result"]["items"])


def test_missing_and_unreadable_images_count_as_failed(
    test_client, monkeypatch, purity_images
):
    ids = purity_images["image_ids"]
    unreadable_path = str(purity_images["dir"] / "gamma.png")
    # gamma.png resolves from the DB but fails feature extraction; id 999999
    # does not exist in the DB at all. Both must count in ``failed`` and the
    # job must still complete on the remaining two images.
    diffs_2 = [[0.0, 0.05], [0.05, 0.0]]
    _install_fake(
        monkeypatch, FakeCcip(diff_matrix=diffs_2, failed_paths={unreadable_path})
    )

    response = test_client.post(
        "/api/dataset/character-purity",
        json={"image_ids": ids + [999999]},
    )
    assert response.status_code == 200

    progress = _wait_for_job(test_client, response.json()["job_id"])
    assert progress["status"] == "done"
    result = progress["result"]
    assert result["failed"] == 2
    assert result["extracted"] == 2
    assert {item["image_id"] for item in result["items"]} == set(ids[:2])


def test_job_fails_cleanly_when_fewer_than_two_images_survive(
    test_client, monkeypatch, purity_images
):
    ids = purity_images["image_ids"]
    failed_paths = {
        str(purity_images["dir"] / name) for name in ("beta.png", "gamma.png")
    }
    _install_fake(monkeypatch, FakeCcip(diff_matrix=[[0.0]], failed_paths=failed_paths))

    response = test_client.post(
        "/api/dataset/character-purity", json={"image_ids": ids}
    )
    assert response.status_code == 200

    progress = _wait_for_job(test_client, response.json()["job_id"])
    assert progress["status"] == "failed"
    assert progress["failed"] == 2
    assert progress["result"] is None


def test_second_start_conflicts_then_cancel_terminates(
    test_client, monkeypatch, purity_images
):
    fake = _install_fake(monkeypatch, BlockingCcip(diff_matrix=DIFFS_3))
    ids = purity_images["image_ids"]

    first = test_client.post("/api/dataset/character-purity", json={"image_ids": ids})
    assert first.status_code == 200
    job_id = first.json()["job_id"]
    assert fake.started.wait(timeout=5.0), "worker never reached extraction"

    second = test_client.post("/api/dataset/character-purity", json={"image_ids": ids})
    assert second.status_code == 409

    cancel = test_client.post(
        "/api/dataset/character-purity/cancel", json={"job_id": job_id}
    )
    assert cancel.status_code == 200
    assert cancel.json()["status"] == "cancelling"

    fake.release.set()
    progress = _wait_for_job(test_client, job_id)
    assert progress["status"] == "cancelled"

    # Job store is reusable after a cancelled run.
    idle_cancel = test_client.post("/api/dataset/character-purity/cancel", json={})
    assert idle_cancel.status_code == 200
    assert idle_cancel.json()["status"] == "cancelled"
