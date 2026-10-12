"""Undo a batch move/copy run from its journal (services/sorting/move_journal.py).

Runs in the batch-move slot (one at a time, same progress and cancel), with
``run_kind: "undo"``. A moved file goes back to the exact place it came from,
and a copy the run made is removed, but only while the file is still what the
run left behind: moved again since, the original place taken by another file,
a copy edited since, or the image gone from the library are each reported
with the reason and left alone. A file the run began on but never recorded as
done (a power cut in between) is settled by looking at the disk: it goes back
only when it is at the destination and not at its old place. A finished undo
marks the run as undone.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from typing import Any, Dict, List, Optional

from fastapi import BackgroundTasks, HTTPException

import database as db
from services.sorting import move_journal
from services.sorting_models import BatchMoveUndoRequest
from utils.reported_cause import normalize_reported_cause

logger = logging.getLogger("services.sorting_service")

# Reasons shown for files an undo leaves alone (the page words its own summary).
MOVED_AGAIN = "It was moved again since; left where it is now"
NOT_IN_LIBRARY = "It is no longer in the library; left where it is"
COPY_CHANGED = "The copy was changed since; kept"
COPY_INDEXED = "The copy has been imported into the library since; kept"
# A file the run began on but never recorded as done.
STOPPED_BEFORE = (
    "The run stopped before this file moved; it is still in its original place"
)
STOPPED_CHECK = "The run stopped part-way through this file; check the disk: '{folder}' and its old place"
STOPPED_COPY = "The run stopped while copying this file; check '{folder}' for a copy, which was kept"


def _same_path(a: Optional[str], b: Optional[str]) -> bool:
    if not a or not b:
        return False
    return os.path.normcase(os.path.abspath(a)) == os.path.normcase(os.path.abspath(b))


def _stopped(reason: str, entry: Dict[str, Any]) -> str:
    return reason.format(folder=os.path.basename(entry.get("destination") or ""))


class BatchMoveUndoMixin:
    """Undo slice of SortingService (assembled in services/sorting_service.py)."""

    def _undo_moved_file(self, entry: Dict[str, Any]) -> Optional[str]:
        """Put one moved file back; the reason when it cannot be, None when it is back."""
        image = db.get_image_by_id(int(entry["image_id"]))
        if not image:
            return NOT_IN_LIBRARY
        if _same_path(image.get("path"), entry["source"]) and os.path.exists(
            entry["source"]
        ):
            return None  # already back (an undo that was stopped and run again)
        current = self._resolve_image_path(image.get("path") or "")
        if not current or not _same_path(current, entry["target"]):
            return MOVED_AGAIN
        try:
            self._restore_file_to_original_path(
                int(image["id"]), current, entry["source"]
            )
        except (
            Exception
        ) as exc:  # FileOperationError, or the database refusing the path
            return normalize_reported_cause(str(exc)) or "Could not move it back"
        return None

    def _undo_interrupted_move(self, entry: Dict[str, Any]) -> Optional[str]:
        """A move the run began but never recorded as done: back only if it left the source for the destination."""
        image = db.get_image_by_id(int(entry["image_id"]))
        if not image:
            return NOT_IN_LIBRARY
        source = entry["source"]
        listed = self._resolve_image_path(image.get("path") or "")
        in_destination = bool(listed) and _same_path(
            os.path.dirname(listed), entry.get("destination")
        )
        if listed and not in_destination and not _same_path(listed, source):
            return MOVED_AGAIN
        moved_to = self._interrupted_target(entry, listed if in_destination else None)
        at_source = os.path.exists(source)
        if moved_to is None and at_source:
            return STOPPED_BEFORE
        if moved_to is None or at_source:
            return _stopped(STOPPED_CHECK, entry)
        try:
            self._restore_file_to_original_path(int(image["id"]), moved_to, source)
        except Exception as exc:  # FileOperationError, or the database refusing the path
            return normalize_reported_cause(str(exc)) or "Could not move it back"
        return None

    @staticmethod
    def _interrupted_target(
        entry: Dict[str, Any], listed: Optional[str]
    ) -> Optional[str]:
        """The run's file in the destination (where the library lists it, or under its own name), when its size says it is."""
        own_name = os.path.join(
            entry.get("destination") or "", os.path.basename(entry["source"])
        )
        for path in (listed, own_name):
            if path and os.path.isfile(path) and os.path.getsize(path) == entry.get("size"):
                return path
        return None

    def _undo_entry(self, entry: Dict[str, Any], copy: bool) -> Optional[str]:
        """Undo one file of the run; the reason it stays, or None when it is undone."""
        if move_journal.is_interrupted(entry):
            # A copy cut short cannot be told from a file that was there before: it stays.
            return _stopped(STOPPED_COPY, entry) if copy else self._undo_interrupted_move(entry)
        return self._undo_copied_file(entry) if copy else self._undo_moved_file(entry)

    @staticmethod
    def _undo_copied_file(entry: Dict[str, Any]) -> Optional[str]:
        """Remove one copy the run made; the reason when it is kept, None when it is gone."""
        target = entry["target"]
        if not os.path.exists(target):
            return None
        if move_journal.file_facts(target) != {
            "size": entry.get("size"),
            "mtime_ns": entry.get("mtime_ns"),
        }:
            return COPY_CHANGED
        if db.get_image_by_path(target):
            return COPY_INDEXED
        try:
            os.remove(target)
        except OSError as exc:
            return normalize_reported_cause(str(exc)) or "Could not remove the copy"
        return None

    def _start_undo_run(self, token: str, total: int) -> tuple:
        """Claim the batch-move slot for an undo; refuses while another run is busy."""
        cancel_event = threading.Event()
        with self._batch_move_lock:
            if self._batch_move_progress["status"] in {"running", "cancelling"}:
                raise HTTPException(
                    status_code=409, detail="Batch move already in progress"
                )
            self._batch_move_run_id += 1
            run_id = self._batch_move_run_id
            self._batch_move_cancel_event = cancel_event
            self._batch_move_extra = {"run_token": token, "run_kind": "undo"}
            self._batch_move_error_items = []
            self._batch_move_progress = {
                **self._build_default_batch_move_progress_state(),
                "status": "running",
                "step": "undoing",
                "total": total,
                "message": f"Undoing a sort run of {total} images",
                "operation": "undo",
                "started_at": time.time(),
                "updated_at": time.time(),
            }
        return run_id, cancel_event

    def undo_batch_move(
        self, request: BatchMoveUndoRequest, background_tasks: BackgroundTasks
    ) -> Dict[str, Any]:
        """Undo a finished batch move/copy run named by its token, in the background."""
        token = request.run_token
        run = move_journal.read_run(token)
        if run is None:
            raise HTTPException(
                status_code=404, detail="There is no such sort run to undo"
            )
        if move_journal.is_undone(token):
            raise HTTPException(
                status_code=409, detail="This sort run was already undone"
            )
        files: List[Dict[str, Any]] = list(reversed(run["files"]))
        run_id, cancel_event = self._start_undo_run(token, len(files))
        copy = run["operation"] == "copy"

        def run_undo() -> None:
            self._run_undo(run_id, cancel_event, token, files, copy)

        background_tasks.add_task(run_undo)
        return {
            "status": "started",
            "total": len(files),
            "run_token": token,
            "operation": "undo",
        }

    def _run_undo(
        self,
        run_id: int,
        cancel_event: threading.Event,
        token: str,
        files: List[Dict[str, Any]],
        copy: bool,
    ) -> None:
        errors: List[Dict[str, Any]] = self._batch_move_error_items
        try:
            self._undo_files(run_id, cancel_event, token, files, copy, errors)
        except Exception:
            # Never leave the slot "running": say it stopped, with what was restored so far.
            logger.exception("Undo of sort run %s failed", token)
            progress = self.get_batch_move_progress()
            self._finish_undo(
                run_id,
                "error",
                int(progress.get("current", 0)),
                len(files),
                int(progress.get("moved", 0)),
                errors,
            )

    def _undo_files(
        self,
        run_id: int,
        cancel_event: threading.Event,
        token: str,
        files: List[Dict[str, Any]],
        copy: bool,
        errors: List[Dict[str, Any]],
    ) -> None:
        restored = 0
        total = len(files)
        for done, entry in enumerate(files, start=1):
            if cancel_event.is_set():
                self._finish_undo(
                    run_id, "cancelled", done - 1, total, restored, errors
                )
                return
            reason = self._undo_entry(entry, copy)
            name = os.path.basename(entry.get("target") or entry.get("source") or "")
            if reason:
                errors.append(
                    {
                        "image_id": entry.get("image_id"),
                        "filename": name,
                        "error": reason,
                    }
                )
            else:
                restored += 1
            self._update_batch_move_progress_if_current(
                run_id,
                step="undoing",
                current=done,
                total=total,
                moved=restored,
                errors=len(errors),
                current_item=name,
                recent_errors=errors[-3:],
                updated_at=time.time(),
            )
        move_journal.mark_undone(token)
        self._finish_undo(run_id, "done", total, total, restored, errors)

    def _finish_undo(
        self,
        run_id: int,
        status: str,
        current: int,
        total: int,
        restored: int,
        errors: List[Dict[str, Any]],
    ) -> None:
        self._set_batch_move_progress_if_current(
            run_id,
            {
                **self._build_default_batch_move_progress_state(),
                "status": status,
                "step": status,
                "current": current,
                "total": total,
                "moved": restored,
                "errors": len(errors),
                "recent_errors": errors[-3:],
                "message": f"Undo {status}: {restored} of {total} restored, {len(errors)} left as they are",
                "operation": "undo",
                "updated_at": time.time(),
            },
        )
        with self._batch_move_lock:
            if self._batch_move_run_id == run_id:
                self._batch_move_cancel_event = None
