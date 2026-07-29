"""Persist the short-lived Gallery membership independently from the library."""

from migrations._schema_common import table_exists

VERSION = 30
NAME = "gallery_session_images"


def apply(conn):
    existed = table_exists(conn, "gallery_session_images")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS gallery_session_images (
            image_id INTEGER PRIMARY KEY REFERENCES images(id) ON DELETE CASCADE,
            added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_gallery_session_images_added_at
        ON gallery_session_images(added_at, image_id)
        """
    )
    return not existed
