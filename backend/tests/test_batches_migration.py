"""Migration 060 creates the batch tables on fresh and on V3.5 (v48) databases."""

from __future__ import annotations

import sqlite3

import pytest

import database as db
import migrations

BATCH_TABLES = {"batches", "batch_items", "batch_templates"}


def _migration_060():
    return next(m for m in migrations.get_migrations() if m.version == 60)


def _tables(conn: sqlite3.Connection) -> set[str]:
    return {
        str(row[0])
        for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
    }


@pytest.fixture
def v48_database(tmp_path, monkeypatch):
    """A database built by the real migration chain, stopped at version 48."""
    all_migrations = migrations.get_migrations()
    monkeypatch.setattr(db, "DATABASE_PATH", str(tmp_path / "v48.db"))
    monkeypatch.setattr(db, "_pragmas_initialized", set())
    monkeypatch.setattr(
        migrations,
        "get_migrations",
        lambda: [m for m in all_migrations if m.version <= 48],
    )
    db.init_db()
    monkeypatch.setattr(migrations, "get_migrations", lambda: all_migrations)
    monkeypatch.setattr(db, "_pragmas_initialized", set())
    return db


def test_fresh_database_has_batch_tables(test_db):
    with test_db.get_db() as conn:
        assert BATCH_TABLES <= _tables(conn)
        version = conn.execute(
            "SELECT version FROM schema_version WHERE id = 1"
        ).fetchone()[0]
    assert version >= 60


def test_v48_database_upgrades_and_keeps_its_rows(v48_database):
    with v48_database.get_db() as conn:
        assert conn.execute("SELECT version FROM schema_version").fetchone()[0] == 48
        assert not (BATCH_TABLES & _tables(conn))
        conn.execute(
            "INSERT INTO images (id, path, filename) VALUES (7, '/l/a.png', 'a.png')"
        )
        conn.execute(
            "INSERT INTO dataset_projects (id, name, name_key) VALUES (3, 'P', 'p')"
        )

    v48_database.init_db()

    with v48_database.get_db() as conn:
        assert conn.execute("SELECT version FROM schema_version").fetchone()[0] >= 60
        assert BATCH_TABLES <= _tables(conn)
        assert conn.execute("SELECT COUNT(*) FROM images").fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM dataset_projects").fetchone()[0] == 1
        batch_id = conn.execute(
            "INSERT INTO batches (kind, name, dataset_project_id) VALUES ('dataset', 'D', 3)"
        ).lastrowid
        conn.execute(
            "INSERT INTO batch_items (batch_id, image_id, position) VALUES (?, 7, 0)",
            (batch_id,),
        )
        row = conn.execute(
            "SELECT library_id, revision, steps_json, settings_json FROM batches WHERE id = ?",
            (batch_id,),
        ).fetchone()
        assert tuple(row) == ("main", 1, "[]", "{}")

        conn.execute("DELETE FROM dataset_projects WHERE id = 3")
        assert (
            conn.execute(
                "SELECT dataset_project_id FROM batches WHERE id = ?", (batch_id,)
            ).fetchone()[0]
            is None
        )
        conn.execute("DELETE FROM images WHERE id = 7")
        assert conn.execute("SELECT COUNT(*) FROM batch_items").fetchone()[0] == 0


def test_batch_constraints(test_db):
    with test_db.get_db() as conn:
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute("INSERT INTO batches (kind, name) VALUES ('video', 'x')")
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute("INSERT INTO batches (kind, name) VALUES ('pixiv', '  ')")
        conn.execute(
            "INSERT INTO images (id, path, filename) VALUES (1, '/l/a.png', 'a.png')"
        )
        batch_id = conn.execute(
            "INSERT INTO batches (kind, name) VALUES ('pixiv', 'P')"
        ).lastrowid
        conn.execute(
            "INSERT INTO batch_items (batch_id, image_id, position) VALUES (?, 1, 0)",
            (batch_id,),
        )
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO batch_items (batch_id, image_id, position) VALUES (?, 1, 1)",
                (batch_id,),
            )
        conn.execute("DELETE FROM batches WHERE id = ?", (batch_id,))
        assert conn.execute("SELECT COUNT(*) FROM batch_items").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM images").fetchone()[0] == 1


def test_apply_is_idempotent_and_rejects_partial_tables(tmp_path):
    migration = _migration_060()
    conn = sqlite3.connect(tmp_path / "partial.db")
    try:
        conn.execute("CREATE TABLE images (id INTEGER PRIMARY KEY)")
        conn.execute("CREATE TABLE dataset_projects (id INTEGER PRIMARY KEY)")
        assert migration.apply(conn) is False
        assert migration.apply(conn) is False
        conn.execute("DROP TABLE batch_templates")
        with pytest.raises(RuntimeError, match="partially present"):
            migration.apply(conn)
    finally:
        conn.close()
