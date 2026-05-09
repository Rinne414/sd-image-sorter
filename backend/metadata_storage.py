"""Compact persisted metadata helpers.

The original image file is the durable source of raw PNG/EXIF/XMP metadata.
SQLite stores only the parsed summary needed for browsing, filtering, and export.
"""
from __future__ import annotations

import json
from typing import Any, Dict, Optional


COMPACT_METADATA_VERSION = 1


def _json_safe(value: Any) -> Any:
    try:
        json.dumps(value, ensure_ascii=False)
        return value
    except (TypeError, ValueError):
        if isinstance(value, dict):
            return {str(key): _json_safe(item) for key, item in value.items()}
        if isinstance(value, (list, tuple, set)):
            return [_json_safe(item) for item in value]
        if isinstance(value, bytes):
            return value.decode("utf-8", errors="replace")
        return str(value)


def compact_metadata_dict(metadata: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Return the small metadata payload safe to persist in ``images.metadata_json``.

    Heavy raw chunks such as ComfyUI ``prompt``/``workflow``, NovelAI ``Comment``,
    and EXIF/XMP blobs can be re-read from the image when the user opens the
    Reader. Persisting them for every scanned file can make ``images.db`` larger
    than the source library, so the index keeps only the parsed summary.
    """
    if not isinstance(metadata, dict):
        return {"_compact": {"version": COMPACT_METADATA_VERSION}}

    compact: Dict[str, Any] = {"_compact": {"version": COMPACT_METADATA_VERSION}}
    parsed = metadata.get("_parsed")
    if isinstance(parsed, dict):
        compact["_parsed"] = _json_safe(parsed)
    return compact


def compact_metadata_json(metadata: Optional[Dict[str, Any]]) -> str:
    """Serialize compact persisted metadata using stable JSON separators."""
    return json.dumps(
        compact_metadata_dict(metadata),
        ensure_ascii=False,
        separators=(",", ":"),
    )


def compact_existing_metadata_json(raw_metadata_json: Any) -> Optional[str]:
    """Compact an already-stored metadata JSON blob.

    Returns ``None`` when the value cannot be parsed as an object, letting the
    caller preserve unreadable legacy data instead of destroying it blindly.
    """
    if raw_metadata_json is None:
        return compact_metadata_json({})
    if isinstance(raw_metadata_json, bytes):
        raw_metadata_json = raw_metadata_json.decode("utf-8", errors="replace")
    if isinstance(raw_metadata_json, dict):
        return compact_metadata_json(raw_metadata_json)
    if not isinstance(raw_metadata_json, str):
        return None

    text = raw_metadata_json.strip()
    if not text:
        return compact_metadata_json({})
    try:
        parsed = json.loads(text)
    except (TypeError, ValueError, json.JSONDecodeError):
        return None
    if not isinstance(parsed, dict):
        return None
    return compact_metadata_json(parsed)
