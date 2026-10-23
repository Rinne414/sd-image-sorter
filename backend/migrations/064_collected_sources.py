"""Migration 064: where a collected picture came from.

Pictures saved from a web page (the browser extension) or pasted into the
program keep the picture's own address, the page it was on, that page's title,
when it was collected and how (``extension``, ``paste``, ``url``). One row per
picture, removed with the picture.

Additive and idempotent: CREATE ... IF NOT EXISTS only; no existing row is
read or rewritten.
"""

from __future__ import annotations

import sqlite3

from migrations._schema_common import table_exists

VERSION = 64
NAME = "collected_sources"


def apply(conn: sqlite3.Connection) -> bool:
    existed = table_exists(conn, "collected_sources")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS collected_sources (
            image_id INTEGER PRIMARY KEY REFERENCES images(id) ON DELETE CASCADE,
            source_url TEXT,
            page_url TEXT,
            page_title TEXT,
            collected_at TEXT NOT NULL,
            via TEXT NOT NULL DEFAULT 'extension'
        )
        """
    )
    return not existed
