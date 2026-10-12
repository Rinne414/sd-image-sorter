"""Open an existing folder in the OS file manager (Explorer, Finder, xdg-open).

``POST /api/open-folder`` opens the folder of an indexed image by id. This
opens a folder the caller names (an export destination, the target of a
move), so the path is untrusted: it must pass ``validate_folder_path`` and be
an existing directory. The launcher gets an argument list, never a shell, and
only a directory, so Explorer cannot be asked to run a file.
"""

import logging
import os
import subprocess
from typing import Any, Callable, Dict, List

from fastapi import HTTPException

from utils.path_validation import normalize_user_path, validate_folder_path

logger = logging.getLogger(__name__)

_MISSING = "Path does not exist"


def file_manager_command(platform: str, directory: str) -> List[str]:
    """The argument list that shows ``directory`` in the platform's file manager."""
    if platform == "win32":
        return ["explorer", directory]
    if platform == "darwin":
        return ["open", directory]
    return ["xdg-open", directory]


def open_directory(
    raw_path: str,
    *,
    platform: str,
    popen: Callable[[List[str]], Any] = subprocess.Popen,
) -> Dict[str, Any]:
    """Open an existing directory in the file manager; 404 when it is gone, 400 when it is not a folder."""
    is_valid, error = validate_folder_path(raw_path)
    if not is_valid:
        status = 404 if error == _MISSING else 400
        raise HTTPException(status_code=status, detail=error or "Invalid folder path")

    directory = os.path.normpath(str(os.path.realpath(normalize_user_path(raw_path))))
    # Checked again on the resolved path: a link can point somewhere that is not a folder.
    if not os.path.isdir(directory):
        raise HTTPException(status_code=400, detail="Path is not a directory")

    try:
        popen(file_manager_command(platform, directory))
    except Exception as exc:
        logger.error("Failed to open folder %s: %s", directory, exc)
        raise HTTPException(
            status_code=500, detail=f"Failed to open folder: {exc}"
        ) from exc
    return {"success": True, "path": directory}
