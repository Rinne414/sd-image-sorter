"""Collect pictures into the program: from the browser extension, a paste, a URL.

A collected picture is written to ``<output root>/collected/<YYYY-MM-DD>/``
under its own name (``name_2`` on a clash), byte for byte, so generation
metadata inside it stays and is read like any other picture. A format the
gallery does not index (AVIF, ICO ...) is converted to PNG, and the answer
says so. Indexing runs on one background thread: the caller gets its answer
as soon as the file is on disk, pictures saved together are imported in one
batch through ``scan_folder(only_paths=...)``, and their source (picture
address, page address, page title) is stored once each has an id.
"""

from __future__ import annotations

import os
import shutil
import tempfile
import threading
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, BinaryIO, Dict, Optional, Tuple

from PIL import Image

import config
from utils.path_validation import sanitize_filename
from utils.unique_names import first_free_path

COLLECT_FEATURE = "collected"
STEM_MAX_CHARS = 120
URL_MAX_CHARS = 8192
TITLE_MAX_CHARS = 500
FORMAT_EXTENSIONS = {
    "PNG": ".png",
    "JPEG": ".jpg",
    "WEBP": ".webp",
    "GIF": ".gif",
    "BMP": ".bmp",
    "TIFF": ".tif",
}

# What a collected file may be opened as. Pillow can also open EPS (runs
# Ghostscript) and other legacy formats; web bytes never get those.
OPENABLE_FORMATS = (
    "PNG", "JPEG", "MPO", "WEBP", "GIF", "BMP", "DIB", "TIFF",
    "ICO", "CUR", "AVIF", "HEIF",
)



def _openable_formats() -> list[str]:
    """OPENABLE_FORMATS that this Pillow build has (AVIF/HEIF depend on plugins);
    Image.open raises KeyError for a name nobody registered."""
    Image.init()
    return [name for name in OPENABLE_FORMATS if name in Image.OPEN]


_name_lock = threading.Lock()


class CollectError(Exception):
    """A picture that could not be collected; the message is for the user."""

    def __init__(self, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code


@dataclass(frozen=True)
class CollectSource:
    via: str
    source_url: Optional[str] = None
    page_url: Optional[str] = None
    page_title: Optional[str] = None

    def cleaned(self) -> "CollectSource":
        def clip(value: Optional[str], limit: int) -> Optional[str]:
            text = str(value or "").strip()
            return text[:limit] or None

        return CollectSource(
            via=self.via,
            source_url=clip(self.source_url, URL_MAX_CHARS),
            page_url=clip(self.page_url, URL_MAX_CHARS),
            page_title=clip(self.page_title, TITLE_MAX_CHARS),
        )


@dataclass(frozen=True)
class SavedPicture:
    path: Path
    converted_from: Optional[str]

    def as_dict(self) -> Dict[str, Any]:
        return {
            "path": str(self.path),
            "filename": self.path.name,
            "folder": str(self.path.parent),
            "converted_from": self.converted_from,
        }


def collected_folder(now: Optional[datetime] = None) -> Path:
    """``<output root>/collected/<YYYY-MM-DD>`` for today (not created here)."""
    day = (now or datetime.now()).strftime("%Y-%m-%d")
    return config.default_output_folder(COLLECT_FEATURE) / day


def _stem_for(suggested_name: Optional[str]) -> str:
    leaf = sanitize_filename(str(suggested_name or "").strip() or "picture")
    stem = os.path.splitext(leaf)[0].strip(" .") or "picture"
    return stem[:STEM_MAX_CHARS]


def _sniff_format(head: bytes) -> str:
    """The format of a gallery picture from its first bytes, "" for anything else."""
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "PNG"
    if head.startswith(b"\xff\xd8\xff"):
        return "JPEG"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "WEBP"
    if head[:6] in (b"GIF87a", b"GIF89a"):
        return "GIF"
    if head[:2] == b"BM":
        return "BMP"
    if head[:4] in (b"II*\x00", b"MM\x00*"):
        return "TIFF"
    return ""


def _picture_format(path: Path) -> str:
    """Gallery format by signature (no pixel limit applies), else what Pillow
    reads; CollectError for something that is not a picture at all."""
    with open(path, "rb") as handle:
        sniffed = _sniff_format(handle.read(16))
    if sniffed:
        return sniffed
    try:
        with Image.open(path, formats=_openable_formats()) as image:
            return str(image.format or "")
    except Image.DecompressionBombError:
        return "LARGE"
    except (OSError, ValueError) as exc:
        raise CollectError("This is not a picture the program can read.", 415) from exc


def _convert_to_png(path: Path) -> Path:
    png_path = path.with_suffix(".png.part")
    try:
        with Image.open(path, formats=_openable_formats()) as image:
            image.load()
            mode = "RGBA" if "A" in image.getbands() or image.mode == "P" else "RGB"
            image.convert(mode).save(png_path, format="PNG")
    except Image.DecompressionBombError as exc:
        png_path.unlink(missing_ok=True)
        raise CollectError(
            "This picture is in a format the gallery does not show and is too large to convert to PNG.",
            415,
        ) from exc
    except (OSError, ValueError) as exc:
        png_path.unlink(missing_ok=True)
        raise CollectError("This picture could not be converted to PNG.", 415) from exc
    path.unlink(missing_ok=True)
    return png_path


def _place(tmp_path: Path, folder: Path, stem: str, ext: str) -> Path:
    with _name_lock:
        target = first_free_path(folder, stem, ext)
        os.replace(tmp_path, target)
    return target


def store_collected_file(tmp_path: Path, suggested_name: Optional[str]) -> SavedPicture:
    """Move a downloaded or uploaded temp file into today's collected folder."""
    try:
        fmt = _picture_format(tmp_path)
        converted_from = None
        if fmt not in FORMAT_EXTENSIONS:
            tmp_path = _convert_to_png(tmp_path)
            converted_from, fmt = fmt or "unknown", "PNG"
        final = _place(
            tmp_path, tmp_path.parent, _stem_for(suggested_name), FORMAT_EXTENSIONS[fmt]
        )
    except BaseException:
        tmp_path.unlink(missing_ok=True)
        raise
    return SavedPicture(final, converted_from)


def new_temp_file(folder: Path) -> Tuple[int, Path]:
    folder.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=".collect-", suffix=".part", dir=str(folder))
    return fd, Path(name)


def save_collected_stream(
    stream: BinaryIO, suggested_name: Optional[str]
) -> SavedPicture:
    """Copy an uploaded picture (any size) into today's collected folder."""
    fd, tmp_path = new_temp_file(collected_folder())
    try:
        with os.fdopen(fd, "wb") as out:
            shutil.copyfileobj(stream, out, 1024 * 1024)
    except BaseException:
        tmp_path.unlink(missing_ok=True)
        raise
    if tmp_path.stat().st_size == 0:
        tmp_path.unlink(missing_ok=True)
        raise CollectError("The picture arrived empty.", 400)
    return store_collected_file(tmp_path, suggested_name)
