"""Materialize neutral bucket-resize settings for existing Dataset projects."""

from __future__ import annotations

import json
import sqlite3

from migrations._schema_common import table_exists


VERSION = 40
NAME = "dataset_project_bucket_resize"

_NEUTRAL_BUCKET_RESIZE: dict[str, object] = {
    "enabled": False,
    "subject_aware": False,
    "alpha_threshold": 128,
}
NEUTRAL_BUCKET_RESIZE_JSON = json.dumps(
    _NEUTRAL_BUCKET_RESIZE,
    ensure_ascii=True,
    separators=(",", ":"),
)


def apply(conn: sqlite3.Connection) -> bool:
    """Add the disabled object without overwriting already persisted settings."""
    if not table_exists(conn, "dataset_projects"):
        raise RuntimeError(
            "Cannot migrate Dataset bucket-resize settings: dataset_projects is missing"
        )
    columns = {
        str(row[1])
        for row in conn.execute("PRAGMA table_info(dataset_projects)").fetchall()
    }
    if "settings_json" not in columns:
        raise RuntimeError(
            "Cannot migrate Dataset bucket-resize settings: settings_json is missing"
        )
    cursor = conn.execute(
        """
        UPDATE dataset_projects
        SET settings_json = JSON_SET(
            settings_json,
            '$.bucket_resize',
            JSON(?)
        )
        WHERE JSON_TYPE(settings_json, '$.bucket_resize') IS NULL
        """,
        (NEUTRAL_BUCKET_RESIZE_JSON,),
    )
    return cursor.rowcount > 0
