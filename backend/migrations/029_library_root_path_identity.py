"""Migration 029: preserve filesystem identity for Library Roots."""
from __future__ import annotations

from pathlib import PurePosixPath, PureWindowsPath
import re
import sqlite3


VERSION = 29
NAME = "library_root_path_identity"
WINDOWS_DRIVE_PATH_RE = re.compile(r"^[A-Za-z]:(?:[\\/]|$)")
POSIX_MNT_DRIVE_PATH_RE = re.compile(r"^/mnt/([A-Za-z])(?:/(.*))?$")
REQUIRED_COLUMNS = {
    "id",
    "path",
    "path_key",
    "label",
    "enabled",
    "added_at",
    "last_scanned_at",
}

type RootRow = tuple[int, str, str | None, int, str, str | None]
type MigratedRootRow = tuple[int, str, str, str | None, int, str, str | None]


def _normalize_root_path(path: str) -> str:
    normalized = str(path or "").replace("\\", "/").strip()
    while (
        len(normalized) > 1
        and normalized.endswith("/")
        and not normalized.endswith(":/")
    ):
        normalized = normalized[:-1]
    return normalized


def _looks_windows_style_path(path: str) -> bool:
    text = str(path or "").strip()
    return bool(
        WINDOWS_DRIVE_PATH_RE.match(text)
        or text.startswith("\\\\")
        or text.startswith("//")
    )


def _normalize_identity_path(path: str) -> str:
    text = _normalize_root_path(path)
    if not text:
        return text
    if _looks_windows_style_path(text):
        pure_path = PureWindowsPath(text)
        if pure_path.drive and len(pure_path.drive) == 2 and pure_path.drive[1] == ":":
            anchor = f"{pure_path.drive[0].upper()}:{pure_path.root}"
            return str(
                PureWindowsPath(anchor or pure_path.drive.upper(), *pure_path.parts[1:])
            )
        return str(pure_path)
    return str(PurePosixPath(text))


def _translate_posix_mnt_path_to_windows_drive(path: str) -> str | None:
    text = str(path or "").strip().replace("\\", "/")
    match = POSIX_MNT_DRIVE_PATH_RE.match(text)
    if not match:
        return None
    drive = match.group(1).upper()
    parts = [part for part in (match.group(2) or "").split("/") if part]
    return str(PureWindowsPath(f"{drive}:\\", *parts))


def _root_path_key(path: str) -> str:
    normalized = _normalize_identity_path(path)
    if not normalized:
        return normalized
    windows_path = _translate_posix_mnt_path_to_windows_drive(normalized)
    if _looks_windows_style_path(normalized) or windows_path:
        return (windows_path or normalized).casefold()
    return normalized


def _activity_key(row: RootRow) -> tuple[str, int]:
    row_id, _path, _label, _enabled, added_at, last_scanned_at = row
    activity_at = max(added_at, last_scanned_at or added_at)
    return activity_at, row_id


def _merge_root_rows(path_key: str, rows: list[RootRow]) -> MigratedRootRow:
    retained_id = min(row[0] for row in rows)
    display_row = max(rows, key=_activity_key)
    labeled_rows = [row for row in rows if row[2] and row[2].strip()]
    label = max(labeled_rows, key=_activity_key)[2] if labeled_rows else None
    enabled = 1 if any(row[3] for row in rows) else 0
    added_at = min(row[4] for row in rows)
    scanned_values = [row[5] for row in rows if row[5] is not None]
    last_scanned_at = max(scanned_values) if scanned_values else None
    return (
        retained_id,
        display_row[1],
        path_key,
        label,
        enabled,
        added_at,
        last_scanned_at,
    )


def _read_migrated_rows(conn: sqlite3.Connection) -> list[MigratedRootRow]:
    grouped: dict[str, list[RootRow]] = {}
    rows = conn.execute(
        """
        SELECT id, path, label, enabled, added_at, last_scanned_at
        FROM library_roots ORDER BY id
        """
    )
    for row_id, path, label, enabled, added_at, last_scanned_at in rows:
        normalized_path = _normalize_root_path(str(path))
        path_key = _root_path_key(normalized_path)
        if not path_key:
            raise RuntimeError(
                f"Cannot migrate Library Root {int(row_id)}: path must not be blank"
            )
        root_row: RootRow = (
            int(row_id),
            normalized_path,
            str(label) if label is not None else None,
            int(enabled),
            str(added_at),
            str(last_scanned_at) if last_scanned_at is not None else None,
        )
        grouped.setdefault(path_key, []).append(root_row)
    return [
        _merge_root_rows(path_key, grouped[path_key])
        for path_key in sorted(grouped)
    ]


def _read_autoincrement_high_water(conn: sqlite3.Connection) -> int:
    max_row_id = int(
        conn.execute("SELECT COALESCE(MAX(id), 0) FROM library_roots").fetchone()[0]
    )
    sequence_table = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'"
    ).fetchone()
    if sequence_table is None:
        return max_row_id
    sequence_row = conn.execute(
        "SELECT seq FROM sqlite_sequence WHERE name = 'library_roots'"
    ).fetchone()
    sequence_value = int(sequence_row[0]) if sequence_row is not None else 0
    return max(max_row_id, sequence_value)


def _restore_autoincrement_high_water(
    conn: sqlite3.Connection,
    high_water: int,
) -> None:
    if high_water <= 0:
        return
    sequence_row = conn.execute(
        "SELECT seq FROM sqlite_sequence WHERE name = 'library_roots'"
    ).fetchone()
    if sequence_row is None:
        conn.execute(
            "INSERT INTO sqlite_sequence (name, seq) VALUES ('library_roots', ?)",
            (high_water,),
        )
        return
    if int(sequence_row[0]) < high_water:
        conn.execute(
            "UPDATE sqlite_sequence SET seq = ? WHERE name = 'library_roots'",
            (high_water,),
        )


def _replace_library_roots(
    conn: sqlite3.Connection,
    rows: list[MigratedRootRow],
    autoincrement_high_water: int,
) -> None:
    conn.execute(
        """
        CREATE TABLE library_roots_v29 (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT NOT NULL,
            path_key TEXT NOT NULL UNIQUE,
            label TEXT,
            enabled INTEGER NOT NULL DEFAULT 1,
            added_at TEXT NOT NULL,
            last_scanned_at TEXT
        )
        """
    )
    conn.executemany(
        """
        INSERT INTO library_roots_v29 (
            id, path, path_key, label, enabled, added_at, last_scanned_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        rows,
    )
    conn.execute("DROP TABLE library_roots")
    conn.execute("ALTER TABLE library_roots_v29 RENAME TO library_roots")
    conn.execute(
        "CREATE INDEX idx_library_roots_enabled ON library_roots(enabled)"
    )
    _restore_autoincrement_high_water(conn, autoincrement_high_water)


def apply(conn: sqlite3.Connection) -> None:
    """Rebuild Library Root keys with exact POSIX and folded Windows identity."""
    columns = {
        str(row[1]) for row in conn.execute("PRAGMA table_info(library_roots)")
    }
    if not columns:
        raise RuntimeError(
            "Cannot migrate Library Root path identity: library_roots table is missing"
        )
    missing_columns = sorted(REQUIRED_COLUMNS.difference(columns))
    if missing_columns:
        missing_text = ", ".join(missing_columns)
        raise RuntimeError(
            "Cannot migrate Library Root path identity: "
            f"library_roots is missing required columns: {missing_text}"
        )

    rows = _read_migrated_rows(conn)
    autoincrement_high_water = _read_autoincrement_high_water(conn)
    _replace_library_roots(conn, rows, autoincrement_high_water)
