from __future__ import annotations

import sqlite3

from migrations._schema_common import add_missing_legacy_image_columns, create_full_schema


VERSION = 2
NAME = "legacy_schema_upgrade"


def apply(conn: sqlite3.Connection) -> None:
    """
    Upgrade pre-versioned databases that still rely on ad hoc init_db patching.
    """
    add_missing_legacy_image_columns(conn)
    create_full_schema(conn)
