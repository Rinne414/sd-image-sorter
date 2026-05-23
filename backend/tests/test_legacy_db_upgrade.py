"""Regression test for the legacy DB upgrade path.

Background
==========
v3.2.2: a user upgrading from a very old version (DB created before
``tagged_at`` / ``indexed_at`` were added to the schema) hit a hard
``sqlite3.OperationalError: no such column: tagged_at`` during
``init_db()`` because:

1. The full-schema CREATE TABLE statement used ``CREATE TABLE IF NOT
   EXISTS`` so the existing legacy ``images`` table wasn't recreated.
2. The ``add_missing_legacy_image_columns`` backfill list didn't
   include ``tagged_at``, ``indexed_at``, or ``created_at``.
3. The post-migration index ``idx_images_tagged_at ON images(tagged_at)``
   then failed to create because the column genuinely didn't exist.

This test pins the fix: a v0-style DB (just images + tags, no schema
version table, no v3.2.x columns) must upgrade cleanly through
init_db() and reach schema_version 13.
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest


def _build_v0_legacy_db(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(path))
    conn.executescript(
        """
        CREATE TABLE images (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT UNIQUE NOT NULL,
            filename TEXT NOT NULL,
            generator TEXT,
            prompt TEXT,
            negative_prompt TEXT,
            checkpoint TEXT,
            loras TEXT,
            width INTEGER,
            height INTEGER,
            file_size INTEGER,
            metadata_json TEXT,
            created_at TEXT
        );
        CREATE TABLE tags (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            image_id INTEGER NOT NULL,
            tag TEXT NOT NULL,
            confidence REAL
        );
        """
    )
    conn.commit()
    return conn


def test_init_db_upgrades_v0_legacy_db_without_error(tmp_path, monkeypatch):
    legacy_path = tmp_path / "legacy.db"
    conn = _build_v0_legacy_db(legacy_path)
    conn.execute(
        "INSERT INTO images (path, filename, generator, prompt) VALUES (?, ?, ?, ?)",
        ("/legacy/image1.png", "image1.png", "webui", "1girl, smile"),
    )
    conn.execute(
        "INSERT INTO tags (image_id, tag, confidence) VALUES (?, ?, ?)",
        (1, "1girl", 0.99),
    )
    conn.commit()
    conn.close()

    import database as db
    monkeypatch.setattr(db, "DATABASE_PATH", str(legacy_path))
    db._pragmas_initialized = set()

    # Should NOT raise "no such column: tagged_at"
    db.init_db()

    # Verify final state
    verify = sqlite3.connect(str(legacy_path))
    verify.row_factory = sqlite3.Row
    cur = verify.cursor()

    cur.execute("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1")
    row = cur.fetchone()
    assert row is not None
    assert int(row["version"]) >= 13, f"expected schema_version >= 13, got {row['version']}"

    # The legacy image must still exist
    cur.execute("SELECT COUNT(*) c FROM images WHERE path = ?", ("/legacy/image1.png",))
    assert cur.fetchone()["c"] == 1

    # The legacy tag must still exist
    cur.execute("SELECT COUNT(*) c FROM tags WHERE tag = ?", ("1girl",))
    assert cur.fetchone()["c"] == 1

    # All v3.2.x columns must now be present on the images table
    cur.execute("PRAGMA table_info(images)")
    cols = {r["name"] for r in cur.fetchall()}
    expected = {
        "tagged_at", "indexed_at", "created_at",
        "metadata_status", "is_readable", "read_error",
        "source_mtime_ns", "source_size", "content_fingerprint",
        "aesthetic_score", "avg_brightness", "color_temperature",
    }
    missing = expected - cols
    assert not missing, f"legacy upgrade left columns missing: {sorted(missing)}"

    verify.close()


def test_init_db_is_idempotent_on_fully_migrated_db(tmp_path, monkeypatch):
    """Running init_db twice in a row on the same DB must be a no-op."""
    db_path = tmp_path / "fresh.db"
    import database as db
    monkeypatch.setattr(db, "DATABASE_PATH", str(db_path))
    db._pragmas_initialized = set()

    db.init_db()
    db.init_db()  # Should NOT raise

    verify = sqlite3.connect(str(db_path))
    verify.row_factory = sqlite3.Row
    cur = verify.cursor()
    cur.execute("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1")
    row = cur.fetchone()
    assert int(row["version"]) >= 13
    verify.close()
