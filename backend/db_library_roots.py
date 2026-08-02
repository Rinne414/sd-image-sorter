"""Library-root persistence (v3.3.2 Library Navigation — multi-root foundation).

A "library root" is a folder the user added as an image source. It lives in its
own table so the app remembers a source even when it currently has zero indexed
images, and so idle auto-refresh / multi-root management have a stable target
list. ``path_key`` follows filesystem identity: ordinary POSIX paths preserve
case, while Windows, UNC, and WSL drive paths use Unicode case folding.

As of multi-library workspaces, roots are scoped by ``library_id`` (unique on
``(library_id, path_key)``).

Imports only database primitives and the database-independent source-path helper
to avoid an import cycle with the ``database`` facade.
"""
from datetime import datetime
from typing import Optional, List, Dict, Any

from db_core import get_db
from db_helpers import _row_to_dict
from utils.source_paths import indexed_image_path_match_key


def _normalize_root_path(path: str) -> str:
    """Forward-slash, trailing-separator-stripped folder path (keeps bare roots)."""
    normalized = str(path or "").replace("\\", "/").strip()
    # Drop a trailing slash but keep a bare root like ``C:/`` or ``/``.
    while len(normalized) > 1 and normalized.endswith("/") and not normalized.endswith(":/"):
        normalized = normalized[:-1]
    return normalized


def _root_path_key(path: str) -> str:
    """Return the cross-runtime filesystem identity for a root path."""
    return indexed_image_path_match_key(_normalize_root_path(path))


def _active_library_id(library_id: Optional[str] = None) -> str:
    try:
        from library_context import get_current_library_id, normalize_library_id

        if library_id is not None:
            return normalize_library_id(library_id)
        return get_current_library_id()
    except Exception:
        return str(library_id or "main").strip() or "main"


def add_library_root(
    path: str,
    label: Optional[str] = None,
    library_id: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """Register a folder as a library root (idempotent by filesystem identity).

    Returns the stored row, or ``None`` when ``path`` is blank. Re-adding an
    existing root refreshes its display path/label without creating a duplicate.
    Scoped to the current long-lived library workspace unless ``library_id`` is set.
    """
    normalized = _normalize_root_path(path)
    if not normalized:
        return None
    key = _root_path_key(normalized)
    lid = _active_library_id(library_id)
    now = datetime.now().isoformat(timespec="seconds")
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO library_roots (path, path_key, library_id, label, enabled, added_at)
            VALUES (?, ?, ?, ?, 1, ?)
            ON CONFLICT(library_id, path_key) DO UPDATE SET
                path = excluded.path,
                label = COALESCE(excluded.label, library_roots.label)
            """,
            (normalized, key, lid, label, now),
        )
        cursor.execute(
            "SELECT * FROM library_roots WHERE library_id = ? AND path_key = ?",
            (lid, key),
        )
        return _row_to_dict(cursor.fetchone())


def record_library_root_scan(
    path: str,
    library_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Atomically register a scanned root and stamp its successful scan time."""
    normalized = _normalize_root_path(path)
    if not normalized:
        raise ValueError("Scanned library root path must not be blank")

    key = _root_path_key(normalized)
    lid = _active_library_id(library_id)
    now = datetime.now().isoformat(timespec="seconds")
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO library_roots (
                path, path_key, library_id, label, enabled, added_at, last_scanned_at
            )
            VALUES (?, ?, ?, NULL, 1, ?, ?)
            ON CONFLICT(library_id, path_key) DO UPDATE SET
                path = excluded.path,
                last_scanned_at = excluded.last_scanned_at
            """,
            (normalized, key, lid, now, now),
        )
        cursor.execute(
            "SELECT * FROM library_roots WHERE library_id = ? AND path_key = ?",
            (lid, key),
        )
        stored = _row_to_dict(cursor.fetchone())
        if stored is None:
            raise RuntimeError(
                f"Scanned library root was not readable after persistence: {normalized}"
            )
        return stored


def list_library_roots(library_id: Optional[str] = None) -> List[Dict[str, Any]]:
    """Registered roots for one library (current by default), most-recent first."""
    lid = _active_library_id(library_id)
    with get_db() as conn:
        cursor = conn.cursor()
        # COALESCE for pre-migration rows if any linger without library_id.
        cursor.execute(
            """
            SELECT * FROM library_roots
            WHERE COALESCE(library_id, 'main') = ?
            ORDER BY id DESC
            """,
            (lid,),
        )
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


def touch_library_root_scanned(
    path: str,
    library_id: Optional[str] = None,
) -> None:
    """Stamp ``last_scanned_at`` for the root matching ``path`` (no-op if unknown)."""
    key = _root_path_key(path)
    if not key:
        return
    lid = _active_library_id(library_id)
    now = datetime.now().isoformat(timespec="seconds")
    with get_db() as conn:
        conn.execute(
            """
            UPDATE library_roots
            SET last_scanned_at = ?
            WHERE path_key = ? AND COALESCE(library_id, 'main') = ?
            """,
            (now, key, lid),
        )
