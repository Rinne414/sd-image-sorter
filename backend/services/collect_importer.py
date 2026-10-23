"""Index collected pictures in the background and keep where they came from.

One worker thread takes saved pictures from a queue, imports those that
arrived together in one ``scan_folder(only_paths=...)`` call per library and
folder (the same pipeline as Scan and folder watching, so metadata inside the
picture is read as usual), then stores each picture's source. ``generation``
grows after every batch; the classic page polls it and refreshes the gallery.
"""

from __future__ import annotations

import logging
import queue
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, BinaryIO, Dict, List, Optional, Tuple

from services.collect_download import download_picture
from services.collect_service import (
    CollectSource,
    SavedPicture,
    collected_folder,
    save_collected_stream,
    store_collected_file,
)

logger = logging.getLogger("sd-image-sorter")

# Pictures that arrive within this window are imported together.
BATCH_WINDOW_SECONDS = 0.4
INGEST_METADATA_WORKERS = 1


@dataclass
class CollectJob:
    path: Path
    source: CollectSource
    library_id: str
    collected_at: str = field(
        default_factory=lambda: datetime.now().isoformat(timespec="seconds")
    )


def _import_group(library_id: str, folder: Path, jobs: List[CollectJob]) -> int:
    """Import one folder's new pictures into one library; return how many got an id."""
    import database as db
    from db_collected_sources import record_collected_source
    from image_manager import scan_folder
    from library_context import reset_current_library_id, set_current_library_id

    token = set_current_library_id(library_id)
    try:
        scan_folder(
            str(folder),
            recursive=False,
            quick_import=True,
            metadata_workers=INGEST_METADATA_WORKERS,
            precise_total=False,
            only_paths=[str(job.path) for job in jobs],
        )
        stored = 0
        for job in jobs:
            row = db.get_image_by_path(str(job.path), current_library_only=True)
            if not row:
                logger.warning("Collected picture was not indexed: %s", job.path)
                continue
            source = job.source
            record_collected_source(
                int(row["id"]),
                source_url=source.source_url,
                page_url=source.page_url,
                page_title=source.page_title,
                collected_at=job.collected_at,
                via=source.via,
            )
            stored += 1
        return stored
    finally:
        reset_current_library_id(token)


class CollectImporter:
    def __init__(self) -> None:
        self._queue: "queue.Queue[CollectJob]" = queue.Queue()
        self._lock = threading.Lock()
        self._thread: Optional[threading.Thread] = None
        self._busy = 0
        self._generation = 0
        self._imported = 0
        self._last_error: Optional[str] = None
        self._last_error_params: Dict[str, Any] = {}
        self._ui_library_id = "main"

    # The library the classic page shows; the extension does not know it.
    def note_ui_library(self, library_id: Optional[str]) -> None:
        if library_id:
            self._ui_library_id = library_id

    def ui_library(self) -> str:
        return self._ui_library_id

    def submit(self, job: CollectJob) -> None:
        with self._lock:
            self._busy += 1
            if self._thread is None or not self._thread.is_alive():
                self._thread = threading.Thread(
                    target=self._run, name="collect-importer", daemon=True
                )
                self._thread.start()
        self._queue.put(job)

    def status(self) -> Dict[str, Any]:
        with self._lock:
            return {
                "generation": self._generation,
                "waiting": self._busy,
                "imported": self._imported,
                "last_error": self._last_error,
                # The page says it in the UI language; last_error is the fallback.
                "last_error_code": "collect_index_failed" if self._last_error else None,
                "last_error_params": dict(self._last_error_params),
            }

    def wait_idle(self, timeout: float = 30.0) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with self._lock:
                if self._busy == 0:
                    return True
            time.sleep(0.05)
        return False

    def _take_batch(self) -> List[CollectJob]:
        batch = [self._queue.get()]
        deadline = time.monotonic() + BATCH_WINDOW_SECONDS
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return batch
            try:
                batch.append(self._queue.get(timeout=remaining))
            except queue.Empty:
                return batch

    def _run(self) -> None:
        while True:
            batch = self._take_batch()
            groups: Dict[Tuple[str, Path], List[CollectJob]] = {}
            for job in batch:
                groups.setdefault((job.library_id, job.path.parent), []).append(job)
            for (library_id, folder), jobs in groups.items():
                self._import(library_id, folder, jobs)

    def _import(self, library_id: str, folder: Path, jobs: List[CollectJob]) -> None:
        error: Optional[str] = None
        params: Dict[str, Any] = {}
        stored = 0
        try:
            stored = _import_group(library_id, folder, jobs)
        except Exception as exc:  # the worker must survive one bad batch
            logger.exception("Importing collected pictures failed")
            error = f"Saved in {folder}, but adding to the gallery failed: {exc}"
            params = {"folder": str(folder), "reason": str(exc)}
        with self._lock:
            self._busy -= len(jobs)
            self._imported += stored
            self._generation += 1
            self._last_error = error
            self._last_error_params = params
        if stored:
            from services.sorting_service import invalidate_library_health_cache

            invalidate_library_health_cache()


_importer = CollectImporter()


def get_collect_importer() -> CollectImporter:
    return _importer


def _queued(saved: SavedPicture, source: CollectSource, library_id: str) -> Dict[str, Any]:
    _importer.submit(CollectJob(saved.path, source.cleaned(), library_id))
    return {**saved.as_dict(), "queued": True}


def collect_stream(
    stream: BinaryIO, suggested_name: Optional[str], source: CollectSource, library_id: str
) -> Dict[str, Any]:
    """Save an uploaded picture and queue it for the gallery."""
    return _queued(save_collected_stream(stream, suggested_name), source, library_id)


def collect_url(
    url: str, *, referer: Optional[str], source: CollectSource, library_id: str
) -> Dict[str, Any]:
    """Download a picture (the page as Referer), save it and queue it for the gallery."""
    downloaded = download_picture(url, referer=referer, dest_dir=collected_folder())
    saved = store_collected_file(downloaded.path, downloaded.suggested_name)
    return _queued(saved, source, library_id)
