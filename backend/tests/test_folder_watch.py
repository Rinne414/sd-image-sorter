"""Folder watching: a watched library root indexes new pictures without a Scan.

Covers the per-root switch (migration 063), importing only the given files,
the watcher end to end on a real folder (catch-up of files already there,
then a new picture arriving, and a half-written PNG waiting until it is
complete), and the two endpoints.
"""

from __future__ import annotations

import time
from pathlib import Path

import pytest
from PIL import Image

import database as db
from image_manager import scan_folder
from services.folder_watch import FolderWatchService, png_is_complete

WAIT_SECONDS = 30


def _png(path: Path, shade: int = 0) -> Path:
    Image.new("RGB", (8, 8), (shade % 255, 40, 80)).save(path)
    return path


def _indexed(paths) -> set[str]:
    rows = db.get_image_scan_state_by_paths([str(p) for p in paths])
    return {Path(key).name for key in rows}


def _states(service: FolderWatchService) -> list[str]:
    return [root["state"] for root in service.status()["roots"]]


def _wait_until(predicate, timeout: float = WAIT_SECONDS) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.2)
    return predicate()


def test_new_root_is_not_watched_and_the_switch_flips(test_db, tmp_path):
    root = db.add_library_root(str(tmp_path))

    assert root["watch"] == 0
    assert db.list_watched_library_roots() == []

    assert db.set_library_root_watch(root["id"], True) is True
    assert [r["id"] for r in db.list_watched_library_roots()] == [root["id"]]

    db.set_library_root_enabled(root["id"], False)
    assert db.list_watched_library_roots() == []


def test_only_paths_imports_just_the_given_pictures(test_db, tmp_path):
    wanted = _png(tmp_path / "wanted.png", 1)
    other = _png(tmp_path / "other.png", 2)
    (tmp_path / "notes.txt").write_text("not a picture", encoding="utf-8")

    result = scan_folder(
        str(tmp_path),
        quick_import=True,
        precise_total=False,
        only_paths=[
            str(wanted),
            str(tmp_path / "notes.txt"),
            str(tmp_path / "gone.png"),
        ],
    )

    assert result["new"] == 1
    assert _indexed([wanted, other]) == {"wanted.png"}


def test_png_without_its_last_chunk_is_not_complete(tmp_path):
    whole = _png(tmp_path / "whole.png")
    half = tmp_path / "half.png"
    half.write_bytes(whole.read_bytes()[:-12])

    assert png_is_complete(str(whole)) is True
    assert png_is_complete(str(half)) is False


@pytest.fixture
def watcher(test_db, tmp_path):
    service = FolderWatchService(
        force_polling=True,
        poll_delay_ms=100,
        debounce_ms=200,
        stable_seconds=0.3,
        retry_seconds=1.0,
    )
    yield service
    service.stop()


def test_watched_root_catches_up_then_imports_new_pictures(watcher, tmp_path):
    folder = tmp_path / "output"
    folder.mkdir()
    before = _png(folder / "before.png", 3)
    root = db.add_library_root(str(folder))
    db.set_library_root_watch(root["id"], True)

    watcher.start()
    assert _wait_until(lambda: _indexed([before]) == {"before.png"})

    nested = folder / "2026-10-23"
    nested.mkdir()
    after = _png(nested / "after.png", 4)
    assert _wait_until(lambda: _indexed([after]) == {"after.png"})

    # A row is visible as soon as its placeholder is written; the counters
    # move when the import batch finishes, and both files may share one.
    assert _wait_until(lambda: watcher.status()["roots"][0]["imported"] >= 2)
    status = watcher.status()
    assert status["running"] is True
    assert status["generation"] >= 1
    [root_status] = status["roots"]
    assert root_status["mode"] == "polling"
    assert root_status["state"] == "watching"
    assert root_status["imported"] >= 2


def test_half_written_png_waits_until_complete(watcher, tmp_path):
    folder = tmp_path / "output"
    folder.mkdir()
    root = db.add_library_root(str(folder))
    db.set_library_root_watch(root["id"], True)
    watcher.start()
    assert _wait_until(lambda: _states(watcher) == ["watching"])

    data = _png(tmp_path / "source.png", 5).read_bytes()
    target = folder / "slow.png"
    target.write_bytes(data[:-12])
    time.sleep(2.0)
    assert _indexed([target]) == set()

    with open(target, "ab") as handle:
        handle.write(data[-12:])
    assert _wait_until(lambda: _indexed([target]) == {"slow.png"})


def test_turning_watch_off_stops_the_worker(watcher, tmp_path):
    folder = tmp_path / "output"
    folder.mkdir()
    root = db.add_library_root(str(folder))
    db.set_library_root_watch(root["id"], True)
    watcher.start()
    assert _wait_until(lambda: len(watcher.status()["roots"]) == 1)

    db.set_library_root_watch(root["id"], False)
    watcher.reload()

    assert _wait_until(lambda: watcher.status()["roots"] == [])


def test_watch_endpoints(test_client, tmp_path):
    root = db.add_library_root(str(tmp_path))

    missing = test_client.patch("/api/library-roots/999999/watch", json={"watch": True})
    assert missing.status_code == 404

    response = test_client.patch(
        f"/api/library-roots/{root['id']}/watch", json={"watch": True}
    )
    assert response.status_code == 200
    assert response.json()["watch"] == 1

    listed = test_client.get("/api/library-roots").json()["roots"]
    assert [r["watch"] for r in listed if r["id"] == root["id"]] == [1]

    status = test_client.get("/api/watch/status").json()
    assert set(status) == {"running", "paused", "generation", "roots"}


def test_only_paths_refuses_files_outside_the_folder(test_db, tmp_path):
    folder = tmp_path / "output"
    folder.mkdir()
    elsewhere = _png(tmp_path / "elsewhere.png", 6)

    result = scan_folder(
        str(folder), quick_import=True, precise_total=False, only_paths=[str(elsewhere)]
    )

    assert result["new"] == 0
    assert _indexed([elsewhere]) == set()


def test_folder_that_disappears_shows_missing_then_resumes(watcher, tmp_path):
    folder = tmp_path / "output"
    folder.mkdir()
    root = db.add_library_root(str(folder))
    db.set_library_root_watch(root["id"], True)
    watcher.start()
    assert _wait_until(lambda: _states(watcher) == ["watching"])

    parked = tmp_path / "parked"
    folder.rename(parked)
    assert _wait_until(lambda: _states(watcher) == ["missing"], timeout=10)

    parked.rename(folder)
    back = _png(folder / "back.png", 7)
    assert _wait_until(lambda: _indexed([back]) == {"back.png"}, timeout=60)
