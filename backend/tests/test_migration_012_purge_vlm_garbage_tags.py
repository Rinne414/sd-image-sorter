"""Regression tests for migration 012 (purge VLM garbage tags)."""
from __future__ import annotations

import importlib.util
import sqlite3
from pathlib import Path

import pytest


_MIGRATION_PATH = (
    Path(__file__).resolve().parent.parent
    / "migrations"
    / "012_purge_vlm_garbage_tags.py"
)


def _load_migration():
    spec = importlib.util.spec_from_file_location("migration_012", _MIGRATION_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def fresh_db(tmp_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(tmp_path / "images.db"))
    conn.executescript(
        """
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


def test_migration_purges_known_garbage(fresh_db):
    cur = fresh_db.cursor()
    rows = [
        (1, "1girl", 0.99),
        (1, "long_hair", 0.95),
        (1, "*   **Character Design:** The character has long", 0.0),
        (1, "$$x^2 + y^2 = 1$$", 0.0),
        (1, "### 1. Address the issue", 0.0),
        (1, "Are you looking for information on the character", 0.0),
        (1, "feel free to ask!", 0.0),
        (2, "blue_eyes", 0.9),
        (2, "smile", 0.85),
        (2, "school_uniform", 0.8),
        (2, "Description: a beautiful image", 0.0),
        (2, "1. If you moved your folders", 0.0),
        (3, "score_8_up", 0.95),
        (3, "masterpiece", 0.9),
        (3, "saori (blue archive)", 0.95),
    ]
    cur.executemany(
        "INSERT INTO tags (image_id, tag, confidence) VALUES (?, ?, ?)",
        rows,
    )
    fresh_db.commit()

    migration = _load_migration()
    purged = migration.apply(fresh_db)
    fresh_db.commit()

    assert purged is True

    cur.execute("SELECT tag FROM tags ORDER BY tag")
    remaining = [row[0] for row in cur.fetchall()]
    expected_kept = sorted([
        "1girl",
        "long_hair",
        "blue_eyes",
        "smile",
        "school_uniform",
        "score_8_up",
        "masterpiece",
        "saori (blue archive)",
    ])
    assert remaining == expected_kept


def test_migration_is_idempotent(fresh_db):
    migration = _load_migration()
    assert migration.apply(fresh_db) is False  # empty
    assert migration.apply(fresh_db) is False  # still empty


def test_migration_skipped_if_tags_table_missing(tmp_path: Path):
    conn = sqlite3.connect(str(tmp_path / "empty.db"))
    migration = _load_migration()
    assert migration.apply(conn) is False


def test_migration_handles_large_batch(fresh_db):
    """Verify batched deletes work past SQLite's default 999 param limit."""
    cur = fresh_db.cursor()
    # 1500 garbage rows
    rows = [
        (i, f"### Garbage tag number {i}", 0.0)
        for i in range(1500)
    ]
    # Plus 100 real tags
    rows.extend(
        (i, f"real_tag_{i}", 0.9)
        for i in range(100)
    )
    cur.executemany(
        "INSERT INTO tags (image_id, tag, confidence) VALUES (?, ?, ?)",
        rows,
    )
    fresh_db.commit()

    migration = _load_migration()
    purged = migration.apply(fresh_db)
    fresh_db.commit()

    assert purged is True
    cur.execute("SELECT COUNT(*) FROM tags")
    assert cur.fetchone()[0] == 100


def test_migration_filter_matches_runtime_parser():
    """Migration's inlined filter must agree with vlm_providers.base."""
    import sys
    from pathlib import Path

    # Make sure backend is on path - tests run from backend/
    backend_root = Path(__file__).resolve().parent.parent
    if str(backend_root) not in sys.path:
        sys.path.insert(0, str(backend_root))

    from vlm_providers.base import _looks_like_garbage_tag as runtime_filter

    migration = _load_migration()
    inline_filter = migration._looks_like_garbage_tag

    # Build a corpus of tags that exercise both real and garbage shapes.
    corpus = [
        # Real tags
        "1girl",
        "long_hair",
        "blue_eyes",
        "saori (blue archive)",
        "score_8_up",
        "masterpiece",
        "hatsune miku",
        # Garbage
        "### header",
        "$$x = 1$$",
        "Description: text",
        "*   **Character Design:** prose",
        "Sentence ending.",
        "1. If you moved",
        "feel free to ask!",
        "Are you looking for information on the character",
        # Edge cases
        "",
        "a",  # too short
        "x" * 101,  # too long
    ]
    for tag in corpus:
        assert runtime_filter(tag) == inline_filter(tag), (
            f"Migration filter disagrees with runtime parser on {tag!r}"
        )
