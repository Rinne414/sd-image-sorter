"""A picture whose EXIF Orientation is outside 1 through 8 is a normal picture.

Real files carry Orientation=0; viewers show them unrotated. The dataset
readiness check used to report such a picture as "missing or unreadable".
"""

from pathlib import Path

import pytest
from PIL import Image

from services.dataset_export import readiness
from services.dataset_image_geometry import (
    normalize_source_orientation,
    read_exif_orientation,
)

ORIENTATION_TAG = 274


def _save_jpeg(path: Path, orientation) -> Path:
    image = Image.new("RGB", (40, 24), (120, 60, 30))
    exif = Image.Exif()
    if orientation is not None:
        exif[ORIENTATION_TAG] = orientation
    image.save(path, format="JPEG", exif=exif)
    return path


@pytest.mark.parametrize("orientation", [0, 9, 65535])
def test_undefined_orientation_reads_as_normal(tmp_path, orientation):
    path = _save_jpeg(tmp_path / "picture.jpg", orientation)
    with Image.open(path) as image:
        assert read_exif_orientation(image) == 1
        normalized, used = normalize_source_orientation(image)
        assert used == 1
        assert normalized.size == (40, 24)


def test_defined_orientation_is_kept(tmp_path):
    path = _save_jpeg(tmp_path / "picture.jpg", 6)
    with Image.open(path) as image:
        assert read_exif_orientation(image) == 6


def test_readiness_reads_a_picture_with_orientation_zero(tmp_path):
    path = _save_jpeg(tmp_path / "picture.jpg", 0)
    identity = readiness._inspect_source(str(path), lambda: False)
    assert identity is not None
    assert identity[4:] == (40, 24)
