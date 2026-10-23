"""Backend pieces the desktop shell (desktop/) relies on.

- Pause / resume all folder watching (tray menu): workers stop, the per-folder
  switches stay, and resuming adds what was written while paused.
- Quick collect: dropped pictures are copied into ``<output root>/collected``,
  indexed there, and files that are not pictures are named as skipped.
- The lifeline: the server stops when the shell process that started it ends.
"""

from __future__ import annotations

import subprocess
import sys
import threading
import time
from io import BytesIO
from pathlib import Path

import pytest
from PIL import Image

import database as db
import desktop_lifeline
from services.folder_watch import FolderWatchService

WAIT_SECONDS = 30


def _png_bytes(shade: int) -> bytes:
    buffer = BytesIO()
    Image.new("RGB", (8, 8), (shade % 255, 60, 90)).save(buffer, format="PNG")
    return buffer.getvalue()


def _indexed(paths) -> set[str]:
    rows = db.get_image_scan_state_by_paths([str(p) for p in paths])
    return {Path(key).name for key in rows}


def _wait_until(predicate, timeout: float = WAIT_SECONDS) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.2)
    return predicate()


@pytest.fixture
def watcher(test_db):
    service = FolderWatchService(
        force_polling=True,
        poll_delay_ms=100,
        debounce_ms=200,
        stable_seconds=0.3,
        retry_seconds=1.0,
    )
    yield service
    service.stop()


def test_pause_stops_every_folder_and_resume_adds_what_arrived(watcher, tmp_path):
    folder = tmp_path / "output"
    folder.mkdir()
    root = db.add_library_root(str(folder))
    db.set_library_root_watch(root["id"], True)
    watcher.start()
    assert _wait_until(lambda: len(watcher.status()["roots"]) == 1)

    watcher.set_paused(True)
    assert _wait_until(lambda: watcher.status()["roots"] == [])
    assert watcher.status()["paused"] is True
    # The folder's own switch is untouched by a pause.
    assert [r["id"] for r in db.list_watched_library_roots()] == [root["id"]]

    during = folder / "during.png"
    during.write_bytes(_png_bytes(1))
    time.sleep(1.5)
    assert _indexed([during]) == set()

    watcher.set_paused(False)
    assert watcher.status()["paused"] is False
    assert _wait_until(lambda: _indexed([during]) == {"during.png"})


def test_pause_endpoint_round_trip(test_client):
    paused = test_client.post("/api/watch/pause", json={"paused": True})
    assert paused.status_code == 200
    assert paused.json()["paused"] is True
    assert test_client.get("/api/watch/status").json()["paused"] is True

    resumed = test_client.post("/api/watch/pause", json={"paused": False})
    assert resumed.status_code == 200
    assert resumed.json()["paused"] is False

    bad = test_client.post("/api/watch/pause", json={})
    assert bad.status_code == 400


def test_quick_collect_copies_into_output_collected(test_client, test_db, tmp_path):
    custom = tmp_path / "my outputs"
    assert (
        test_client.patch("/api/output-folders", json={"root": str(custom)}).status_code
        == 200
    )

    response = test_client.post(
        "/api/import-files?destination=collected",
        files=[
            ("files", ("dropped.png", _png_bytes(2), "image/png")),
            ("files", ("notes.txt", b"not a picture", "text/plain")),
        ],
    )

    assert response.status_code == 200, response.text
    body = response.json()
    saved = Path(body["saved"][0])
    assert saved.parent == (custom / "collected").resolve()
    assert saved.read_bytes() == _png_bytes(2)
    assert Path(body["folder"]) == (custom / "collected").resolve()
    assert body["imported"] == 1
    assert body["skipped"] == ["notes.txt"]
    assert len(body["image_ids"]) == 1
    assert _indexed([saved]) == {"dropped.png"}

    again = test_client.post(
        "/api/import-files?destination=collected",
        files=[("files", ("dropped.png", _png_bytes(3), "image/png"))],
    ).json()
    assert Path(again["saved"][0]).name == "dropped_2.png"


def test_import_without_destination_still_uses_the_data_folder(test_client, test_db):
    response = test_client.post(
        "/api/import-files",
        files=[("files", ("plain.png", _png_bytes(4), "image/png"))],
    )
    assert response.status_code == 200, response.text
    assert Path(response.json()["folder"]).name == "imports"


def test_unknown_destination_is_refused(test_client):
    response = test_client.post(
        "/api/import-files?destination=../../elsewhere",
        files=[("files", ("x.png", _png_bytes(5), "image/png"))],
    )
    assert response.status_code == 400


def test_lifeline_fires_when_the_shell_process_ends():
    shell = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    gone = threading.Event()
    thread = desktop_lifeline.watch_parent(shell.pid, gone.set, poll_seconds=0.1)

    time.sleep(0.5)
    assert not gone.is_set()

    shell.kill()
    shell.wait(10)
    assert gone.wait(10)
    thread.join(5)


def test_lifeline_fires_at_once_for_a_shell_that_is_already_gone():
    shell = subprocess.Popen([sys.executable, "-c", "pass"])
    shell.wait(10)
    gone = threading.Event()
    desktop_lifeline.watch_parent(shell.pid, gone.set, poll_seconds=0.1)
    assert gone.wait(10)


def test_lifeline_is_off_unless_the_shell_asks():
    called = []
    assert desktop_lifeline.start_if_requested(lambda: called.append(1), environ={}) is None
    assert desktop_lifeline.parent_pid_from({"SD_IMAGE_SORTER_PARENT_PID": "1234"}) == 1234
    assert desktop_lifeline.parent_pid_from({"SD_IMAGE_SORTER_PARENT_PID": "abc"}) is None
    assert desktop_lifeline.parent_pid_from({"SD_IMAGE_SORTER_PARENT_PID": "0"}) is None
    assert called == []
