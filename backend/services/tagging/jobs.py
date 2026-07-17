"""Tagging job supervision: worker-process lifecycle and start_tagging.

Moved verbatim from services/tagging_service.py (decomposition 2026-07).
"""

import logging
import multiprocessing
import queue as queue_module
import time
from typing import Dict, Optional

from fastapi import BackgroundTasks, HTTPException

from config import TAGGER_MODELS
from services.tagging.progress import _build_tag_progress_state
from services.tagging.request import TagRequest
from services.tagging.runtime_plan import TORIIGATE_LOAD_HEARTBEAT_SECONDS
from services.tagging.worker import _tagging_worker_main

# NOTE(decomposition): keep the historical logger channel so log routing
# and output stay byte-identical after the services/tagging split.
logger = logging.getLogger("services.tagging_service")


def _close_setup_progress_queue(progress_queue: object, run_id: int) -> None:
    """Close setup-time queue resources without replacing the setup failure."""
    for operation_name in ("close", "join_thread"):
        operation = getattr(progress_queue, operation_name, None)
        if not callable(operation):
            continue
        try:
            operation()
        except Exception as error:
            logger.warning(
                "Tagging worker setup progress-queue cleanup failed.",
                extra={
                    "run_id": run_id,
                    "cleanup_operation": operation_name,
                    "error_type": type(error).__name__,
                    "cleanup_error": str(error),
                },
            )


class JobsMixin:
    """Job-supervision slice of TaggingService (assembled in services.tagging.service)."""

    def _run_tagging_job(
        self, request: TagRequest, run_id: Optional[int] = None
    ) -> None:
        """Run a tagging job in an isolated worker process and mirror progress back to the API."""
        if run_id is None:
            with self._lock:
                if self._active_run_id <= 0:
                    self._active_run_id = 1
                run_id = self._active_run_id

        with self._lock:
            if run_id != self._active_run_id:
                return

        progress_queue = None
        setup_stage = "building the runtime plan"
        try:
            runtime_plan = self._build_runtime_plan(request)
            setup_stage = "creating the multiprocessing context"
            ctx = multiprocessing.get_context("spawn")
            setup_stage = "creating the worker progress queue"
            progress_queue = ctx.Queue()
            setup_stage = "creating the worker cancellation event"
            cancel_event = ctx.Event()
            setup_stage = "constructing the worker process"
            worker_process = ctx.Process(
                target=_tagging_worker_main,
                args=(runtime_plan, progress_queue, cancel_event),
                daemon=True,
            )
        except Exception as error:
            error_detail = str(error).strip() or type(error).__name__
            current_state = self.get_progress()
            self._apply_worker_progress(
                _build_tag_progress_state(
                    "error",
                    current=current_state.get("processed", 0),
                    total=current_state.get("total", 0),
                    tagged=current_state.get("tagged", 0),
                    errors=current_state.get("errors", 0),
                    message=(
                        f"Tagging worker setup failed while {setup_stage}: {error_detail}. "
                        "The run did not start. Check available system resources and "
                        "the backend log, then start tagging again."
                    ),
                    run_id=run_id,
                ),
                run_id=run_id,
            )
            if progress_queue is not None:
                _close_setup_progress_queue(progress_queue, run_id)
            logger.error(
                "Tagging worker setup failed.",
                extra={
                    "run_id": run_id,
                    "setup_stage": setup_stage,
                    "error_type": type(error).__name__,
                    "setup_error": error_detail,
                },
                exc_info=(type(error), error, error.__traceback__),
            )
            return

        should_abort = False
        with self._lock:
            if run_id != self._active_run_id:
                should_abort = True
            else:
                self._progress = _build_tag_progress_state(
                    "running", message="Preparing tagger...", run_id=run_id
                )
                self._worker_process = worker_process
                self._worker_cancel_event = cancel_event
                self._cancel_requested = False

        if should_abort:
            self._cleanup_worker_handles(progress_queue, run_id=run_id)
            return

        saw_terminal_state = False
        last_worker_message_at = time.monotonic()
        last_loading_heartbeat_at = last_worker_message_at
        model_name = str(runtime_plan.get("model_name") or "")
        runtime_backend = str(
            TAGGER_MODELS.get(model_name, {}).get("runtime_backend", "wd14")
        ).lower()

        try:
            worker_process.start()
            while True:
                if self._cancel_requested:
                    cancel_event.set()

                try:
                    payload = progress_queue.get(timeout=0.25)
                    self._apply_worker_progress(payload, run_id=run_id)
                    last_worker_message_at = time.monotonic()
                    if payload.get("status") in {"done", "error", "cancelled"}:
                        saw_terminal_state = True
                except queue_module.Empty:
                    pass

                now = time.monotonic()
                if (
                    worker_process.is_alive()
                    and runtime_backend == "toriigate"
                    and (now - last_worker_message_at)
                    >= TORIIGATE_LOAD_HEARTBEAT_SECONDS
                    and (now - last_loading_heartbeat_at)
                    >= TORIIGATE_LOAD_HEARTBEAT_SECONDS
                ):
                    current_state = self.get_progress()
                    if (
                        current_state.get("status") == "running"
                        and int(current_state.get("current", 0) or 0) == 0
                        and int(current_state.get("total", 0) or 0) == 0
                    ):
                        elapsed_seconds = int(max(1, now - last_worker_message_at))
                        self._apply_worker_progress(
                            _build_tag_progress_state(
                                "running",
                                current=0,
                                total=0,
                                tagged=current_state.get("tagged", 0),
                                errors=current_state.get("errors", 0),
                                message=(
                                    "ToriiGate is still loading. "
                                    f"Elapsed {elapsed_seconds}s. This stage can use a lot of RAM/VRAM before the first image starts."
                                ),
                                runtime_backend_target=current_state.get(
                                    "runtime_backend_target", ""
                                ),
                                runtime_backend_actual=current_state.get(
                                    "runtime_backend_actual", ""
                                ),
                                runtime_backend_reason=current_state.get(
                                    "runtime_backend_reason", ""
                                ),
                                memory_pressure_warning=current_state.get(
                                    "memory_pressure_warning", ""
                                ),
                                run_id=run_id,
                            ),
                            run_id=run_id,
                        )
                        last_loading_heartbeat_at = now

                if not worker_process.is_alive():
                    saw_terminal_state = (
                        self._drain_worker_queue(progress_queue, run_id=run_id)
                        or saw_terminal_state
                    )
                    break

                if saw_terminal_state:
                    worker_process.join(timeout=2.0)
                    saw_terminal_state = (
                        self._drain_worker_queue(progress_queue, run_id=run_id)
                        or saw_terminal_state
                    )
                    if not worker_process.is_alive():
                        break

            worker_process.join(timeout=1.0)

            if not saw_terminal_state:
                current_state = self.get_progress()
                if self._cancel_requested:
                    self._apply_worker_progress(
                        _build_tag_progress_state(
                            "cancelled",
                            current=current_state.get("processed", 0),
                            total=current_state.get("total", 0),
                            tagged=current_state.get("tagged", 0),
                            errors=current_state.get("errors", 0),
                            message="Tagging worker stopped during cancellation.",
                            run_id=run_id,
                        ),
                        run_id=run_id,
                    )
                else:
                    self._apply_worker_progress(
                        _build_tag_progress_state(
                            "error",
                            current=current_state.get("processed", 0),
                            total=current_state.get("total", 0),
                            tagged=current_state.get("tagged", 0),
                            errors=current_state.get("errors", 0),
                            message="Tagger worker crashed unexpectedly. The app stayed alive, but this tagging run was stopped.",
                            run_id=run_id,
                        ),
                        run_id=run_id,
                    )
        except Exception as error:
            current_state = self.get_progress()
            self._apply_worker_progress(
                _build_tag_progress_state(
                    "error",
                    current=current_state.get("processed", 0),
                    total=current_state.get("total", 0),
                    tagged=current_state.get("tagged", 0),
                    errors=current_state.get("errors", 0),
                    message=f"Error monitoring tagging worker: {error}",
                    run_id=run_id,
                ),
                run_id=run_id,
            )
        finally:
            self._cleanup_worker_handles(progress_queue, run_id=run_id)

    def start_tagging(
        self, request: TagRequest, background_tasks: BackgroundTasks
    ) -> Dict[str, str]:
        """Start tagging images with WD14 tagger."""
        self._validate_tag_request(request)

        if self._get_tagger is None:
            raise HTTPException(status_code=500, detail="Tagger not initialized")

        with self._lock:
            if self._progress["status"] in {"running", "cancelling"}:
                worker_alive = bool(
                    self._worker_process and self._worker_process.is_alive()
                )
                if worker_alive:
                    # 409 Conflict, matching the smart-tag and VLM-batch busy
                    # responses (400 stays reserved for invalid requests).
                    raise HTTPException(
                        status_code=409, detail="Tagging already in progress"
                    )
                logger.warning(
                    "Recovering from stale tagging state %r with no live worker; allowing a fresh start.",
                    self._progress["status"],
                )
                self._worker_process = None
                self._worker_cancel_event = None
                self._cancel_requested = False

            self._active_run_id += 1
            run_id = self._active_run_id
            self._progress = _build_tag_progress_state(
                "running", message="Preparing tagger...", run_id=run_id
            )
        background_tasks.add_task(self._run_tagging_job, request, run_id)
        return {"status": "started", "message": "Tagging started in background"}
