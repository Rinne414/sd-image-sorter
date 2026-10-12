"""A finished import drops the cached library report.

The library status (V4 rail and report) reads GET /api/library-health, which is
cached for a minute. Without this, the counts after a quick import (new
untagged images, the tag-after-import count) stayed stale for up to 60 s.
"""

import threading
import time

from fastapi import BackgroundTasks

import services.sorting_service as sorting_service
from services.sorting_models import SCAN_SOURCE_MANUAL, ScanRequest
from services.sorting_service import SortingService


def _finished(*_args, **_kwargs):
    return {
        "total": 2,
        "new": 2,
        "updated": 0,
        "removed": 0,
        "errors": 0,
        "metadata_processed": 2,
        "metadata_total": 2,
    }


def test_a_finished_import_drops_the_cached_library_report(
    test_db, tmp_path, monkeypatch
):
    monkeypatch.setattr("services.sorting_service.scan_folder", _finished)
    sorting_service._LIBRARY_HEALTH_CACHE[("main", 8)] = (time.time(), {"stale": True})
    service = SortingService()
    tasks = BackgroundTasks()

    service.start_scan(
        ScanRequest(folder_path=str(tmp_path)), tasks, SCAN_SOURCE_MANUAL
    )
    worker = threading.Thread(target=tasks.tasks[0].func)
    worker.start()
    worker.join(timeout=10)

    assert service.get_scan_progress()["status"] == "done"
    assert sorting_service._LIBRARY_HEALTH_CACHE == {}
