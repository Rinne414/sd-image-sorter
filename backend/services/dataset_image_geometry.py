"""EXIF orientation normalization shared by Dataset pixel transforms."""

from __future__ import annotations

from typing import TypeAlias

from PIL import Image, ImageOps


ImageSize: TypeAlias = tuple[int, int]

_EXIF_ORIENTATION_TAG = 274
_ORIENTATION_TRANSPOSE = {
    2: Image.Transpose.FLIP_LEFT_RIGHT,
    3: Image.Transpose.ROTATE_180,
    4: Image.Transpose.FLIP_TOP_BOTTOM,
    5: Image.Transpose.TRANSPOSE,
    6: Image.Transpose.ROTATE_270,
    7: Image.Transpose.TRANSVERSE,
    8: Image.Transpose.ROTATE_90,
}


def read_exif_orientation(image: Image.Image) -> int:
    """Return a validated EXIF orientation, treating an absent tag as normal."""
    orientation = image.getexif().get(_EXIF_ORIENTATION_TAG, 1)
    if type(orientation) is not int or not 1 <= orientation <= 8:
        raise ValueError(
            "EXIF Orientation must be an integer from 1 through 8; "
            f"received={orientation!r}"
        )
    return orientation


def normalized_exif_size(size: ImageSize, orientation: int) -> ImageSize:
    """Return the visual dimensions after applying an EXIF orientation."""
    width, height = size
    if width <= 0 or height <= 0:
        raise ValueError(f"Image dimensions must be positive; received={size!r}")
    if not 1 <= orientation <= 8:
        raise ValueError(
            "EXIF Orientation must be an integer from 1 through 8; "
            f"received={orientation!r}"
        )
    return (height, width) if orientation in {5, 6, 7, 8} else (width, height)


def normalize_source_orientation(image: Image.Image) -> tuple[Image.Image, int]:
    """Return visually normalized pixels with the orientation metadata removed."""
    orientation = read_exif_orientation(image)
    return ImageOps.exif_transpose(image), orientation


def normalize_mask_orientation(mask: Image.Image, orientation: int) -> Image.Image:
    """Apply a source image's EXIF geometry to its raw-pixel training mask."""
    transpose = _ORIENTATION_TRANSPOSE.get(orientation)
    return mask.copy() if transpose is None else mask.transpose(transpose)
