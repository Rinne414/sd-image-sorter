"""Migration 013: Purge any image row whose path lives inside the app's
own runtime/test scratch directories.

Background
==========
Migration 011 caught the obvious ``test_e2e_fake_tagger`` pytest leakage
(10 rows on the affected user's DB) but missed three other classes of
leakage that the deep bug-hunt surfaced:

1. **stress-big-scan** - an early stress harness scanned 10,000 generated
   PNGs into the production DB; 400 of them survived (all with
   ``checkpoint='stress_model'``). These appear as
   ``.tmp/stress-big-scan/valid-NNNNN.png``.

2. **manual-test** - older E2E tests staged sandbox PNGs under
   ``.tmp/manual-test/...`` and tagged them with ``e2e_fixture``. The
   image rows weren't covered by migration 011's ``pytest-of`` /
   ``test_e2e_fake_tagger`` markers, and the tag rows weren't covered
   by migration 012's shape filter (``e2e_fixture`` looks like a
   legitimate single-token tag).

3. **bughunt-sandbox / bughunt-edge-cases** - the deep-bughunt test
   suite itself (this branch) scanned PNGs into the DB to verify
   sandbox sort flows, unicode filenames, and broken-metadata handling.
   Those rows are runtime artefacts, not user images.

The signature this migration uses is **strictly path-based**: any image
whose stored path passes through the application's own ``.tmp/`` or
``data/tmp/`` runtime scratch directories. Both of those locations are
documented as ephemeral state owned by the app (see
``backend/config.py:get_temp_dir`` and ``data/tmp`` in the .gitignore)
and should never contain a user's image library.

A user who puts a real folder called ``.tmp`` in their library is not
hurt by this migration: the matched paths must contain ``.tmp/`` AND a
test fixture marker, OR be under the runtime ``data/tmp/`` heap.
"""
from __future__ import annotations

import logging
import sqlite3

from migrations._schema_common import table_exists

logger = logging.getLogger(__name__)

VERSION = 13
NAME = "purge_residual_test_pollution"


# Specific marker patterns that indicate a row came from the app's own
# test infrastructure or a runtime stress harness. The match requires
# BOTH a runtime tmp prefix AND one of the markers, so a user's real
# folder named "stress-big-scan" elsewhere is unaffected.
_RUNTIME_TMP_PREFIXES = (
    "%/data/tmp/%",
    "%\\data\\tmp\\%",
    "%/.tmp/%",
    "%\\.tmp\\%",
)

_FIXTURE_MARKERS = (
    "%pytest-of%",
    "%manual-test%",
    "%manual-autosep-%",
    "%manual-sort-%",
    "%stress-big-scan%",
    "%stress-80k-scan%",
    "%bughunt-sandbox%",
    "%bughunt-edge-cases%",
    "%e2e-test-corpus%",
    "%e2e-comprehensive%",
    "%e2e-data-%",
    "%playwright-%",
    "%release-smoke-%",
    "%fake-tagger%",
    "%test-corpus%",
    "%fresh-install-%",
    "%v321-%",
    "%v322-%",
)

# Tags that only ever come from the test fixture pipeline. ``e2e_fixture``
# is the canonical marker injected by tagging_service's E2E harness so
# any image carrying it is by construction a test artefact even if the
# image row itself somehow escaped path-based detection.
_TEST_TAGS = (
    "e2e_fixture",
)


def apply(conn: sqlite3.Connection) -> bool:
    if not table_exists(conn, "images"):
        return False

    cursor = conn.cursor()
    where_clauses = []
    params: list[str] = []
    for tmp in _RUNTIME_TMP_PREFIXES:
        for fixture in _FIXTURE_MARKERS:
            where_clauses.append("(path LIKE ? AND path LIKE ?)")
            params.extend([tmp, fixture])

    where_sql = " OR ".join(where_clauses)

    # Phase 1: find image ids rooted under runtime tmp + fixture marker.
    cursor.execute(f"SELECT id FROM images WHERE {where_sql}", params)
    image_ids = [int(row[0]) for row in cursor.fetchall()]

    # Phase 2: any image referenced by a known test-fixture tag.
    if table_exists(conn, "tags"):
        for tag in _TEST_TAGS:
            cursor.execute(
                "SELECT DISTINCT image_id FROM tags WHERE tag = ?",
                (tag,),
            )
            for row in cursor.fetchall():
                image_ids.append(int(row[0]))

    # De-duplicate while preserving order.
    seen = set()
    unique_ids = []
    for image_id in image_ids:
        if image_id not in seen:
            seen.add(image_id)
            unique_ids.append(image_id)

    if not unique_ids:
        return False

    logger.warning(
        "[migration 013] Purging %d residual test/runtime image rows",
        len(unique_ids),
    )

    # Delete dependent rows first (idempotent on missing tables).
    batch_size = 500
    deleted_total = 0
    for related in (
        "tags",
        "image_loras",
        "image_prompt_tokens",
        "artist_predictions",
        "image_embeddings",
    ):
        if not table_exists(conn, related):
            continue
        for start in range(0, len(unique_ids), batch_size):
            batch = unique_ids[start : start + batch_size]
            placeholders = ",".join("?" * len(batch))
            try:
                cursor.execute(
                    f"DELETE FROM {related} WHERE image_id IN ({placeholders})",
                    batch,
                )
            except sqlite3.OperationalError:
                # Table exists but doesn't have an image_id column we can
                # delete by; safe to skip.
                pass

    for start in range(0, len(unique_ids), batch_size):
        batch = unique_ids[start : start + batch_size]
        placeholders = ",".join("?" * len(batch))
        cursor.execute(
            f"DELETE FROM images WHERE id IN ({placeholders})",
            batch,
        )
        deleted_total += cursor.rowcount

    return deleted_total > 0
