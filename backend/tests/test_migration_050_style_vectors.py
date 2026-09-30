"""Regression tests for migration 050 (image_style_vectors).

050 adds the per-image style-vector table used by the style map: one row per
(image_id, space), keyed to the image's content fingerprint so a changed
picture is re-extracted. Rows follow their image (``ON DELETE CASCADE``) and
the migration is additive and idempotent.
"""

from __future__ import annotations

import sqlite3

import pytest

import database as db
import migrations


EXPECTED_COLUMNS = {
    "image_id",
    "space",
    "model_version",
    "content_fingerprint",
    "dim",
    "dtype",
    "vector",
    "updated_at",
}


def _columns(conn: sqlite3.Connection) -> dict[str, tuple]:
    return {
        str(row[1]): tuple(row)
        for row in conn.execute("PRAGMA table_info(image_style_vectors)").fetchall()
    }


def _insert_vector(
    conn: sqlite3.Connection, image_id: int, space: str = "kaloscope"
) -> None:
    conn.execute(
        """
        INSERT INTO image_style_vectors
            (image_id, space, model_version, content_fingerprint, dim, dtype, vector)
        VALUES (?, ?, 'model:v1', 'fp', 4, 'float16', X'00000000')
        """,
        (image_id, space),
    )


def _vector_count(conn: sqlite3.Connection, image_id: int) -> int:
    return conn.execute(
        "SELECT COUNT(*) FROM image_style_vectors WHERE image_id = ?", (image_id,)
    ).fetchone()[0]


@pytest.fixture
def v49_database(tmp_path, monkeypatch):
    """A database built by the real migration chain, stopped at version 49."""
    all_migrations = migrations.get_migrations()
    assert all_migrations[-1].version >= 50
    monkeypatch.setattr(db, "DATABASE_PATH", str(tmp_path / "v49.db"))
    monkeypatch.setattr(db, "_pragmas_initialized", set())
    monkeypatch.setattr(
        migrations,
        "get_migrations",
        lambda: [m for m in all_migrations if m.version <= 49],
    )
    db.init_db()
    monkeypatch.setattr(migrations, "get_migrations", lambda: all_migrations)
    monkeypatch.setattr(db, "_pragmas_initialized", set())
    return db


def test_fresh_database_has_style_vector_table_with_composite_key(test_db):
    with test_db.get_db() as conn:
        columns = _columns(conn)
        assert set(columns) == EXPECTED_COLUMNS
        # PRAGMA table_info pk column: 1-based position in the primary key.
        assert columns["image_id"][5] == 1
        assert columns["space"][5] == 2
        for name in ("model_version", "content_fingerprint", "dim", "dtype", "vector"):
            assert columns[name][3] == 1, f"{name} must be NOT NULL"
        foreign_keys = conn.execute(
            "PRAGMA foreign_key_list(image_style_vectors)"
        ).fetchall()
        assert [(row[2], row[3], row[4], row[6]) for row in foreign_keys] == [
            ("images", "image_id", "id", "CASCADE")
        ]


def test_one_row_per_image_and_space(test_db):
    with test_db.get_db() as conn:
        conn.execute(
            "INSERT INTO images (id, path, filename) VALUES (1, '/lib/a.png', 'a.png')"
        )
        _insert_vector(conn, 1, "kaloscope")
        _insert_vector(conn, 1, "other")
        with pytest.raises(sqlite3.IntegrityError):
            _insert_vector(conn, 1, "kaloscope")
        assert (
            conn.execute("SELECT COUNT(*) FROM image_style_vectors").fetchone()[0] == 2
        )


def test_vector_rows_follow_their_image(test_db):
    with test_db.get_db() as conn:
        assert conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1
        conn.executemany(
            "INSERT INTO images (id, path, filename) VALUES (?, ?, ?)",
            [(1, "/lib/a.png", "a.png"), (2, "/lib/b.png", "b.png")],
        )
        _insert_vector(conn, 1)
        _insert_vector(conn, 2)
        conn.execute("DELETE FROM images WHERE id = 1")
        remaining = [
            row[0] for row in conn.execute("SELECT image_id FROM image_style_vectors")
        ]
        assert remaining == [2]
        with pytest.raises(sqlite3.IntegrityError):
            _insert_vector(conn, 999)


def test_upgrade_from_v49_creates_table_and_keeps_images(v49_database):
    with v49_database.get_db() as conn:
        assert (
            conn.execute("SELECT MAX(version) FROM schema_version").fetchone()[0] == 49
        )
        assert "image_style_vectors" not in {
            row[0]
            for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        conn.execute(
            "INSERT INTO images (id, path, filename) VALUES (7, '/lib/g.png', 'g.png')"
        )

    v49_database.init_db()

    with v49_database.get_db() as conn:
        assert (
            conn.execute("SELECT MAX(version) FROM schema_version").fetchone()[0] >= 50
        )
        assert set(_columns(conn)) == EXPECTED_COLUMNS
        assert conn.execute("SELECT id FROM images WHERE id = 7").fetchone() is not None
        _insert_vector(conn, 7)
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []


def test_migration_050_is_idempotent(test_db):
    migration = next(item for item in migrations.get_migrations() if item.version == 50)
    with test_db.get_db() as conn:
        conn.execute(
            "INSERT INTO images (id, path, filename) VALUES (1, '/lib/a.png', 'a.png')"
        )
        _insert_vector(conn, 1)
        migration.apply(conn)
        assert (
            conn.execute("SELECT COUNT(*) FROM image_style_vectors").fetchone()[0] == 1
        )


def test_pixel_change_on_rescan_clears_style_vectors(test_db, tmp_path):
    """New pixels at the same path drop the vector, like artist_predictions.

    Mirrors ``test_database`` "pixels changed": the row has derived state and
    a known fingerprint, then a rescan records a different fingerprint.
    """
    image_id = test_db.add_image(
        path=str(tmp_path / "changed.png"),
        filename="changed.png",
        source_mtime_ns=100,
        source_size=200,
    )
    with test_db.get_db() as conn:
        conn.execute(
            "UPDATE images SET ai_caption = ?, content_fingerprint = ? WHERE id = ?",
            ("stale caption", "fingerprint-1", image_id),
        )
        _insert_vector(conn, image_id)
        assert _vector_count(conn, image_id) == 1

    test_db.update_image_metadata(
        image_id=image_id,
        generator="comfyui",
        prompt="pixels changed",
        negative_prompt=None,
        metadata_json="{}",
        width=768,
        height=768,
        file_size=300,
        checkpoint=None,
        loras=[],
        source_mtime_ns=101,
        source_size=300,
        metadata_status="complete",
        content_fingerprint="fingerprint-2",
        preserve_derived_state=True,
    )

    with test_db.get_db() as conn:
        assert _vector_count(conn, image_id) == 0


def test_same_pixels_on_rescan_keep_style_vectors(test_db, tmp_path):
    image_id = test_db.add_image(
        path=str(tmp_path / "same.png"),
        filename="same.png",
        source_mtime_ns=100,
        source_size=200,
    )
    with test_db.get_db() as conn:
        conn.execute(
            "UPDATE images SET ai_caption = ?, content_fingerprint = ? WHERE id = ?",
            ("caption", "fingerprint-1", image_id),
        )
        _insert_vector(conn, image_id)

    test_db.update_image_metadata(
        image_id=image_id,
        generator="comfyui",
        prompt="metadata only",
        negative_prompt=None,
        metadata_json="{}",
        width=768,
        height=768,
        file_size=200,
        checkpoint=None,
        loras=[],
        source_mtime_ns=101,
        source_size=200,
        metadata_status="complete",
        content_fingerprint="fingerprint-1",
        preserve_derived_state=True,
    )

    with test_db.get_db() as conn:
        assert _vector_count(conn, image_id) == 1
