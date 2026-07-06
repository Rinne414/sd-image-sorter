"""Migration 024: tags.source + tags.category columns.

v3.5.0 tagger-audit P1-5 / P3-11. Two problems shared one root cause — tag
rows carried no provenance:

* Re-tagging DELETE+INSERTed every row, silently destroying manually added
  tags and VLM-generated tags (audit F5, live-verified: an injected manual
  row vanished after one Smart Tag run). ``source`` ('tagger' | 'vlm' |
  'manual' | 'trigger') lets pipeline writes replace only pipeline rows.
* Export templates could not render the Anima model card's real section
  order (characters → copyright → artists → general) because the tagger's
  category verdict was thrown away at persist time. ``category`` keeps it.

Both columns stay NULL for legacy rows: NULL source is treated as 'tagger'
(every pre-024 row came from a tagger pipeline), NULL category falls back
to the existing heuristic split at export time. No backfill needed.
"""
from __future__ import annotations

import sqlite3


VERSION = 24
NAME = "tag_source_category"


def _add_column(conn: sqlite3.Connection, table: str, column: str, decl: str) -> None:
    existing = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
    if column not in existing:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")


def apply(conn: sqlite3.Connection) -> None:
    _add_column(conn, "tags", "source", "TEXT")
    _add_column(conn, "tags", "category", "TEXT")
