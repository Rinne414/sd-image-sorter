"""Materialize neutral watermark-removal settings for existing Dataset projects."""

from __future__ import annotations

import json
import sqlite3

from migrations._schema_common import table_exists


VERSION = 41
NAME = "dataset_project_watermark_removal"

_NEUTRAL_WATERMARK_REMOVAL: dict[str, object] = {
    "enabled": False,
    "method": "telea",
    "radius": 3,
    "padding_percent": 0,
    "regions": [],
}
NEUTRAL_WATERMARK_REMOVAL_JSON = json.dumps(
    _NEUTRAL_WATERMARK_REMOVAL,
    ensure_ascii=True,
    separators=(",", ":"),
)


def apply(conn: sqlite3.Connection) -> bool:
    """Add the disabled object without overwriting existing project settings."""
    if not table_exists(conn, "dataset_projects"):
        raise RuntimeError(
            "Cannot migrate Dataset watermark-removal settings: dataset_projects is missing"
        )
    columns = {
        str(row[1])
        for row in conn.execute("PRAGMA table_info(dataset_projects)").fetchall()
    }
    if "settings_json" not in columns:
        raise RuntimeError(
            "Cannot migrate Dataset watermark-removal settings: settings_json is missing"
        )
    cursor = conn.execute(
        """
        UPDATE dataset_projects
        SET settings_json = JSON_SET(
            settings_json,
            '$.watermark_removal',
            JSON(?)
        )
        WHERE JSON_TYPE(settings_json, '$.watermark_removal') IS NULL
        """,
        (NEUTRAL_WATERMARK_REMOVAL_JSON,),
    )
    return cursor.rowcount > 0
