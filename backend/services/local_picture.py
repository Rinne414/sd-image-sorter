"""Find a picture on this computer from the location a drop or paste carried.

QQ and other chat apps copy a picture as ``<img src="file://L:\\...\\x.png">``
(HTML or plain text) and drag it out as a ``file://`` link, so the page gets
the picture's location instead of the picture. ``resolve_local_picture`` turns
that location (a Windows or POSIX path, or a ``file://`` URL in any of the
shapes apps write) into a checked path of a readable picture, so the page can
fetch it and treat it like a dropped file.

Errors are ``LocalPictureError`` with a ``code`` the page words in its own
language (``apiError.<code>``); ``message`` is the English fallback.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Dict, List, Optional
from urllib.parse import unquote

from config import ALLOWED_IMAGE_EXTENSIONS
from metadata_parser import verify_image_readable
from utils.path_validation import normalize_user_path, validate_file_path
from utils.reported_cause import describe_readability_failure

MEDIA_TYPES: Dict[str, str] = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
}

_DRIVE_PATH = re.compile(r"^/*([A-Za-z]:[\\/].*)$", re.S)
_UNC_PATH = re.compile(r"^(?:\\\\|//)[^\\/]+[\\/][^\\/]+")
# A share (\\host\share, WebDAV \\host@80\...) or a \\?\ / \\.\ device path.
_NETWORK_OR_DEVICE = re.compile(r"^(?:\\\\|//)")
_QUOTES = (('"', '"'), ("'", "'"), ("<", ">"))


class LocalPictureError(Exception):
    """A location that does not lead to a readable picture."""

    def __init__(
        self,
        message: str,
        status_code: int = 400,
        code: str = "local_picture_bad_path",
        params: Optional[Dict[str, str]] = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.code = code
        self.params = params or {}

    def detail(self) -> dict:
        return {"code": self.code, "message": self.message, "params": self.params}


def _unwrap(text: str) -> str:
    value = text.strip()
    for opening, closing in _QUOTES:
        if len(value) >= 2 and value.startswith(opening) and value.endswith(closing):
            return value[1:-1].strip()
    return value


def _from_file_url_body(body: str) -> Optional[str]:
    """The path in what follows ``file:`` (already decoded or not)."""
    drive = _DRIVE_PATH.match(body)
    if drive:
        return drive.group(1)
    if body.lower().startswith("//localhost/"):
        return _from_file_url_body(body[len("//localhost") :])
    if body.startswith("//") and not body.startswith("///"):
        # file://server/share/x.png is the share \\server\share\x.png.
        return "\\\\" + body[2:].replace("/", "\\") if os.name == "nt" else None
    if body.startswith("/"):
        return "/" + body.lstrip("/")
    return None


def _is_absolute(path: str) -> bool:
    if re.match(r"^[A-Za-z]:[\\/]", path) or _UNC_PATH.match(path):
        return True
    # A POSIX path means nothing on Windows (it would land on the current drive).
    return os.name != "nt" and path.startswith("/")


def path_candidates(raw: str) -> List[str]:
    """The absolute paths ``raw`` may name, most likely first (none for a relative path).

    A ``file:`` URL is percent-decoded, but apps also write unencoded ones
    (QQ: ``file://L:\\Tencent Files\\...``) whose names may hold a literal
    ``%`` or ``#``, so the undecoded reading is tried as well.
    """
    text = _unwrap(raw)
    if not text:
        return []
    if text[:5].lower() == "file:":
        body = text[5:]
        bodies = [unquote(body), body]
        cut = re.split(r"[?#]", body, maxsplit=1)[0]
        if cut != body:
            bodies.insert(1, unquote(cut))
        found = [_from_file_url_body(item) for item in bodies]
    else:
        found = [text]
    candidates: List[str] = []
    for path in found:
        if path and _is_absolute(path) and path not in candidates:
            candidates.append(path)
    return candidates


def _leaf(path: str) -> str:
    parts = [part for part in re.split(r"[\\/]+", path) if part]
    return parts[-1] if parts else path


def _check(path: str) -> Path:
    """The resolved path of a readable picture at ``path``, or the reason it is not one."""
    name = _leaf(path)
    if Path(name).suffix.lower() not in ALLOWED_IMAGE_EXTENSIONS:
        raise LocalPictureError(
            f"{name} is not a picture the program can read (PNG, JPG, WebP, GIF, BMP or TIFF).",
            status_code=415,
            code="local_picture_not_picture",
            params={"name": name},
        )
    if _NETWORK_OR_DEVICE.match(path):
        # A location comes from clipboard or drag data any web page can write.
        # Merely looking up \\host\share makes Windows sign in to that host with
        # the user's credentials, so a share is refused before any file access.
        raise LocalPictureError(
            f"{name} is on a network share. Copy it to this computer first, or drag the file itself.",
            code="local_picture_network",
            params={"name": name},
        )
    ok, reason = validate_file_path(path, allowed_extensions=ALLOWED_IMAGE_EXTENSIONS)
    if not ok:
        if reason in (
            "File does not exist",
            "Path is not a file",
            "Symlink target does not exist",
        ):
            raise LocalPictureError(
                f"{name} is not at the location that came with it.",
                status_code=404,
                code="local_picture_missing",
                params={"name": name, "path": path},
            )
        raise LocalPictureError(
            f"This is not a usable file location: {reason}.",
            code="local_picture_bad_path",
        )
    resolved = Path(normalize_user_path(path)).resolve()
    readable, read_error = verify_image_readable(str(resolved))
    if not readable:
        why = (
            describe_readability_failure(read_error)
            if read_error
            else "image decode failed"
        )
        raise LocalPictureError(
            f"{name} could not be opened as a picture: {why}",
            status_code=422,
            code="local_picture_unreadable",
            params={"name": name, "reason": why},
        )
    return resolved


# When several readings of a location fail, the most telling reason is reported.
_RANK = {
    "local_picture_unreadable": 3,
    "local_picture_missing": 2,
    "local_picture_network": 2,
    "local_picture_not_picture": 1,
    "local_picture_bad_path": 0,
}


def resolve_local_picture(raw: str) -> Path:
    """The checked, resolved path of the picture ``raw`` names.

    Raises ``LocalPictureError``: ``local_picture_bad_path`` (not a full
    location on this computer), ``local_picture_not_picture`` (not a picture
    extension), ``local_picture_network`` (a network share or device path,
    never looked up), ``local_picture_missing`` (nothing there) or
    ``local_picture_unreadable`` (there, but not a decodable picture).
    """
    candidates = path_candidates(raw)
    if not candidates:
        raise LocalPictureError(
            "This is not a full file location on this computer.",
            code="local_picture_bad_path",
        )
    worst: Optional[LocalPictureError] = None
    for candidate in candidates:
        try:
            return _check(candidate)
        except LocalPictureError as error:
            if worst is None or _RANK[error.code] > _RANK[worst.code]:
                worst = error
    assert worst is not None
    raise worst


def media_type_of(path: Path) -> str:
    return MEDIA_TYPES.get(path.suffix.lower(), "application/octet-stream")
