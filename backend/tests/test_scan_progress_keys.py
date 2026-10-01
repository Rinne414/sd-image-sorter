"""Scan progress carries a message_key so the UI can localise the status line."""

from pathlib import Path

import pytest

from exceptions import ScanCancelledError
from services import sorting_service as sorting_module
from services.sorting_models import ScanCancelRequest, ScanRequest


class ImmediateBackgroundTasks:
    def add_task(self, func, *args, **kwargs):
        func(*args, **kwargs)


def _service():
    from routers import sorting as sorting_router

    service = sorting_router.get_sorting_service()
    service.reset_scan_progress()
    return service


def _request(folder: Path, **overrides):
    return ScanRequest(folder_path=str(folder), recursive=False, **overrides)


def _scan_with(monkeypatch, service, tmp_path, fake, **overrides):
    monkeypatch.setattr(sorting_module, "scan_folder", fake)
    return service.start_scan(
        _request(tmp_path, **overrides), ImmediateBackgroundTasks(), "manual"
    )


def _done_result(**extra):
    base = {"total": 3, "new": 3, "updated": 0, "removed": 0, "errors": 0}
    base.update(extra)
    return base


def test_idle_state_has_empty_message_key():
    service = _service()
    assert service.get_scan_progress()["message_key"] == ""


def test_start_response_and_done_state_have_keys(test_db, tmp_path, monkeypatch):
    service = _service()
    seen = {}

    def fake(folder, recursive, progress_cb, **kwargs):
        seen["start"] = service.get_scan_progress()
        return _done_result()

    result = _scan_with(monkeypatch, service, tmp_path, fake)
    progress = service.get_scan_progress()

    assert result["message_key"] == "started"
    assert seen["start"]["message_key"] == "counting_before"
    assert progress["status"] == "done"
    assert progress["message_key"] == "done"
    assert progress["new"] == 3


def test_cleanup_start_state_has_sync_key(test_db, tmp_path, monkeypatch):
    service = _service()
    seen = {}

    def fake(folder, recursive, progress_cb, **kwargs):
        seen["start"] = service.get_scan_progress()
        return _done_result()

    _scan_with(monkeypatch, service, tmp_path, fake, cleanup_missing=True)
    assert seen["start"]["message_key"] == "syncing_index"


@pytest.mark.parametrize(
    "phase, details, expected",
    [
        ("counting", {"counted": 7}, "counting"),
        ("counted", {"import_total": 9}, "counted"),
        ("cleanup", {"removed": 2}, "cleanup"),
        ("library_ready", {"import_complete": True, "metadata_total": 5, "metadata_processed": 1}, "library_ready_metadata"),
        ("library_ready", {"import_total": 5}, "library_ready_import"),
        ("metadata", {"import_complete": True}, "reading_details"),
        ("metadata", {"import_complete": False, "import_total": 4}, "importing_details"),
        (None, {"total_final": True}, "processing"),
    ],
)
def test_phase_states_have_keys(test_db, tmp_path, monkeypatch, phase, details, expected):
    service = _service()
    seen = {}

    def fake(folder, recursive, progress_cb, **kwargs):
        d = dict(details)
        if phase:
            d["phase"] = phase
        progress_cb(1, 5, "a.png", d)
        seen["progress"] = service.get_scan_progress()
        return _done_result()

    _scan_with(monkeypatch, service, tmp_path, fake)
    assert seen["progress"]["message_key"] == expected


def test_unreadable_image_state_has_key_and_item(test_db, tmp_path, monkeypatch):
    service = _service()
    seen = {}

    def fake(folder, recursive, progress_cb, **kwargs):
        progress_cb(1, 5, "a.png", {"last_error": {"filename": "bad.png", "error": "x"}})
        seen["progress"] = service.get_scan_progress()
        return _done_result()

    _scan_with(monkeypatch, service, tmp_path, fake)
    assert seen["progress"]["message_key"] == "skipped_unreadable"
    assert seen["progress"]["message_item"] == "bad.png"


def test_cancelled_error_and_aborted_states_have_keys(test_db, tmp_path, monkeypatch):
    service = _service()

    def cancelled(folder, recursive, progress_cb, **kwargs):
        raise ScanCancelledError("stop")

    _scan_with(monkeypatch, service, tmp_path, cancelled)
    assert service.get_scan_progress()["message_key"] == "cancelled"

    service = _service()

    def boom(folder, recursive, progress_cb, **kwargs):
        raise RuntimeError("boom")

    _scan_with(monkeypatch, service, tmp_path, boom)
    progress = service.get_scan_progress()
    assert progress["status"] == "error"
    assert progress["message_key"] == "error"


def test_cancel_request_on_idle_worker_has_key(test_db, tmp_path):
    service = _service()
    service.set_scan_progress(
        {"run_id": 5, "source": "manual", "status": "running", "current": 2, "total": 4}
    )
    result = service.cancel_scan(ScanCancelRequest(run_id=5, source="manual"))
    assert result["status"] == "cancelled"
    assert service.get_scan_progress()["message_key"] == "cancelled"


def test_reset_leaves_idle_key(test_db, tmp_path):
    service = _service()
    service.set_scan_progress({"run_id": 5, "source": "manual", "status": "done"})
    service.reset_scan_progress()
    assert service.get_scan_progress()["message_key"] == ""


def test_done_state_flags_the_missing_text_notice(test_db, tmp_path, monkeypatch):
    from services.sorting import scan as scan_module

    service = _service()
    monkeypatch.setattr(
        scan_module,
        "_prompt_coverage_for_scope",
        lambda *a, **k: {"total": 10, "missing_prompt": 9, "missing_text": 9},
    )
    _scan_with(monkeypatch, service, tmp_path, lambda *a, **k: _done_result())
    progress = service.get_scan_progress()

    assert progress["missing_text_notice"] is True
    assert progress["metadata_missing_text"] == 9
    assert progress["metadata_prompt_total"] == 10


def test_progress_endpoint_exposes_the_key_fields(test_client, test_db, tmp_path, monkeypatch):
    """The response model must not strip message_key / message_item."""
    service = _service()
    seen = {}

    def fake(folder, recursive, progress_cb, **kwargs):
        progress_cb(1, 5, "a.png", {"last_error": {"filename": "bad.png", "error": "x"}})
        seen["body"] = test_client.get("/api/scan/progress").json()
        return _done_result()

    started = _scan_with(monkeypatch, service, tmp_path, fake)
    assert started["message_key"] == "started"
    assert seen["body"]["message_key"] == "skipped_unreadable"
    assert seen["body"]["message_item"] == "bad.png"

    final = test_client.get("/api/scan/progress").json()
    assert final["message_key"] == "done"
    assert final["missing_text_notice"] is False


def test_response_models_declare_the_key_fields():
    from services.sorting_models import ScanProgressResponse, ScanStartResponse

    assert "message_key" in ScanStartResponse.model_fields
    for name in ("message_key", "message_item", "missing_text_notice"):
        assert name in ScanProgressResponse.model_fields


def test_scan_error_carries_the_actionable_cause(test_db, tmp_path, monkeypatch, test_client):
    from exceptions import ScanError

    service = _service()

    def refuse(folder, recursive, progress_cb, **kwargs):
        raise ScanError(
            message="Image indexing completed, but Library Root persistence failed. Check database write access and scan this folder again.",
            path=None,
            details={},
        )

    _scan_with(monkeypatch, service, tmp_path, refuse)
    progress = service.get_scan_progress()
    assert progress["message_key"] == "error"
    assert "Check database write access" in progress["message_detail"]
    body = test_client.get("/api/scan/progress").json()
    assert "Check database write access" in body["message_detail"]


def test_unexpected_scan_error_has_no_detail(test_db, tmp_path, monkeypatch):
    service = _service()

    def boom(folder, recursive, progress_cb, **kwargs):
        raise RuntimeError("secret internals")

    _scan_with(monkeypatch, service, tmp_path, boom)
    assert service.get_scan_progress()["message_detail"] == ""
