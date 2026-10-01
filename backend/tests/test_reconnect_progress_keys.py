"""Reconnect progress carries a message_key and counts so the UI can localise it."""

from pathlib import Path

from PIL import Image


class ImmediateBackgroundTasks:
    def add_task(self, func, *args, **kwargs):
        func(*args, **kwargs)


class DeferredBackgroundTasks:
    def __init__(self):
        self.tasks = []

    def add_task(self, func, *args, **kwargs):
        self.tasks.append((func, args, kwargs))


def _request(folder: Path):
    from routers.images import ReconnectMissingFilesRequest

    return ReconnectMissingFilesRequest(search_folder=str(folder), recursive=True)


def test_idle_progress_has_empty_message_key():
    from services.image_service import ImageService

    assert ImageService()._build_default_reconnect_progress_state()["message_key"] == ""


def test_start_state_has_starting_key(test_db, tmp_path):
    from services.image_service import ImageService

    service = ImageService()
    service.start_reconnect_missing_files(_request(tmp_path), DeferredBackgroundTasks())
    progress = service.get_reconnect_progress()

    assert progress["message_key"] == "starting"
    assert progress["message"]


def test_done_state_has_key_and_counts(test_db, tmp_path):
    from services.image_service import ImageService

    found = tmp_path / "new" / "k.png"
    found.parent.mkdir(parents=True)
    Image.new("RGB", (8, 8), color="white").save(found)
    stat = found.stat()
    test_db.add_image(
        path=str(tmp_path / "old" / "k.png"),
        filename="k.png",
        metadata_json="{}",
        file_size=stat.st_size,
        source_size=stat.st_size,
        source_mtime_ns=stat.st_mtime_ns,
    )
    service = ImageService()
    service.start_reconnect_missing_files(
        _request(found.parent), ImmediateBackgroundTasks()
    )
    progress = service.get_reconnect_progress()

    assert progress["status"] == "done"
    assert progress["message_key"] == "done"
    assert progress["matched"] == 1
    assert progress["still_missing"] == 0
    assert progress["message"].startswith("Reconnected 1 missing files.")


def test_cancelled_state_has_key(test_db, tmp_path, monkeypatch):
    from services.image_service import ImageService

    service = ImageService()

    def interrupted(*args, **kwargs):
        raise InterruptedError

    monkeypatch.setattr(service, "reconnect_missing_files_once", interrupted)
    service.start_reconnect_missing_files(
        _request(tmp_path), ImmediateBackgroundTasks()
    )
    progress = service.get_reconnect_progress()

    assert progress["status"] == "cancelled"
    assert progress["message_key"] == "cancelled"
    assert "checked_files" in progress


def test_error_state_has_key(test_db, tmp_path, monkeypatch):
    from services.image_service import ImageService

    service = ImageService()

    def boom(*args, **kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(service, "reconnect_missing_files_once", boom)
    service.start_reconnect_missing_files(
        _request(tmp_path), ImmediateBackgroundTasks()
    )
    progress = service.get_reconnect_progress()

    assert progress["status"] == "error"
    assert progress["message_key"] == "error"


def test_cancelling_state_has_key(test_db, tmp_path):
    from services.image_service import ImageService

    service = ImageService()
    service.start_reconnect_missing_files(_request(tmp_path), DeferredBackgroundTasks())
    result = service.cancel_reconnect_missing_files()

    assert result["status"] == "cancelling"
    assert result["message_key"] == "cancelling"
