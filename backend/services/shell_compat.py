"""Which desktop shell versions a release works with.

The desktop shell (``desktop/``, ``SD Image Sorter.exe``) is a separate layer
with its own version. The in-app updater only replaces ``backend/`` and
``frontend/``; it never touches the shell's files, which are locked while the
shell runs. A release names the oldest shell it still works with
(``min_shell_version`` in the release manifest). When the running shell is
older, the update is not installed in place: the user is told to download
the full package instead.

The shell tells the backend its own version through
``SD_IMAGE_SORTER_SHELL_VERSION``; without it (browser launchers) nothing here
applies.
"""

from __future__ import annotations

import os
import re
from typing import Any, Mapping, Optional

SHELL_VERSION_ENV = "SD_IMAGE_SORTER_SHELL_VERSION"

_NUMBER_RE = re.compile(r"\d+")


def running_shell_version(environ: Mapping[str, str] = os.environ) -> Optional[str]:
    """The version of the desktop shell that started this server, or None."""
    text = str(environ.get(SHELL_VERSION_ENV) or "").strip()
    return text or None


def _numeric_key(version: str) -> tuple[int, ...]:
    """Dotted numbers of a shell version ("0.2.0-beta" -> (0, 2, 0)); shells have no pre-releases."""
    core = version.strip().lstrip("vV").split("-", 1)[0].split("+", 1)[0]
    return tuple(int(part) for part in _NUMBER_RE.findall(core))


def shell_is_older(shell_version: str, minimum: str) -> bool:
    """True when ``shell_version`` is below ``minimum`` (missing parts count as 0)."""
    have, need = _numeric_key(shell_version), _numeric_key(minimum)
    width = max(len(have), len(need))
    return have + (0,) * (width - len(have)) < need + (0,) * (width - len(need))


def shell_requirement(
    manifest: Mapping[str, Any], shell_version: str, latest_version: str
) -> Optional[dict[str, Any]]:
    """Describe why a release cannot be installed in place, or None when it can.

    ``manifest`` is the release manifest; a missing or unreadable
    ``min_shell_version`` means the release works with any shell.
    """
    minimum = str(manifest.get("min_shell_version") or "").strip()
    if (
        not minimum
        or not _numeric_key(minimum)
        or not shell_is_older(shell_version, minimum)
    ):
        return None
    return {
        "min_shell_version": minimum,
        "shell_version": shell_version,
        "latest_shell_version": str(manifest.get("shell_version") or "").strip()
        or None,
        "reason": (
            f"Version {latest_version} needs a newer desktop program: this one is {shell_version}, "
            f"it needs {minimum} or newer, and the in-app update cannot replace it. "
            "Download the full package (windows-portable.zip) from the release page and use it instead. "
            f"/ {latest_version} 版需要更新桌面程序：当前是 {shell_version}，需要 {minimum} 或更新，"
            "程序内更新无法替换它。请从发布页下载完整包（windows-portable.zip）后使用。"
        ),
    }
