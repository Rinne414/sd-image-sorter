"""Phase D/C library-root actions on SortingService (v3.3.2 Library Navigation).

remove (keep images) / rescan (quick-import a root) / auto-refresh (idle-gated
quick-scan of the stalest enabled root). Scan-triggering paths monkeypatch
``start_registered_root_scan`` so tests stay deterministic unless completion
persistence is the behavior under test.
"""
import os

import pytest
from fastapi import BackgroundTasks, HTTPException

import database as db
from services.sorting_service import SortingService
from services.sorting_models import (
    SCAN_SOURCE_LIBRARY_AUTO_REFRESH,
    SCAN_SOURCE_LIBRARY_RESCAN,
    SCAN_SOURCE_MANUAL,
    ScanRequest,
)


def _cross_runtime_root_path(folder_name: str) -> tuple[str, str]:
    if os.name == "nt":
        return f"/mnt/l/Pics/{folder_name}", rf"L:\Pics\{folder_name}"
    return rf"L:\Pics\{folder_name}", f"/mnt/l/Pics/{folder_name}"


@pytest.fixture
def service():
    """A fresh SortingService (idle scan state) — mirrors test_sorting's isolation."""
    return SortingService()


def test_manual_scan_keeps_runtime_path_as_root_record(
    service,
    monkeypatch,
):
    request_path = r"L:\Pics\Manual"
    expected_record_path = (
        request_path if os.name == "nt" else "/mnt/l/Pics/Manual"
    )
    captured = {}

    def fake_start_scan(
        request,
        background_tasks,
        source,
        *,
        root_record_path,
    ):
        captured["root_record_path"] = root_record_path
        return {
            "status": "started",
            "message": "started",
            "run_id": 1,
            "source": source,
        }

    monkeypatch.setattr(service, "_start_scan", fake_start_scan)

    result = service.start_scan(
        ScanRequest(folder_path=request_path),
        BackgroundTasks(),
        SCAN_SOURCE_MANUAL,
    )

    assert result["source"] == SCAN_SOURCE_MANUAL
    assert captured["root_record_path"] == expected_record_path


class TestRemoveLibraryRoot:
    def test_remove_existing_keeps_status(self, test_db, service):
        row = db.add_library_root("L:/Pics/Anime")
        assert service.remove_library_root(row["id"]) == {"status": "removed", "id": row["id"]}
        assert db.list_library_roots() == []

    def test_remove_unknown_raises_404(self, test_db, service):
        with pytest.raises(HTTPException) as exc:
            service.remove_library_root(999)
        assert exc.value.status_code == 404


class TestRescanLibraryRoot:
    def test_rescan_unknown_raises_404(self, test_db, service):
        with pytest.raises(HTTPException) as exc:
            service.rescan_library_root(999, BackgroundTasks())
        assert exc.value.status_code == 404

    def test_rescan_delegates_quick_import(self, test_db, service, monkeypatch):
        stored_path, runtime_path = _cross_runtime_root_path("Anime")
        row = db.add_library_root(stored_path)
        captured = {}

        def fake_start_registered_root_scan(
            request,
            background_tasks,
            source,
            *,
            root_record_path,
        ):
            captured["request"] = request
            captured["source"] = source
            captured["root_record_path"] = root_record_path
            return {
                "status": "started",
                "message": "started",
                "run_id": 1,
                "source": source,
            }

        monkeypatch.setattr(
            service,
            "start_registered_root_scan",
            fake_start_registered_root_scan,
        )
        result = service.rescan_library_root(row["id"], BackgroundTasks())
        assert result == {
            "status": "started",
            "message": "started",
            "run_id": 1,
            "source": SCAN_SOURCE_LIBRARY_RESCAN,
        }
        assert captured["request"].folder_path == runtime_path
        assert captured["request"].quick_import is True
        assert captured["request"].force_reparse is False
        assert captured["source"] == SCAN_SOURCE_LIBRARY_RESCAN
        assert captured["root_record_path"] == row["path"]

    def test_registered_root_completion_preserves_stored_display_path(
        self,
        test_db,
        service,
        monkeypatch,
        tmp_path,
    ):
        stored_path, _runtime_path = _cross_runtime_root_path("Persisted")
        root = db.add_library_root(stored_path)
        assert root is not None
        background_tasks = BackgroundTasks()

        monkeypatch.setattr(
            "services.sorting_service.scan_folder",
            lambda *_args, **_kwargs: {
                "total": 0,
                "new": 0,
                "updated": 0,
                "removed": 0,
                "errors": 0,
                "metadata_processed": 0,
                "metadata_total": 0,
            },
        )

        service.start_registered_root_scan(
            ScanRequest(folder_path=str(tmp_path)),
            background_tasks,
            SCAN_SOURCE_LIBRARY_RESCAN,
            root_record_path=root["path"],
        )
        background_tasks.tasks[0].func()

        stored = db.get_library_root(root["id"])
        assert stored["path"] == root["path"]
        assert stored["last_scanned_at"] is not None

    def test_rescan_rejects_pending_manual_completion_with_stable_code(
        self,
        test_db,
        service,
        tmp_path,
    ):
        row = db.add_library_root(str(tmp_path))
        service._scan_progress.update({
            "run_id": 7,
            "source": SCAN_SOURCE_MANUAL,
            "status": "done",
        })

        with pytest.raises(HTTPException) as exc:
            service.rescan_library_root(row["id"], BackgroundTasks())

        assert exc.value.status_code == 409
        assert exc.value.detail["code"] == "manual_completion_pending"

    def test_rescan_api_preserves_manual_completion_detail_envelope(
        self,
        test_client,
        tmp_path,
    ):
        from routers.sorting import get_sorting_service

        row = db.add_library_root(str(tmp_path))
        service = get_sorting_service()
        service._scan_progress.update({
            "run_id": 8,
            "source": SCAN_SOURCE_MANUAL,
            "status": "done",
        })

        response = test_client.post(f"/api/library-roots/{row['id']}/rescan")

        assert response.status_code == 409
        payload = response.json()
        assert payload["code"] == "manual_completion_pending"
        assert payload["error"] == payload["message"]
        assert payload["type"] == "HTTPException"
        assert "detail" not in payload


class TestAutoRefreshLibrary:
    def test_idle_when_no_roots(self, test_db, service):
        assert service.auto_refresh_library(BackgroundTasks())["status"] == "idle"

    def test_skipped_when_scan_running(self, test_db, service):
        db.add_library_root("L:/Pics/Anime")
        service._scan_progress["status"] = "running"
        assert service.auto_refresh_library(BackgroundTasks()) == {
            "status": "skipped",
            "reason": "scan_in_progress",
        }

    def test_picks_stalest_enabled_root(self, test_db, service, monkeypatch):
        stored_a, _runtime_a = _cross_runtime_root_path("A")
        stored_b, runtime_b = _cross_runtime_root_path("B")
        root_a = db.add_library_root(stored_a)
        root_b = db.add_library_root(stored_b)
        db.touch_library_root_scanned(root_a["path"])  # A scanned; B never -> B is stalest
        captured = {}

        def fake_start_registered_root_scan(
            request,
            background_tasks,
            source,
            *,
            root_record_path,
        ):
            captured["path"] = request.folder_path
            captured["source"] = source
            captured["root_record_path"] = root_record_path
            return {
                "status": "started",
                "message": "started",
                "run_id": 2,
                "source": source,
            }

        monkeypatch.setattr(
            service,
            "start_registered_root_scan",
            fake_start_registered_root_scan,
        )
        result = service.auto_refresh_library(BackgroundTasks())
        assert result["status"] == "started"
        assert result["root"] == root_b["path"]
        assert result["scan"] == {
            "status": "started",
            "message": "started",
            "run_id": 2,
            "source": SCAN_SOURCE_LIBRARY_AUTO_REFRESH,
        }
        assert captured["path"] == runtime_b
        assert captured["source"] == SCAN_SOURCE_LIBRARY_AUTO_REFRESH
        assert captured["root_record_path"] == root_b["path"]

    def test_manual_terminal_must_be_consumed_before_auto_refresh(self, test_db, service):
        db.add_library_root("L:/Pics/Anime")
        service._scan_progress.update({
            "run_id": 7,
            "source": SCAN_SOURCE_MANUAL,
            "status": "done",
        })

        assert service.auto_refresh_library(BackgroundTasks()) == {
            "status": "skipped",
            "reason": "manual_completion_pending",
        }

    def test_background_start_cannot_overwrite_manual_terminal(self, test_db, service, tmp_path):
        service._scan_progress.update({
            "run_id": 7,
            "source": SCAN_SOURCE_MANUAL,
            "status": "done",
        })

        with pytest.raises(HTTPException) as exc:
            service.start_scan(
                ScanRequest(folder_path=str(tmp_path)),
                BackgroundTasks(),
                SCAN_SOURCE_LIBRARY_AUTO_REFRESH,
            )

        assert exc.value.status_code == 409
        assert service.get_scan_progress()["run_id"] == 7
        assert service.get_scan_progress()["source"] == SCAN_SOURCE_MANUAL

    def test_lost_race_with_active_manual_scan_is_normalized(self, test_db, service, monkeypatch):
        db.add_library_root("L:/Pics/Anime")

        def fake_start_registered_root_scan(
            request,
            background_tasks,
            source,
            *,
            root_record_path,
        ):
            service._scan_progress.update({
                "run_id": 8,
                "source": SCAN_SOURCE_MANUAL,
                "status": "running",
            })
            raise HTTPException(status_code=409, detail="Manual scan won the race")

        monkeypatch.setattr(
            service,
            "start_registered_root_scan",
            fake_start_registered_root_scan,
        )

        assert service.auto_refresh_library(BackgroundTasks()) == {
            "status": "skipped",
            "reason": "scan_in_progress",
        }

    def test_lost_race_with_manual_terminal_preserves_completion(self, test_db, service, monkeypatch):
        db.add_library_root("L:/Pics/Anime")

        def fake_start_registered_root_scan(
            request,
            background_tasks,
            source,
            *,
            root_record_path,
        ):
            service._scan_progress.update({
                "run_id": 9,
                "source": SCAN_SOURCE_MANUAL,
                "status": "done",
            })
            raise HTTPException(status_code=409, detail="Manual completion won the race")

        monkeypatch.setattr(
            service,
            "start_registered_root_scan",
            fake_start_registered_root_scan,
        )

        assert service.auto_refresh_library(BackgroundTasks()) == {
            "status": "skipped",
            "reason": "manual_completion_pending",
        }

    def test_disabled_roots_excluded(self, test_db, service):
        row = db.add_library_root("L:/Pics/A")
        db.set_library_root_enabled(row["id"], False)
        assert service.auto_refresh_library(BackgroundTasks())["status"] == "idle"
