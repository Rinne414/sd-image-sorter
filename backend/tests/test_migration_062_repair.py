"""Migration 062 gives a V Opus database the three migrations it skipped.

V Opus numbered its own migrations 060 and 061 while the classic line went on
to 049-051. ``init_db`` skips every migration at or below the database's
version, so a database V Opus had taken to 061 would never get 049 (aesthetic
score columns), 050 (``image_style_vectors``) or 051 (``sorted_images``).
062 runs them again: it repairs such a database and changes nothing on a fresh
one or one that came up through 051.
"""

from __future__ import annotations

import sqlite3

import pytest

import database as db
import migrations

AESTHETIC_COLUMNS = (
    "aesthetic_version",
    "aesthetic_waifu",
    "aesthetic_anime",
    "aesthetic_anime_pct",
    "aesthetic_anime_grade",
)
REPAIRED_TABLES = ("image_style_vectors", "sorted_images")
BATCH_TABLES = ("batches", "batch_items", "batch_templates")


def _schema_version(conn: sqlite3.Connection) -> int:
    return int(
        conn.execute("SELECT version FROM schema_version WHERE id = 1").fetchone()[0]
    )


def _image_columns(conn: sqlite3.Connection) -> set[str]:
    return {str(row[1]) for row in conn.execute("PRAGMA table_info(images)").fetchall()}


def _tables(conn: sqlite3.Connection) -> set[str]:
    return {
        str(row[0])
        for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'"
        ).fetchall()
    }


def _schema(conn: sqlite3.Connection) -> set[tuple[str, str]]:
    """Every table, index and column, so two databases can be compared."""
    items = {
        (str(row[0]), str(row[1]))
        for row in conn.execute(
            "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'"
        ).fetchall()
    }
    for table in _tables(conn):
        for row in conn.execute(f'PRAGMA table_info("{table}")').fetchall():
            items.add(("column", f"{table}.{row[1]}"))
    return items


def _build(tmp_path, monkeypatch, name: str, keep) -> str:
    """A database built by the real migration chain with only the kept versions."""
    all_migrations = migrations.get_migrations()
    path = str(tmp_path / name)
    monkeypatch.setattr(db, "DATABASE_PATH", path)
    monkeypatch.setattr(db, "_pragmas_initialized", set())
    monkeypatch.setattr(
        migrations,
        "get_migrations",
        lambda: [m for m in all_migrations if keep(m.version)],
    )
    db.init_db()
    monkeypatch.setattr(migrations, "get_migrations", lambda: all_migrations)
    monkeypatch.setattr(db, "_pragmas_initialized", set())
    return path


def _upgrade(path: str, monkeypatch) -> None:
    monkeypatch.setattr(db, "DATABASE_PATH", path)
    monkeypatch.setattr(db, "_pragmas_initialized", set())
    db.init_db()


@pytest.fixture
def vopus_061_database(tmp_path, monkeypatch) -> str:
    """What V Opus left: 001-048 plus its 060 and 061, never 049-051.

    The baseline here is the merged one, which already creates the aesthetic
    columns for a fresh database, so they are dropped again to match a
    database V Opus created.
    """
    path = _build(
        tmp_path, monkeypatch, "vopus61.db", lambda v: v <= 48 or v in (60, 61)
    )
    with sqlite3.connect(path) as conn:
        for column in AESTHETIC_COLUMNS:
            if column in _image_columns(conn):
                conn.execute(f"ALTER TABLE images DROP COLUMN {column}")
        for table in REPAIRED_TABLES:
            conn.execute(f"DROP TABLE IF EXISTS {table}")
        conn.execute(
            "INSERT INTO images (id, path, filename, aesthetic_score) "
            "VALUES (7, '/lib/a.png', 'a.png', 6.5)"
        )
        conn.execute(
            "INSERT INTO batches (id, kind, name) VALUES (3, 'custom', 'Picks')"
        )
        conn.execute(
            "INSERT INTO batch_items (batch_id, image_id, position) VALUES (3, 7, 0)"
        )
        assert _schema_version(conn) == 61
    return path


def test_migration_062_comes_right_after_the_v_opus_pair():
    versions = [m.version for m in migrations.get_migrations()]
    start = versions.index(60)
    assert versions[start : start + 3] == [60, 61, 62]


LATEST = migrations.get_migrations()[-1].version


def test_a_vopus_061_database_gets_the_skipped_columns_and_tables(
    vopus_061_database, monkeypatch
):
    with sqlite3.connect(vopus_061_database) as conn:
        assert not set(AESTHETIC_COLUMNS) & _image_columns(conn)
        assert not set(REPAIRED_TABLES) & _tables(conn)

    _upgrade(vopus_061_database, monkeypatch)

    with sqlite3.connect(vopus_061_database) as conn:
        assert _schema_version(conn) == LATEST
        assert set(AESTHETIC_COLUMNS) <= _image_columns(conn)
        assert set(REPAIRED_TABLES) <= _tables(conn)
        # Rows are kept as they were; an old score counts as "to score" again.
        row = conn.execute(
            "SELECT filename, aesthetic_score, aesthetic_version FROM images WHERE id = 7"
        ).fetchone()
        assert row == ("a.png", 6.5, None)
        assert conn.execute("SELECT name FROM batches WHERE id = 3").fetchone() == (
            "Picks",
        )
        assert conn.execute("SELECT COUNT(*) FROM batch_items").fetchone() == (1,)


def test_the_repaired_vopus_database_has_the_schema_of_a_fresh_one(
    vopus_061_database, tmp_path, monkeypatch
):
    _upgrade(vopus_061_database, monkeypatch)
    fresh = _build(tmp_path, monkeypatch, "fresh.db", lambda v: True)
    with sqlite3.connect(vopus_061_database) as repaired, sqlite3.connect(fresh) as new:
        missing = _schema(new) - _schema(repaired)
    assert not missing


def test_a_main_051_database_comes_up_through_060_061_and_062(tmp_path, monkeypatch):
    path = _build(tmp_path, monkeypatch, "main51.db", lambda v: v <= 51)
    with sqlite3.connect(path) as conn:
        assert _schema_version(conn) == 51
        before = _schema(conn)

    _upgrade(path, monkeypatch)

    fresh = _build(tmp_path, monkeypatch, "fresh.db", lambda v: True)
    with sqlite3.connect(path) as conn, sqlite3.connect(fresh) as new:
        assert _schema_version(conn) == LATEST
        assert set(BATCH_TABLES) <= _tables(conn)
        after = _schema(conn)
        assert after == _schema(new)
    # Only the batch migrations added anything: 062 changed nothing here.
    assert {name for kind, name in after - before if kind == "table"} == set(
        BATCH_TABLES
    )


def test_a_fresh_database_lands_on_062(test_db):
    with test_db.get_db() as conn:
        assert _schema_version(conn) == LATEST
        assert set(AESTHETIC_COLUMNS) <= _image_columns(conn)
        assert set(REPAIRED_TABLES) <= _tables(conn)


def test_062_twice_changes_nothing(test_db):
    migration = next(m for m in migrations.get_migrations() if m.version == 62)
    with test_db.get_db() as conn:
        before = _schema(conn)
        migration.apply(conn)
        migration.apply(conn)
        assert _schema(conn) == before
