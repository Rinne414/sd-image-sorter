from __future__ import annotations

import json
import sqlite3
from typing import Any, Dict, Optional

from migrations._schema_common import table_exists


VERSION = 8
NAME = "compact_persisted_metadata"

_BATCH_SIZE = 500
_COMPACT_METADATA_VERSION = 1
def _json_safe_v1(value: Any) -> Any:
    """Migration-frozen JSON sanitizer used by v8 compaction."""
    try:
        json.dumps(value, ensure_ascii=False)
        return value
    except (TypeError, ValueError):
        if isinstance(value, dict):
            return {str(key): _json_safe_v1(item) for key, item in value.items()}
        if isinstance(value, (list, tuple, set)):
            return [_json_safe_v1(item) for item in value]
        if isinstance(value, bytes):
            return value.decode("utf-8", errors="replace")
        return str(value)


def _compact_metadata_json_v1(metadata: Optional[Dict[str, Any]]) -> str:
    """Migration-frozen compact persisted metadata shape."""
    compact: Dict[str, Any] = {"_compact": {"version": _COMPACT_METADATA_VERSION}}
    if isinstance(metadata, dict) and isinstance(metadata.get("_parsed"), dict):
        compact["_parsed"] = _json_safe_v1(metadata["_parsed"])
    return json.dumps(compact, ensure_ascii=False, separators=(",", ":"))


def _compact_existing_metadata_json_v1(raw_metadata_json: Any) -> Optional[str]:
    """Migration-frozen compactor for legacy images.metadata_json values."""
    if raw_metadata_json is None:
        return _compact_metadata_json_v1({})
    if isinstance(raw_metadata_json, bytes):
        raw_metadata_json = raw_metadata_json.decode("utf-8", errors="replace")
    if isinstance(raw_metadata_json, dict):
        return _compact_metadata_json_v1(raw_metadata_json)
    if not isinstance(raw_metadata_json, str):
        return None

    text = raw_metadata_json.strip()
    if not text:
        return _compact_metadata_json_v1({})
    try:
        parsed = json.loads(text)
    except (TypeError, ValueError, json.JSONDecodeError):
        return None
    if not isinstance(parsed, dict):
        return None
    return _compact_metadata_json_v1(parsed)


def _should_attempt_compaction(metadata_json: str) -> bool:
    if not metadata_json:
        return False
    if '"_compact"' in metadata_json:
        return False
    return True


def _compact_table_column(conn: sqlite3.Connection, table_name: str, id_column: str) -> int:
    changed = 0
    last_id = 0
    while True:
        rows = conn.execute(
            f"SELECT {id_column}, metadata_json FROM {table_name} "
            "WHERE metadata_json IS NOT NULL AND metadata_json != '' "
            f"AND {id_column} > ? ORDER BY {id_column} LIMIT ?",
            (last_id, _BATCH_SIZE),
        ).fetchall()
        if not rows:
            break

        for row in rows:
            row_id = row[0]
            last_id = max(last_id, int(row_id))
            original = row[1]
            if not isinstance(original, str) or not _should_attempt_compaction(original):
                continue
            compacted = _compact_existing_metadata_json_v1(original)
            if compacted is None or compacted == original:
                continue
            conn.execute(
                f"UPDATE {table_name} SET metadata_json = ? WHERE {id_column} = ?",
                (compacted, row_id),
            )
            changed += 1

    return changed


def apply(conn: sqlite3.Connection) -> bool:
    """Shrink raw metadata copies in persisted index rows.

    Returns True when rows changed so init_db can run VACUUM after committing;
    without VACUUM, SQLite would keep the old large pages allocated on disk.
    """
    changed = 0
    if table_exists(conn, "images"):
        changed += _compact_table_column(conn, "images", "id")
    if table_exists(conn, "collection_items"):
        changed += _compact_table_column(conn, "collection_items", "id")
    return changed > 0
