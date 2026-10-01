"""Is this path on the network, and may the request thread read it? (MS1a)

Pure string and local-drive-table work plus ``lstat`` / ``readlink`` without
following links: nothing on the network is ever touched here.
``model_roots`` owns the UNC spellings; this module adds the NT prefixes a
``readlink`` returns (``\\\\?\\C:\\x`` is local, ``\\\\?\\UNC\\s\\x`` is not),
mapped and removable drives, Linux network mounts (``/proc/mounts``) and
symlinks or junctions whose target is one of those.

``resolve_local_chain`` is the one gate every root, extra folder and
candidate folder goes through: it walks the path from the drive root, one
component at a time, follows local links by their target string and stops
at the first network one. ``judge_path`` does the same for files below an
already resolved base.
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
from typing import Dict, List, Optional, Sequence, Tuple

import model_roots

logger = logging.getLogger(__name__)

# Windows drive types (GetDriveTypeW).
_DRIVE_REMOVABLE = 2
_DRIVE_FIXED = 3
_DRIVE_REMOTE = 4
_REPARSE_POINT = getattr(stat_module, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
_NT_PREFIXES = ("\\\\?\\", "\\??\\")
_MAX_LINK_HOPS = 40

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

KIND_LOCAL = "local"
KIND_NETWORK = "network"
KIND_MISSING = "missing"


# ---------------------------------------------------------------------------
# Strings only
# ---------------------------------------------------------------------------


def normalize_path(raw: str) -> str:
    expanded = os.path.expanduser(os.path.expandvars(str(raw).strip()))
    return os.path.normpath(os.path.abspath(expanded))


def _same_path(a: str, b: str) -> bool:
    return os.path.normcase(a) == os.path.normcase(b)


def _windows_form(raw: object) -> str:
    """Every slash as a backslash; pure string work. A copy of the private
    helper in ``model_roots`` (kept private there on purpose)."""
    return str(raw or "").strip().replace("/", "\\")


def strip_nt_prefix(raw: object) -> str:
    """``\\\\?\\C:\\x`` and ``\\??\\C:\\x`` become ``C:\\x``; the ``UNC``
    forms become ``\\\\server\\share``. Anything else is returned unchanged."""
    text = str(raw or "")
    form = _windows_form(text)
    for prefix in _NT_PREFIXES:
        if form.startswith(prefix):
            rest = form[len(prefix) :]
            if rest[:4].upper() == "UNC\\":
                return "\\\\" + rest[4:]
            return rest
    return text


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
    """UNC in any spelling (``model_roots``) after the NT prefixes are
    stripped, a mapped or removable drive (Windows), or a network mount
    (Linux). Pure string work plus the local drive table: nothing on the
    network is touched."""
    original = str(path or "")
    text = strip_nt_prefix(original)
    if model_roots.is_network_path(text):
        return True
    if sys.platform == "win32":
        return _drive_type(text) in (_DRIVE_REMOTE, _DRIVE_REMOVABLE)
    if sys.platform.startswith("linux"):
        normalized = posixpath.normpath(original)
        return any(_under_mount(normalized, mount) for mount in _linux_network_mounts())
    return False


# ---------------------------------------------------------------------------
# Links, one component at a time
# ---------------------------------------------------------------------------


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


def _link_target(path: str) -> Tuple[str, Optional[str]]:
    """``("none", None)`` for a plain entry, ``("link", target)`` for a symlink
    or junction (target as stored, not followed; ``None`` when it cannot be
    read), ``("missing", None)`` when the entry cannot be lstat'ed."""
    try:
        info = os.lstat(path)
    except OSError:
        return KIND_MISSING, None
    is_link = stat_module.S_ISLNK(info.st_mode)
    if sys.platform == "win32":
        is_link = is_link or bool(
            getattr(info, "st_file_attributes", 0) & _REPARSE_POINT
        )
    if not is_link:
        return "none", None
    try:
        return "link", os.readlink(path)
    except OSError:
        return "link", None


def _absolute_target(link_path: str, target: str) -> str:
    cleaned = strip_nt_prefix(target)
    if not os.path.isabs(cleaned):
        cleaned = os.path.join(os.path.dirname(link_path), cleaned)
    return os.path.normpath(cleaned)


def _first_link(text: str) -> Tuple[Optional[str], Optional[str], List[str]]:
    """Walk ``text`` from its drive root; (kind, prefix, remaining parts) at the
    first link or missing component, or ``(None, None, [])`` when there is none."""
    drive, tail = os.path.splitdrive(text)
    parts = [p for p in tail.split(os.sep) if p]
    prefix = (drive + os.sep) if drive else os.sep
    for index, part in enumerate(parts):
        prefix = os.path.join(prefix, part)
        kind, target = _link_target(prefix)
        if kind == "none":
            continue
        if kind == KIND_MISSING or target is None:
            return KIND_MISSING, prefix, []
        return _absolute_target(prefix, target), prefix, parts[index + 1 :]
    return None, None, []


def resolve_local_chain(path: object) -> Tuple[str, str]:
    """(kind, resolved path): ``local`` with every link followed to a local
    folder, ``network`` at the first component whose target is a network
    location (that target is returned, never touched), or ``missing``.

    Only ``lstat`` and ``readlink`` of local components are used; a network
    path is recognised by its string before anything is stat'ed.
    """
    text = os.path.normpath(os.path.abspath(str(path or "")))
    for _hop in range(_MAX_LINK_HOPS):
        if is_network_path(text):
            return KIND_NETWORK, text
        target, prefix, remaining = _first_link(text)
        if target is None:
            return KIND_LOCAL, text
        if target == KIND_MISSING:
            return KIND_MISSING, prefix or text
        text = os.path.join(target, *remaining) if remaining else target
    return KIND_MISSING, text


def _under_base(path: str, bases: Sequence[str]) -> bool:
    key = os.path.normcase(path)
    for base in bases:
        base_key = os.path.normcase(base)
        if key == base_key or key.startswith(base_key.rstrip(os.sep) + os.sep):
            return True
    return False


def judge_path(
    bases: Sequence[str],
    path: str,
    *,
    network_allowed: bool,
    cache: Optional[Dict[str, Tuple[bool, bool]]] = None,
) -> Tuple[bool, bool]:
    """(readable, is_network) for ``path`` below one of the already resolved ``bases``.

    Every component below the base is lstat'ed without following links; a
    link is resolved with ``resolve_local_chain`` and makes the path a
    network path when it ends on the network (readable only when
    ``network_allowed``). A component that cannot be lstat'ed is not readable.
    """
    key = os.path.normcase(path)
    if cache is not None and key in cache:
        return cache[key]
    verdict = _judge_uncached(bases, path, network_allowed=network_allowed, cache=cache)
    if cache is not None:
        cache[key] = verdict
    return verdict


def _judge_uncached(
    bases: Sequence[str],
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
        and _under_base(parent, bases)
        and not any(_same_path(parent, base) for base in bases)
    ):
        parent_ok, inherited_network = judge_path(
            bases, parent, network_allowed=network_allowed, cache=cache
        )
        if not parent_ok:
            return False, inherited_network
    kind, target = _link_target(path)
    if kind == KIND_MISSING or (kind == "link" and target is None):
        return False, inherited_network
    if kind == "none":
        return True, inherited_network
    target_kind, _resolved = resolve_local_chain(_absolute_target(path, target))
    if target_kind == KIND_NETWORK:
        return network_allowed, True
    if target_kind == KIND_MISSING:
        return False, inherited_network
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
