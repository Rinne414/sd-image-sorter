"""Regression tests for migration 046 (collections per library workspace).

046 rebuilds ``collections`` to swap ``UNIQUE(slug)`` for
``UNIQUE(library_id, slug)``. The runner applies it inside a SAVEPOINT on a
connection with ``foreign_keys=ON``, where ``PRAGMA foreign_keys=OFF`` does
nothing, so ``DROP TABLE collections`` cascaded into ``collection_items`` and
emptied every user collection on upgrade. These tests build a real v45 database
through the migration chain, seed collection items, and upgrade it the way
startup does.
"""

from __future__ import annotations

import sqlite3

import pytest

import database as db
import migrations


def _item_rows(conn: sqlite3.Connection) -> list[tuple]:
    return [
        tuple(row)
        for row in conn.execute("SELECT * FROM collection_items ORDER BY id").fetchall()
    ]


@pytest.fixture
def v45_database(tmp_path, monkeypatch):
    """A database built by the real migration chain, stopped at version 45."""
    all_migrations = migrations.get_migrations()
    assert all_migrations[-1].version >= 46
    monkeypatch.setattr(db, "DATABASE_PATH", str(tmp_path / "v45.db"))
    monkeypatch.setattr(db, "_pragmas_initialized", set())
    monkeypatch.setattr(
        migrations,
        "get_migrations",
        lambda: [m for m in all_migrations if m.version <= 45],
    )
    db.init_db()
    monkeypatch.setattr(migrations, "get_migrations", lambda: all_migrations)
    monkeypatch.setattr(db, "_pragmas_initialized", set())
    return db


def _seed_collections(conn: sqlite3.Connection) -> None:
    conn.executemany(
        "INSERT INTO images (id, path, filename) VALUES (?, ?, ?)",
        [
            (1, "/lib/a.png", "a.png"),
            (2, "/lib/b.png", "b.png"),
            (3, "/lib/c.png", "c.png"),
        ],
    )
    conn.executemany(
        "INSERT INTO collections (id, slug, name, folder_path) VALUES (?, ?, ?, ?)",
        [(101, "keepers", "Keepers", "/c/keepers"), (102, "refs", "Refs", "/c/refs")],
    )
    conn.executemany(
        "INSERT INTO collection_items "
        "(id, collection_id, source_image_id, copied_path, prompt, added_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        [
            (10, 101, 1, "/c/keepers/a.png", "1girl, solo", "2026-01-02 03:04:05"),
            (11, 101, 2, "/c/keepers/b.png", None, "2026-01-03 03:04:05"),
            (12, 102, 3, "/c/refs/c.png", "landscape", "2026-01-04 03:04:05"),
        ],
    )


def test_upgrade_from_v45_keeps_every_collection_item(v45_database):
    with v45_database.get_db() as conn:
        assert (
            conn.execute("SELECT MAX(version) FROM schema_version").fetchone()[0] == 45
        )
        _seed_collections(conn)
        items_before = _item_rows(conn)
    assert len(items_before) == 3

    v45_database.init_db()

    with v45_database.get_db() as conn:
        assert (
            conn.execute("SELECT MAX(version) FROM schema_version").fetchone()[0] == 46
        )
        assert conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1
        assert _item_rows(conn) == items_before
        collections = conn.execute(
            "SELECT id, slug, library_id FROM collections WHERE id >= 101 ORDER BY id"
        ).fetchall()
        assert [tuple(row) for row in collections] == [
            (101, "keepers", "main"),
            (102, "refs", "main"),
        ]
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
        # Slugs are unique per library now, not globally.
        conn.execute(
            "INSERT INTO collections (slug, name, folder_path, library_id) "
            "VALUES ('keepers', 'Keepers B', '/c/b', 'lib_b')"
        )
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO collections (slug, name, folder_path, library_id) "
                "VALUES ('keepers', 'Dup', '/c/dup', 'main')"
            )


def test_items_still_cascade_with_their_collection_after_upgrade(v45_database):
    with v45_database.get_db() as conn:
        _seed_collections(conn)

    v45_database.init_db()

    with v45_database.get_db() as conn:
        conn.execute("DELETE FROM collections WHERE id = 101")
        remaining = [
            row[0]
            for row in conn.execute("SELECT id FROM collection_items ORDER BY id")
        ]
    assert remaining == [12]


def test_migration_046_asks_for_no_vacuum_and_is_idempotent(v45_database):
    with v45_database.get_db() as conn:
        _seed_collections(conn)
    migration = next(m for m in migrations.get_migrations() if m.version == 46)

    with v45_database.get_db() as conn:
        assert migration.apply(conn) is False
        items_after_first = _item_rows(conn)
        assert migration.apply(conn) is False
        assert _item_rows(conn) == items_after_first
    assert len(items_after_first) == 3
