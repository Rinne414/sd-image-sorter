"""Migration 011: One-time purge of leaked test/runtime tmp rows.

Background
==========
Older test runs (test_e2e_fake_tagger_completes_without_downloading_real_model
and friends) sometimes leaked their fixture rows into the user's production
``data/images.db`` when the test_db isolation fixture was less robust on
Windows / WSL or when ``TMPDIR`` was redirected into the project's own
``data/tmp/`` runtime folder.

These rows are easy to identify - they live under ``data/tmp/pytest-of-*/``
or ``.tmp/pytest-...``, and they show up in /api/library-health as ``error``
metadata_status entries the user can't easily get rid of without manual SQL.
``data/tmp`` and ``.tmp`` are reserved for the app's own ephemeral state and
should never legitimately contain a user's image library, so any image row
under those prefixes is safe to purge.

This migration is one-time and conservative: it only touches paths that
contain BOTH a runtime tmp marker AND the obvious pytest fixture markers
(``pytest-of`` or ``test_e2e``). Real user data with names like
"my_data_tmp_backup" is untouched.
"""
from __future__ import annotations

import logging
import sqlite3

from migrations._schema_common import table_exists

logger = logging.getLogger(__name__)

VERSION = 11
NAME = "purge_leaked_test_rows"


# LIKE patterns that match pytest fixture pollution. We require BOTH a
# runtime/tmp prefix AND a fixture marker so we never touch genuine user
# images that happen to have "tmp" in the path.
_RUNTIME_TMP_MARKERS = (
    "%/data/tmp/%",      # POSIX path
    "%\\data\\tmp\\%",   # Windows path
    "%/.tmp/%",
    "%\\.tmp\\%",
)

_FIXTURE_MARKERS = (
    "%pytest-of%",
    "%test_e2e_fake_tagger%",
    "%test_e2e_fake_tagger_completes%",
    "%test_e2e_full_tagging_pipeline%",
)


def apply(conn: sqlite3.Connection) -> bool:
    """Delete leaked pytest rows. Returns True if any rows were removed."""
    if not table_exists(conn, "images"):
        return False

    cursor = conn.cursor()
    where_clauses = []
    params: list[str] = []
    for tmp in _RUNTIME_TMP_MARKERS:
        for fixture in _FIXTURE_MARKERS:
            where_clauses.append("(path LIKE ? AND path LIKE ?)")
            params.extend([tmp, fixture])

    if not where_clauses:
        return False

    where_sql = " OR ".join(where_clauses)

    cursor.execute(f"SELECT COUNT(*) FROM images WHERE {where_sql}", params)
    leaked = int(cursor.fetchone()[0] or 0)
    if leaked == 0:
        return False

    logger.warning(
        "[migration 011] Purging %d leaked pytest fixture rows from images table",
        leaked,
    )

    # Delete dependent rows from related tables first (foreign key cleanliness).
    # tags, image_loras, image_prompt_tokens, artist_predictions all reference image_id.
    image_ids_query = f"SELECT id FROM images WHERE {where_sql}"
    cursor.execute(image_ids_query, params)
    image_ids = [int(row[0]) for row in cursor.fetchall()]

    if image_ids:
        placeholders = ",".join("?" * len(image_ids))
        for related in ("tags", "image_loras", "image_prompt_tokens", "artist_predictions"):
            if table_exists(conn, related):
                try:
                    cursor.execute(f"DELETE FROM {related} WHERE image_id IN ({placeholders})", image_ids)
                except sqlite3.OperationalError as exc:
                    # If the table has a different schema we don't recognize, skip.
                    logger.debug("[migration 011] skipped cleanup for %s: %s", related, exc)

        cursor.execute(f"DELETE FROM images WHERE id IN ({placeholders})", image_ids)

    return True
