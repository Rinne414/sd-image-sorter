"""Persist versioned Dataset Maker project settings."""
from __future__ import annotations

import json
import sqlite3

from migrations._schema_common import table_exists


VERSION = 33
NAME = "dataset_project_settings"


_DEFAULT_SETTINGS_V1: dict[str, object] = {
    "settings_version": 1,
    "target_model": "",
    "caption_render": {
        "trigger": "",
        "common_tags": [],
        "blacklist": [],
        "normalize_tag_underscores": True,
        "content_mode": "template",
        "prefix": "",
        "template": {
            "template_override": "{trigger}, {tags:filtered}, {append}",
            "replace_rules": {},
            "max_tags": 0,
        },
    },
    "naming": {
        "preset": "keep",
        "custom_pattern": "{trigger}_{index:03d}",
    },
    "output": {
        "mode": "folder",
        "folder": "",
        "image_op": "copy",
        "overwrite_policy": "unique",
    },
    "trainer": {
        "config": "none",
        "contract_version": None,
        "mask_export": "none",
        "repeats": 10,
        "batch": 2,
        "resolution": 1024,
        "keep_tokens": 0,
    },
    "planning": {"epochs": 10},
}
DEFAULT_SETTINGS_JSON_V1 = json.dumps(
    _DEFAULT_SETTINGS_V1,
    ensure_ascii=True,
    separators=(",", ":"),
)


def _column_names(conn: sqlite3.Connection, table: str) -> set[str]:
    return {
        str(row[1])
        for row in conn.execute(f"PRAGMA table_info({table})").fetchall()
    }


def apply(conn: sqlite3.Connection) -> bool:
    """Add strict JSON settings and materialize neutral defaults for old projects."""
    if not table_exists(conn, "dataset_projects"):
        raise RuntimeError(
            "Cannot migrate Dataset project settings: dataset_projects is missing"
        )
    if "settings_json" in _column_names(conn, "dataset_projects"):
        return False

    sql_default = DEFAULT_SETTINGS_JSON_V1.replace("'", "''")
    conn.execute(
        f"""
        ALTER TABLE dataset_projects
        ADD COLUMN settings_json TEXT NOT NULL
            DEFAULT '{sql_default}'
            CHECK (
                JSON_VALID(settings_json) = 1
                AND JSON_TYPE(settings_json) = 'object'
            )
        """
    )
    return True
