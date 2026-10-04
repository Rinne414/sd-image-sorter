"""What an export folder already holds, so the confirm can say so.

Exporting twice into one folder used to mix two datasets without a word (the
default "add a number" policy keeps both sets). Exporting there stays allowed;
this read-only count lets the Dataset Maker confirm warn before it happens.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Dict, List, Union

from config import ALLOWED_IMAGE_EXTENSIONS
from services.dataset_export._constants import EXPORT_MANIFEST_FILENAME
from utils.path_validation import normalize_user_path

CAPTION_EXTENSIONS = frozenset({".txt", ".caption"})
# kohya trains every "<repeats>_<name>" folder under its train dir.
KOHYA_FOLDER_RE = re.compile(r"^\d+_.+")
MAX_LISTED_KOHYA_FOLDERS = 10


def output_folder_status(output_folder: str) -> Dict[str, Union[bool, int, List[str]]]:
    """Count the files directly inside ``output_folder`` (not recursive).

    A folder that does not exist yet reports ``exists: False`` and zeros.
    Raises ``ValueError`` for a path that is not a usable folder path.
    """
    folder = Path(normalize_user_path(output_folder))
    status: Dict[str, Union[bool, int, List[str]]] = {
        "exists": False,
        "file_count": 0,
        "image_count": 0,
        "caption_count": 0,
        "has_export_manifest": False,
        "other_kohya_folders": _other_kohya_exports(folder),
    }
    if not folder.is_dir():
        return status
    status["exists"] = True
    with os.scandir(folder) as entries:
        for entry in entries:
            if not entry.is_file():
                continue
            status["file_count"] += 1
            suffix = Path(entry.name).suffix.lower()
            if suffix in ALLOWED_IMAGE_EXTENSIONS:
                status["image_count"] += 1
            elif suffix in CAPTION_EXTENSIONS:
                status["caption_count"] += 1
            elif entry.name == EXPORT_MANIFEST_FILENAME:
                status["has_export_manifest"] = True
    return status


def _other_kohya_exports(folder: Path) -> List[str]:
    """Earlier exports beside a kohya concept folder (``10_foo`` next to ``15_foo``).

    kohya reads all of them, so the same pictures would train twice. Only
    folders holding an export manifest count, so unrelated folders stay out.
    """
    if not KOHYA_FOLDER_RE.match(folder.name) or not folder.parent.is_dir():
        return []
    found: List[str] = []
    with os.scandir(folder.parent) as entries:
        for entry in entries:
            if entry.name == folder.name or not entry.is_dir() or not KOHYA_FOLDER_RE.match(entry.name):
                continue
            if (Path(entry.path) / EXPORT_MANIFEST_FILENAME).is_file():
                found.append(entry.name)
    return sorted(found)[:MAX_LISTED_KOHYA_FOLDERS]
