from __future__ import annotations

from pathlib import Path
import sqlite3

import migrations
import pytest


def _migration_028():
    return next(migration for migration in migrations.get_migrations() if migration.version == 28)


def test_migration_uses_frozen_path_identity_helpers():
    source = (
        Path(__file__).resolve().parents[1]
        / "migrations"
        / "028_favorite_path_identity.py"
    ).read_text(encoding="utf-8")

    assert "utils.source_paths" not in source


def test_migration_rebuilds_resolved_favorites_and_retains_unresolved_legacy_keys():
    conn = sqlite3.connect(":memory:")
    conn.executescript(
        """
        CREATE TABLE images (
            id INTEGER PRIMARY KEY,
            path TEXT UNIQUE NOT NULL
        );
        CREATE INDEX idx_images_path_lower ON images(LOWER(path));
        CREATE TABLE favorite_paths (
            path_key TEXT PRIMARY KEY,
            added_at TEXT NOT NULL
        );
        INSERT INTO images (path) VALUES ('/lib/A.png'), ('/lib/a.png');
        INSERT INTO images (path) VALUES ('C:\\Library\\Keep.png');
        INSERT INTO images (path) VALUES ('C:\\Library\\ẞ.png');
        INSERT INTO images (path) VALUES ('/mnt/c/Library/Keep.png');
        INSERT INTO favorite_paths (path_key, added_at)
        VALUES ('/lib/a.png', '2026-01-01 00:00:00');
        INSERT INTO favorite_paths (path_key, added_at)
        VALUES ('c:\\library\\keep.png', '2026-01-02 00:00:00');
        INSERT INTO favorite_paths (path_key, added_at)
        VALUES ('c:\\library\\ẞ.png', '2026-01-02 12:00:00');
        INSERT INTO favorite_paths (path_key, added_at)
        VALUES ('/gone/keep.png', '2026-01-03 00:00:00');
        """
    )

    _migration_028().apply(conn)

    rows = conn.execute(
        "SELECT path_key, match_case, added_at FROM favorite_paths "
        "ORDER BY path_key, match_case"
    ).fetchall()
    assert rows == [
        ("/gone/keep.png", 0, "2026-01-03 00:00:00"),
        ("/lib/A.png", 1, "2026-01-01 00:00:00"),
        ("/lib/a.png", 1, "2026-01-01 00:00:00"),
        (r"c:\library\keep.png", 0, "2026-01-02 00:00:00"),
        (r"c:\library\ss.png", 0, "2026-01-02 12:00:00"),
    ]
    identity_rows = {
        tuple(row)
        for row in conn.execute(
            "SELECT i.path, p.path_key FROM images i "
            "JOIN image_path_identities p ON p.image_id = i.id"
        )
    }
    assert identity_rows == {
        ("/lib/A.png", "/lib/a.png"),
        ("/lib/a.png", "/lib/a.png"),
        (r"C:\Library\Keep.png", r"c:\library\keep.png"),
        (r"C:\Library\ẞ.png", r"c:\library\ss.png"),
        ("/mnt/c/Library/Keep.png", r"c:\library\keep.png"),
    }


def test_migration_fails_explicitly_when_legacy_table_is_missing():
    conn = sqlite3.connect(":memory:")

    with pytest.raises(RuntimeError, match="favorite_paths table is missing"):
        _migration_028().apply(conn)


def test_migration_skips_empty_materialized_image_path_identities():
    conn = sqlite3.connect(":memory:")
    conn.executescript(
        """
        CREATE TABLE images (
            id INTEGER PRIMARY KEY,
            path TEXT UNIQUE NOT NULL
        );
        CREATE TABLE favorite_paths (
            path_key TEXT PRIMARY KEY,
            added_at TEXT NOT NULL
        );
        INSERT INTO images (path) VALUES (''), ('   ');
        """
    )

    _migration_028().apply(conn)

    assert conn.execute(
        "SELECT image_id, path_key FROM image_path_identities"
    ).fetchall() == []
    with pytest.raises(sqlite3.IntegrityError, match="CHECK constraint failed"):
        conn.execute(
            "INSERT INTO image_path_identities (image_id, path_key) VALUES (?, ?)",
            (1, ""),
        )


def test_migration_converts_sqlite_ascii_lower_unicode_windows_key():
    conn = sqlite3.connect(":memory:")
    conn.executescript(
        """
        CREATE TABLE images (
            id INTEGER PRIMARY KEY,
            path TEXT UNIQUE NOT NULL
        );
        CREATE TABLE favorite_paths (
            path_key TEXT PRIMARY KEY,
            added_at TEXT NOT NULL
        );
        INSERT INTO images (path) VALUES ('C:\\Library\\Ä.png');
        INSERT INTO favorite_paths (path_key, added_at)
        VALUES ('c:\\library\\Ä.png', '2026-01-01 00:00:00');
        """
    )

    _migration_028().apply(conn)

    row = conn.execute(
        "SELECT path_key, match_case FROM favorite_paths"
    ).fetchone()
    assert row == (r"c:\library\ä.png", 0)


def test_migration_casefolds_unresolved_sharp_s_key():
    conn = sqlite3.connect(":memory:")
    conn.executescript(
        """
        CREATE TABLE images (
            id INTEGER PRIMARY KEY,
            path TEXT UNIQUE NOT NULL
        );
        CREATE TABLE favorite_paths (
            path_key TEXT PRIMARY KEY,
            added_at TEXT NOT NULL
        );
        INSERT INTO favorite_paths (path_key, added_at)
        VALUES ('C:\\Library\\ẞ.png', '2026-01-01 00:00:00');
        """
    )

    _migration_028().apply(conn)

    row = conn.execute(
        "SELECT path_key, match_case FROM favorite_paths"
    ).fetchone()
    assert row == (r"c:\library\ss.png", 0)


def test_migrated_forward_slash_windows_favorite_can_be_removed_and_restored(
    test_db,
):
    import database as db

    with db.get_db() as conn:
        conn.execute("DROP TABLE favorite_paths")
        conn.execute(
            """
            CREATE TABLE favorite_paths (
                path_key TEXT PRIMARY KEY,
                added_at TEXT NOT NULL
            )
            """
        )
        cursor = conn.execute(
            "INSERT INTO images (path, filename) VALUES (?, ?)",
            ("C:/Library/Keep.png", "Keep.png"),
        )
        old_id = int(cursor.lastrowid)
        conn.execute(
            "INSERT INTO favorite_paths (path_key, added_at) VALUES (?, ?)",
            ("c:/library/keep.png", "2026-01-01 00:00:00"),
        )
        _migration_028().apply(conn)

    assert db.is_favorited(old_id)

    db.set_favorite(old_id, False)
    assert not db.is_favorited(old_id)

    db.set_favorite(old_id, True)
    with db.get_db() as conn:
        conn.execute("DELETE FROM images")

    new_id = db.add_image(
        path=r"C:\Library\Keep.png",
        filename="Keep.png",
    )

    assert db.get_favorite_source_ids() == [new_id]
    assert db.is_favorited(new_id)


def test_migration_keeps_native_sqlite_image_writes_compatible(test_db):
    import database as db

    update_id = db.add_image(path=r"C:\Native\Update.png", filename="Update.png")
    delete_id = db.add_image(path=r"C:\Native\Delete.png", filename="Delete.png")

    raw = sqlite3.connect(db.DATABASE_PATH)
    try:
        schema_sql = "\n".join(
            str(row[0] or "")
            for row in raw.execute(
                "SELECT sql FROM sqlite_schema "
                "WHERE type IN ('index', 'trigger', 'table')"
            )
        )
        assert "indexed_path_casefold" not in schema_sql.casefold()

        raw.execute(
            "INSERT INTO images (path, filename) VALUES (?, ?)",
            ("/native/write.png", "write.png"),
        )
        raw_insert_id = int(raw.execute("SELECT last_insert_rowid()").fetchone()[0])
        assert raw.execute(
            "SELECT 1 FROM image_path_identities WHERE image_id = ?",
            (raw_insert_id,),
        ).fetchone() is None
        raw.execute(
            "UPDATE images SET path = ? WHERE path = ?",
            ("/native/renamed.png", "/native/write.png"),
        )
        raw.execute(
            "UPDATE images SET path = ? WHERE id = ?",
            (r"C:\Native\Updated.png", update_id),
        )
        assert raw.execute(
            "SELECT 1 FROM image_path_identities WHERE image_id = ?",
            (update_id,),
        ).fetchone() is None
        raw.execute("DELETE FROM images WHERE id = ?", (delete_id,))
        assert raw.execute(
            "SELECT 1 FROM image_path_identities WHERE image_id = ?",
            (delete_id,),
        ).fetchone() is None
        raw.execute(
            "DELETE FROM images WHERE path = ?",
            ("/native/renamed.png",),
        )
        raw.commit()
    finally:
        raw.close()
