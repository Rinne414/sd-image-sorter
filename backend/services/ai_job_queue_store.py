"""File persistence for the unified AI-job FIFO queue.

The tagging pipeline's cross-job FIFO queue (gallery AI Tag / Smart Tag /
VLM caption batch) is otherwise in-memory only and lost on a backend
restart. This module write-throughs the queued entries to a package-local
JSON file under ``STATE_DIR`` so a restart restores the pending jobs in
order.

Mirrors the shape of ``sorting_session_store.py``: a path helper plus
read/write with a schema version, an atomic write (temp sibling +
``os.replace``), and no legacy path fallbacks. Only the request-shaped
spec needed to re-submit a job is stored here — the caller strips live
runtime handles (legacy service objects, event loops, futures) before
persisting and re-binds them at restore/dispatch time.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any, Dict, List

import config


logger = logging.getLogger(__name__)

AI_JOB_QUEUE_SCHEMA_VERSION = 1
_QUEUE_FILENAME = "ai-job-queue.json"


def get_queue_state_path() -> Path:
    """Return the package-local AI-job-queue state file path.

    Reads ``config.STATE_DIR`` on every call so tests can redirect it with
    a single monkeypatch (same seam as ``similarity.get_state_dir``).
    """
    return Path(config.STATE_DIR) / _QUEUE_FILENAME


def read_queue_state() -> List[Dict[str, Any]]:
    """Load persisted queue entries in order.

    Returns ``[]`` (never raises) when the file is missing, unreadable,
    corrupt, an unexpected shape, or written by an unsupported schema
    version, so a bad file degrades to an empty queue instead of blocking
    startup.
    """
    path = get_queue_state_path()
    try:
        if not path.exists():
            return []
        with path.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError) as exc:
        # ValueError covers json.JSONDecodeError (corrupt file).
        logger.warning(
            "AI job queue state %s is unreadable/corrupt (%s); starting with an empty queue",
            path,
            exc,
        )
        return []

    if not isinstance(data, dict):
        logger.warning(
            "AI job queue state %s has an unexpected shape; starting with an empty queue", path
        )
        return []

    version = data.get("schema_version")
    if version is not None and version != AI_JOB_QUEUE_SCHEMA_VERSION:
        logger.warning(
            "AI job queue state schema v%s is unsupported (current v%s); starting with an empty queue",
            version,
            AI_JOB_QUEUE_SCHEMA_VERSION,
        )
        return []

    entries = data.get("entries")
    if not isinstance(entries, list):
        return []
    return entries


def write_queue_state(entries: List[Dict[str, Any]]) -> None:
    """Atomically persist the queue entries. Best-effort: never raises.

    Writes a temp sibling then ``os.replace`` so a crash mid-write can
    never leave a half-written state file (same idiom as
    ``similarity_ann._persist_index``).
    """
    try:
        path = get_queue_state_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "schema_version": AI_JOB_QUEUE_SCHEMA_VERSION,
            "entries": list(entries),
        }
        tmp_path = path.with_name(path.name + ".tmp")
        with tmp_path.open("w", encoding="utf-8") as handle:
            json.dump(payload, handle)
        os.replace(tmp_path, path)
    except Exception as exc:  # noqa: BLE001 — persistence must never break the caller
        logger.debug("AI job queue persist skipped: %s", exc)


__all__ = [
    "AI_JOB_QUEUE_SCHEMA_VERSION",
    "get_queue_state_path",
    "read_queue_state",
    "write_queue_state",
]
