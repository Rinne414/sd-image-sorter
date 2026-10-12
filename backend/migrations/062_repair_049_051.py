"""Migration 062: give a V Opus database the three migrations it skipped.

V Opus (frontend-v4) numbered its own migrations 060 and 061 while the classic
line went on to 049-051. ``init_db`` skips every migration whose version is at
or below the database's, so a database V Opus had already taken to 061 never
ran 049 (versioned and anime aesthetic score columns), 050
(``image_style_vectors``) or 051 (``sorted_images``) after the two lines were
merged, and every feature reading them failed on it.

This migration runs those three again. Each is additive and idempotent (ADD
COLUMN only when absent, CREATE ... IF NOT EXISTS), so on a fresh database or
one that came up through 051 it changes nothing. No row is read or rewritten,
so no VACUUM.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

VERSION = 62
NAME = "repair_049_051"

# The migrations a database numbered past them may have skipped, in order.
REPAIRED_MIGRATIONS = (
    "049_aesthetic_versions.py",
    "050_style_vectors.py",
    "051_sorted_images.py",
)


def apply(conn: sqlite3.Connection) -> bool:
    from migrations import _load_module_from_path

    migrations_dir = Path(__file__).resolve().parent
    for filename in REPAIRED_MIGRATIONS:
        _load_module_from_path(migrations_dir / filename).apply(conn)
    return False
