"""Migration 010: Add color analysis columns to images table.

These columns store color data extracted during scan to enable color-based
filtering and sorting in the gallery (brightness, temperature, hue, distribution shape).

All columns are nullable so existing libraries continue working; the values
will be populated lazily on first sort/filter use, or via a background task.
"""
from __future__ import annotations

import sqlite3

from migrations._schema_common import table_exists


VERSION = 10
NAME = "color_analysis_columns"


COLUMNS_TO_ADD = (
    # JSON array of {hex, pct} dicts for top-5 dominant colors
    ("dominant_colors", "TEXT"),
    # Average brightness 0-255 (HSV V channel)
    ("avg_brightness", "REAL"),
    # 'warm' | 'cool' | 'neutral' (computed from average hue)
    ("color_temperature", "TEXT"),
    # Average saturation 0-255 (HSV S channel)
    ("color_saturation", "REAL"),
    # JSON 16-bucket brightness histogram for shape analysis
    ("brightness_histogram", "TEXT"),
    # Third moment (skew): negative=left-heavy (dark), positive=right-heavy (bright)
    ("brightness_skew", "REAL"),
    # 'left_heavy' | 'right_heavy' | 'middle_heavy' | 'edge_heavy' | 'balanced'
    ("brightness_distribution", "TEXT"),
)


def _column_exists(conn: sqlite3.Connection, table: str, column: str) -> bool:
    cursor = conn.execute(f"PRAGMA table_info({table})")
    return any(row[1] == column for row in cursor.fetchall())


def apply(conn: sqlite3.Connection) -> None:
    """Add color analysis columns to images table (idempotent)."""
    if not table_exists(conn, "images"):
        return

    cursor = conn.cursor()
    for column_name, column_type in COLUMNS_TO_ADD:
        if not _column_exists(conn, "images", column_name):
            cursor.execute(f"ALTER TABLE images ADD COLUMN {column_name} {column_type}")

    # Indexes for fast filter/sort
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_images_avg_brightness ON images(avg_brightness)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_images_color_temperature ON images(color_temperature)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_images_brightness_distribution ON images(brightness_distribution)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_images_brightness_skew ON images(brightness_skew)")
