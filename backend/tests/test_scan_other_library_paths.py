"""A scan lists every image that already belongs to another library.

The post-scan button offers "Move N into this library" with N = all of them,
but only the first 200 paths used to be recorded, so the move silently
stopped at 200.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image

import db_libraries as libdb
from image_manager import scan_folder
from library_context import reset_current_library_id, set_current_library_id

IMAGE_COUNT = 250


def test_every_other_library_path_is_recorded(test_db, tmp_path: Path) -> None:
    for index in range(IMAGE_COUNT):
        Image.new("RGB", (8, 8), (index % 255, 0, 0)).save(
            tmp_path / f"img-{index:03d}.png"
        )
    scan_folder(str(tmp_path), recursive=False, quick_import=True)

    other = libdb.create_library("Other")
    token = set_current_library_id(other["id"])
    try:
        result = scan_folder(str(tmp_path), recursive=False, quick_import=True)
    finally:
        reset_current_library_id(token)

    assert result["skipped_other_library"] == IMAGE_COUNT
    assert len(result["skipped_other_library_paths"]) == IMAGE_COUNT
    assert len(set(result["skipped_other_library_paths"])) == IMAGE_COUNT
