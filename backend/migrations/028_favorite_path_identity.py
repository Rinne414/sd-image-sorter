"""Migration 028: preserve case-sensitive Favorites path identity."""
from __future__ import annotations

from pathlib import PurePosixPath, PureWindowsPath
import re
import sqlite3


VERSION = 28
NAME = "favorite_path_identity"
IDENTITY_BATCH_SIZE = 500
WINDOWS_DRIVE_PATH_RE = re.compile(r"^[A-Za-z]:(?:[\\/]|$)")
POSIX_MNT_DRIVE_PATH_RE = re.compile(r"^/mnt/([A-Za-z])(?:/(.*))?$")
SQLITE_ASCII_LOWER_TABLE = str.maketrans(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    "abcdefghijklmnopqrstuvwxyz",
)


def _looks_windows_style_path(path: str) -> bool:
    text = str(path or "").strip()
    return bool(
        WINDOWS_DRIVE_PATH_RE.match(text)
        or text.startswith("\\\\")
        or text.startswith("//")
    )


def _normalize_path(path: str) -> str:
    text = str(path or "").strip()
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
    return str(PurePosixPath(text.replace("\\", "/")))


def _translate_posix_mnt_path_to_windows_drive(path: str) -> str | None:
    text = str(path or "").strip().replace("\\", "/")
    match = POSIX_MNT_DRIVE_PATH_RE.match(text)
    if not match:
        return None
    drive = match.group(1).upper()
    parts = [part for part in (match.group(2) or "").split("/") if part]
    return str(PureWindowsPath(f"{drive}:\\", *parts))


def _is_case_insensitive_path(path: str) -> bool:
    normalized = _normalize_path(path)
    return bool(
        normalized
        and (
            _looks_windows_style_path(normalized)
            or _translate_posix_mnt_path_to_windows_drive(normalized)
        )
    )


def _path_casefold(path: str) -> str:
    normalized = _normalize_path(path)
    if not normalized:
        return normalized
    windows_path = _translate_posix_mnt_path_to_windows_drive(normalized)
    return (windows_path or normalized).casefold()


def _legacy_path_keys(path: str) -> list[str]:
    raw = str(path or "").strip()
    normalized = _normalize_path(raw)
    keys: list[str] = []
    for candidate in (raw, normalized):
        if not candidate:
            continue
        for key in (
            candidate.lower(),
            candidate.translate(SQLITE_ASCII_LOWER_TABLE),
            _path_casefold(candidate),
        ):
            if key not in keys:
                keys.append(key)
    return keys


def _favorite_identity(path: str) -> tuple[str, int]:
    normalized = _normalize_path(path)
    if _is_case_insensitive_path(normalized):
        return _path_casefold(normalized), 0
    return normalized, 1


def _create_image_path_identity_schema(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS image_path_identities (
            image_id INTEGER PRIMARY KEY,
            path_key TEXT NOT NULL CHECK (path_key != '')
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_image_path_identities_path_key "
        "ON image_path_identities(path_key)"
    )
    conn.execute(
        """
        CREATE TRIGGER IF NOT EXISTS delete_image_path_identity_after_path_update
        AFTER UPDATE OF path ON images
        WHEN OLD.path IS NOT NEW.path
        BEGIN
            DELETE FROM image_path_identities WHERE image_id = OLD.id;
        END
        """
    )
    conn.execute(
        """
        CREATE TRIGGER IF NOT EXISTS delete_image_path_identity_after_image_delete
        AFTER DELETE ON images
        BEGIN
            DELETE FROM image_path_identities WHERE image_id = OLD.id;
        END
        """
    )


def _backfill_image_path_identities(conn: sqlite3.Connection) -> None:
    conn.execute("DELETE FROM image_path_identities")
    image_rows = conn.execute("SELECT id, path FROM images")
    while True:
        batch = image_rows.fetchmany(IDENTITY_BATCH_SIZE)
        if not batch:
            return
        identities = [
            (int(image_id), path_key)
            for image_id, path in batch
            if (path_key := _path_casefold(str(path)))
        ]
        if identities:
            conn.executemany(
                "INSERT INTO image_path_identities (image_id, path_key) VALUES (?, ?)",
                identities,
            )


def apply(conn: sqlite3.Connection) -> None:
    """Add explicit exact/case-folded identity without losing legacy anchors."""
    columns = {
        row[1] for row in conn.execute("PRAGMA table_info(favorite_paths)")
    }
    if not columns:
        raise RuntimeError(
            "Cannot migrate Favorites path identity: favorite_paths table is missing"
        )
    conn.execute("DROP INDEX IF EXISTS idx_images_path_casefold")
    _create_image_path_identity_schema(conn)
    _backfill_image_path_identities(conn)
    if "match_case" in columns:
        return

    legacy_rows = {
        str(path_key): str(added_at)
        for path_key, added_at in conn.execute(
            "SELECT path_key, added_at FROM favorite_paths"
        )
    }
    migrated: dict[tuple[str, int], str] = {}
    resolved_legacy_keys: set[str] = set()
    for (image_path,) in conn.execute("SELECT path FROM images"):
        path = str(image_path)
        for legacy_key in set(_legacy_path_keys(path)).intersection(
            legacy_rows
        ):
            path_key, match_case = _favorite_identity(path)
            identity = (path_key, match_case)
            added_at = legacy_rows[legacy_key]
            existing = migrated.get(identity)
            if existing is None:
                migrated[identity] = added_at
            else:
                migrated[identity] = max(existing, added_at)
            resolved_legacy_keys.add(legacy_key)

    for legacy_key, added_at in legacy_rows.items():
        if legacy_key in resolved_legacy_keys:
            continue
        identity = (_path_casefold(legacy_key), 0)
        existing = migrated.get(identity)
        if existing is None:
            migrated[identity] = added_at
        else:
            migrated[identity] = max(existing, added_at)

    conn.execute(
        """
        CREATE TABLE favorite_paths_v2 (
            path_key TEXT NOT NULL,
            match_case INTEGER NOT NULL CHECK (match_case IN (0, 1)),
            added_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (path_key, match_case)
        ) WITHOUT ROWID
        """
    )
    conn.executemany(
        "INSERT INTO favorite_paths_v2 "
        "(path_key, match_case, added_at) VALUES (?, ?, ?)",
        [
            (path_key, match_case, added_at)
            for (path_key, match_case), added_at in migrated.items()
        ],
    )
    conn.execute("DROP TABLE favorite_paths")
    conn.execute("ALTER TABLE favorite_paths_v2 RENAME TO favorite_paths")
