"""Migration 065: videos are library items too.

``media_type`` is 'video' for a file whose name ends in a video extension and
'image' for everything else. It is a VIRTUAL generated column computed from
``path``, so every writer (scan, move, rename, collect) keeps it right without
being told, and no existing row is rewritten.

The video columns are filled by the background video indexer once ffprobe has
read the file; they stay NULL for pictures:

- ``duration_seconds``  length in seconds
- ``video_codec``       codec of the first video stream (h264, vp9, prores ...)
- ``video_fps``         frames per second of that stream
- ``video_has_audio``   1 when the file has an audio stream
- ``video_probe_state`` 'pending' until probed, then 'ready' or 'unreadable'
- ``video_probe_error`` the short reason when ffprobe could not read the file

Additive and idempotent: ADD COLUMN only when absent (checked through
``table_xinfo``, which lists generated columns that ``table_info`` hides).
"""

from __future__ import annotations

import sqlite3

from migrations._schema_common import table_exists

VERSION = 65
NAME = "video_media"

# Lower-cased extensions that make a file a video. Keep in sync with
# config.ALLOWED_VIDEO_EXTENSIONS; a new extension needs a new migration that
# drops and re-adds this column (and its index).
_MEDIA_TYPE_SQL = (
    "CASE WHEN lower(substr(path, -4)) IN ('.mp4', '.mkv', '.mov', '.m4v') "
    "OR lower(substr(path, -5)) = '.webm' THEN 'video' ELSE 'image' END"
)

_VIDEO_COLUMNS = (
    ("duration_seconds", "REAL"),
    ("video_codec", "TEXT"),
    ("video_fps", "REAL"),
    ("video_has_audio", "INTEGER"),
    ("video_probe_state", "TEXT"),
    ("video_probe_error", "TEXT"),
)


def _columns(conn: sqlite3.Connection) -> set[str]:
    return {
        str(row[1]) for row in conn.execute("PRAGMA table_xinfo(images)").fetchall()
    }


def apply(conn: sqlite3.Connection) -> None:
    if not table_exists(conn, "images"):
        return
    existing = _columns(conn)
    if "media_type" not in existing:
        conn.execute(
            "ALTER TABLE images ADD COLUMN media_type TEXT "
            f"GENERATED ALWAYS AS ({_MEDIA_TYPE_SQL}) VIRTUAL"
        )
    for name, sql_type in _VIDEO_COLUMNS:
        if name not in existing:
            conn.execute(f"ALTER TABLE images ADD COLUMN {name} {sql_type}")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_images_media_type ON images(media_type)"
    )
    # Videos indexed before this migration (none were: the scanner skipped
    # them) would need probing; mark any that exist so the indexer picks them up.
    conn.execute(
        "UPDATE images SET video_probe_state = 'pending' "
        "WHERE media_type = 'video' AND video_probe_state IS NULL"
    )
