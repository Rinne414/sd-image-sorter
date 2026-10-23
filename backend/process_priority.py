"""Run background work below normal priority.

The program can stay open all day next to ComfyUI, a browser and games.
Background work - metadata worker processes, the gallery tagging worker,
folder watching, the idle-model sweeper - runs below normal priority so it
never makes the rest of the computer feel slow. The API server itself keeps
normal priority, so clicks in the program stay quick.

Windows: ``BELOW_NORMAL_PRIORITY_CLASS`` for a worker process (psutil), and
``THREAD_PRIORITY_BELOW_NORMAL`` for a thread the program owns. Linux and
macOS: ``nice`` +10 (on Linux a thread has its own nice value).
"""

from __future__ import annotations

import logging
import os
import sys
import threading
from typing import Any, Optional

logger = logging.getLogger(__name__)

BACKGROUND_NICE = 10
_THREAD_PRIORITY_BELOW_NORMAL = -1


def _psutil() -> Any:
    import psutil

    return psutil


def lower_process_priority(pid: Optional[int] = None) -> bool:
    """Put a worker process (this one when ``pid`` is None) below normal."""
    try:
        psutil = _psutil()
        process = psutil.Process(pid) if pid else psutil.Process()
        if sys.platform == "win32":
            process.nice(psutil.BELOW_NORMAL_PRIORITY_CLASS)
        else:
            process.nice(max(int(process.nice()), BACKGROUND_NICE))
        return True
    except Exception as exc:  # noqa: BLE001 - priority is a courtesy, never a failure
        logger.debug("Could not lower process priority: %s", exc)
        return False


def lower_current_thread_priority() -> bool:
    """Put the calling thread below normal; only for threads the program owns.

    Never call this on a shared pool thread (FastAPI's request threads): the
    pool would hand the lowered thread to the next request.
    """
    try:
        if sys.platform == "win32":
            import ctypes

            kernel32 = ctypes.windll.kernel32
            handle = kernel32.GetCurrentThread()
            return bool(
                kernel32.SetThreadPriority(handle, _THREAD_PRIORITY_BELOW_NORMAL)
            )
        if sys.platform.startswith("linux"):
            thread_id = threading.get_native_id()
            current = os.getpriority(os.PRIO_PROCESS, thread_id)
            os.setpriority(os.PRIO_PROCESS, thread_id, max(current, BACKGROUND_NICE))
            return True
    except Exception as exc:  # noqa: BLE001 - priority is a courtesy, never a failure
        logger.debug("Could not lower thread priority: %s", exc)
    return False
