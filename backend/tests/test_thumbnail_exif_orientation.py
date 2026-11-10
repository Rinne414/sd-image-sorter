"""A thumbnail is the same way up as the picture the browser shows.

A JPEG can be stored rotated with an EXIF Orientation tag (phones, some
editors). The browser turns the full picture upright; the thumbnail ignored
the tag, so those pictures were upside-down or sideways in the gallery, in
Style Finder and on the style map (beginner walkthrough 2026-11-11, three
pictures of a 147-picture library with Orientation 3).
"""

from __future__ import annotations

import io
import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).parent.parent))

import thumbnail_cache  # noqa: E402

ORIENTATION_TAG = 0x0112


def _top_red_bottom_blue(path: Path, orientation: int | None) -> None:
    """A picture whose upright view is red on top and blue below, stored with `orientation`."""
    upright = Image.new("RGB", (64, 128), (0, 0, 255))
    upright.paste((255, 0, 0), (0, 0, 64, 64))
    stored = upright.rotate(180) if orientation == 3 else upright
    if orientation is None:
        stored.save(path, format="JPEG", quality=95)
        return
    exif = Image.Exif()
    exif[ORIENTATION_TAG] = orientation
    stored.save(path, format="JPEG", quality=95, exif=exif)


def _thumbnail_top_and_bottom(path: Path) -> tuple[tuple, tuple]:
    data, _modified = thumbnail_cache.generate_and_cache_thumbnail(str(path), 256)
    thumb = Image.open(io.BytesIO(data)).convert("RGB")
    return thumb.getpixel((thumb.width // 2, 4)), thumb.getpixel(
        (thumb.width // 2, thumb.height - 5)
    )


def _is_red(pixel) -> bool:
    return pixel[0] > 180 and pixel[2] < 90


def _is_blue(pixel) -> bool:
    return pixel[2] > 180 and pixel[0] < 90


def test_thumbnail_of_a_picture_stored_upside_down_is_upright(monkeypatch, tmp_path):
    monkeypatch.setattr(thumbnail_cache, "CACHE_DIR", tmp_path / "cache")
    source = tmp_path / "rotated.jpg"
    _top_red_bottom_blue(source, orientation=3)

    top, bottom = _thumbnail_top_and_bottom(source)

    assert _is_red(top) and _is_blue(bottom)


def test_thumbnail_of_a_plain_picture_is_unchanged(monkeypatch, tmp_path):
    monkeypatch.setattr(thumbnail_cache, "CACHE_DIR", tmp_path / "cache")
    for name, orientation in (
        ("plain.jpg", None),
        ("normal.jpg", 1),
        ("undefined.jpg", 0),
    ):
        source = tmp_path / name
        _top_red_bottom_blue(source, orientation=orientation)

        top, bottom = _thumbnail_top_and_bottom(source)

        assert _is_red(top) and _is_blue(bottom), name


def test_thumbnails_made_before_the_fix_are_not_served_again(monkeypatch, tmp_path):
    """The cache key changed with the fix, so an upside-down thumbnail already on disk is remade."""
    monkeypatch.setattr(thumbnail_cache, "CACHE_DIR", tmp_path / "cache")
    source = tmp_path / "rotated.jpg"
    _top_red_bottom_blue(source, orientation=3)
    mtime = source.stat().st_mtime
    import hashlib
    import os

    old_key = hashlib.md5(
        f"{os.path.abspath(str(source))}:256:{mtime}".encode(), usedforsecurity=False
    ).hexdigest()

    assert (
        thumbnail_cache._get_cache_key(str(source), 256, mtime) != f"{old_key}_256.webp"
    )
