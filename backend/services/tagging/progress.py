"""Tagging progress state: canonical payload builder and service-side machinery.

Moved verbatim from services/tagging_service.py (decomposition 2026-07).
"""

import logging
import queue as queue_module
from typing import Any, Dict, Optional

from services.state_compat import MutableStateProxy

# NOTE(decomposition): keep the historical logger channel so log routing
# and output stay byte-identical after the services/tagging split.
logger = logging.getLogger("services.tagging_service")


def _build_tag_progress_state(
    status: str,
    current: int = 0,
    total: int = 0,
    tagged: int = 0,
    errors: int = 0,
    message: str = "",
    runtime_backend_target: str = "",
    runtime_backend_actual: str = "",
    runtime_backend_reason: str = "",
    memory_pressure_warning: str = "",
    run_id: int = 0,
    last_run_stats: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Build a normalized tag progress payload."""
    payload: Dict[str, Any] = {
        "status": status,
        "current": current,
        "processed": current,
        "total": total,
        "tagged": tagged,
        "errors": errors,
        "message": message,
        "runtime_backend_target": runtime_backend_target,
        "runtime_backend_actual": runtime_backend_actual,
        "runtime_backend_reason": runtime_backend_reason,
        "memory_pressure_warning": memory_pressure_warning,
        "run_id": run_id,
    }
    if last_run_stats:
        # Only present on terminal states (done / cancelled / error). The
        # frontend uses the presence of this key to know it's safe to pop
        # the post-tag stats modal exactly once per run.
        payload["last_run_stats"] = last_run_stats
    return payload


class ProgressMixin:
    """Progress-state slice of TaggingService (assembled in services.tagging.service)."""

    @staticmethod
    def _coerce_progress_state(state: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        """Normalize externally injected progress state onto the canonical shape."""
        state = state or {}
        coerced = _build_tag_progress_state(
            str(state.get("status", "idle")),
            current=int(state.get("current", 0) or 0),
            total=int(state.get("total", 0) or 0),
            tagged=int(state.get("tagged", 0) or 0),
            errors=int(state.get("errors", 0) or 0),
            message=str(state.get("message", "") or ""),
            runtime_backend_target=str(state.get("runtime_backend_target", "") or ""),
            runtime_backend_actual=str(state.get("runtime_backend_actual", "") or ""),
            runtime_backend_reason=str(state.get("runtime_backend_reason", "") or ""),
            memory_pressure_warning=str(state.get("memory_pressure_warning", "") or ""),
            run_id=int(state.get("run_id", 0) or 0),
        )
        if "processed" in state:
            coerced["processed"] = int(state.get("processed", coerced["current"]) or 0)
        return coerced

    def get_progress(self) -> Dict[str, Any]:
        """Get the current tagging progress state."""
        with self._lock:
            return self._progress.copy()

    def is_worker_active(self) -> bool:
        """Return whether the owned tagging child process is still alive."""
        with self._lock:
            return bool(
                self._worker_process and self._worker_process.is_alive()
            )

    def get_progress_proxy(self) -> MutableStateProxy:
        """Expose the legacy dict-style progress handle without moving ownership out of the service."""
        return self._progress_proxy

    def set_progress(self, state: Dict[str, Any]) -> None:
        """Set the tag progress state."""
        with self._lock:
            self._progress = self._coerce_progress_state(state)

    def reset_progress(self) -> Dict[str, Any]:
        """Reset a stuck tagging task back to idle."""
        with self._lock:
            if self._worker_process and self._worker_process.is_alive():
                return {
                    "status": self._progress["status"],
                    "message": "Cannot reset while the tagger worker is still running",
                }
            if self._progress["status"] in {
                "running",
                "cancelling",
                "error",
                "done",
                "cancelled",
            }:
                if self._pending_run_id == self._active_run_id:
                    self._active_run_id += 1
                self._pending_run_id = None
                self._progress = _build_tag_progress_state(
                    "idle", message="Reset by user"
                )
                self._cancel_requested = False
                self._worker_process = None
                self._worker_cancel_event = None
                return {"status": "reset", "message": "Tagging progress reset to idle"}
            return {"status": self._progress["status"], "message": "Nothing to reset"}

    def cancel_tagging(self) -> Dict[str, Any]:
        """Request cooperative cancellation of the current tagging task."""
        with self._lock:
            if self._progress["status"] not in {"running", "cancelling"}:
                return {
                    "status": self._progress["status"],
                    "message": "No tagging task is running",
                }

            self._cancel_requested = True
            if self._worker_cancel_event is not None:
                self._worker_cancel_event.set()
            self._progress["status"] = "cancelling"
            current = self._progress.get("current", 0)
            total = self._progress.get("total", 0)
            tagged = self._progress.get("tagged", 0)
            errors = self._progress.get("errors", 0)
            run_id = int(self._progress.get("run_id") or self._active_run_id or 0)
            self._progress["message"] = f"Cancelling... ({current}/{total})"

            worker = self._worker_process

            # If start_tagging just queued a background task but the worker
            # process has not been spawned yet, _worker_process is still None.
            # Finalize the cancellation here and bump _active_run_id so the
            # pending _run_tagging_job aborts when it finally executes (its
            # run_id will no longer match self._active_run_id, so it takes
            # the should_abort path instead of clobbering progress and
            # spawning a worker that nobody can cancel).
            if worker is None:
                self._progress = _build_tag_progress_state(
                    "cancelled",
                    current=current,
                    total=total,
                    tagged=tagged,
                    errors=errors,
                    message=f"Tagging cancelled at {current}/{total}.",
                    run_id=run_id,
                )
                self._pending_run_id = None
                self._active_run_id += 1
                self._cancel_requested = False
                return {"status": "cancelled", "message": "Tagging cancelled"}

        worker_stopped = not worker.is_alive()
        # If the worker is alive, give it a short grace period then forcefully terminate
        if worker.is_alive():
            worker.join(timeout=3.0)
            if worker.is_alive():
                logger.warning(
                    "Tagger worker did not stop cooperatively, terminating process."
                )
                try:
                    worker.terminate()
                    worker.join(timeout=5.0)
                except Exception as exc:
                    logger.error("Error terminating tagger worker: %s", exc)
                    try:
                        worker.kill()
                    except Exception:
                        pass
            worker_stopped = not worker.is_alive()

        if worker_stopped:
            with self._lock:
                if run_id == self._active_run_id:
                    self._progress = _build_tag_progress_state(
                        "cancelled",
                        current=current,
                        total=total,
                        tagged=tagged,
                        errors=errors,
                        message=f"Tagging cancelled at {current}/{total}.",
                        run_id=run_id,
                    )
                    self._worker_process = None
                    self._worker_cancel_event = None
            return {"status": "cancelled", "message": "Tagging cancelled"}

        return {"status": "cancelling", "message": "Cancellation requested"}

    def _apply_worker_progress(
        self, payload: Dict[str, Any], run_id: Optional[int] = None
    ) -> None:
        """Merge a worker progress message into shared service state."""
        with self._lock:
            if run_id is not None and run_id != self._active_run_id:
                return
            effective_run_id = int(
                payload.get("run_id")
                or run_id
                or self._progress.get("run_id")
                or self._active_run_id
                or 0
            )
            previous_last_run_stats = self._progress.get("last_run_stats")
            self._progress = {
                "status": payload.get("status", self._progress.get("status", "idle")),
                "current": payload.get("current", self._progress.get("current", 0)),
                "processed": payload.get(
                    "processed",
                    payload.get("current", self._progress.get("processed", 0)),
                ),
                "total": payload.get("total", self._progress.get("total", 0)),
                "tagged": payload.get("tagged", self._progress.get("tagged", 0)),
                "errors": payload.get("errors", self._progress.get("errors", 0)),
                "message": payload.get("message", self._progress.get("message", "")),
                "runtime_backend_target": payload.get(
                    "runtime_backend_target",
                    self._progress.get("runtime_backend_target", ""),
                ),
                "runtime_backend_actual": payload.get(
                    "runtime_backend_actual",
                    self._progress.get("runtime_backend_actual", ""),
                ),
                "runtime_backend_reason": payload.get(
                    "runtime_backend_reason",
                    self._progress.get("runtime_backend_reason", ""),
                ),
                "memory_pressure_warning": payload.get(
                    "memory_pressure_warning",
                    self._progress.get("memory_pressure_warning", ""),
                ),
                "run_id": effective_run_id,
            }
            # Terminal payloads carry last_run_stats (the post-run stats
            # modal's trigger — app.js pops it when GET /api/tag/progress
            # exposes the key). The explicit-key rebuild above used to drop
            # it, so the modal could never fire on the process-isolated
            # pipeline. Carry-forward keeps it alive across same-run
            # straggler payloads; reset_progress clears it for the next run.
            last_run_stats = payload.get("last_run_stats") or previous_last_run_stats
            if last_run_stats:
                self._progress["last_run_stats"] = last_run_stats

    def _drain_worker_queue(self, progress_queue: Any, run_id: int) -> bool:
        """Drain queued worker progress messages. Returns True if a terminal state was seen."""
        saw_terminal_state = False
        while True:
            try:
                payload = progress_queue.get_nowait()
            except queue_module.Empty:
                break
            self._apply_worker_progress(payload, run_id=run_id)
            if payload.get("status") in {"done", "error", "cancelled"}:
                saw_terminal_state = True
        return saw_terminal_state

    def _cleanup_worker_handles(
        self, progress_queue: Any = None, run_id: Optional[int] = None
    ) -> None:
        """Clear worker references and close IPC handles when possible."""
        with self._lock:
            if run_id is None or self._pending_run_id == run_id:
                self._pending_run_id = None
            if run_id is None or run_id == self._active_run_id:
                self._worker_process = None
                self._worker_cancel_event = None
                if self._progress["status"] != "cancelling":
                    self._cancel_requested = False

        if progress_queue is not None:
            close = getattr(progress_queue, "close", None)
            if callable(close):
                close()
            join_thread = getattr(progress_queue, "join_thread", None)
            if callable(join_thread):
                join_thread()
