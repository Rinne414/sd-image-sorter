"""Migration 051: remember which pictures a sort already put somewhere.

``sorted_images`` holds one row per library picture that Auto-Separate or
Manual Sort copied or moved. A copy leaves the original in place and a move
only re-points the library row, so without this record Manual Sort queued
pictures the user had already sorted ("auto-sort first, hand-sort the rest").

``source`` is ``auto_separate`` or ``manual_sort``; ``operation`` is ``copy``
or ``move``. Rows follow their picture (``ON DELETE CASCADE``). Undoing a
Manual Sort action removes the row or gives back the one it replaced.

Additive and idempotent: CREATE IF NOT EXISTS only, nothing is read or
rewritten, so no VACUUM.
"""

from __future__ import annotations

import sqlite3

VERSION = 51
NAME = "sorted_images"


def apply(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS sorted_images (
            image_id INTEGER PRIMARY KEY REFERENCES images(id) ON DELETE CASCADE,
            source TEXT NOT NULL,
            operation TEXT NOT NULL,
            sorted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
