"""Migration 023: raw_metadata_gz column (metadata L3, v3.5.0).

When ComfyUI parsing cannot recover a positive prompt, the scanner now
stores the image's raw ``prompt`` text chunk (gzipped) in this column.
That makes every future parser upgrade retroactive: "Re-parse failed
images" replays the stored graphs through the improved parser without
touching — or even needing — the original files.

Column-add only; nothing to backfill (raw chunks are captured going
forward, and the re-parse job falls back to reading the file when a row
has no stored raw but the file is still reachable).
"""
from __future__ import annotations

import sqlite3

from migrations._schema_common import add_missing_legacy_image_columns


VERSION = 23
NAME = "raw_metadata_column"


def apply(conn: sqlite3.Connection) -> None:
    add_missing_legacy_image_columns(conn)
