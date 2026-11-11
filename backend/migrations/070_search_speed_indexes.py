"""Migration 070: indexes for the two searches that were slow in a large library.

Measured on a 100,000-picture library (2026-11-12):

- ``steps:``, ``cfg:`` and ``sampler:`` read the parameter out of each
  picture's stored metadata, for every picture, on every search: about 1.7 s
  per request. Each gets an index on the very expression the search uses
  (``db_generation_search.index_expressions``), led by the library so one
  library's search never walks another's rows. The same request then took
  0.02 to 0.5 s.
- Sorting by name pages by offset, and without an index every page sorted the
  whole library again: 5 to 6 s for a page in the middle. An index in name
  order makes a page a short walk (4 ms).

Nothing is read, rewritten or cleared; the indexes add about 3 s to this one
start-up per 100,000 pictures. Damaged metadata is indexed as "no such
parameter" (the expressions guard with ``json_valid``), so it cannot stop the
build.
"""

from __future__ import annotations

import sqlite3

from migrations._schema_common import table_exists

VERSION = 70
NAME = "search_speed_indexes"


def apply(conn: sqlite3.Connection) -> None:
    """Create the indexes (idempotent, additive)."""
    if not table_exists(conn, "images"):
        return
    from db_generation_search import index_expressions

    for name, expression in index_expressions().items():
        conn.execute(
            f"CREATE INDEX IF NOT EXISTS {name} ON images(library_id, {expression})"
        )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_images_lib_filename ON images(library_id, filename, id)"
    )
