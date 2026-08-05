"""Materialize neutral subject-crop settings for existing Dataset projects."""
from __future__ import annotations

import json
import sqlite3

from migrations._schema_common import table_exists


VERSION = 39
NAME = "dataset_project_subject_crop"

_NEUTRAL_SUBJECT_CROP: dict[str, object] = {
    "enabled": False,
    "alpha_threshold": 1,
    "padding_percent": 0,
    "background_mode": "keep_background",
    "solid_color": "#000000",
}
NEUTRAL_SUBJECT_CROP_JSON = json.dumps(
    _NEUTRAL_SUBJECT_CROP,
    ensure_ascii=True,
    separators=(",", ":"),
)


def apply(conn: sqlite3.Connection) -> bool:
    """Add the disabled object without overwriting already persisted settings."""
    if not table_exists(conn, "dataset_projects"):
        raise RuntimeError(
            "Cannot migrate Dataset subject-crop settings: dataset_projects is missing"
        )
    columns = {
        str(row[1])
        for row in conn.execute("PRAGMA table_info(dataset_projects)").fetchall()
    }
    if "settings_json" not in columns:
        raise RuntimeError(
            "Cannot migrate Dataset subject-crop settings: settings_json is missing"
        )
    cursor = conn.execute(
        """
        UPDATE dataset_projects
        SET settings_json = JSON_SET(
            settings_json,
            '$.subject_crop',
            JSON(?)
        )
        WHERE JSON_TYPE(settings_json, '$.subject_crop') IS NULL
        """,
        (NEUTRAL_SUBJECT_CROP_JSON,),
    )
    return cursor.rowcount > 0
