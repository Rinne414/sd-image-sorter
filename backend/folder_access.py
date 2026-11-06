"""Can this program write to a folder? Asked before creating temporary files in it.

On Windows, tempfile.mkstemp, NamedTemporaryFile and mkdtemp take a refused
write for a name clash and try again up to 2,147,483,647 times, so a folder
without write permission makes them hang instead of raising an error (seen
2026-11-07). Anything that creates a temporary file in a chosen folder calls
require_writable first; tests/test_folder_access.py fails when one does not.
Standard library only: launchers use it before the packages exist.
"""

from __future__ import annotations

import errno
import os
import uuid
from pathlib import Path
from typing import Union


def folder_is_writable(folder: Union[str, Path]) -> bool:
    """Create a real file, because os.access says nothing useful on Windows."""
    probe = os.path.join(str(folder), f".write-check-{os.getpid()}-{uuid.uuid4().hex}")
    try:
        handle = os.open(probe, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except OSError:
        return False
    os.close(handle)
    try:
        os.unlink(probe)
    except OSError:
        pass
    return True


def require_writable(folder: Union[str, Path]) -> None:
    """Raise PermissionError right away for a folder that cannot be written."""
    if not folder_is_writable(folder):
        raise PermissionError(
            errno.EACCES, "No permission to write to this folder", str(folder)
        )
