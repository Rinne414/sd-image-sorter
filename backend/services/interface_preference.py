"""Which interface opens at ``/``: the classic one or V Opus.

Both interfaces work on the same backend and library. The choice is made in
either interface's Settings and kept in ``CONFIG_DIR/interface.json``, so
every browser and every launch opens the same one. A missing or unreadable
file means the classic interface, the default.
"""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path

from config import CONFIG_DIR

logger = logging.getLogger(__name__)

CLASSIC = "classic"
VOPUS = "vopus"
INTERFACES = (CLASSIC, VOPUS)

# Windows refuses to replace a file while another reader holds it open (the
# ``/`` route reading the choice, an antivirus scan, the search indexer); a
# short retry covers that moment.
_REPLACE_ATTEMPTS = 5
_REPLACE_RETRY_SECONDS = 0.1
# What the page shows when the file stays held: short, no path, no errno.
INTERFACE_FILE_BUSY_ERROR = (
    "The interface choice is in use by another program, so it was not saved. Try again. / "
    "界面选择文件正被其他程序占用，这次没有保存，请重试。"
)


class InterfaceChoiceBusyError(OSError):
    """The choice file stayed held by another program through every retry."""


def _preference_path() -> Path:
    return Path(CONFIG_DIR) / "interface.json"


def get_preferred_interface() -> str:
    """The remembered interface, ``classic`` unless ``vopus`` was chosen."""
    path = _preference_path()
    try:
        value = json.loads(path.read_text(encoding="utf-8")).get("interface")
    except FileNotFoundError:
        return CLASSIC
    except (OSError, ValueError, AttributeError) as exc:
        logger.warning("Ignoring unreadable interface choice in %s: %s", path, exc)
        return CLASSIC
    return value if value in INTERFACES else CLASSIC


def set_preferred_interface(value: str) -> str:
    """Remember ``value`` (one of ``INTERFACES``); written atomically."""
    if value not in INTERFACES:
        raise ValueError(f"Unknown interface: {value!r}")
    path = _preference_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_name(path.name + ".tmp")
    partial.write_text(json.dumps({"interface": value}), encoding="utf-8")
    try:
        _replace_with_retry(partial, path)
    finally:
        _discard_partial(partial)
    return value


def _replace_with_retry(partial: Path, path: Path) -> None:
    """``os.replace``, waiting out a reader that holds ``path`` for a moment.

    Raises ``InterfaceChoiceBusyError`` when it stays held; the path and errno
    go to the log.
    """
    for attempt in range(_REPLACE_ATTEMPTS):
        try:
            os.replace(partial, path)
            return
        except PermissionError as exc:
            if attempt == _REPLACE_ATTEMPTS - 1:
                logger.warning(
                    "Could not replace %s after %d attempts (errno %s): %s",
                    path,
                    _REPLACE_ATTEMPTS,
                    exc.errno,
                    exc,
                )
                raise InterfaceChoiceBusyError(INTERFACE_FILE_BUSY_ERROR) from exc
            time.sleep(_REPLACE_RETRY_SECONDS)


def _discard_partial(partial: Path) -> None:
    """Remove the temp file (gone already after a replace). A reader holding
    it only leaves it behind; that must not hide why the save failed."""
    try:
        partial.unlink(missing_ok=True)
    except OSError as exc:
        logger.warning("Could not remove %s: %s", partial, exc)
