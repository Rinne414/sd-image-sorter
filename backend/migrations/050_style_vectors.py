"""Migration 050: per-image style vectors for the style map.

``image_style_vectors`` holds one vector per (image, space). ``space`` names
the model family the vector comes from (``kaloscope`` = the head-BN feature of
the Kaloscope 2.0 classifier); ``model_version`` records the exact weights and
layer so a model change makes every row "to extract" again, and
``content_fingerprint`` is the pixel digest the vector was computed from, so a
changed picture at the same path is re-extracted rather than kept.

Rows follow their image (``ON DELETE CASCADE``, same as artist_predictions);
a rescan that sees new pixels drops them through ``_clear_image_derived_state``.
Similarity's CLIP vectors stay in ``images.embedding`` and are not copied here.

Additive and idempotent: CREATE IF NOT EXISTS only, nothing is read or
rewritten, so no VACUUM.
"""

from __future__ import annotations

import sqlite3

VERSION = 50
NAME = "style_vectors"


def apply(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS image_style_vectors (
            image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
            space TEXT NOT NULL,
            model_version TEXT NOT NULL,
            content_fingerprint TEXT NOT NULL,
            dim INTEGER NOT NULL,
            dtype TEXT NOT NULL,
            vector BLOB NOT NULL,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (image_id, space)
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_image_style_vectors_space_version
        ON image_style_vectors(space, model_version)
        """
    )
