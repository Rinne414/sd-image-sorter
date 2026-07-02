"""File persistence helpers for manual sort sessions."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional


logger = logging.getLogger(__name__)

SORT_SESSION_SCHEMA_VERSION = 1


def get_session_file_candidates(session_file: str, legacy_session_file: str) -> List[Path]:
    """Return persisted-session paths in preferred load/save order."""
    preferred = Path(session_file).expanduser()
    legacy = Path(legacy_session_file).expanduser()
    if preferred.resolve() == legacy.resolve():
        return [preferred]
    return [preferred, legacy]


def find_existing_session_file(paths: Iterable[Path]) -> Optional[Path]:
    """Find the first existing persisted sort-session file."""
    for candidate in paths:
        if candidate.exists():
            return candidate
    return None


def parse_persisted_session_version(data: Dict[str, Any]) -> int:
    """Read the persisted schema version, treating missing versions as legacy v0."""
    raw_version = data.get("session_schema_version")
    if raw_version is None:
        return 0
    try:
        version = int(raw_version)
    except (TypeError, ValueError) as exc:
        raise ValueError("Invalid session_schema_version") from exc
    if version < 0:
        raise ValueError("Invalid session_schema_version")
    return version


def build_persisted_sort_session_payload(session: Dict[str, Any]) -> Dict[str, Any]:
    """Return the on-disk manual-sort session payload."""
    return {
        "session_schema_version": SORT_SESSION_SCHEMA_VERSION,
        "active": session["active"],
        "mode": session["mode"],
        "current_index": session["current_index"],
        "champion_index": session["champion_index"],
        "folders": session["folders"],
        "collection_slots": session["collection_slots"],
        "operation_mode": session["operation_mode"],
        "history": session["history"],
        "redo_stack": session["redo_stack"],
        "image_ids": session["image_ids"],
    }


def read_persisted_session(path: Path) -> Dict[str, Any]:
    """Read a persisted sort-session JSON file."""
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_persisted_session(path: Path, data: Dict[str, Any]) -> None:
    """Write a persisted sort-session JSON file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(data, handle)


def discard_persisted_session_files(reason: str, paths: Iterable[Path]) -> None:
    """Delete unusable persisted session files so future boots do not half-restore them."""
    logger.warning("Discarding persisted sort session: %s", reason)
    remove_session_files(paths, warning_message="Failed to remove unsupported session file %s: %s")


def remove_session_files(
    paths: Iterable[Path],
    *,
    warning_message: str = "Failed to remove session file %s: %s",
) -> None:
    """Remove persisted session files, logging and continuing on filesystem errors."""
    for path in paths:
        try:
            if path.exists():
                path.unlink()
        except OSError as exc:
            logger.warning(warning_message, path, exc)


__all__ = [
    "SORT_SESSION_SCHEMA_VERSION",
    "build_persisted_sort_session_payload",
    "discard_persisted_session_files",
    "find_existing_session_file",
    "get_session_file_candidates",
    "parse_persisted_session_version",
    "read_persisted_session",
    "remove_session_files",
    "write_persisted_session",
]
