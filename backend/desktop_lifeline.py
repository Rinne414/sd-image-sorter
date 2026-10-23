"""Stop the server when the desktop shell that started it goes away.

The desktop shell (desktop/) starts the backend with
``SD_IMAGE_SORTER_PARENT_PID`` set to its own process id. A watcher thread
waits for that process to end; when the shell quits, crashes or is ended
from Task Manager, the server shuts down the normal way, so no backend is
left holding the port.

Windows: the watcher opens the shell process once and waits on its handle,
so a reused process id cannot fool it. Elsewhere it checks every second
whether the process still exists.

(Watching a stdin pipe instead was tried and rejected: on Windows a thread
blocked reading stdin makes the metadata worker processes hang at start-up,
because they inherit that handle and synchronous I/O on it is serialized.)

Launchers that do not set the variable (run.bat, run-portable.bat, run.sh)
are unaffected.
"""

from __future__ import annotations

import logging
import os
import sys
import threading
import time
from typing import Callable, Mapping, Optional

logger = logging.getLogger(__name__)

PARENT_PID_ENV = "SD_IMAGE_SORTER_PARENT_PID"
POSIX_POLL_SECONDS = 1.0
_SYNCHRONIZE = 0x00100000
_INFINITE = 0xFFFFFFFF


def parent_pid_from(environ: Mapping[str, str] = os.environ) -> Optional[int]:
    """The shell's process id, or None when no shell asked to be watched."""
    raw = environ.get(PARENT_PID_ENV, "").strip()
    if not raw.isdigit() or int(raw) <= 0:
        return None
    return int(raw)


def _wait_windows(pid: int) -> None:
    import ctypes

    kernel32 = ctypes.windll.kernel32
    kernel32.OpenProcess.restype = ctypes.c_void_p
    handle = kernel32.OpenProcess(_SYNCHRONIZE, False, pid)
    if not handle:
        return  # Already gone (or never existed): treat as gone.
    try:
        kernel32.WaitForSingleObject(ctypes.c_void_p(handle), _INFINITE)
    finally:
        kernel32.CloseHandle(ctypes.c_void_p(handle))


def _process_exists(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _wait_posix(pid: int, poll_seconds: float) -> None:
    while _process_exists(pid):
        time.sleep(poll_seconds)


def watch_parent(
    pid: int,
    on_gone: Callable[[], None],
    poll_seconds: float = POSIX_POLL_SECONDS,
) -> threading.Thread:
    """Call ``on_gone`` once process ``pid`` has ended."""

    def run() -> None:
        if sys.platform == "win32":
            _wait_windows(pid)
        else:
            _wait_posix(pid, poll_seconds)
        logger.info("Desktop shell (process %s) is gone; stopping the server", pid)
        on_gone()

    thread = threading.Thread(target=run, name="desktop-lifeline", daemon=True)
    thread.start()
    return thread


def start_if_requested(
    on_gone: Callable[[], None],
    environ: Mapping[str, str] = os.environ,
) -> Optional[threading.Thread]:
    """Watch the desktop shell when it asked for it; otherwise do nothing."""
    pid = parent_pid_from(environ)
    if pid is None:
        return None
    return watch_parent(pid, on_gone)
