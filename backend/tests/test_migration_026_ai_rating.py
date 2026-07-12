"""Regression tests for migration 026 (first-class AI rating columns)."""
from __future__ import annotations

import importlib.util
import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

_MIGRATION_PATH = (
    Path(__file__).resolve().parent.parent / "migrations" / "026_ai_rating_columns.py"
)


def _load_migration():
    spec = importlib.util.spec_from_file_location("migration_026", _MIGRATION_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def pre_026_db(tmp_path: Path) -> sqlite3.Connection:
    """A DB shaped like a pre-026 install: images without the ai_rating
    columns, tags carrying the rating verdicts as plain rows."""
    conn = sqlite3.connect(str(tmp_path / "images.db"))
    conn.executescript(
        """
        CREATE TABLE images (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT UNIQUE NOT NULL,
            filename TEXT NOT NULL,
            tagged_at DATETIME
        );
        CREATE TABLE tags (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            image_id INTEGER NOT NULL,
            tag TEXT NOT NULL,
            confidence REAL DEFAULT 1.0,
            source TEXT,
            category TEXT
        );
        """
    )
    conn.commit()
    return conn


def _seed(conn, image_id, path, tags):
    conn.execute(
        "INSERT INTO images (id, path, filename) VALUES (?, ?, ?)",
        (image_id, path, path.rsplit("/", 1)[-1]),
    )
    conn.executemany(
        "INSERT INTO tags (image_id, tag, confidence) VALUES (?, ?, ?)",
        [(image_id, tag, conf) for tag, conf in tags],
    )


def test_backfill_picks_best_rating_row(pre_026_db):
    # Highest confidence wins.
    _seed(pre_026_db, 1, "/a.png", [("general", 0.9), ("explicit", 0.2), ("1girl", 0.99)])
    # Exact-confidence tie: severity (explicit > questionable > ...) wins.
    _seed(pre_026_db, 2, "/b.png", [("explicit", 0.8), ("questionable", 0.8)])
    # No rating rows at all -> stays NULL.
    _seed(pre_026_db, 3, "/c.png", [("landscape", 0.9)])
    pre_026_db.commit()

    migration = _load_migration()
    migration.apply(pre_026_db)
    pre_026_db.commit()

    rows = dict(
        (row[0], (row[1], row[2]))
        for row in pre_026_db.execute(
            "SELECT id, ai_rating, ai_rating_confidence FROM images"
        )
    )
    assert rows[1] == ("general", 0.9)
    assert rows[2] == ("explicit", 0.8)
    assert rows[3] == (None, None)


def test_second_run_is_idempotent_and_preserves_live_values(pre_026_db):
    _seed(pre_026_db, 1, "/a.png", [("general", 0.9)])
    pre_026_db.commit()

    migration = _load_migration()
    migration.apply(pre_026_db)
    pre_026_db.commit()

    # Live sync later moved the verdict; a re-run must NOT re-backfill over it.
    pre_026_db.execute(
        "UPDATE images SET ai_rating = 'explicit', ai_rating_confidence = 0.7 WHERE id = 1"
    )
    pre_026_db.commit()

    migration.apply(pre_026_db)
    pre_026_db.commit()

    row = pre_026_db.execute(
        "SELECT ai_rating, ai_rating_confidence FROM images WHERE id = 1"
    ).fetchone()
    assert row == ("explicit", 0.7)


def test_creates_partial_index(pre_026_db):
    migration = _load_migration()
    migration.apply(pre_026_db)
    pre_026_db.commit()

    names = [
        row[0]
        for row in pre_026_db.execute(
            "SELECT name FROM sqlite_master WHERE type = 'index'"
        )
    ]
    assert "idx_images_ai_rating" in names
