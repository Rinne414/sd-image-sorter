"""What a batch move/copy run did, so the run can be undone later.

Each run writes one JSON-lines file named by its token under the state dir:
a header line (operation, destination, when) and one line per image it moved
or copied (image id, where the file came from, where it went, the size and
modification time of what it left behind). Undo reads it back and refuses to
touch a file that is no longer what the run left there. An undone run gets a
marker file, so it cannot be undone twice.
"""

from __future__ import annotations

import json
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, TextIO

import config

_TOKEN = re.compile(r"^[0-9a-f]{32}$")


def journal_dir() -> Path:
    """Where run journals live (resolved at call time, so tests can move it)."""
    return Path(config.STATE_DIR) / "batch-move-runs"


def new_token() -> str:
    return uuid.uuid4().hex


def _path(token: str) -> Path:
    if not _TOKEN.match(token or ""):
        raise ValueError("invalid run token")
    return journal_dir() / f"{token}.jsonl"


def _undone_marker(token: str) -> Path:
    return _path(token).with_suffix(".undone")


#: Runs kept for undo; older journals are removed when a new run starts.
KEEP_RUNS = 100


def prune(folder: Path, keep: int = KEEP_RUNS) -> None:
    """Remove all but the newest `keep` run journals (and their undone markers)."""
    runs = sorted(folder.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)
    for old in runs[keep:]:
        for leftover in (old, old.with_suffix(".undone")):
            try:
                leftover.unlink()
            except FileNotFoundError:
                pass


def file_facts(path: str) -> Dict[str, int]:
    """Size and modification time of a file, to recognise it later."""
    stat = os.stat(path)
    return {"size": int(stat.st_size), "mtime_ns": int(stat.st_mtime_ns)}


class RunJournal:
    """Appends one run's records; each line is flushed so a crash keeps what was done."""

    def __init__(self, token: str, operation: str, destination: str) -> None:
        path = _path(token)
        path.parent.mkdir(parents=True, exist_ok=True)
        prune(path.parent)
        self._handle: Optional[TextIO] = open(path, "a", encoding="utf-8")
        self._write(
            {
                "kind": "run",
                "operation": operation,
                "destination": destination,
                "started_at": time.time(),
            }
        )

    def _write(self, entry: Dict[str, Any]) -> None:
        if self._handle is None:
            return
        self._handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
        self._handle.flush()

    def record(self, image_id: int, source: str, target: str) -> None:
        self._write(
            {
                "kind": "file",
                "image_id": int(image_id),
                "source": source,
                "target": target,
                **file_facts(target),
            }
        )

    def close(self) -> None:
        if self._handle is not None:
            self._handle.close()
            self._handle = None


def read_run(token: str) -> Optional[Dict[str, Any]]:
    """The run's header and file records, or None when there is no such run."""
    path = _path(token)
    if not path.exists():
        return None
    header: Dict[str, Any] = {}
    files: List[Dict[str, Any]] = []
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except ValueError:
                # A line cut short by a crash: the records before it still count.
                continue
            if entry.get("kind") == "run":
                header = entry
            elif entry.get("kind") == "file":
                files.append(entry)
    return {
        "operation": header.get("operation", "move"),
        "destination": header.get("destination"),
        "files": files,
    }


def is_undone(token: str) -> bool:
    return _undone_marker(token).exists()


def mark_undone(token: str) -> None:
    _undone_marker(token).write_text(str(time.time()), encoding="utf-8")
