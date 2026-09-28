"""Migration 049: versioned LAION scores and room for the anime aesthetic scores.

``aesthetic_version`` records which scorer build produced ``aesthetic_score``.
Scores written before this migration read NULL: they were computed with the
CLIP ViT-L/14 config that uses GELU instead of the QuickGELU the OpenAI
weights expect, so they are off by up to about one point. They are kept
as they are and only count as "to score" again; the user re-scores them with
Score all whenever they choose. Nothing is rewritten here.

The other columns hold the optional anime scores: ``aesthetic_waifu``
(Waifu Scorer V3, 0-10) and deepghs anime_aesthetic's continuous score
(``aesthetic_anime``, 0-6), percentile (``aesthetic_anime_pct``, 0-1) and
grade (``aesthetic_anime_grade``, masterpiece ... worst).

Additive and idempotent: ADD COLUMN only when absent; no row is read or
rewritten, so no VACUUM.
"""

from __future__ import annotations

import sqlite3

from migrations._schema_common import table_exists

VERSION = 49
NAME = "aesthetic_versions"

NEW_COLUMNS = (
    ("aesthetic_version", "INTEGER"),
    ("aesthetic_waifu", "REAL"),
    ("aesthetic_anime", "REAL"),
    ("aesthetic_anime_pct", "REAL"),
    ("aesthetic_anime_grade", "TEXT"),
)


def apply(conn: sqlite3.Connection) -> None:
    if not table_exists(conn, "images"):
        return
    existing = {
        str(row[1]) for row in conn.execute("PRAGMA table_info(images)").fetchall()
    }
    for name, sql_type in NEW_COLUMNS:
        if name not in existing:
            conn.execute(f"ALTER TABLE images ADD COLUMN {name} {sql_type}")
