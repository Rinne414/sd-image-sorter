"""An existing database is copied aside before its schema is upgraded.

A schema upgrade is one-way: an older version refuses the upgraded database.
So before the first migration touches an existing database, ``init_db``
writes a copy next to it under ``backups/``. A new database or one that is
already current is not copied, only the newest few copies are kept, and a copy
that cannot be written does not stop the upgrade (it only leaves no way back).
"""

from __future__ import annotations

import logging
import os
import sqlite3
import time
from pathlib import Path

import database as db
import db_schema
import migrations


def _build(tmp_path: Path, monkeypatch, name: str, keep) -> Path:
    all_migrations = migrations.get_migrations()
    path = tmp_path / name
    monkeypatch.setattr(db, "DATABASE_PATH", str(path))
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


def _upgrade(path: Path, monkeypatch) -> None:
    monkeypatch.setattr(db, "DATABASE_PATH", str(path))
    monkeypatch.setattr(db, "_pragmas_initialized", set())
    db.init_db()


def _version(path: Path) -> int:
    with sqlite3.connect(path) as conn:
        return int(conn.execute("SELECT version FROM schema_version").fetchone()[0])


def _backups(path: Path) -> list[Path]:
    folder = path.parent / "backups"
    return sorted(folder.iterdir()) if folder.is_dir() else []


def test_an_upgrade_copies_the_database_aside_first(tmp_path, monkeypatch):
    latest = migrations.get_migrations()[-1].version
    old = _build(tmp_path, monkeypatch, "library.db", lambda v: v < latest)
    with sqlite3.connect(old) as conn:
        conn.execute(
            "INSERT INTO images (id, path, filename) VALUES (5, '/l/a.png', 'a.png')"
        )
    previous = _version(old)

    _upgrade(old, monkeypatch)

    assert _version(old) == latest
    copies = _backups(old)
    assert [
        p.name.startswith(f"library-schema-{previous:03d}-to-{latest:03d}-")
        for p in copies
    ] == [True]
    assert copies[0].suffix == ".db"
    with sqlite3.connect(copies[0]) as conn:
        assert (
            int(conn.execute("SELECT version FROM schema_version").fetchone()[0])
            == previous
        )
        assert conn.execute("SELECT filename FROM images WHERE id = 5").fetchone() == (
            "a.png",
        )


def test_a_new_database_is_not_copied(tmp_path, monkeypatch):
    fresh = _build(tmp_path, monkeypatch, "new.db", lambda v: True)
    assert _backups(fresh) == []


def test_a_current_database_is_not_copied(tmp_path, monkeypatch):
    current = _build(tmp_path, monkeypatch, "current.db", lambda v: True)
    _upgrade(current, monkeypatch)
    assert _backups(current) == []


def test_a_copy_that_cannot_be_written_does_not_stop_the_upgrade(
    tmp_path, monkeypatch, caplog
):
    latest = migrations.get_migrations()[-1].version
    old = _build(tmp_path, monkeypatch, "library.db", lambda v: v < latest)

    def disk_full(_conn, target: Path) -> None:
        target.write_bytes(b"half a copy")
        raise sqlite3.OperationalError("database or disk is full")

    monkeypatch.setattr(db_schema, "_copy_database", disk_full)
    with caplog.at_level(logging.WARNING, logger="db_schema"):
        _upgrade(old, monkeypatch)

    assert _version(old) == latest
    assert "database or disk is full" in caplog.text
    # The half-written copy is removed, and no copy pretends to be complete.
    assert _backups(old) == []


def test_a_copy_that_cannot_be_tidied_does_not_stop_the_upgrade(
    tmp_path, monkeypatch, caplog
):
    latest = migrations.get_migrations()[-1].version
    old = _build(tmp_path, monkeypatch, "library.db", lambda v: v < latest)

    def locked(*_args) -> None:
        raise PermissionError(13, "The file is in use")

    monkeypatch.setattr(db_schema, "_prune_schema_backups", locked)
    with caplog.at_level(logging.WARNING, logger="db_schema"):
        _upgrade(old, monkeypatch)

    assert _version(old) == latest
    assert "The file is in use" in caplog.text
    assert len(_backups(old)) == 1


def test_only_the_newest_copies_are_kept(tmp_path, monkeypatch):
    latest = migrations.get_migrations()[-1].version
    old = _build(tmp_path, monkeypatch, "library.db", lambda v: v < latest)
    folder = old.parent / "backups"
    folder.mkdir()
    now = time.time()
    for age in (1, 2, 3, 4):
        stale = folder / f"library-schema-040-to-041-2026010{age}-000000.db"
        stale.write_bytes(b"old copy")
        os.utime(stale, (now - age * 86400, now - age * 86400))
    unrelated = folder / "my-own-copy.db"
    unrelated.write_bytes(b"keep me")

    _upgrade(old, monkeypatch)

    names = {p.name for p in _backups(old)}
    assert "my-own-copy.db" in names
    ours = sorted(n for n in names if n.startswith("library-schema-"))
    assert len(ours) == db_schema.SCHEMA_BACKUPS_KEPT
    assert "library-schema-040-to-041-20260101-000000.db" in ours
    assert "library-schema-040-to-041-20260104-000000.db" not in ours


def test_the_copy_just_written_is_kept_whatever_the_other_times_say(
    tmp_path, monkeypatch
):
    latest = migrations.get_migrations()[-1].version
    old = _build(tmp_path, monkeypatch, "library.db", lambda v: v < latest)
    folder = old.parent / "backups"
    folder.mkdir()
    future = time.time() + 30 * 86400
    for day in (1, 2, 3):
        skewed = folder / f"library-schema-040-to-041-2027010{day}-000000.db"
        skewed.write_bytes(b"copy from a clock that ran ahead")
        os.utime(skewed, (future, future))

    _upgrade(old, monkeypatch)

    ours = [p.name for p in _backups(old) if p.name.startswith("library-schema-")]
    assert len(ours) == db_schema.SCHEMA_BACKUPS_KEPT
    assert any(f"-to-{latest:03d}-" in name for name in ours)


def test_a_name_with_wildcard_characters_still_finds_its_own_copies(
    tmp_path, monkeypatch
):
    latest = migrations.get_migrations()[-1].version
    old = _build(tmp_path, monkeypatch, "my[1].db", lambda v: v < latest)
    folder = old.parent / "backups"
    folder.mkdir()
    for day in (1, 2, 3, 4):
        stale = folder / f"my[1]-schema-040-to-041-2026010{day}-000000.db"
        stale.write_bytes(b"old copy")
        os.utime(stale, (time.time() - day * 86400,) * 2)

    _upgrade(old, monkeypatch)

    ours = [p.name for p in _backups(old) if p.name.startswith("my[1]-schema-")]
    assert len(ours) == db_schema.SCHEMA_BACKUPS_KEPT
