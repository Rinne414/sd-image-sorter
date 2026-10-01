"""Move and batch-move progress carry a message_key so the UI can localise it.

The bilingual ``message`` stays for API compatibility; the counters the UI
needs (``current`` / ``total`` / ``moved`` / ``errors`` / ``operation``) are
already progress fields.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import BackgroundTasks

import services.sorting_service as ss


@pytest.fixture
def svc(tmp_path, monkeypatch):
    monkeypatch.setattr(
        ss, "SESSION_FILE", str(tmp_path / "session.json"), raising=False
    )
    monkeypatch.setattr(
        ss, "LEGACY_SESSION_FILE", str(tmp_path / "legacy.json"), raising=False
    )
    return ss.SortingService()


def _image(test_db, tmp_path: Path, name: str = "a.png") -> int:
    from PIL import Image

    library = tmp_path / "library"
    library.mkdir(exist_ok=True)
    path = library / name
    Image.new("RGB", (16, 16), color="green").save(path)
    return test_db.add_image(
        path=str(path), filename=name, generator="unknown", metadata_json="{}"
    )


def _batch(svc, tmp_path, **overrides):
    tasks = BackgroundTasks()
    started = svc.batch_move_images(
        ss.BatchMoveRequest(
            destination_folder=str(tmp_path / "out"),
            generators=["unknown"],
            **overrides,
        ),
        tasks,
    )
    return started, tasks


def test_idle_states_have_an_empty_key(svc):
    assert svc.get_batch_move_progress()["message_key"] == ""
    assert svc.get_move_progress()["message_key"] == ""


def test_batch_move_start_and_done_have_keys(test_db, tmp_path, svc):
    _image(test_db, tmp_path)

    started, tasks = _batch(svc, tmp_path)
    assert started["message_key"] == "started"
    assert svc.get_batch_move_progress()["message_key"] == "starting"

    tasks.tasks[0].func()
    progress = svc.get_batch_move_progress()

    assert progress["status"] == "done"
    assert progress["message_key"] == "done"
    assert progress["moved"] == 1
    assert progress["operation"] == "move"


def test_batch_move_with_no_match_has_the_no_images_key(test_db, tmp_path, svc):
    started, tasks = _batch(svc, tmp_path)

    assert started["message_key"] == "no_images"
    assert tasks.tasks == []


def test_batch_move_internal_error_has_the_error_key(
    test_db, tmp_path, svc, monkeypatch
):
    _image(test_db, tmp_path)

    def refuse(*args, **kwargs):
        raise OSError("destination is gone")

    monkeypatch.setattr("services.sorting.batch_move.os.makedirs", refuse)

    _started, tasks = _batch(svc, tmp_path)
    tasks.tasks[0].func()
    progress = svc.get_batch_move_progress()

    assert progress["status"] == "error"
    assert progress["message_key"] == "error"


def test_batch_move_cancelling_has_a_key(svc):
    svc._batch_move_progress.update(
        {"status": "running", "current": 1, "total": 4, "operation": "copy"}
    )

    result = svc.cancel_batch_move()

    assert result["status"] == "cancelling"
    assert svc.get_batch_move_progress()["message_key"] == "cancelling"


def test_move_job_start_progress_and_done_have_keys(test_db, tmp_path, svc):
    image_id = _image(test_db, tmp_path)
    tasks = BackgroundTasks()

    started = svc.start_move_job(
        ss.MoveRequest(image_ids=[image_id], destination_folder=str(tmp_path / "out")),
        tasks,
    )
    assert started["message_key"] == "started"
    assert svc.get_move_progress()["message_key"] == "starting"

    tasks.tasks[0].func()
    progress = svc.get_move_progress()

    assert progress["status"] == "done"
    assert progress["message_key"] == "done"
    assert progress["moved"] == 1


def test_move_job_cancelling_has_a_key(svc):
    svc._move_progress.update(
        {"status": "running", "current": 1, "total": 4, "operation": "move"}
    )

    result = svc.cancel_move()

    assert result["status"] == "cancelling"
    assert svc.get_move_progress()["message_key"] == "cancelling"
