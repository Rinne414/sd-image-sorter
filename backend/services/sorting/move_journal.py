"""What a batch move/copy run did, so the run can be undone later.

Each run writes one JSON-lines file named by its token under the state dir:
a header line (operation, destination, when), then two lines per image. The
"intent" line (image id, where the file is, the folder it goes to, its size
and modification time) is synced to disk before the file is touched; the
"done" line (where it went, the size and modification time of what it left
behind) is synced after. A power cut between the two leaves an intent without
its done line, which undo settles by looking at the disk. Journals written
before intent lines existed hold one line per file and no phase: done lines.
Undo refuses to touch a file that is no longer what the run left there. An
undone run gets a marker file, so it cannot be undone twice.
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


def _sync_folder(folder: Path) -> None:
    """Make a new journal's name durable too (Windows cannot open a folder to sync it)."""
    if os.name == "nt":
        return
    descriptor = os.open(folder, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


class RunJournal:
    """Appends one run's records: every line flushed, and synced to disk around each file."""

    def __init__(self, token: str, operation: str, destination: str) -> None:
        path = _path(token)
        path.parent.mkdir(parents=True, exist_ok=True)
        prune(path.parent)
        self._operation = operation
        self._steps = 0
        self._handle: Optional[TextIO] = open(path, "a", encoding="utf-8")
        self._write(
            {
                "kind": "run",
                "operation": operation,
                "destination": destination,
                "started_at": time.time(),
            }
        )
        _sync_folder(path.parent)

    def _write(self, entry: Dict[str, Any], durable: bool = False) -> None:
        if self._handle is None:
            return
        self._handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
        self._handle.flush()
        if durable:
            os.fsync(self._handle.fileno())

    def intend(self, image_id: int, source: str, destination: str) -> int:
        """Say on disk which file is about to go to which folder; the step its done line names."""
        self._steps += 1
        self._write(
            {
                "kind": "file",
                "phase": "intent",
                "step": self._steps,
                "image_id": int(image_id),
                "source": source,
                "destination": destination,
                "operation": self._operation,
                **file_facts(source),
            },
            durable=True,
        )
        return self._steps

    def record(
        self, image_id: int, source: str, target: str, step: Optional[int] = None
    ) -> None:
        """Say on disk where the file of `step` went and what it left there."""
        self._write(
            {
                "kind": "file",
                "phase": "done",
                "step": step,
                "image_id": int(image_id),
                "source": source,
                "target": target,
                **file_facts(target),
            },
            durable=True,
        )

    def close(self) -> None:
        if self._handle is not None:
            self._handle.close()
            self._handle = None


def _one_per_file(records: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """One record per file in run order: its done line, or its intent when no done line reached the disk.

    A line without a phase comes from a journal written before intents existed: a done line.
    """
    files: List[Dict[str, Any]] = []
    waiting: Dict[int, int] = {}  # step of an intent -> its place in `files`
    for entry in records:
        phase = entry.get("phase", "done")
        step = entry.get("step")
        if phase == "intent" and isinstance(step, int):
            waiting[step] = len(files)
            files.append(entry)
        elif phase == "done":
            if isinstance(step, int) and step in waiting:
                files[waiting.pop(step)] = entry
            else:
                files.append(entry)
    return files


def is_interrupted(entry: Dict[str, Any]) -> bool:
    """A file the run began on but never said it finished (a crash or power cut in between)."""
    return entry.get("phase") == "intent"


def read_run(token: str) -> Optional[Dict[str, Any]]:
    """The run's header and one record per file, or None when there is no such run."""
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
        "files": _one_per_file(files),
    }


def is_undone(token: str) -> bool:
    return _undone_marker(token).exists()


def mark_undone(token: str) -> None:
    _undone_marker(token).write_text(str(time.time()), encoding="utf-8")
