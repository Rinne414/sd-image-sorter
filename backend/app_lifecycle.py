"""Stopping and restarting the running server.

A restart is a graceful shutdown that ends with exit code ``RESTART_EXIT_CODE``.
Launchers that set ``SD_IMAGE_SORTER_RESTART_LOOP=1`` start the server again in
the same console on that code, so the port and the browser tab stay the same.
Older launchers without the loop still restart through ``update_worker.py``.
"""

from __future__ import annotations

import logging
import os
import signal
import threading
import time
import uuid
from typing import Any, Optional

logger = logging.getLogger(__name__)

RESTART_EXIT_CODE = 75
RESTART_LOOP_ENV = "SD_IMAGE_SORTER_RESTART_LOOP"

# Changes on every start, so a page can tell the restarted server from the old one.
BOOT_ID = uuid.uuid4().hex

# A shutdown that hangs (a stuck worker thread, a slow lifespan hook) must not
# leave the user waiting on a server that never comes back.
EXIT_WATCHDOG_SECONDS = 20.0

_server: Optional[Any] = None
_restart_requested = False


def launcher_restarts_in_place() -> bool:
    return os.environ.get(RESTART_LOOP_ENV) == "1"


def attach_server(server: Any) -> None:
    """Remember the uvicorn server so an exit request can stop it gracefully."""
    global _server
    _server = server


def exit_code_after_shutdown() -> int:
    return RESTART_EXIT_CODE if _restart_requested else 0


def request_exit(*, restart: bool) -> None:
    """Stop the server; with ``restart`` the launcher loop starts it again."""
    global _restart_requested
    _restart_requested = restart
    exit_code = exit_code_after_shutdown()
    _start_exit_watchdog(exit_code)
    if _server is not None:
        _server.should_exit = True
        return
    os.kill(os.getpid(), signal.SIGINT)


def _start_exit_watchdog(exit_code: int) -> None:
    def _force_exit() -> None:
        time.sleep(EXIT_WATCHDOG_SECONDS)
        logger.warning(
            "Shutdown did not finish within %.0f s; exiting with code %s",
            EXIT_WATCHDOG_SECONDS,
            exit_code,
        )
        os._exit(exit_code)

    threading.Thread(target=_force_exit, name="exit-watchdog", daemon=True).start()
