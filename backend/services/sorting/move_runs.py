"""The recent move and copy runs, so one can be undone after its toast is gone.

Every batch move or copy writes a journal (``move_journal.py``), and undo works
from that journal alone. The Undo button, though, lived only in the result
toast or banner: leave the page and the way back was lost while the journal
still sat on disk. This lists the journals, newest first, with what a person
needs to recognise a run: when, move or copy, where to, how many files, and
whether it was already undone.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List

from services.sorting import move_journal


def _describe(path: Path) -> Dict[str, Any]:
    """One run from its journal: the header line, then one count per file."""
    header: Dict[str, Any] = {}
    done_ids: set = set()
    started_ids: set = set()
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
                key = entry.get("image_id", entry.get("source"))
                # Journals from before intent lines existed hold done lines without a phase.
                if entry.get("phase", "done") == "done":
                    done_ids.add(key)
                else:
                    started_ids.add(key)
    token = path.stem
    return {
        "run_token": token,
        "operation": header.get("operation", "move"),
        "destination": header.get("destination"),
        "started_at": header.get("started_at"),
        "files": len(done_ids),
        # Begun but never finished (a crash in between): undo settles these by looking at the disk.
        "interrupted": len(started_ids - done_ids),
        "undone": move_journal.is_undone(token),
    }


def list_runs(limit: int = 20, offset: int = 0) -> Dict[str, Any]:
    """Runs newest first; ``total`` is how many journals are kept."""
    folder = move_journal.journal_dir()
    if not folder.is_dir():
        return {"runs": [], "total": 0}
    journals = sorted(
        folder.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True
    )
    page = journals[max(0, offset) : max(0, offset) + max(1, limit)]
    runs: List[Dict[str, Any]] = []
    for path in page:
        try:
            runs.append(_describe(path))
        except OSError:
            # Removed between the listing and the read (a new run pruned it).
            continue
    return {"runs": runs, "total": len(journals)}
