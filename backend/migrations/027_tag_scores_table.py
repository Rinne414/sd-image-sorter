"""Migration 027: tag_scores table (BE-1 virtual re-threshold).

Persists every tagger score >= config.TAG_SCORES_FLOOR per
(image, model, tag) at tagging time, so that:

* re-threshold becomes a zero-inference operation — read the stored
  distribution back at a new cutoff instead of re-running ONNX over the
  whole library;
* coverage-gap queries ("images whose score for this tag sits just under
  the threshold — probably missing the tag") power the Separation
  Console's find-missing flow (N2, the #1 LoRA-trainer story);
* per-model audits can show which model produced which verdict.

No backfill is possible: sub-threshold scores were never persisted before
this table existed. The table fills up as images are (re-)tagged.

WITHOUT ROWID + PK(image_id, model, tag): the PK itself serves the
re-threshold read path (image scope + model prefix). idx(model, tag)
serves per-model maintenance/stats; idx(tag, score) serves the
coverage-gap band scan. ON DELETE CASCADE piggybacks on the per-connection
``PRAGMA foreign_keys = ON`` (db_core) so image deletion cleans scores up
like it already does tag rows.
"""
from __future__ import annotations

import sqlite3


VERSION = 27
NAME = "tag_scores_table"


def apply(conn: sqlite3.Connection) -> None:
    cursor = conn.cursor()
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS tag_scores (
            image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
            model TEXT NOT NULL,
            tag TEXT NOT NULL,
            score REAL NOT NULL,
            category TEXT,
            PRIMARY KEY (image_id, model, tag)
        ) WITHOUT ROWID
        """
    )
    cursor.execute(
        "CREATE INDEX IF NOT EXISTS idx_tag_scores_model_tag ON tag_scores(model, tag)"
    )
    cursor.execute(
        "CREATE INDEX IF NOT EXISTS idx_tag_scores_tag_score ON tag_scores(tag, score)"
    )
