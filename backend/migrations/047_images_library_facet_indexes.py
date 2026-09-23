"""Covering indexes for the per-library facet counts behind /api/stats.

library_id, generator, checkpoint_normalized and metadata_status were added to
``images`` over time, so they sit at the end of each row, behind the raw
workflow JSON. Counting them per library therefore read the whole table (about
80 MB for 27k images): ~3 s on the first stats request after launch. These
indexes let each count read a small index instead (measured on a 27.5k-image
library: generators 22 -> 1.5 ms, checkpoints 36 -> 1.6 ms, metadata status
38 -> 4.5 ms warm; cold reads shrink from the table to the index).
"""

from __future__ import annotations

from migrations._schema_common import table_exists

VERSION = 47
NAME = "images_library_facet_indexes"

_INDEXES = (
    ("idx_images_lib_generator", "library_id, generator, is_readable"),
    ("idx_images_lib_checkpoint", "library_id, checkpoint_normalized, is_readable"),
    ("idx_images_lib_metadata_status", "library_id, metadata_status, is_readable"),
)


def apply(conn) -> bool:
    if not table_exists(conn, "images"):
        return False
    for name, columns in _INDEXES:
        conn.execute(f"CREATE INDEX IF NOT EXISTS {name} ON images({columns})")
    # New indexes only: no rows rewritten, no VACUUM needed.
    return False
