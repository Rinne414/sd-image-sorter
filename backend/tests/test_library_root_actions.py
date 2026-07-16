"""Phase D/C library-root actions on SortingService (v3.3.2 Library Navigation).

remove (keep images) / rescan (quick-import a root) / auto-refresh (idle-gated
quick-scan of the stalest enabled root). Scan-triggering paths monkeypatch
``start_scan`` so the tests stay deterministic and never launch a real scan.
"""
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


@pytest.fixture
def service():
    """A fresh SortingService (idle scan state) — mirrors test_sorting's isolation."""
    return SortingService()


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
        row = db.add_library_root("L:/Pics/Anime")
        captured = {}

        def fake_start_scan(request, background_tasks, source):
            captured["request"] = request
            captured["source"] = source
            return {
                "status": "started",
                "message": "started",
                "run_id": 1,
                "source": source,
            }

        monkeypatch.setattr(service, "start_scan", fake_start_scan)
        result = service.rescan_library_root(row["id"], BackgroundTasks())
        assert result == {
            "status": "started",
            "message": "started",
            "run_id": 1,
            "source": SCAN_SOURCE_LIBRARY_RESCAN,
        }
        assert captured["request"].folder_path == "L:/Pics/Anime"
        assert captured["request"].quick_import is True
        assert captured["request"].force_reparse is False
        assert captured["source"] == SCAN_SOURCE_LIBRARY_RESCAN

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
        db.add_library_root("L:/Pics/A")
        db.add_library_root("L:/Pics/B")
        db.touch_library_root_scanned("L:/Pics/A")  # A scanned; B never -> B is stalest
        captured = {}

        def fake_start_scan(request, background_tasks, source):
            captured["path"] = request.folder_path
            captured["source"] = source
            return {
                "status": "started",
                "message": "started",
                "run_id": 2,
                "source": source,
            }

        monkeypatch.setattr(service, "start_scan", fake_start_scan)
        result = service.auto_refresh_library(BackgroundTasks())
        assert result["status"] == "started"
        assert result["root"] == "L:/Pics/B"
        assert result["scan"] == {
            "status": "started",
            "message": "started",
            "run_id": 2,
            "source": SCAN_SOURCE_LIBRARY_AUTO_REFRESH,
        }
        assert captured["path"] == "L:/Pics/B"
        assert captured["source"] == SCAN_SOURCE_LIBRARY_AUTO_REFRESH

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

        def fake_start_scan(request, background_tasks, source):
            service._scan_progress.update({
                "run_id": 8,
                "source": SCAN_SOURCE_MANUAL,
                "status": "running",
            })
            raise HTTPException(status_code=409, detail="Manual scan won the race")

        monkeypatch.setattr(service, "start_scan", fake_start_scan)

        assert service.auto_refresh_library(BackgroundTasks()) == {
            "status": "skipped",
            "reason": "scan_in_progress",
        }

    def test_lost_race_with_manual_terminal_preserves_completion(self, test_db, service, monkeypatch):
        db.add_library_root("L:/Pics/Anime")

        def fake_start_scan(request, background_tasks, source):
            service._scan_progress.update({
                "run_id": 9,
                "source": SCAN_SOURCE_MANUAL,
                "status": "done",
            })
            raise HTTPException(status_code=409, detail="Manual completion won the race")

        monkeypatch.setattr(service, "start_scan", fake_start_scan)

        assert service.auto_refresh_library(BackgroundTasks()) == {
            "status": "skipped",
            "reason": "manual_completion_pending",
        }

    def test_disabled_roots_excluded(self, test_db, service):
        row = db.add_library_root("L:/Pics/A")
        db.set_library_root_enabled(row["id"], False)
        assert service.auto_refresh_library(BackgroundTasks())["status"] == "idle"
