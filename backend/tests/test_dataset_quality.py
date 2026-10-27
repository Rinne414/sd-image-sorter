"""Blur / flat-colour hints: the scoring job, its cache and the endpoint."""

from __future__ import annotations

import os
from pathlib import Path
import random
import time

import pytest
from PIL import Image, ImageDraw, ImageFilter

from services import image_quality_service as quality
from services.bulk_job_service import (
    JOB_KIND_IMAGE_QUALITY,
    BulkJobService,
    get_bulk_job_service,
)
from services.image_quality_scores import SCORES_VERSION


def _busy(seed: int) -> Image.Image:
    rng = random.Random(seed)
    img = Image.new("RGB", (640, 640), (90, 120, 160))
    draw = ImageDraw.Draw(img)
    for _ in range(120):
        x, y = rng.randrange(640), rng.randrange(640)
        draw.rectangle(
            [x, y, x + rng.randrange(8, 120), y + rng.randrange(8, 120)],
            fill=tuple(rng.randrange(256) for _ in range(3)),
            outline=(0, 0, 0),
        )
    return img


@pytest.fixture
def pictures(tmp_path):
    folder = tmp_path / "pics"
    folder.mkdir()
    _busy(1).save(folder / "sharp.png")
    _busy(2).filter(ImageFilter.GaussianBlur(10)).save(folder / "soft.png")
    Image.new("RGB", (640, 640), (200, 120, 40)).save(folder / "flat.png")
    (folder / "broken.png").write_bytes(b"nope")
    return folder


@pytest.fixture
def cache(tmp_path):
    return quality.QualityCache(tmp_path / "quality.sqlite3")


@pytest.fixture(autouse=True)
def private_cache_folder(tmp_path, monkeypatch):
    """The endpoint tests keep their cache out of the real data folder."""
    monkeypatch.setattr("config.DEFAULT_CACHE_DIR", str(tmp_path / "cache"))


def _paths(folder):
    return [
        str(folder / n) for n in ("sharp.png", "soft.png", "flat.png", "broken.png")
    ]


def _run_job(pending, cache):
    service = BulkJobService()
    job_id = service.create_job(JOB_KIND_IMAGE_QUALITY, total=len(pending))
    service.run_job(
        job_id, lambda handle: quality.run_scoring_job(handle, pending, cache)
    )
    return service.get_job(job_id)


def test_job_scores_pending_pictures_and_the_cache_remembers_them(pictures, cache):
    targets, gone = quality.resolve_targets([], _paths(pictures))
    assert gone == 0
    first = quality.tally(targets, cache)
    assert len(first.pending) == 4 and not first.scored

    job = _run_job(first.pending, cache)

    assert job["status"] == "done"
    assert job["processed"] == 4
    assert job["result"] == {"scored": 3, "unreadable": 1}
    second = quality.tally(targets, cache)
    assert second.pending == [] and len(second.scored) == 3 and second.unreadable == 1
    flags = {
        os.path.basename(i["abs_path"]): i["flags"]
        for i in quality.flagged_items(second.scored)
    }
    assert flags == {"soft.png": ["blurry"], "flat.png": ["flat"]}


def test_a_changed_file_or_a_new_scoring_version_is_scored_again(
    pictures, cache, monkeypatch
):
    target_path = str(pictures / "sharp.png")
    targets, _ = quality.resolve_targets([], [target_path])
    _run_job(quality.tally(targets, cache).pending, cache)
    assert quality.tally(targets, cache).pending == []

    _busy(9).filter(ImageFilter.GaussianBlur(10)).save(target_path)
    later = time.time_ns() + 5_000_000_000
    os.utime(target_path, ns=(later, later))
    changed, _ = quality.resolve_targets([], [target_path])
    assert len(quality.tally(changed, cache).pending) == 1

    monkeypatch.setattr(
        "services.image_quality_service.SCORES_VERSION", SCORES_VERSION + 1
    )
    assert len(quality.tally(targets, cache).pending) == 1


def test_cancelling_stops_the_job_before_it_scores_anything(pictures, cache):
    targets, _ = quality.resolve_targets([], _paths(pictures))
    service = BulkJobService()
    job_id = service.create_job(JOB_KIND_IMAGE_QUALITY, total=4)

    def worker(handle):
        service.cancel_job(job_id)
        quality.run_scoring_job(handle, targets, cache)

    service.run_job(job_id, worker)

    assert service.get_job(job_id)["status"] == "cancelled"
    assert quality.tally(targets, cache).scored == {}


def test_the_cache_file_may_be_deleted_while_the_app_runs(pictures, cache):
    targets, _ = quality.resolve_targets([], _paths(pictures))
    _run_job(quality.tally(targets, cache).pending, cache)
    assert len(quality.tally(targets, cache).scored) == 3

    cache.path.unlink()

    again = quality.tally(targets, cache)
    assert len(again.pending) == 4 and not again.scored
    _run_job(again.pending, cache)
    assert len(quality.tally(targets, cache).scored) == 3


def test_missing_files_are_counted_not_scored(pictures, cache):
    targets, gone = quality.resolve_targets(
        [], [str(pictures / "gone.png"), str(pictures / "flat.png")]
    )

    state = quality.tally(targets, cache, gone=gone)

    assert (state.total, state.missing, len(state.pending)) == (2, 1, 1)


def test_endpoint_scores_in_the_background_then_lists_what_to_review(
    test_client, pictures
):
    import database as db

    ids = [
        db.add_image(path=str(pictures / name), filename=name)
        for name in ("sharp.png", "soft.png", "flat.png")
    ]

    first = test_client.post("/api/dataset/quality", json={"image_ids": ids})

    assert first.status_code == 200
    body = first.json()
    # TestClient runs the background task before it returns, so the job is done.
    job = test_client.get(f"/api/bulk-jobs/{body['job_id']}").json()
    assert body["started"] is True and body["pending"] == 3 and body["items"] == []
    assert job["status"] == "done" and job["processed"] == 3

    again = test_client.post(
        "/api/dataset/quality", json={"image_ids": ids, "start": False}
    ).json()
    assert (again["scored"], again["pending"], again["job_id"], again["started"]) == (
        3,
        0,
        None,
        False,
    )
    by_name = {os.path.basename(i["abs_path"]): i for i in again["items"]}
    assert set(by_name) == {"soft.png", "flat.png"}
    assert by_name["soft.png"]["flags"] == ["blurry"]
    assert by_name["soft.png"]["image_id"] == ids[1]
    assert by_name["flat.png"]["flags"] == ["flat"]
    assert again["thresholds"] == {"blur_below": 50.0, "flat_above": 0.92}

    strict = test_client.post(
        "/api/dataset/quality",
        json={"image_ids": ids, "start": False, "blur_below": 100000},
    ).json()
    assert {os.path.basename(i["abs_path"]) for i in strict["items"]} == {
        "sharp.png",
        "soft.png",
        "flat.png",
    }


def test_endpoint_reads_folder_paths_and_starts_no_job_when_told_not_to(
    test_client, pictures
):
    paths = [
        str(pictures / "flat.png"),
        str(pictures / "broken.png"),
        str(pictures / "nope.png"),
    ]

    quiet = test_client.post(
        "/api/dataset/quality", json={"image_paths": paths, "start": False}
    ).json()
    assert (quiet["total"], quiet["pending"], quiet["missing"], quiet["job_id"]) == (
        3,
        2,
        1,
        None,
    )

    started = test_client.post(
        "/api/dataset/quality", json={"image_paths": paths}
    ).json()
    assert started["started"] is True
    final = test_client.post(
        "/api/dataset/quality", json={"image_paths": paths, "start": False}
    ).json()
    assert (final["scored"], final["unreadable"], final["pending"]) == (1, 1, 0)
    assert final["items"][0]["image_id"] == 0
    assert final["items"][0]["flags"] == ["flat"]


def test_endpoint_refuses_an_empty_request(test_client):
    assert test_client.post("/api/dataset/quality", json={}).status_code == 400


def test_a_folder_import_sent_by_its_scan_is_scored(test_client, pictures, tmp_path, monkeypatch):
    """A large folder import reaches the check as its scan, not its paths.

    3.9.0 took only ids and paths, so the Quality Audit never scored pictures
    imported from a folder and said nothing about it.
    """
    import services.dataset_session_service as dataset_session_service

    scan_dir = tmp_path / "scan-manifests"
    scan_dir.mkdir()
    monkeypatch.setattr(dataset_session_service, "_SCAN_DIR", scan_dir)
    scan = dataset_session_service.scan_folder_for_dataset(
        str(pictures), recursive=False, limit=1
    )
    source = {"scan_token": scan["scan_token"], "exclude_paths": [str(pictures / "sharp.png")]}

    started = test_client.post(
        "/api/dataset/quality", json={"dataset_scan_tokens": [source]}
    ).json()
    # Four files in the folder, one taken out of the dataset (broken.png is
    # not listed by the scan: it is not a readable picture).
    assert started["total"] + started["missing"] >= 2
    assert started["started"] is True
    final = test_client.post(
        "/api/dataset/quality", json={"dataset_scan_tokens": [source], "start": False}
    ).json()
    assert final["pending"] == 0
    flagged = {Path(item["abs_path"]).name: item["flags"] for item in final["items"]}
    assert flagged.get("flat.png") == ["flat"]
    assert "blurry" in flagged.get("soft.png", [])
    assert "sharp.png" not in flagged


def test_an_unknown_scan_is_refused_in_words(test_client):
    reply = test_client.post(
        "/api/dataset/quality",
        json={"dataset_scan_tokens": [{"scan_token": "no-such-scan", "exclude_paths": []}]},
    )
    assert reply.status_code == 400
    assert "scan token" in reply.text


def test_a_second_request_joins_the_running_job(test_client, pictures):
    service = get_bulk_job_service()
    running = service.create_job(JOB_KIND_IMAGE_QUALITY, total=5)
    service._jobs[running].status = "running"  # a job that has not finished
    try:
        reply = test_client.post(
            "/api/dataset/quality", json={"image_paths": [str(pictures / "flat.png")]}
        ).json()
        assert (reply["started"], reply["job_id"]) == (False, running)
    finally:
        service._jobs[running].status = "done"
