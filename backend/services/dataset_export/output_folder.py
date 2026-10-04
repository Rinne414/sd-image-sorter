"""What an export folder already holds, so the confirm can say so.

Exporting twice into one folder used to mix two datasets without a word (the
default "add a number" policy keeps both sets). Exporting there stays allowed;
this read-only count lets the Dataset Maker confirm warn before it happens.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Dict, Union

from config import ALLOWED_IMAGE_EXTENSIONS
from services.dataset_export._constants import EXPORT_MANIFEST_FILENAME
from utils.path_validation import normalize_user_path

CAPTION_EXTENSIONS = frozenset({".txt", ".caption"})


def output_folder_status(output_folder: str) -> Dict[str, Union[bool, int]]:
    """Count the files directly inside ``output_folder`` (not recursive).

    A folder that does not exist yet reports ``exists: False`` and zeros.
    Raises ``ValueError`` for a path that is not a usable folder path.
    """
    folder = Path(normalize_user_path(output_folder))
    status: Dict[str, Union[bool, int]] = {
        "exists": False,
        "file_count": 0,
        "image_count": 0,
        "caption_count": 0,
        "has_export_manifest": False,
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
