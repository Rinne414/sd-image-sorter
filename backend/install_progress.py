"""What a feature install is doing right now, for the progress bars.

pip (pip_runner.py) and Hugging Face downloads report here;
services/model_service.py passes it on to GET /api/models/download-progress,
which every interface reads. A child process (the PyTorch repair) reports
through a file its parent relays. Standard library only at import time.

Fields reported: active (bytes are moving), stage ("resolving", "downloading",
"installing" or "" when idle), filename, downloaded, total, file_index and
package_count.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import tempfile
import threading
from contextlib import contextmanager
from typing import Any, Callable, Dict, Iterator, Optional

logger = logging.getLogger(__name__)

CHILD_PROGRESS_ENV = "SD_SORTER_INSTALL_PROGRESS_FILE"
CHILD_RELAY_SECONDS = 0.5
IDLE: Dict[str, Any] = {
    "active": False,
    "stage": "",
    "filename": "",
    "downloaded": 0,
    "total": 0,
    "file_index": 0,
    "package_count": 0,
}
# Hub progress bars named for the whole job rather than one file.
GENERIC_BAR_NAMES = ("downloading", "fetching", "download complete")

_listener: Optional[Callable[..., None]] = None
_hub_watched = False
_hub_lock = threading.Lock()


def set_listener(listener: Optional[Callable[..., None]]) -> None:
    global _listener
    _listener = listener


def report(**fields: Any) -> None:
    """Pass on one progress update. Progress never gets to break an install."""
    if _listener is not None:
        _listener(**fields)
    child_file = os.environ.get(CHILD_PROGRESS_ENV)
    if child_file:
        temporary = f"{child_file}.{os.getpid()}.tmp"
        try:
            with open(temporary, "w", encoding="utf-8") as handle:
                json.dump(fields, handle)
            os.replace(temporary, child_file)
        except OSError as error:
            logger.debug("Could not write install progress: %s", error)


def report_idle() -> None:
    report(**IDLE)


@contextmanager
def relay_child_progress() -> Iterator[Dict[str, str]]:
    """Yields the environment a child process needs; relays what it reports until the block ends."""
    folder = tempfile.mkdtemp(prefix="sd-sorter-progress-")
    path = os.path.join(folder, "progress.json")
    stop = threading.Event()

    def relay() -> None:
        last = None
        while not stop.wait(CHILD_RELAY_SECONDS):
            try:
                with open(path, encoding="utf-8") as handle:
                    text = handle.read()
                if text != last:
                    last = text
                    fields = json.loads(text)
                    if _listener is not None:
                        _listener(**fields)
            except (OSError, ValueError):
                continue

    thread = threading.Thread(target=relay, name="install-progress-relay", daemon=True)
    thread.start()
    try:
        yield {CHILD_PROGRESS_ENV: path}
    finally:
        stop.set()
        thread.join(timeout=2)
        if _listener is not None:
            _listener(**IDLE)
        shutil.rmtree(folder, ignore_errors=True)


def _bar_file_name(description: str) -> str:
    name = description.strip().rstrip(":").strip()
    return "" if name.lower().startswith(GENERIC_BAR_NAMES) else name


def watch_hub_downloads() -> None:
    """Report the bytes of every Hugging Face download, third-party callers included.

    open_clip, fastembed and our own loaders all go through the Hub's one progress
    bar class, so this is the one place that sees them all. Counts its own bytes
    because a disabled bar stops counting.
    """
    global _hub_watched
    with _hub_lock:
        if _hub_watched:
            return
        _hub_watched = True
    try:
        from huggingface_hub.utils.tqdm import tqdm as hub_bar
    except ImportError as error:
        logger.debug("Hugging Face progress is not available: %s", error)
        with _hub_lock:
            _hub_watched = False
        return

    original_init = hub_bar.__init__
    original_update = hub_bar.update
    original_close = hub_bar.close

    def init(self: Any, *args: Any, **kwargs: Any) -> None:
        self._install_counts_bytes = kwargs.get("unit") == "B"
        self._install_name = _bar_file_name(str(kwargs.get("desc") or ""))
        self._install_done = int(kwargs.get("initial") or 0)
        original_init(self, *args, **kwargs)

    def update(self: Any, n: Any = 1) -> Any:
        result = original_update(self, n)
        if getattr(self, "_install_counts_bytes", False):
            self._install_done += int(n or 0)
            report(
                active=True,
                stage="downloading",
                filename=self._install_name,
                downloaded=self._install_done,
                total=int(self.total or 0),
            )
        return result

    def close(self: Any) -> Any:
        was_counting = getattr(self, "_install_counts_bytes", False)
        self._install_counts_bytes = False
        result = original_close(self)
        if was_counting:
            report_idle()
        return result

    hub_bar.__init__ = init
    hub_bar.update = update
    hub_bar.close = close
