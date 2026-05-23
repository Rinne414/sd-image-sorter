"""Regression tests for migration 013 (residual test pollution purge)."""
from __future__ import annotations

import importlib.util
import sqlite3
from pathlib import Path

import pytest


_MIGRATION_PATH = (
    Path(__file__).resolve().parent.parent
    / "migrations"
    / "013_purge_residual_test_pollution.py"
)


def _load_migration():
    spec = importlib.util.spec_from_file_location("migration_013", _MIGRATION_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def fresh_db(tmp_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(tmp_path / "images.db"))
    conn.executescript(
        """
        CREATE TABLE images (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT NOT NULL,
            filename TEXT NOT NULL,
            metadata_status TEXT,
            checkpoint TEXT
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


def test_purges_stress_big_scan(fresh_db):
    cur = fresh_db.cursor()
    rows = [
        ("/mnt/l/.../.tmp/stress-big-scan/valid-00001.png", "valid-00001.png", "complete", "stress_model"),
        ("/mnt/l/.../.tmp/stress-big-scan/valid-00002.png", "valid-00002.png", "complete", "stress_model"),
        ("L:\\Pictures\\AAA Reference\\real.png", "real.png", "complete", "real_model"),
    ]
    cur.executemany(
        "INSERT INTO images (path, filename, metadata_status, checkpoint) VALUES (?, ?, ?, ?)",
        rows,
    )
    fresh_db.commit()

    migration = _load_migration()
    purged = migration.apply(fresh_db)
    fresh_db.commit()

    assert purged is True
    cur.execute("SELECT COUNT(*) FROM images")
    assert cur.fetchone()[0] == 1
    cur.execute("SELECT path FROM images")
    assert cur.fetchone()[0] == "L:\\Pictures\\AAA Reference\\real.png"


def test_purges_manual_test_paths(fresh_db):
    cur = fresh_db.cursor()
    cur.executemany(
        "INSERT INTO images (path, filename, metadata_status) VALUES (?, ?, 'complete')",
        [
            ("/mnt/l/.../.tmp/manual-test/manual-sort-inbox/manual-sort-1.png", "manual-sort-1.png"),
            ("/mnt/l/.../.tmp/manual-test/autosep-inbox/manual-autosep-1.png", "manual-autosep-1.png"),
            ("L:\\Pictures\\real-image.png", "real-image.png"),
        ],
    )
    fresh_db.commit()

    migration = _load_migration()
    purged = migration.apply(fresh_db)
    fresh_db.commit()

    assert purged is True
    cur.execute("SELECT COUNT(*) FROM images")
    assert cur.fetchone()[0] == 1


def test_purges_e2e_fixture_tag_orphans(fresh_db):
    """An image tagged with e2e_fixture is by construction a test row,
    even if its path doesn't otherwise look suspicious."""
    cur = fresh_db.cursor()
    cur.execute(
        "INSERT INTO images (path, filename, metadata_status) VALUES (?, ?, 'complete')",
        ("L:\\some\\non-suspicious\\path.png", "path.png"),
    )
    image_id = cur.lastrowid
    cur.execute("INSERT INTO tags (image_id, tag, confidence) VALUES (?, 'e2e_fixture', 0.99)", (image_id,))
    cur.execute(
        "INSERT INTO images (path, filename, metadata_status) VALUES (?, ?, 'complete')",
        ("L:\\Pictures\\real.png", "real.png"),
    )
    fresh_db.commit()

    migration = _load_migration()
    purged = migration.apply(fresh_db)
    fresh_db.commit()

    assert purged is True
    cur.execute("SELECT COUNT(*) FROM images")
    assert cur.fetchone()[0] == 1
    cur.execute("SELECT COUNT(*) FROM tags WHERE tag = 'e2e_fixture'")
    assert cur.fetchone()[0] == 0


def test_purges_bughunt_sandbox(fresh_db):
    cur = fresh_db.cursor()
    cur.executemany(
        "INSERT INTO images (path, filename, metadata_status) VALUES (?, ?, 'complete')",
        [
            ("L:\\...\\.tmp\\bughunt-sandbox\\sort-corpus\\img.png", "img.png"),
            ("L:\\...\\.tmp\\bughunt-edge-cases\\中文文件夹\\test.png", "test.png"),
            ("L:\\Pictures\\actual-user-image.png", "actual-user-image.png"),
        ],
    )
    fresh_db.commit()

    migration = _load_migration()
    purged = migration.apply(fresh_db)
    fresh_db.commit()

    assert purged is True
    cur.execute("SELECT COUNT(*) FROM images")
    assert cur.fetchone()[0] == 1


def test_does_not_touch_legit_paths(fresh_db):
    """User folders that just happen to mention 'tmp' or 'test' must survive."""
    cur = fresh_db.cursor()
    legit = [
        ("L:\\Pictures\\my_tmp_backup\\photo.png", "photo.png", "complete", None),
        ("/home/user/tests-collection/cat.jpg", "cat.jpg", "complete", None),
        # Folder named like 'pytest-of' but no runtime tmp prefix.
        ("C:\\Users\\me\\Pictures\\pytest-of-someone\\image.png", "image.png", "complete", None),
        # data/tmp inside but no fixture marker.
        ("L:\\Antigravitiy code\\sd-image-sorter\\data\\tmp\\my-image.png", "my-image.png", "complete", None),
    ]
    cur.executemany(
        "INSERT INTO images (path, filename, metadata_status, checkpoint) VALUES (?, ?, ?, ?)",
        legit,
    )
    fresh_db.commit()

    migration = _load_migration()
    purged = migration.apply(fresh_db)

    assert purged is False
    cur.execute("SELECT COUNT(*) FROM images")
    assert cur.fetchone()[0] == len(legit)


def test_idempotent_on_clean_db(fresh_db):
    migration = _load_migration()
    assert migration.apply(fresh_db) is False
    assert migration.apply(fresh_db) is False


def test_handles_missing_tables(tmp_path: Path):
    conn = sqlite3.connect(str(tmp_path / "empty.db"))
    migration = _load_migration()
    assert migration.apply(conn) is False
