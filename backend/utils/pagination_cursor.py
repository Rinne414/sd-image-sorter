"""
Cursor token helpers for gallery pagination.
"""
from __future__ import annotations

import base64
import binascii
import json
from dataclasses import dataclass
from typing import Any, Mapping, Optional


CURSOR_TOKEN_VERSION = 1
INVALID_CURSOR_MESSAGE = "Invalid cursor token. Pass the previous next_cursor value unchanged."


@dataclass(frozen=True)
class ImageCursor:
    """Decoded pagination cursor."""

    image_id: int
    sort_value: Optional[str] = None
    is_opaque: bool = False


def decode_image_cursor(token: str) -> ImageCursor:
    """Decode a legacy integer cursor or the opaque token returned by the API."""
    if token is None:
        raise ValueError(INVALID_CURSOR_MESSAGE)
    token = str(token).strip()
    if token == "":
        raise ValueError(INVALID_CURSOR_MESSAGE)

    try:
        return ImageCursor(image_id=int(token), sort_value=None, is_opaque=False)
    except ValueError:
        pass

    try:
        padded = token + ("=" * (-len(token) % 4))
        payload = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8"))
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError, binascii.Error):
        raise ValueError(INVALID_CURSOR_MESSAGE) from None

    if not isinstance(payload, dict):
        raise ValueError(INVALID_CURSOR_MESSAGE)
    if payload.get("v") != CURSOR_TOKEN_VERSION:
        raise ValueError(INVALID_CURSOR_MESSAGE)

    image_id = payload.get("id")
    sort_value = payload.get("sort_value")
    if isinstance(image_id, bool) or not isinstance(image_id, int):
        raise ValueError(INVALID_CURSOR_MESSAGE)
    if sort_value is not None and not isinstance(sort_value, str):
        raise ValueError(INVALID_CURSOR_MESSAGE)

    return ImageCursor(image_id=image_id, sort_value=sort_value, is_opaque=True)


def encode_image_cursor(image_id: int, sort_value: Optional[str]) -> str:
    """Encode a stable opaque cursor for /api/images pagination."""
    payload = {
        "v": CURSOR_TOKEN_VERSION,
        "id": int(image_id),
        "sort_value": sort_value,
    }
    raw = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def encode_image_cursor_from_image(image: Mapping[str, Any]) -> str:
    """Build an opaque cursor from an image row/payload."""
    image_id = image.get("id")
    if isinstance(image_id, bool) or not isinstance(image_id, int):
        raise ValueError("Cannot encode cursor without an integer image id.")

    sort_value = image.get("library_order_time") or image.get("created_at")
    return encode_image_cursor(image_id, str(sort_value) if sort_value is not None else None)
