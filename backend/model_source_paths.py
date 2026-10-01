"""Is this path on the network, and may the request thread read it? (MS1a)

Pure string and local-drive-table work plus ``lstat`` without following
links: nothing on the network is ever touched here. ``model_roots`` owns
the UNC spellings; this module adds mapped and removable drives, Linux
network mounts (``/proc/mounts``) and symlinks or junctions whose target is
one of those.
"""

from __future__ import annotations

import logging
import os
import posixpath
import stat as stat_module
import sys
import threading
import time
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import model_roots

logger = logging.getLogger(__name__)

# Windows drive types (GetDriveTypeW).
_DRIVE_REMOVABLE = 2
_DRIVE_FIXED = 3
_DRIVE_REMOTE = 4
_REPARSE_POINT = getattr(stat_module, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)

# Linux filesystem types that mean "somewhere on the network".
_LINUX_NETWORK_FS = {
    "nfs",
    "nfs4",
    "cifs",
    "smb3",
    "smbfs",
    "sshfs",
    "afs",
    "ncpfs",
    "9p",
    "ceph",
    "glusterfs",
}
_LINUX_MOUNTS_TTL_SECONDS = 30.0


# ---------------------------------------------------------------------------


def normalize_path(raw: str) -> str:
    expanded = os.path.expanduser(os.path.expandvars(str(raw).strip()))
    return os.path.normpath(os.path.abspath(expanded))


def _same_path(a: str, b: str) -> bool:
    return os.path.normcase(a) == os.path.normcase(b)


def _drive_type(path: str) -> Optional[int]:
    if sys.platform != "win32":
        return None
    drive, _ = os.path.splitdrive(path)
    if not drive or drive.startswith("\\\\"):
        return None
    try:
        import ctypes

        return int(ctypes.windll.kernel32.GetDriveTypeW(drive + "\\"))
    except (AttributeError, OSError, ValueError) as exc:
        logger.warning("Drive type of %s unknown: %s", drive, exc)
        return None


def _read_linux_mounts() -> List[Tuple[str, str]]:
    """(mount point, filesystem type) rows of ``/proc/mounts``."""
    rows: List[Tuple[str, str]] = []
    with open("/proc/mounts", "r", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            parts = line.split()
            if len(parts) >= 3:
                rows.append((parts[1].replace("\\040", " "), parts[2]))
    return rows


_linux_mounts_lock = threading.Lock()
_linux_mounts: Optional[List[Tuple[str, str]]] = None
_linux_mounts_read_at = 0.0


def _forget_linux_mounts() -> None:
    global _linux_mounts, _linux_mounts_read_at
    with _linux_mounts_lock:
        _linux_mounts = None
        _linux_mounts_read_at = 0.0


def _linux_network_mounts() -> List[str]:
    """Mount points whose filesystem is a network one; empty (and logged) when unreadable."""
    global _linux_mounts, _linux_mounts_read_at
    with _linux_mounts_lock:
        if (
            _linux_mounts is None
            or time.monotonic() - _linux_mounts_read_at > _LINUX_MOUNTS_TTL_SECONDS
        ):
            try:
                _linux_mounts = _read_linux_mounts()
            except OSError as exc:
                logger.warning(
                    "/proc/mounts unreadable (%s); no mount is treated as network", exc
                )
                _linux_mounts = []
            _linux_mounts_read_at = time.monotonic()
        rows = list(_linux_mounts)
    return [
        point
        for point, fstype in rows
        if fstype in _LINUX_NETWORK_FS or fstype.startswith("fuse.")
    ]


def _under_mount(path: str, mount: str) -> bool:
    if mount == "/":
        return True
    return path == mount or path.startswith(mount.rstrip("/") + "/")


def is_network_path(path: object) -> bool:
    """UNC in any spelling or NT namespace (``model_roots``), a mapped or
    removable drive (Windows), or a network mount (Linux). Pure string work
    plus the local drive table: nothing on the network is touched."""
    text = str(path or "")
    if model_roots.is_network_path(text):
        return True
    if sys.platform == "win32":
        return _drive_type(text) in (_DRIVE_REMOTE, _DRIVE_REMOVABLE)
    if sys.platform.startswith("linux"):
        normalized = posixpath.normpath(text)
        return any(_under_mount(normalized, mount) for mount in _linux_network_mounts())
    return False


def is_reparse_entry(entry: os.DirEntry) -> bool:
    """A symlink or (Windows) junction; never followed by scans and walks."""
    try:
        if entry.is_symlink():
            return True
        if sys.platform == "win32":
            return bool(
                entry.stat(follow_symlinks=False).st_file_attributes & _REPARSE_POINT
            )
    except OSError:
        return True
    return False


def _reparse_target(path: str) -> Optional[str]:
    """The link target when ``path`` is a symlink or junction (not followed), else None."""
    try:
        info = os.lstat(path)
    except OSError:
        return None
    is_link = stat_module.S_ISLNK(info.st_mode)
    if sys.platform == "win32":
        is_link = is_link or bool(
            getattr(info, "st_file_attributes", 0) & _REPARSE_POINT
        )
    if not is_link:
        return None
    try:
        return os.readlink(path)
    except OSError:
        return ""


def judge_path(
    root: str,
    path: str,
    *,
    network_allowed: bool,
    cache: Optional[Dict[str, Tuple[bool, bool]]] = None,
) -> Tuple[bool, bool]:
    """(readable, is_network) for ``path`` inside ``root``.

    Every component below the root is lstat'ed without following links; a
    symlink or junction whose target is a network location makes the path a
    network path, readable only when ``network_allowed``. A component that
    cannot be lstat'ed is not readable.
    """
    key = os.path.normcase(path)
    if cache is not None and key in cache:
        return cache[key]
    verdict = _judge_uncached(root, path, network_allowed=network_allowed, cache=cache)
    if cache is not None:
        cache[key] = verdict
    return verdict


def _judge_uncached(
    root: str,
    path: str,
    *,
    network_allowed: bool,
    cache: Optional[Dict[str, Tuple[bool, bool]]],
) -> Tuple[bool, bool]:
    if is_network_path(path):
        return network_allowed, True
    parent = os.path.dirname(path)
    inherited_network = False
    if (
        parent
        and len(parent) < len(path)
        and not _same_path(parent, root)
        and os.path.normcase(parent).startswith(os.path.normcase(root))
    ):
        parent_ok, inherited_network = judge_path(
            root, parent, network_allowed=network_allowed, cache=cache
        )
        if not parent_ok:
            return False, inherited_network
    target = _reparse_target(path)
    if target is None:
        return True, inherited_network
    if target == "" or is_network_path(target):
        return network_allowed, True
    return True, inherited_network


def list_fixed_drives() -> List[str]:
    """Roots the T2 scan walks: fixed local drives on Windows, home/opt/srv elsewhere."""
    if sys.platform == "win32":
        try:
            import ctypes
            import string

            mask = ctypes.windll.kernel32.GetLogicalDrives()
        except (AttributeError, OSError) as exc:
            logger.warning("Drive list unavailable: %s", exc)
            return []
        drives = []
        for index, letter in enumerate(string.ascii_uppercase):
            if mask & (1 << index) and _drive_type(f"{letter}:\\") == _DRIVE_FIXED:
                drives.append(f"{letter}:\\")
        return drives
    # /mnt and /media are where network and removable volumes land: never scanned.
    candidates = [str(Path.home()), "/opt", "/srv"]
    return [c for c in candidates if os.path.isdir(c)]
