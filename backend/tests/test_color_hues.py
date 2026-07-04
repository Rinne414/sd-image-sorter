"""Tests for the v3.5.0 dominant-hue color filter.

Covers the hex→hue classifier, the dominant_color_tags derivation,
migration 022's JSON-only backfill, and the color_hues /
exclude_color_hues query filters.
"""
from __future__ import annotations

import json
import sqlite3

import pytest

import migrations
from color_analyzer import (
    DOMINANT_COLOR_TAGS,
    classify_hex_color,
    dominant_color_tags_from_json,
)
from migrations._schema_common import create_full_schema


# ---------------------------------------------------------------------------
# Classifier anchors
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("hex_color,expected", [
    ("#FF0000", "red"),
    ("#DC143C", "red"),       # crimson — deep saturated red near the hue wrap
    ("#FFB6C1", "pink"),      # light pink
    ("#FF69B4", "pink"),      # hot pink (magenta band)
    ("#FF00FF", "purple"),    # magenta
    ("#FFA500", "orange"),
    ("#FFFF00", "yellow"),
    ("#008000", "green"),
    ("#00FFFF", "cyan"),
    ("#87CEEB", "blue"),      # sky blue
    ("#000080", "blue"),      # navy
    ("#800080", "purple"),
    ("#8B4513", "brown"),     # saddle brown (dark warm)
    ("#F5F5F5", "white"),
    ("#111111", "black"),
    ("#808080", "gray"),
])
def test_classifier_anchor_colors(hex_color, expected):
    assert classify_hex_color(hex_color) == expected


def test_classifier_skips_skin_tones():
    assert classify_hex_color("#F0C8A0") is None


def test_classifier_rejects_garbage():
    assert classify_hex_color("") is None
    assert classify_hex_color("#XYZ") is None
    assert classify_hex_color("not-a-color") is None


def test_all_emitted_tags_are_in_vocabulary():
    emitted = {
        classify_hex_color(f"#{r:02X}{g:02X}{b:02X}")
        for r in (0, 90, 180, 255) for g in (0, 90, 180, 255) for b in (0, 90, 180, 255)
    }
    emitted.discard(None)
    assert emitted <= set(DOMINANT_COLOR_TAGS)


# ---------------------------------------------------------------------------
# dominant_color_tags_from_json
# ---------------------------------------------------------------------------

def test_tags_from_json_thresholds_and_dedupes():
    payload = json.dumps([
        {"hex": "#FF0000", "pct": 40.0},
        {"hex": "#F5F5F5", "pct": 30.0},
        {"hex": "#EE0000", "pct": 16.0},   # second red — deduped
        {"hex": "#0000FF", "pct": 5.0},    # below the 15% floor — ignored
    ])
    assert dominant_color_tags_from_json(payload) == ",red,white,"


def test_tags_from_json_handles_bad_input():
    assert dominant_color_tags_from_json(None) == ""
    assert dominant_color_tags_from_json("") == ""
    assert dominant_color_tags_from_json("{not json") == ""
    assert dominant_color_tags_from_json('{"hex": "#FF0000"}') == ""  # not a list
    assert dominant_color_tags_from_json('[{"pct": "bad"}]') == ""


# ---------------------------------------------------------------------------
# Migration 022 backfill
# ---------------------------------------------------------------------------

def test_migration_022_registered():
    versions = [m.version for m in migrations.get_migrations()]
    assert 22 in versions
    assert len(versions) == len(set(versions))


def test_migration_022_backfills_from_json_only(tmp_path):
    db_path = tmp_path / "m022.db"
    conn = sqlite3.connect(str(db_path))
    try:
        create_full_schema(conn)
        # Simulate a pre-022 install: the v3.2.1 color pass added
        # dominant_colors, but dominant_color_tags does not exist yet.
        conn.execute("ALTER TABLE images ADD COLUMN dominant_colors TEXT")
        red_json = json.dumps([{"hex": "#FF0000", "pct": 55.0}])
        conn.execute(
            "INSERT INTO images (id, path, filename, dominant_colors) VALUES (1, 'a.png', 'a.png', ?)",
            (red_json,),
        )
        conn.execute(
            "INSERT INTO images (id, path, filename) VALUES (2, 'b.png', 'b.png')"
        )
        conn.commit()

        migration = next(m for m in migrations.get_migrations() if m.version == 22)
        migration.apply(conn)
        conn.commit()

        rows = dict(conn.execute("SELECT id, dominant_color_tags FROM images").fetchall())
        assert rows[1] == ",red,"
        assert rows[2] is None  # never analyzed → left for the normal color pass
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Query filters
# ---------------------------------------------------------------------------

@pytest.fixture
def hue_db(test_db):
    conn = test_db.get_connection()
    try:
        rows = [
            (1, "red.png", ",red,white,"),
            (2, "blue.png", ",blue,"),
            (3, "plain.png", None),
            (4, "empty.png", ""),
        ]
        conn.executemany(
            "INSERT INTO images (id, path, filename, dominant_color_tags) VALUES (?, ?, ?, ?)",
            [(i, f"C:/t/{name}", name, tags) for i, name, tags in rows],
        )
        conn.commit()
    finally:
        conn.close()
    return test_db


def test_color_hues_filter_matches_any(hue_db):
    assert hue_db.get_filtered_image_ids(color_hues=["red"]) == [1]
    assert sorted(hue_db.get_filtered_image_ids(color_hues=["red", "blue"])) == [1, 2]


def test_exclude_color_hues_keeps_null_rows(hue_db):
    ids = sorted(hue_db.get_filtered_image_ids(exclude_color_hues=["blue"]))
    assert ids == [1, 3, 4]


def test_invalid_hues_are_ignored(hue_db):
    all_ids = sorted(hue_db.get_filtered_image_ids())
    assert sorted(hue_db.get_filtered_image_ids(color_hues=["sparkly"])) == all_ids


def test_hue_filter_composes_with_exclude(hue_db):
    ids = hue_db.get_filtered_image_ids(color_hues=["red", "blue"], exclude_color_hues=["white"])
    assert ids == [2]
