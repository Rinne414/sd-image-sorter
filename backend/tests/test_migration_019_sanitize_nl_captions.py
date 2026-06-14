"""Regression tests for migration 019 (sanitize raw-JSON NL captions).

Older builds persisted ToriiGate's raw (often truncated) JSON answers
directly into ``images.nl_caption`` and fused them into ``ai_caption``.
Migration 019 rewrites those rows to plain prose. These tests pin the
row selection (only JSON-shaped captions are touched), the rewrite of
both columns, idempotency, and that the inline sanitize copy stays in
lockstep with the runtime ``ToriiGateTagger._sanitize_nl_text``.
"""
from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from migrations._schema_common import create_full_schema  # noqa: E402
import migrations  # noqa: E402
from toriigate_tagger import ToriiGateTagger  # noqa: E402


TRUNCATED_JSON = (
    '{"description": "A close-up shot focuses on the torso and thighs of a '
    'woman standing against a plain, light grey background.", '
    '"tags": "1girl, solo, head_out_of_frame, cropped_head,'
)
CLEAN_PROSE = (
    "A close-up shot focuses on the torso and thighs of a woman standing "
    "against a plain, light grey background."
)


def _get_migration_019():
    return next(m for m in migrations.get_migrations() if m.version == 19)


def _make_db() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.execute(
        "CREATE TABLE images ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT, "
        "path TEXT, filename TEXT, ai_caption TEXT, nl_caption TEXT)"
    )
    conn.commit()
    return conn


def test_migration_019_is_registered():
    versions = [m.version for m in migrations.get_migrations()]
    assert 19 in versions
    assert len(versions) == len(set(versions))


def test_migration_019_rewrites_truncated_json_nl_caption():
    conn = _make_db()
    try:
        conn.execute(
            "INSERT INTO images (path, ai_caption, nl_caption) VALUES (?, ?, ?)",
            (
                "/lib/a.png",
                f"@trigger, 1girl, solo, skirt, {TRUNCATED_JSON}",
                TRUNCATED_JSON,
            ),
        )
        conn.commit()

        assert _get_migration_019().apply(conn) is True

        row = conn.execute(
            "SELECT nl_caption, ai_caption FROM images WHERE path = '/lib/a.png'"
        ).fetchone()
        assert row[0] == CLEAN_PROSE
        assert row[1] == f"@trigger, 1girl, solo, skirt, {CLEAN_PROSE}"
        assert "{" not in row[0] and "{" not in row[1]
    finally:
        conn.close()


def test_migration_019_rewrites_complete_json_nl_caption():
    conn = _make_db()
    try:
        full_json = '{"description": "A dog runs across a beach.", "tags": "dog, beach"}'
        conn.execute(
            "INSERT INTO images (path, ai_caption, nl_caption) VALUES (?, ?, ?)",
            ("/lib/b.png", f"dog, beach, {full_json}", full_json),
        )
        conn.commit()

        assert _get_migration_019().apply(conn) is True

        row = conn.execute(
            "SELECT nl_caption, ai_caption FROM images WHERE path = '/lib/b.png'"
        ).fetchone()
        assert row[0] == "A dog runs across a beach."
        assert row[1] == "dog, beach, A dog runs across a beach."
    finally:
        conn.close()


def test_migration_019_rewrites_fenced_json_nl_caption():
    conn = _make_db()
    try:
        fenced_json = (
            '```json\n{"description": "A cat sleeps on a sofa.", '
            '"tags": "cat, sofa"}\n```'
        )
        conn.execute(
            "INSERT INTO images (path, ai_caption, nl_caption) VALUES (?, ?, ?)",
            ("/lib/fenced.png", f"cat, sofa, {fenced_json}", fenced_json),
        )
        conn.commit()

        assert _get_migration_019().apply(conn) is True

        row = conn.execute(
            "SELECT nl_caption, ai_caption FROM images WHERE path = '/lib/fenced.png'"
        ).fetchone()
        assert row[0] == "A cat sleeps on a sofa."
        assert row[1] == "cat, sofa, A cat sleeps on a sofa."
    finally:
        conn.close()


def test_migration_019_rewrites_top_level_caption_key_nl_caption():
    conn = _make_db()
    try:
        key_value_payload = '"caption": "A girl stands in a field.", "tags": "1girl, solo"'
        conn.execute(
            "INSERT INTO images (path, ai_caption, nl_caption) VALUES (?, ?, ?)",
            ("/lib/key-value.png", f"1girl, solo, {key_value_payload}", key_value_payload),
        )
        conn.commit()

        assert _get_migration_019().apply(conn) is True

        row = conn.execute(
            "SELECT nl_caption, ai_caption FROM images WHERE path = '/lib/key-value.png'"
        ).fetchone()
        assert row[0] == "A girl stands in a field."
        assert row[1] == "1girl, solo, A girl stands in a field."
    finally:
        conn.close()


def test_migration_019_leaves_plain_prose_rows_untouched():
    conn = _make_db()
    try:
        prose = "A girl with long hair stands in a sunny field. She is smiling."
        conn.execute(
            "INSERT INTO images (path, ai_caption, nl_caption) VALUES (?, ?, ?)",
            ("/lib/c.png", f"1girl, {prose}", prose),
        )
        conn.commit()

        assert _get_migration_019().apply(conn) is False

        row = conn.execute(
            "SELECT nl_caption, ai_caption FROM images WHERE path = '/lib/c.png'"
        ).fetchone()
        assert row[0] == prose
        assert row[1] == f"1girl, {prose}"
    finally:
        conn.close()


def test_migration_019_leaves_prose_with_inline_key_value_untouched():
    conn = _make_db()
    try:
        prose = 'A monitor overlay reads "status": "recording" while the subject stands still.'
        conn.execute(
            "INSERT INTO images (path, ai_caption, nl_caption) VALUES (?, ?, ?)",
            ("/lib/quoted.png", f"monitor, {prose}", prose),
        )
        conn.commit()

        assert _get_migration_019().apply(conn) is False

        row = conn.execute(
            "SELECT nl_caption, ai_caption FROM images WHERE path = '/lib/quoted.png'"
        ).fetchone()
        assert row[0] == prose
        assert row[1] == f"monitor, {prose}"
    finally:
        conn.close()


def test_migration_019_leaves_bracketed_prose_untouched():
    conn = _make_db()
    try:
        prose = "[wide shot] A girl with long hair stands in a sunny field."
        conn.execute(
            "INSERT INTO images (path, ai_caption, nl_caption) VALUES (?, ?, ?)",
            ("/lib/bracketed.png", f"1girl, {prose}", prose),
        )
        conn.commit()

        assert _get_migration_019().apply(conn) is False

        row = conn.execute(
            "SELECT nl_caption, ai_caption FROM images WHERE path = '/lib/bracketed.png'"
        ).fetchone()
        assert row[0] == prose
        assert row[1] == f"1girl, {prose}"
    finally:
        conn.close()


def test_migration_019_leaves_braced_shot_label_prose_untouched():
    conn = _make_db()
    try:
        prose = "{close-up} A girl with long hair stands in a sunny field."
        conn.execute(
            "INSERT INTO images (path, ai_caption, nl_caption) VALUES (?, ?, ?)",
            ("/lib/braced.png", f"1girl, {prose}", prose),
        )
        conn.commit()

        assert _get_migration_019().apply(conn) is False

        row = conn.execute(
            "SELECT nl_caption, ai_caption FROM images WHERE path = '/lib/braced.png'"
        ).fetchone()
        assert row[0] == prose
        assert row[1] == f"1girl, {prose}"
    finally:
        conn.close()


def test_migration_019_tags_only_json_clears_nl_and_tidies_ai_caption():
    conn = _make_db()
    try:
        tags_json = '{"tags": "1girl, solo, long_hair"}'
        conn.execute(
            "INSERT INTO images (path, ai_caption, nl_caption) VALUES (?, ?, ?)",
            ("/lib/d.png", f"1girl, solo, {tags_json}", tags_json),
        )
        conn.commit()

        assert _get_migration_019().apply(conn) is True

        row = conn.execute(
            "SELECT nl_caption, ai_caption FROM images WHERE path = '/lib/d.png'"
        ).fetchone()
        assert row[0] == ""
        assert row[1] == "1girl, solo"
    finally:
        conn.close()


def test_init_db_upgrade_019_sanitizes_json_caption_without_touching_clean_rows(
    tmp_path, monkeypatch
):
    """End-to-end upgrade path: schema_version 18 -> latest via init_db().

    This reproduces the real startup path instead of calling migration 019
    directly, and verifies JSON-shaped historical rows are healed while normal
    prose rows survive byte-for-byte.
    """
    db_path = tmp_path / "pre_019.db"
    raw = sqlite3.connect(str(db_path))
    try:
        create_full_schema(raw)
        raw.execute(
            "CREATE TABLE schema_version ("
            "id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)"
        )
        raw.execute("INSERT INTO schema_version (id, version) VALUES (1, 18)")
        raw.execute(
            "INSERT INTO images (path, filename, ai_caption, nl_caption) VALUES (?, ?, ?, ?)",
            (
                "/legacy/json.png",
                "json.png",
                f"1girl, solo, {TRUNCATED_JSON}",
                TRUNCATED_JSON,
            ),
        )
        clean = "{close-up} A girl with long hair stands in a sunny field."
        raw.execute(
            "INSERT INTO images (path, filename, ai_caption, nl_caption) VALUES (?, ?, ?, ?)",
            (
                "/legacy/clean.png",
                "clean.png",
                f"1girl, {clean}",
                clean,
            ),
        )
        raw.commit()
    finally:
        raw.close()

    import database as db

    monkeypatch.setattr(db, "DATABASE_PATH", str(db_path))
    db._pragmas_initialized = set()
    db.init_db()

    latest_version = migrations.get_migrations()[-1].version
    verify = sqlite3.connect(str(db_path))
    verify.row_factory = sqlite3.Row
    try:
        version_row = verify.execute(
            "SELECT version FROM schema_version WHERE id = 1"
        ).fetchone()
        assert int(version_row["version"]) == latest_version

        json_row = verify.execute(
            "SELECT nl_caption, ai_caption FROM images WHERE path = ?",
            ("/legacy/json.png",),
        ).fetchone()
        assert json_row["nl_caption"] == CLEAN_PROSE
        assert json_row["ai_caption"] == f"1girl, solo, {CLEAN_PROSE}"

        clean_row = verify.execute(
            "SELECT nl_caption, ai_caption FROM images WHERE path = ?",
            ("/legacy/clean.png",),
        ).fetchone()
        assert clean_row["nl_caption"] == clean
        assert clean_row["ai_caption"] == f"1girl, {clean}"
    finally:
        verify.close()


def test_migration_019_is_idempotent():
    conn = _make_db()
    try:
        conn.execute(
            "INSERT INTO images (path, ai_caption, nl_caption) VALUES (?, ?, ?)",
            ("/lib/e.png", f"1girl, {TRUNCATED_JSON}", TRUNCATED_JSON),
        )
        conn.commit()

        migration = _get_migration_019()
        assert migration.apply(conn) is True
        first = conn.execute(
            "SELECT nl_caption, ai_caption FROM images WHERE path = '/lib/e.png'"
        ).fetchone()

        assert migration.apply(conn) is False, "second run must be a no-op"
        second = conn.execute(
            "SELECT nl_caption, ai_caption FROM images WHERE path = '/lib/e.png'"
        ).fetchone()
        assert first == second
    finally:
        conn.close()


def test_migration_019_skips_db_without_nl_caption_column():
    conn = sqlite3.connect(":memory:")
    try:
        conn.execute(
            "CREATE TABLE images (id INTEGER PRIMARY KEY, path TEXT, ai_caption TEXT)"
        )
        conn.commit()
        assert _get_migration_019().apply(conn) is False
    finally:
        conn.close()


def test_migration_019_skips_when_images_table_absent():
    conn = sqlite3.connect(":memory:")
    try:
        assert _get_migration_019().apply(conn) is False
    finally:
        conn.close()


def test_migration_019_sanitize_matches_runtime():
    """The inline sanitize copy must agree with the runtime implementation."""
    module_globals = _get_migration_019().apply.__globals__
    migration_sanitize = module_globals["_sanitize_nl_text"]

    cases = [
        TRUNCATED_JSON,
        '{"description": "A dog runs across a beach.", "tags": "dog, beach"}',
        '{"tags": "1girl, solo"}',
        '{"caption": "Two knights duel at dawn."}',
        '"caption": "Two knights duel at dawn.", "tags": "duel"',
        '["A castle.", "A moat."]',
        '```json\n{"description": "A fenced answer."}\n```',
        '<think>x</think>{"description": "A cat sleeps."}',
        "Plain prose stays as-is, even with, commas.",
        'A monitor overlay reads "status": "recording" while the subject stands still.',
        "[wide shot] A plain caption stays intact.",
        "{close-up} A plain caption stays intact.",
        '{"description": "She says \\"hi\\".", "tags": "1girl"}',
        '{"description": "Cut mid sent',
    ]
    for case in cases:
        assert migration_sanitize(case) == ToriiGateTagger._sanitize_nl_text(case), case
