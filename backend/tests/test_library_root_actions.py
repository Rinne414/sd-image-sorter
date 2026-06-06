"""Phase D/C library-root actions on SortingService (v3.3.2 Library Navigation).

remove (keep images) / rescan (quick-import a root) / auto-refresh (idle-gated
quick-scan of the stalest enabled root). Scan-triggering paths monkeypatch
``start_scan`` so the tests stay deterministic and never launch a real scan.
"""
import pytest
from fastapi import BackgroundTasks, HTTPException

import database as db
from services.sorting_service import SortingService


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

        def fake_start_scan(request, background_tasks):
            captured["request"] = request
            return {"status": "started"}

        monkeypatch.setattr(service, "start_scan", fake_start_scan)
        result = service.rescan_library_root(row["id"], BackgroundTasks())
        assert result == {"status": "started"}
        assert captured["request"].folder_path == "L:/Pics/Anime"
        assert captured["request"].quick_import is True
        assert captured["request"].force_reparse is False


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

        def fake_start_scan(request, background_tasks):
            captured["path"] = request.folder_path
            return {"status": "started"}

        monkeypatch.setattr(service, "start_scan", fake_start_scan)
        result = service.auto_refresh_library(BackgroundTasks())
        assert result["status"] == "started"
        assert result["root"] == "L:/Pics/B"
        assert captured["path"] == "L:/Pics/B"

    def test_disabled_roots_excluded(self, test_db, service):
        row = db.add_library_root("L:/Pics/A")
        db.set_library_root_enabled(row["id"], False)
        assert service.auto_refresh_library(BackgroundTasks())["status"] == "idle"
