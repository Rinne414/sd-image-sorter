"""Regression test for migration 018 (nl_caption backfill).

Background
==========
The v3.3.3 VLM-caption work added an ``nl_caption`` column to the ``images``
table via ``FULL_SCHEMA_STATEMENTS`` + ``LEGACY_IMAGE_COLUMNS`` but did not
ship a dedicated migration. Because ``add_missing_legacy_image_columns``
only runs inside migrations 001/002, a database already past
schema_version 2 (i.e. every existing install) upgraded WITHOUT gaining the
column and then crashed with ``sqlite3.OperationalError: no such column:
nl_caption`` on the next gallery / dataset-maker query.

Migration 018 backfills the column on upgrade. These tests pin both the
migration in isolation and the full ``init_db()`` upgrade path that an
existing user actually hits.
"""
from __future__ import annotations

import sqlite3

import migrations
from migrations._schema_common import create_full_schema


def _get_migration_018():
    return next(m for m in migrations.get_migrations() if m.version == 18)


def test_migration_018_is_registered_as_latest():
    """The loader must discover 018 and treat it as the newest migration."""
    all_migrations = migrations.get_migrations()
    versions = [m.version for m in all_migrations]
    assert 18 in versions
    assert all_migrations[-1].version >= 18, "018 must sort as (at least) the latest"
    # Versions remain unique / strictly ordered (get_migrations enforces this,
    # but assert here so a duplicate 018 fails loudly in this suite too).
    assert len(versions) == len(set(versions))


def test_migration_018_adds_nl_caption_to_existing_table():
    """Applying 018 to a pre-nl_caption images table adds the column."""
    conn = sqlite3.connect(":memory:")
    try:
        conn.execute(
            "CREATE TABLE images ("
            "id INTEGER PRIMARY KEY AUTOINCREMENT, "
            "path TEXT, filename TEXT, ai_caption TEXT)"
        )
        conn.commit()
        before = {row[1] for row in conn.execute("PRAGMA table_info(images)")}
        assert "nl_caption" not in before, "precondition: column starts absent"

        _get_migration_018().apply(conn)

        after = {row[1] for row in conn.execute("PRAGMA table_info(images)")}
        assert "nl_caption" in after, "migration 018 must add nl_caption"
    finally:
        conn.close()


def test_migration_018_is_idempotent():
    """Re-applying 018 on a DB that already has nl_caption must not raise."""
    conn = sqlite3.connect(":memory:")
    try:
        conn.execute(
            "CREATE TABLE images ("
            "id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT, nl_caption TEXT)"
        )
        conn.commit()

        migration = _get_migration_018()
        migration.apply(conn)  # nl_caption already present
        migration.apply(conn)  # second run must be a no-op, not "duplicate column"

        cols = {row[1] for row in conn.execute("PRAGMA table_info(images)")}
        assert "nl_caption" in cols
    finally:
        conn.close()


def test_migration_018_skips_when_images_table_absent():
    """A DB without an images table (defensive) must not raise."""
    conn = sqlite3.connect(":memory:")
    try:
        _get_migration_018().apply(conn)  # no images table -> early return
    finally:
        conn.close()


def test_init_db_upgrade_backfills_missing_nl_caption(tmp_path, monkeypatch):
    """End-to-end: an existing v3.3.2-era DB whose images table lacks
    nl_caption must gain it through init_db() instead of crashing later.

    Reproduces the real upgrade by building the current full schema, then
    dropping nl_caption and rewinding schema_version to 17 (its value before
    migration 018 existed) — exactly the state of an installed user's DB.
    """
    db_path = tmp_path / "pre_nl_caption.db"

    # Build a realistic pre-018 database with a RAW connection (so init_db is
    # only invoked once, after the buggy state already exists on disk).
    raw = sqlite3.connect(str(db_path))
    try:
        create_full_schema(raw)  # current schema (includes nl_caption + indexes)
        raw.execute("ALTER TABLE images DROP COLUMN nl_caption")  # simulate the gap
        raw.execute(
            "CREATE TABLE schema_version ("
            "id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)"
        )
        raw.execute("INSERT INTO schema_version (id, version) VALUES (1, 17)")
        raw.execute(
            "INSERT INTO images (path, filename, generator, prompt) VALUES (?, ?, ?, ?)",
            ("/legacy/img1.png", "img1.png", "webui", "1girl, smile"),
        )
        raw.commit()
        cols_before = {row[1] for row in raw.execute("PRAGMA table_info(images)")}
        assert "nl_caption" not in cols_before, "precondition: bug reproduced"
    finally:
        raw.close()

    import database as db

    monkeypatch.setattr(db, "DATABASE_PATH", str(db_path))
    db._pragmas_initialized = set()

    # Must NOT raise, and must backfill nl_caption + advance schema_version.
    db.init_db()

    latest_version = migrations.get_migrations()[-1].version
    verify = sqlite3.connect(str(db_path))
    verify.row_factory = sqlite3.Row
    try:
        cols_after = {row["name"] for row in verify.execute("PRAGMA table_info(images)")}
        assert "nl_caption" in cols_after, "init_db must backfill nl_caption on upgrade"

        version_row = verify.execute(
            "SELECT version FROM schema_version WHERE id = 1"
        ).fetchone()
        assert int(version_row["version"]) == latest_version

        # The pre-existing row survives and reads NULL for the new column.
        row = verify.execute(
            "SELECT nl_caption FROM images WHERE path = ?", ("/legacy/img1.png",)
        ).fetchone()
        assert row is not None
        assert row["nl_caption"] is None
    finally:
        verify.close()
