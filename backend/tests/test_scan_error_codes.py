"""ScanError carries a reason code + args so the UI can say what to do, in its language."""

from __future__ import annotations

import pytest

from exceptions import ScanError
from image_manager import scan_folder
from tests.test_scan_progress_keys import _scan_with, _service


def test_scan_error_defaults_to_no_code():
    error = ScanError("x")

    assert error.code == ""
    assert error.args_map == {}


@pytest.mark.parametrize(
    "setup, code",
    [
        ("missing", "folder_not_found"),
        ("file", "not_a_directory"),
    ],
)
def test_scan_folder_raises_coded_errors(tmp_path, setup, code):
    target = tmp_path / "nope"
    if setup == "file":
        target.write_text("x")

    with pytest.raises(ScanError) as caught:
        scan_folder(str(target), recursive=False, metadata_workers=1)

    assert caught.value.code == code
    assert caught.value.args_map["path"] == str(target)


def test_unreadable_root_is_coded_with_the_os_reason(tmp_path, monkeypatch):
    import image_manager

    def deny(*args, **kwargs):
        raise PermissionError(13, "Access is denied")

    monkeypatch.setattr(image_manager.os, "scandir", deny)

    with pytest.raises(ScanError) as caught:
        scan_folder(str(tmp_path), recursive=False, metadata_workers=1)

    assert caught.value.code == "scan_root_inaccessible"
    assert caught.value.args_map["reason"] == "Access is denied"


def test_progress_carries_the_code_and_args(test_db, tmp_path, monkeypatch, test_client):
    service = _service()

    def refuse(folder, recursive, progress_cb, **kwargs):
        raise ScanError(
            "Cannot access scan root", path="L:\Pics", code="scan_root_inaccessible",
            args={"path": "L:\Pics", "reason": "Access is denied"},
        )

    _scan_with(monkeypatch, service, tmp_path, refuse)
    body = test_client.get("/api/scan/progress").json()

    assert body["message_detail_code"] == "scan_root_inaccessible"
    assert body["message_detail_args"] == {"path": "L:\Pics", "reason": "Access is denied"}


def test_library_root_write_failure_is_coded(test_db, tmp_path, monkeypatch):
    import database as db

    service = _service()
    (tmp_path / "a.png").write_bytes(b"")
    from PIL import Image

    Image.new("RGB", (8, 8)).save(tmp_path / "a.png")

    def readonly(*args, **kwargs):
        raise RuntimeError("attempt to write a readonly database")

    monkeypatch.setattr(db, "record_library_root_scan", readonly)
    service.start_scan(
        __import__("services.sorting_models", fromlist=["ScanRequest"]).ScanRequest(
            folder_path=str(tmp_path), recursive=False
        ),
        type("T", (), {"add_task": lambda self, f, *a, **k: f(*a, **k)})(),
        "manual",
    )
    progress = service.get_scan_progress()

    assert progress["status"] == "error"
    assert progress["message_detail_code"] == "library_root_persist_failed"
    assert progress["message_detail_args"]["path"]
