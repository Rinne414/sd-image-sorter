"""Library-root persistence (v3.3.2 Library Navigation — multi-root foundation).

A "library root" is a folder the user added as an image source. It lives in its
own table so the app remembers a source even when it currently has zero indexed
images, and so idle auto-refresh / multi-root management have a stable target
list. Identity is case-insensitive via ``path_key`` (lowered, forward-slash
normalized path) to avoid duplicate roots on Windows.

Imports only from db_core / db_helpers / stdlib to avoid an import cycle with the
``database`` facade (mirrors db_collections.py).
"""
from datetime import datetime
from typing import Optional, List, Dict, Any

from db_core import get_db
from db_helpers import _row_to_dict


def _normalize_root_path(path: str) -> str:
    """Forward-slash, trailing-separator-stripped folder path (keeps bare roots)."""
    normalized = str(path or "").replace("\\", "/").strip()
    # Drop a trailing slash but keep a bare root like ``C:/`` or ``/``.
    while len(normalized) > 1 and normalized.endswith("/") and not normalized.endswith(":/"):
        normalized = normalized[:-1]
    return normalized


def _root_path_key(path: str) -> str:
    """Case-insensitive identity key for a root path."""
    return _normalize_root_path(path).lower()


def add_library_root(path: str, label: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Register a folder as a library root (idempotent by case-insensitive path).

    Returns the stored row, or ``None`` when ``path`` is blank. Re-adding an
    existing root refreshes its display path/label without creating a duplicate.
    """
    normalized = _normalize_root_path(path)
    if not normalized:
        return None
    key = normalized.lower()
    now = datetime.now().isoformat(timespec="seconds")
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO library_roots (path, path_key, label, enabled, added_at)
            VALUES (?, ?, ?, 1, ?)
            ON CONFLICT(path_key) DO UPDATE SET
                path = excluded.path,
                label = COALESCE(excluded.label, library_roots.label)
            """,
            (normalized, key, label, now),
        )
        cursor.execute("SELECT * FROM library_roots WHERE path_key = ?", (key,))
        return _row_to_dict(cursor.fetchone())


def list_library_roots() -> List[Dict[str, Any]]:
    """All registered roots, most-recently-added first."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM library_roots ORDER BY id DESC")
        return [_row_to_dict(row) for row in cursor.fetchall()]


def get_library_root(root_id: int) -> Optional[Dict[str, Any]]:
    """One root by id, or ``None``."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM library_roots WHERE id = ?", (int(root_id),))
        row = cursor.fetchone()
        return _row_to_dict(row) if row else None


def remove_library_root(root_id: int) -> bool:
    """Unregister a root. Does NOT delete its indexed images. True if a row went."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM library_roots WHERE id = ?", (int(root_id),))
        return cursor.rowcount > 0


def set_library_root_enabled(root_id: int, enabled: bool) -> bool:
    """Toggle whether a root participates in auto-refresh / scans. True if updated."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "UPDATE library_roots SET enabled = ? WHERE id = ?",
            (1 if enabled else 0, int(root_id)),
        )
        return cursor.rowcount > 0


def touch_library_root_scanned(path: str) -> None:
    """Stamp ``last_scanned_at`` for the root matching ``path`` (no-op if unknown)."""
    key = _root_path_key(path)
    if not key:
        return
    now = datetime.now().isoformat(timespec="seconds")
    with get_db() as conn:
        conn.execute(
            "UPDATE library_roots SET last_scanned_at = ? WHERE path_key = ?",
            (now, key),
        )
