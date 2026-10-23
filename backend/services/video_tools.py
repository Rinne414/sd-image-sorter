"""Find ffmpeg / ffprobe and run them as low-priority child processes.

Video support uses the two programs as subprocesses (never an in-process
library): a broken file or a hung decoder can only kill its own process, the
backend keeps running, and every call has a timeout.

Where they are looked for, first match wins:

1. ``<data>/tools/ffmpeg/bin`` - installed from inside the program
   (``services/ffmpeg_install.py``, LGPL shared build)
2. ``<program>/tools/ffmpeg/bin`` or ``<program>/ffmpeg`` - shipped beside it
3. the system ``PATH``

Both programs must come from the same place; a folder that has only one of
them is skipped.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional, Sequence

from config import PROJECT_ROOT, get_tools_dir

_EXE = ".exe" if sys.platform == "win32" else ""
# Windows: no console window, below-normal priority so a probe or a frame grab
# never takes CPU from the UI or a scan.
_WIN_FLAGS = 0x08000000 | 0x00004000  # CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS
_POSIX_NICENESS = 10


@dataclass(frozen=True)
class VideoTools:
    ffmpeg: str
    ffprobe: str
    source: str  # "installed" | "beside_program" | "path"


class VideoToolsMissing(RuntimeError):
    """ffmpeg/ffprobe are not available; the caller shows the install action."""


_cache_lock = threading.Lock()
_cached: Optional[VideoTools] = None
_cache_valid = False


def installed_bin_dir() -> Path:
    return Path(get_tools_dir()) / "ffmpeg" / "bin"


def _pair_in(folder: Path, source: str) -> Optional[VideoTools]:
    ffmpeg = folder / f"ffmpeg{_EXE}"
    ffprobe = folder / f"ffprobe{_EXE}"
    if ffmpeg.is_file() and ffprobe.is_file():
        return VideoTools(str(ffmpeg), str(ffprobe), source)
    return None


def _discover() -> Optional[VideoTools]:
    found = _pair_in(installed_bin_dir(), "installed")
    if found:
        return found
    for folder in (PROJECT_ROOT / "tools" / "ffmpeg" / "bin", PROJECT_ROOT / "ffmpeg"):
        found = _pair_in(folder, "beside_program")
        if found:
            return found
    ffmpeg = shutil.which("ffmpeg")
    ffprobe = shutil.which("ffprobe")
    if ffmpeg and ffprobe:
        return VideoTools(ffmpeg, ffprobe, "path")
    return None


def find_tools(*, refresh: bool = False) -> Optional[VideoTools]:
    """The ffmpeg/ffprobe pair, or None. Cached; ``refresh`` looks again."""
    global _cached, _cache_valid
    with _cache_lock:
        if refresh or not _cache_valid:
            _cached = _discover()
            _cache_valid = True
        return _cached


def require_tools() -> VideoTools:
    tools = find_tools()
    if tools is None:
        raise VideoToolsMissing("Video support (ffmpeg) is not installed")
    return tools


def forget_tools() -> None:
    """Drop the cached lookup (after an install or removal)."""
    global _cache_valid
    with _cache_lock:
        _cache_valid = False


def _lower_priority() -> None:  # pragma: no cover - runs in the child on POSIX
    try:
        os.nice(_POSIX_NICENESS)
    except OSError:
        pass


def popen_kwargs() -> dict:
    """Keyword arguments that start a quiet, low-priority child process."""
    if sys.platform == "win32":
        return {"creationflags": _WIN_FLAGS}
    return {"preexec_fn": _lower_priority}


def run_tool(
    args: Sequence[str], *, timeout: float, stdin_devnull: bool = True
) -> subprocess.CompletedProcess:
    """Run ffmpeg/ffprobe with a timeout; output is captured as bytes."""
    return subprocess.run(
        list(args),
        stdin=subprocess.DEVNULL if stdin_devnull else None,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
        check=False,
        **popen_kwargs(),
    )


def list_encoders(tools: VideoTools) -> List[str]:
    """Names of the encoders this ffmpeg build has (used to pick a preview codec)."""
    try:
        result = run_tool([tools.ffmpeg, "-hide_banner", "-encoders"], timeout=20)
    except (OSError, subprocess.TimeoutExpired):
        return []
    names = []
    for line in result.stdout.decode("utf-8", "replace").splitlines():
        parts = line.split()
        if len(parts) >= 2 and len(parts[0]) == 6 and parts[0][0] in "VAS":
            names.append(parts[1])
    return names
