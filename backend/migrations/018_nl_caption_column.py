"""Migration 018: Backfill the nl_caption column on existing databases.

The v3.3.3 VLM-caption work added an ``nl_caption`` column to ``images``
(a pure natural-language caption kept separate from the fused
``ai_caption`` so the dataset maker can show / export booru tags and the
sentence independently). That change added the column to
``FULL_SCHEMA_STATEMENTS`` (fresh installs) and to ``LEGACY_IMAGE_COLUMNS``
(the legacy backfill list) — but ``add_missing_legacy_image_columns`` only
runs inside migrations 001/002, which never re-execute on a database that
is already past schema_version 2.

So every *existing* install (typically at the latest pre-018 version)
upgraded without ever gaining ``nl_caption`` and then crashed with
``sqlite3.OperationalError: no such column: nl_caption`` the moment any
gallery / dataset-maker query selected it. Fresh installs were fine; only
upgrades were broken — exactly the class of bug migration 015 (user_rating)
was added for.

This migration re-runs the shared legacy backfill, which is idempotent
(``PRAGMA table_info`` guard) and therefore safe on databases that already
have ``nl_caption``. Using the shared helper — rather than a single hard
-coded ``ALTER TABLE`` — also re-heals any future column appended to
``LEGACY_IMAGE_COLUMNS`` without its own migration.
"""
from __future__ import annotations

import sqlite3

from migrations._schema_common import add_missing_legacy_image_columns


VERSION = 18
NAME = "nl_caption_column"


def apply(conn: sqlite3.Connection) -> None:
    """Backfill any missing legacy image columns (notably nl_caption)."""
    add_missing_legacy_image_columns(conn)
