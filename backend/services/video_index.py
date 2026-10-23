"""Background video indexer: probes videos the scan marked 'pending'.

One daemon thread, one ffprobe at a time at below-normal priority, so a scan
of many pictures with a few videos runs as fast as before and the UI never
waits for it. A video that ffprobe cannot read yet is retried while it is
still being written (changed in the last ``STILL_WRITING_SECONDS``); after
that it is recorded as unreadable with the reason, never dropped.

Without ffmpeg/ffprobe the rows simply stay 'pending' (they are listed with
their file name, size and date); installing video support kicks the indexer.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from typing import Any, Dict, List, Optional

import db_videos
from services import video_probe, video_tools

logger = logging.getLogger(__name__)

BATCH_SIZE = 20
STILL_WRITING_SECONDS = 60.0
RETRY_SECONDS = 10.0
IDLE_EXIT_SECONDS = 1.0


def _update_recipe(image_id: int, path: str, info: video_probe.VideoInfo) -> None:
    import database
    from metadata_storage import compact_metadata_json

    recipe, _source = video_probe.recipe_for(path, info)
    try:
        stat = os.stat(path)
    except OSError:
        stat = None
    database.update_image_metadata(
        image_id=image_id,
        generator=recipe["generator"],
        prompt=recipe["prompt"],
        negative_prompt=recipe["negative_prompt"],
        metadata_json=compact_metadata_json(recipe["metadata"]),
        width=info.width,
        height=info.height,
        file_size=stat.st_size if stat else None,
        checkpoint=recipe["checkpoint"],
        loras=recipe["loras"],
        is_readable=True,
        source_mtime_ns=stat.st_mtime_ns if stat else None,
        source_size=stat.st_size if stat else None,
        metadata_status="complete",
        preserve_derived_state=True,
    )


def index_one(image_id: int, path: str, *, now: Optional[float] = None) -> str:
    """Probe one video and store what was found. Returns the resulting state.

    'retry' means the file is still being written and stays pending.
    """
    now = time.time() if now is None else now
    if not os.path.isfile(path):
        db_videos.save_video_facts(
            image_id, state=db_videos.UNREADABLE, error="File not found"
        )
        return db_videos.UNREADABLE
    try:
        info = video_probe.probe(path)
    except video_probe.VideoProbeError as exc:
        if not video_probe.file_is_quiet(path, STILL_WRITING_SECONDS, now):
            return "retry"
        db_videos.save_video_facts(
            image_id, state=db_videos.UNREADABLE, error=str(exc)[:300]
        )
        return db_videos.UNREADABLE
    _update_recipe(image_id, path, info)
    db_videos.save_video_facts(
        image_id,
        state=db_videos.READY,
        duration=info.duration,
        codec=info.codec,
        fps=info.fps,
        has_audio=info.has_audio,
    )
    return db_videos.READY


class VideoIndexer:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._wake = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._retry_at: Dict[int, float] = {}
        self.last_error: Optional[str] = None

    def kick(self) -> None:
        """Start (or wake) the indexer when there is anything to probe."""
        with self._lock:
            self._wake.set()
            if self._thread is not None and self._thread.is_alive():
                return
            self._thread = threading.Thread(
                target=self._run, name="video-indexer", daemon=True
            )
            self._thread.start()

    def is_running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def _run(self) -> None:
        try:
            while True:
                self._wake.clear()
                if video_tools.find_tools() is None and self._finish():
                    return
                self._one_pass()
                wait = self._next_retry_wait()
                if wait is None:
                    if not self._wake.wait(IDLE_EXIT_SECONDS) and self._finish():
                        return
                    continue
                self._wake.wait(wait)
        except Exception as exc:  # keep the server alive; report through status
            self.last_error = str(exc)
            logger.exception("Video indexer stopped: %s", exc)
            with self._lock:
                self._thread = None

    def _finish(self) -> bool:
        """Leave unless a kick arrived meanwhile (checked under the kick lock)."""
        with self._lock:
            if self._wake.is_set():
                return False
            self._thread = None
            return True

    def _next_retry_wait(self) -> Optional[float]:
        if not self._retry_at:
            return None
        return max(0.5, min(self._retry_at.values()) - time.time())

    def _one_pass(self) -> None:
        after_id = 0
        while True:
            rows = db_videos.pending_videos(BATCH_SIZE, after_id)
            if not rows:
                return
            for row in rows:
                after_id = row["id"]
                self._index_row(row)

    def _index_row(self, row: Dict) -> None:
        image_id = row["id"]
        retry_at = self._retry_at.get(image_id)
        if retry_at is not None and retry_at > time.time():
            return
        try:
            state = index_one(image_id, row["path"])
        except video_tools.VideoToolsMissing:
            return
        except Exception as exc:
            logger.warning("Could not index video %s: %s", row["path"], exc)
            db_videos.save_video_facts(
                image_id, state=db_videos.UNREADABLE, error=str(exc)[:300]
            )
            state = db_videos.UNREADABLE
        if state == "retry":
            self._retry_at[image_id] = time.time() + RETRY_SECONDS
        else:
            self._retry_at.pop(image_id, None)


def video_scan_result(path: str, filename: str) -> Dict[str, Any]:
    """Scan-worker payload for a video: file facts only, marked for probing."""
    from datetime import datetime

    from metadata_storage import compact_metadata_json
    from sidecar_fingerprint import compute_sidecar_fingerprint

    stat = os.stat(path)
    file_time = datetime.fromtimestamp(stat.st_mtime)
    record = {
        "path": path,
        "filename": filename,
        "generator": "unknown",
        "prompt": None,
        "sidecar_caption": None,
        "negative_prompt": None,
        "metadata_json": compact_metadata_json({}),
        "width": None,
        "height": None,
        "file_size": int(stat.st_size),
        "checkpoint": None,
        "loras": [],
        "library_order_time": file_time,
        "source_file_mtime": file_time,
        "created_at": file_time,
        "model_hash": None,
        "is_readable": True,
        "read_error": None,
        "source_mtime_ns": int(stat.st_mtime_ns),
        "source_size": int(stat.st_size),
        "metadata_status": "complete",
        "content_fingerprint": None,
        "sidecar_fingerprint": compute_sidecar_fingerprint(path),
        "video_probe_state": db_videos.PENDING,
    }
    return {"filename": filename, "generator": "unknown", "record": record, "error": None}


def queue_scanned_videos(paths: List[str]) -> None:
    """Called by the scan after it stored new or changed videos."""
    db_videos.mark_videos_pending(paths)
    get_video_indexer().kick()


_indexer: Optional[VideoIndexer] = None
_indexer_lock = threading.Lock()


def get_video_indexer() -> VideoIndexer:
    global _indexer
    if _indexer is None:
        with _indexer_lock:
            if _indexer is None:
                _indexer = VideoIndexer()
    return _indexer
