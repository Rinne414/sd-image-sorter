"""Regression tests for migration 011 (purge leaked pytest fixture rows)."""
from __future__ import annotations

import importlib.util
import sqlite3
from pathlib import Path

import pytest

from migrations import _schema_common as schema_common


_MIGRATION_PATH = (
    Path(__file__).resolve().parent.parent
    / "migrations"
    / "011_purge_leaked_test_rows.py"
)


def _load_migration():
    spec = importlib.util.spec_from_file_location("migration_011", _MIGRATION_PATH)
    assert spec and spec.loader, f"could not load {_MIGRATION_PATH}"
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def fresh_db(tmp_path: Path) -> sqlite3.Connection:
    """Build the minimum schema the migration needs."""
    conn = sqlite3.connect(str(tmp_path / "images.db"))
    conn.executescript(
        """
        CREATE TABLE images (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT NOT NULL,
            filename TEXT NOT NULL,
            metadata_status TEXT,
            read_error TEXT
        );
        CREATE TABLE tags (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            image_id INTEGER NOT NULL,
            tag TEXT NOT NULL,
            confidence REAL
        );
        CREATE TABLE image_loras (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            image_id INTEGER NOT NULL,
            lora_name TEXT
        );
        """
    )
    conn.commit()
    return conn


def test_migration_purges_pytest_pollution(fresh_db):
    cur = fresh_db.cursor()
    cur.executemany(
        "INSERT INTO images (path, filename, metadata_status, read_error) VALUES (?, ?, ?, ?)",
        [
            (
                "/mnt/l/Antigravitiy code/sd-image-sorter/data/tmp/pytest-of-user/pytest-220/test_e2e_fake_tagger_completes0/fake-tagger.png",
                "fake-tagger.png",
                "error",
                "File not found on disk",
            ),
            (
                "L:\\Antigravitiy code\\sd-image-sorter\\data\\tmp\\pytest-of-User\\pytest-223\\test_e2e_fake_tagger_completes0\\fake-tagger.png",
                "fake-tagger.png",
                "error",
                "File not found on disk",
            ),
            (
                "L:\\Pictures\\AAA Reference\\real-image.png",
                "real-image.png",
                "complete",
                None,
            ),
        ],
    )
    fresh_db.commit()

    # Insert a tag for the leaked row to verify cleanup.
    cur.execute("SELECT id FROM images WHERE path LIKE '%pytest%'")
    leak_ids = [row[0] for row in cur.fetchall()]
    assert leak_ids
    cur.executemany(
        "INSERT INTO tags (image_id, tag, confidence) VALUES (?, ?, ?)",
        [(image_id, "fixture_tag", 1.0) for image_id in leak_ids],
    )
    fresh_db.commit()

    migration = _load_migration()
    purged = migration.apply(fresh_db)
    fresh_db.commit()

    assert purged is True

    cur.execute("SELECT COUNT(*) FROM images")
    assert cur.fetchone()[0] == 1

    cur.execute("SELECT path FROM images")
    remaining_paths = [row[0] for row in cur.fetchall()]
    assert remaining_paths == ["L:\\Pictures\\AAA Reference\\real-image.png"]

    cur.execute("SELECT COUNT(*) FROM tags")
    assert cur.fetchone()[0] == 0


def test_migration_is_idempotent(fresh_db):
    migration = _load_migration()
    assert migration.apply(fresh_db) is False
    assert migration.apply(fresh_db) is False


def test_migration_does_not_touch_legit_paths(fresh_db):
    cur = fresh_db.cursor()
    legit = [
        ("L:\\Pictures\\my_tmp_backup\\photo.png", "photo.png", "complete", None),
        ("/home/user/archive/tmp_collection/cat.jpg", "cat.jpg", "complete", None),
        # Folder named like 'pytest-of' but no runtime tmp prefix - leave alone.
        (
            "C:\\Users\\me\\Pictures\\pytest-of-someone\\image.png",
            "image.png",
            "complete",
            None,
        ),
        # data\tmp\ but no fixture marker - probably user putting a real image
        # in the app's tmp directory; we still leave it (we're conservative).
        (
            "L:\\Antigravitiy code\\sd-image-sorter\\data\\tmp\\my-image.png",
            "my-image.png",
            "complete",
            None,
        ),
    ]
    cur.executemany(
        "INSERT INTO images (path, filename, metadata_status, read_error) VALUES (?, ?, ?, ?)",
        legit,
    )
    fresh_db.commit()

    migration = _load_migration()
    purged = migration.apply(fresh_db)

    assert purged is False
    cur.execute("SELECT COUNT(*) FROM images")
    assert cur.fetchone()[0] == len(legit)


def test_migration_skipped_if_images_table_missing(tmp_path: Path):
    conn = sqlite3.connect(str(tmp_path / "empty.db"))
    migration = _load_migration()
    assert migration.apply(conn) is False
