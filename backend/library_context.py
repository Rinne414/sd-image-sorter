"""Request-scoped current library (long-lived workspace) id.

Frontend sends ``X-SD-Library-Id``. Missing/invalid values fall back to ``main``
so existing clients and tests keep working.
"""

from __future__ import annotations

from contextvars import ContextVar, Token
from typing import Optional

MAIN_LIBRARY_ID = "main"
LIBRARY_HEADER = "X-SD-Library-Id"

_current_library_id: ContextVar[str] = ContextVar(
    "sd_current_library_id",
    default=MAIN_LIBRARY_ID,
)


def normalize_library_id(value: Optional[str]) -> str:
    text = str(value or "").strip()
    if not text:
        return MAIN_LIBRARY_ID
    # Path-safe id: letters, digits, dash, underscore only.
    cleaned = "".join(ch for ch in text if ch.isalnum() or ch in "-_")
    return cleaned[:64] or MAIN_LIBRARY_ID


def get_current_library_id() -> str:
    return normalize_library_id(_current_library_id.get())


def set_current_library_id(library_id: Optional[str]) -> Token:
    return _current_library_id.set(normalize_library_id(library_id))


def reset_current_library_id(token: Token) -> None:
    _current_library_id.reset(token)


def bind_library_id_from_header(header_value: Optional[str]) -> Token:
    return set_current_library_id(header_value)
