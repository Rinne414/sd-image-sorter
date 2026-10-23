"""Folder watching: index new pictures in watched library roots within seconds.

A library root with ``watch = 1`` gets one worker thread while the app runs.
The worker first catches up (an incremental scan of the whole root, so files
written while the app was closed are picked up), then follows file events and
imports each new or changed picture once it has stopped growing. Events are
treated as hints: an hourly catch-up scan covers anything the operating
system dropped (Windows discards events when its buffer overflows).

Network folders (UNC paths, mapped network drives, NFS/SMB/9p mounts) do not
deliver reliable events, so they are polled instead, and the status says so.

Deleted or renamed-away files are left alone: their rows stay and show up as
missing, exactly as after a manual scan. Nothing here deletes data.
"""

from __future__ import annotations

import logging
import os
import sys
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence

from config import is_video_path

logger = logging.getLogger(__name__)

DEBOUNCE_MS = 1500
EVENT_WAIT_MS = 2000
NETWORK_POLL_MS = 15000
STABLE_SECONDS = 1.0
CATCH_UP_INTERVAL_SECONDS = 3600
RETRY_SECONDS = 30
SUPERVISOR_WAIT_SECONDS = 30
INGEST_METADATA_WORKERS = 1
PNG_TAIL_BYTES = 12
PNG_GRACE_FACTOR = 10
# A video ffprobe cannot read yet waits up to this many stable periods (the
# indexer keeps retrying after that, so a slow encoder never loses the file).
VIDEO_GRACE_FACTOR = 30

NETWORK_FS_TYPES = frozenset(
    {"nfs", "nfs4", "cifs", "smb3", "smbfs", "fuse.sshfs", "9p", "afs", "ncpfs"}
)

RootRow = Dict[str, Any]
IngestFn = Callable[[RootRow, Optional[Sequence[str]], Callable[[], bool]], int]


def _picture_extensions() -> frozenset[str]:
    from config import ALLOWED_MEDIA_EXTENSIONS

    return frozenset(ext.lower() for ext in ALLOWED_MEDIA_EXTENSIONS)


def video_is_complete(path: str) -> bool:
    """A video is finished once ffprobe reads a duration (an MP4 writes its
    index last). Without ffprobe there is nothing to ask: size stability decides."""
    from services import video_probe, video_tools

    if video_tools.find_tools() is None:
        return True
    try:
        video_probe.probe(path)
    except video_probe.VideoProbeError:
        return False
    except video_tools.VideoToolsMissing:
        return True
    return True


def is_network_path(path: str) -> bool:
    """True for folders whose change events cannot be trusted (polled instead)."""
    text = str(path or "")
    if text.startswith("\\\\") or text.startswith("//"):
        return True
    if sys.platform == "win32":
        return _is_windows_remote_drive(text)
    return _linux_mount_fs_type(text) in NETWORK_FS_TYPES


def _is_windows_remote_drive(path: str) -> bool:
    drive = os.path.splitdrive(os.path.abspath(path))[0]
    if not drive:
        return False
    try:
        import ctypes

        drive_remote = 4
        return ctypes.windll.kernel32.GetDriveTypeW(drive + "\\") == drive_remote
    except (AttributeError, OSError):
        return False


def _linux_mount_fs_type(path: str) -> str:
    try:
        with open("/proc/mounts", encoding="utf-8") as mounts:
            entries = [line.split()[1:3] for line in mounts if len(line.split()) >= 3]
    except OSError:
        return ""
    target = os.path.realpath(path)
    best_point, best_type = "", ""
    for mount_point, fs_type in entries:
        point = mount_point.replace("\\040", " ")
        prefix = point if point.endswith("/") else point + "/"
        if (target == point or target.startswith(prefix)) and len(point) > len(
            best_point
        ):
            best_point, best_type = point, fs_type
    return best_type


def png_is_complete(path: str) -> bool:
    """A PNG is finished once its last chunk (IEND) is on disk."""
    try:
        with open(path, "rb") as handle:
            handle.seek(0, os.SEEK_END)
            if handle.tell() < PNG_TAIL_BYTES:
                return False
            handle.seek(-PNG_TAIL_BYTES, os.SEEK_END)
            return b"IEND" in handle.read(PNG_TAIL_BYTES)
    except OSError:
        return False


def _now_text() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _scan_root(
    root: RootRow,
    only_paths: Optional[Sequence[str]],
    stop_requested: Callable[[], bool],
) -> int:
    """Import ``only_paths`` (or catch up the whole root); return pictures added or changed."""
    import database as db
    from image_manager import DEFAULT_METADATA_WORKERS, scan_folder
    from library_context import reset_current_library_id, set_current_library_id

    catch_up = only_paths is None
    library_id = root.get("library_id") or "main"
    token = set_current_library_id(library_id)
    try:
        result = scan_folder(
            str(root["path"]),
            recursive=True,
            stop_requested=stop_requested,
            quick_import=True,
            metadata_workers=DEFAULT_METADATA_WORKERS
            if catch_up
            else INGEST_METADATA_WORKERS,
            precise_total=False,
            only_paths=only_paths,
        )
        if catch_up:
            db.touch_library_root_scanned(str(root["path"]), library_id)
    finally:
        reset_current_library_id(token)
    changed = int(result.get("new") or 0) + int(result.get("updated") or 0)
    return max(0, changed - int(result.get("unchanged") or 0))


@dataclass
class RootStatus:
    root_id: int
    path: str
    library_id: str
    mode: str
    state: str = "starting"
    error: Optional[str] = None
    imported: int = 0
    last_import_at: Optional[str] = None
    last_catch_up_at: Optional[str] = None

    def as_dict(self) -> Dict[str, Any]:
        return {
            "root_id": self.root_id,
            "path": self.path,
            "library_id": self.library_id,
            "mode": self.mode,
            "state": self.state,
            "error": self.error,
            "imported": self.imported,
            "last_import_at": self.last_import_at,
            "last_catch_up_at": self.last_catch_up_at,
        }


@dataclass
class _Pending:
    size: int
    mtime_ns: int
    seen_at: float = field(default_factory=time.monotonic)


@dataclass
class _Worker:
    """One watched root: its event thread, its catch-up thread, its status."""

    root: RootRow
    polling: bool
    status: RootStatus
    stop: threading.Event = field(default_factory=threading.Event)
    thread: Optional[threading.Thread] = None
    catch_up: Optional[threading.Thread] = None


class FolderWatchService:
    """Supervises one watcher thread per watched root."""

    def __init__(
        self,
        *,
        list_roots: Optional[Callable[[], List[RootRow]]] = None,
        ingest: IngestFn = _scan_root,
        force_polling: Optional[bool] = None,
        poll_delay_ms: int = NETWORK_POLL_MS,
        debounce_ms: int = DEBOUNCE_MS,
        stable_seconds: float = STABLE_SECONDS,
        retry_seconds: float = RETRY_SECONDS,
    ) -> None:
        self._list_roots = list_roots or self._default_list_roots
        self._ingest = ingest
        self._force_polling = force_polling
        self._poll_delay_ms = poll_delay_ms
        self._debounce_ms = debounce_ms
        self._stable_seconds = stable_seconds
        self._retry_seconds = retry_seconds
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._reload = threading.Event()
        self._supervisor: Optional[threading.Thread] = None
        self._workers: Dict[tuple, _Worker] = {}
        self._generation = 0

    @staticmethod
    def _default_list_roots() -> List[RootRow]:
        import database as db

        return db.list_watched_library_roots()

    # Lifecycle -----------------------------------------------------------

    def start(self) -> None:
        with self._lock:
            if self._supervisor is not None and self._supervisor.is_alive():
                return
            self._stop.clear()
            self._supervisor = threading.Thread(
                target=self._supervise, name="folder-watch", daemon=True
            )
            self._supervisor.start()

    def stop(self, timeout: float = 5.0) -> None:
        """Stop every thread, waiting at most ``timeout`` seconds in total."""
        self._stop.set()
        self._reload.set()
        with self._lock:
            supervisor = self._supervisor
            workers = list(self._workers.values())
        for worker in workers:
            worker.stop.set()
        deadline = time.monotonic() + timeout
        threads = (
            [supervisor] + [w.thread for w in workers] + [w.catch_up for w in workers]
        )
        for thread in threads:
            if thread is not None:
                thread.join(max(0.0, deadline - time.monotonic()))

    def reload(self) -> None:
        """Re-read the watched roots now (after a switch was flipped)."""
        self._reload.set()

    def status(self) -> Dict[str, Any]:
        with self._lock:
            running = self._supervisor is not None and self._supervisor.is_alive()
            return {
                "running": running,
                "generation": self._generation,
                "roots": [worker.status.as_dict() for worker in self._workers.values()],
            }

    # Supervisor ----------------------------------------------------------

    def _supervise(self) -> None:
        while not self._stop.is_set():
            # Cleared before reading, so a switch flipped while the list is
            # being read still wakes the next round instead of being lost.
            self._reload.clear()
            try:
                self._sync_workers(self._list_roots())
            except Exception:
                logger.exception("Folder watch could not read the watched folders")
            self._reload.wait(SUPERVISOR_WAIT_SECONDS)
        with self._lock:
            workers = list(self._workers.values())
        for worker in workers:
            worker.stop.set()

    def _sync_workers(self, roots: List[RootRow]) -> None:
        from utils.source_paths import indexed_path_for_runtime

        wanted = {}
        for row in roots:
            runtime_path = indexed_path_for_runtime(str(row["path"]), os.name)
            root = {**row, "path": runtime_path}
            key = (int(root["id"]), runtime_path, str(root.get("library_id") or "main"))
            wanted[key] = root
        with self._lock:
            for key in list(self._workers):
                worker = self._workers[key]
                if (
                    key not in wanted
                    or worker.thread is None
                    or not worker.thread.is_alive()
                ):
                    worker.stop.set()
                    del self._workers[key]
            for key, root in wanted.items():
                if key not in self._workers:
                    self._workers[key] = self._start_worker(key, root)

    def _start_worker(self, key: tuple, root: RootRow) -> _Worker:
        polling = (
            self._force_polling
            if self._force_polling is not None
            else is_network_path(key[1])
        )
        worker = _Worker(
            root=root,
            polling=polling,
            status=RootStatus(
                root_id=key[0],
                path=key[1],
                library_id=key[2],
                mode="polling" if polling else "native",
            ),
        )
        worker.thread = threading.Thread(
            target=self._run_worker,
            args=(worker,),
            name=f"folder-watch-{key[0]}",
            daemon=True,
        )
        worker.thread.start()
        return worker

    # Worker --------------------------------------------------------------
    # A worker only ever touches its own status object, so a worker that is
    # still winding down after the switch was flipped off and on again cannot
    # overwrite the new worker's state.

    def _set_state(
        self, worker: _Worker, state: str, error: Optional[str] = None
    ) -> None:
        with self._lock:
            worker.status.state = state
            worker.status.error = error

    def _import(self, worker: _Worker, paths: Optional[Sequence[str]]) -> None:
        if worker.stop.is_set():
            return
        count = self._ingest(worker.root, paths, worker.stop.is_set)
        with self._lock:
            if paths is None:
                worker.status.last_catch_up_at = _now_text()
            if count > 0:
                worker.status.imported += count
                worker.status.last_import_at = _now_text()
                self._generation += 1

    def _run_worker(self, worker: _Worker) -> None:
        while not worker.stop.is_set():
            try:
                if not Path(str(worker.root["path"])).is_dir():
                    self._set_state(worker, "missing")
                    worker.stop.wait(self._retry_seconds)
                    continue
                self._set_state(worker, "catching_up")
                self._follow_events(worker)
            except Exception as exc:
                if worker.stop.is_set():
                    break
                if not Path(str(worker.root["path"])).is_dir():
                    continue
                logger.warning(
                    "Folder watch failed for %s: %s", worker.root.get("path"), exc
                )
                self._set_state(worker, "error", str(exc) or exc.__class__.__name__)
                worker.stop.wait(self._retry_seconds)

    def _start_catch_up(self, worker: _Worker) -> None:
        """Scan the whole root in its own thread so new pictures keep arriving meanwhile."""
        if worker.catch_up is not None and worker.catch_up.is_alive():
            return

        def run() -> None:
            try:
                self._import(worker, None)
                if not worker.stop.is_set():
                    self._set_state(worker, "watching")
            except Exception as exc:
                if not worker.stop.is_set():
                    logger.warning(
                        "Folder catch-up failed for %s: %s",
                        worker.root.get("path"),
                        exc,
                    )
                    self._set_state(worker, "error", str(exc) or exc.__class__.__name__)

        worker.catch_up = threading.Thread(
            target=run, name=f"folder-catch-up-{worker.status.root_id}", daemon=True
        )
        worker.catch_up.start()

    def _follow_events(self, worker: _Worker) -> None:
        from watchfiles import Change, watch

        extensions = _picture_extensions()
        root_path = str(worker.root["path"])

        root_key = os.path.normcase(os.path.abspath(root_path))

        def is_picture_change(change: Change, path: str) -> bool:
            if change == Change.deleted:
                # Only the folder's own deletion matters: it ends this round
                # (a batch with nothing left after filtering never reaches us).
                return os.path.normcase(os.path.abspath(path)) == root_key
            return Path(path).suffix.lower() in extensions

        pending: Dict[str, _Pending] = {}
        # The first round catches up the whole root. It starts after the
        # watcher is listening, so a picture written during a long catch-up
        # still arrives as an event instead of waiting for the next pass.
        next_catch_up = 0.0
        for changes in watch(
            root_path,
            watch_filter=is_picture_change,
            debounce=self._debounce_ms,
            stop_event=worker.stop,
            rust_timeout=EVENT_WAIT_MS,
            yield_on_timeout=True,
            raise_interrupt=False,
            force_polling=worker.polling,
            poll_delay_ms=self._poll_delay_ms,
            recursive=True,
            ignore_permission_denied=True,
        ):
            if worker.stop.is_set():
                return
            # An unplugged drive or a deleted folder leaves a dead handle that
            # never reports anything; notice it here, not at the next catch-up.
            if not Path(root_path).is_dir():
                return
            for _, path in changes:
                self._note_pending(pending, path)
            ready = self._take_ready(pending)
            if ready:
                self._import(worker, ready)
            if time.monotonic() >= next_catch_up:
                self._start_catch_up(worker)
                next_catch_up = time.monotonic() + CATCH_UP_INTERVAL_SECONDS

    @staticmethod
    def _note_pending(pending: Dict[str, _Pending], path: str) -> None:
        try:
            info = os.stat(path)
        except OSError:
            pending.pop(path, None)
            return
        pending[path] = _Pending(size=info.st_size, mtime_ns=info.st_mtime_ns)

    def _take_ready(self, pending: Dict[str, _Pending]) -> List[str]:
        """Pictures that stopped growing; still-growing ones wait for the next round."""
        ready: List[str] = []
        now = time.monotonic()
        for path, seen in list(pending.items()):
            try:
                info = os.stat(path)
            except OSError:
                del pending[path]
                continue
            if info.st_size != seen.size or info.st_mtime_ns != seen.mtime_ns:
                pending[path] = _Pending(size=info.st_size, mtime_ns=info.st_mtime_ns)
                continue
            quiet_for = now - seen.seen_at
            if quiet_for < self._stable_seconds or info.st_size == 0:
                continue
            # A PNG normally ends with IEND; one with data after it is taken
            # once it has not changed for a while.
            if (
                path.lower().endswith(".png")
                and not png_is_complete(path)
                and quiet_for < self._stable_seconds * PNG_GRACE_FACTOR
            ):
                continue
            if (
                is_video_path(path)
                and quiet_for < self._stable_seconds * VIDEO_GRACE_FACTOR
                and not video_is_complete(path)
            ):
                continue
            ready.append(path)
            del pending[path]
        return ready


_service: Optional[FolderWatchService] = None
_service_lock = threading.Lock()


def get_folder_watch_service() -> FolderWatchService:
    global _service
    if _service is None:
        with _service_lock:
            if _service is None:
                _service = FolderWatchService()
    return _service
