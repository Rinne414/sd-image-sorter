from __future__ import annotations

from pathlib import Path
import sqlite3

import migrations
import pytest


def _migration_029():
    return next(
        migration for migration in migrations.get_migrations() if migration.version == 29
    )


def _create_legacy_library_roots(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE library_roots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT NOT NULL,
            path_key TEXT NOT NULL UNIQUE,
            label TEXT,
            enabled INTEGER NOT NULL DEFAULT 1,
            added_at TEXT NOT NULL,
            last_scanned_at TEXT
        );
        CREATE INDEX idx_library_roots_enabled ON library_roots(enabled);
        """
    )


def test_migration_uses_frozen_path_identity_helpers():
    source = (
        Path(__file__).resolve().parents[1]
        / "migrations"
        / "029_library_root_path_identity.py"
    ).read_text(encoding="utf-8")

    assert "utils.source_paths" not in source


def test_migration_preserves_posix_case_and_merges_cross_platform_duplicates():
    conn = sqlite3.connect(":memory:")
    _create_legacy_library_roots(conn)
    conn.executemany(
        """
        INSERT INTO library_roots (
            id, path, path_key, label, enabled, added_at, last_scanned_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        [
            (1, "/library/Case", "/library/case", "Upper", 1,
             "2026-01-01T00:00:00", None),
            (2, "/library/case", "/library/case-legacy", "Lower", 1,
             "2026-01-02T00:00:00", None),
            (10, "C:/Pictures/ẞ", "c:/pictures/ß", "Shared", 0,
             "2026-01-03T00:00:00", None),
            (20, "/mnt/c/pictures/ss", "/mnt/c/pictures/ss", None, 1,
             "2026-01-01T00:00:00", "2026-01-04T00:00:00"),
        ],
    )

    _migration_029().apply(conn)

    rows = conn.execute(
        """
        SELECT id, path, path_key, label, enabled, added_at, last_scanned_at
        FROM library_roots ORDER BY id
        """
    ).fetchall()
    assert rows == [
        (1, "/library/Case", "/library/Case", "Upper", 1,
         "2026-01-01T00:00:00", None),
        (2, "/library/case", "/library/case", "Lower", 1,
         "2026-01-02T00:00:00", None),
        (10, "/mnt/c/pictures/ss", r"c:\pictures\ss", "Shared", 1,
         "2026-01-01T00:00:00", "2026-01-04T00:00:00"),
    ]
    cursor = conn.execute(
        """
        INSERT INTO library_roots (
            path, path_key, label, enabled, added_at, last_scanned_at
        ) VALUES ('/library/new', '/library/new', NULL, 1,
                  '2026-01-05T00:00:00', NULL)
        """
    )
    assert cursor.lastrowid == 21


def test_migration_merges_unc_unicode_duplicates_deterministically():
    conn = sqlite3.connect(":memory:")
    _create_legacy_library_roots(conn)
    conn.executemany(
        """
        INSERT INTO library_roots (
            id, path, path_key, label, enabled, added_at, last_scanned_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        [
            (4, "//SERVER/Share/ẞ", "//server/share/ß", "Older", 0,
             "2026-02-01T00:00:00", "2026-02-02T00:00:00"),
            (9, "//server/share/ss", "//server/share/ss", "Newer", 0,
             "2026-02-03T00:00:00", "2026-02-04T00:00:00"),
        ],
    )

    migration = _migration_029()
    migration.apply(conn)
    first_result = conn.execute(
        """
        SELECT id, path, path_key, label, enabled, added_at, last_scanned_at
        FROM library_roots
        """
    ).fetchall()
    migration.apply(conn)

    assert first_result == [
        (4, "//server/share/ss", r"\\server\share\ss", "Newer", 0,
         "2026-02-01T00:00:00", "2026-02-04T00:00:00"),
    ]
    assert conn.execute(
        """
        SELECT id, path, path_key, label, enabled, added_at, last_scanned_at
        FROM library_roots
        """
    ).fetchall() == first_result


def test_migration_fails_explicitly_when_library_roots_table_is_missing():
    conn = sqlite3.connect(":memory:")

    with pytest.raises(RuntimeError, match="library_roots table is missing"):
        _migration_029().apply(conn)


def test_migration_fails_explicitly_when_required_column_is_missing():
    conn = sqlite3.connect(":memory:")
    conn.execute(
        """
        CREATE TABLE library_roots (
            id INTEGER PRIMARY KEY,
            path TEXT NOT NULL,
            path_key TEXT NOT NULL UNIQUE,
            enabled INTEGER NOT NULL,
            added_at TEXT NOT NULL,
            last_scanned_at TEXT
        )
        """
    )

    with pytest.raises(RuntimeError, match="missing required columns: label"):
        _migration_029().apply(conn)


def test_migration_fails_explicitly_for_blank_legacy_path():
    conn = sqlite3.connect(":memory:")
    _create_legacy_library_roots(conn)
    conn.execute(
        """
        INSERT INTO library_roots (
            path, path_key, label, enabled, added_at, last_scanned_at
        ) VALUES ('   ', 'legacy-blank', NULL, 1, '2026-01-01T00:00:00', NULL)
        """
    )

    with pytest.raises(RuntimeError, match="Library Root 1: path must not be blank"):
        _migration_029().apply(conn)
