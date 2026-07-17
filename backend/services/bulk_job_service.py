"""Durable, job-ID-keyed registry for long-running Gallery bulk operations.

This is the shared background-job framework that closes Debt-22 (token-scoped
delete / remove-from-gallery / same-name sidecar export were chunked but still
occupied one synchronous HTTP request on very large libraries).

Design goals:
- Durable job IDs so a client can poll status / cancel by id and list active
  jobs, instead of the per-operation singleton progress endpoints.
- Server-owned state (threading.Lock + dict), following the same
  service-owned-background-state pattern as ``AestheticService`` /
  ``ArtistService`` and the ``TaggingPipelineService`` singleton accessor.
- Generic on purpose: this module never imports image / export logic. Each
  operation builds a ``worker_fn`` (or a chunked snapshot/process pair) in its
  own service and hands it to :meth:`BulkJobService.run_job` via a FastAPI
  ``BackgroundTask``. That keeps the registry reusable and free of circular
  imports (``image_service`` / ``tagging_service`` import *this* module).
"""
from __future__ import annotations

import logging
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterable, List, Optional

from services.service_provider import ServiceProvider


logger = logging.getLogger(__name__)

# The three token-scoped Gallery operations Debt-22 promotes to background jobs.
JOB_KIND_DELETE_FILES = "delete_files"
JOB_KIND_REMOVE_FROM_GALLERY = "remove_from_gallery"
JOB_KIND_EXPORT_SIDECARS = "export_sidecars"
# v3.5.0 Tier 1: whole-library near-duplicate group scan (progress + cancel).
JOB_KIND_DUPLICATE_SCAN = "duplicate_scan"
# v3.5.0 metadata L3: re-parse missing-prompt images from stored raw
# envelopes (or the files themselves) through the current parser.
JOB_KIND_REPARSE_METADATA = "reparse_metadata"
VALID_JOB_KINDS = {
    JOB_KIND_DELETE_FILES,
    JOB_KIND_REMOVE_FROM_GALLERY,
    JOB_KIND_EXPORT_SIDECARS,
    JOB_KIND_DUPLICATE_SCAN,
    JOB_KIND_REPARSE_METADATA,
}

STATUS_QUEUED = "queued"
STATUS_RUNNING = "running"
STATUS_DONE = "done"
STATUS_ERROR = "error"
STATUS_CANCELLED = "cancelled"
TERMINAL_STATUSES = {STATUS_DONE, STATUS_ERROR, STATUS_CANCELLED}

# Bounded error samples so a job over a 100k+ library cannot accumulate an
# unbounded error list in memory or in the polled JSON payload.
MAX_ERROR_SAMPLES = 20
# Default per-chunk size for the chunked worker (matches the 500 the existing
# delete/remove/export DB helpers already use).
DEFAULT_CHUNK_SIZE = 500
# Cap on retained terminal jobs so completed/cancelled jobs are still pollable
# for a while but the registry cannot grow without bound over a long session.
MAX_RETAINED_TERMINAL_JOBS = 50


ProgressCallback = Callable[[Dict[str, Any]], None]
PublishCallback = Callable[[], None]


@dataclass
class _BulkJob:
    """Internal mutable job record. ``cancel_event`` is never serialized."""

    id: str
    kind: str
    status: str = STATUS_QUEUED
    total: int = 0
    processed: int = 0
    error_count: int = 0
    error_samples: List[str] = field(default_factory=list)
    message: str = ""
    result: Dict[str, Any] = field(default_factory=dict)
    created_at: float = field(default_factory=time.time)
    started_at: Optional[float] = None
    finished_at: Optional[float] = None
    cancel_event: threading.Event = field(default_factory=threading.Event)

    def to_public(self) -> Dict[str, Any]:
        """Serializable snapshot for the status endpoint (no cancel_event)."""
        return {
            "id": self.id,
            "job_id": self.id,
            "kind": self.kind,
            "status": self.status,
            "total": self.total,
            "processed": self.processed,
            "error_count": self.error_count,
            "error_samples": list(self.error_samples),
            "message": self.message,
            # Copy list values too: _merge_result extends lists in place, so a
            # shallow dict copy would share them with the mutating worker.
            "result": {
                key: list(value) if isinstance(value, list) else value
                for key, value in self.result.items()
            },
            "created_at": self.created_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
        }


class BulkJobHandle:
    """Thin, worker-facing view of one job.

    Workers use this to report progress, record bounded error samples, and
    accumulate a result payload. They also poll :attr:`cancelled` between
    chunks to stop cooperatively. All mutations go back through the service so
    they are lock-guarded.
    """

    def __init__(self, service: "BulkJobService", job_id: str) -> None:
        self._service = service
        self._job_id = job_id

    @property
    def job_id(self) -> str:
        return self._job_id

    @property
    def cancelled(self) -> bool:
        return self._service._is_cancelled(self._job_id)

    def set_progress(
        self,
        *,
        processed: Optional[int] = None,
        total: Optional[int] = None,
        message: Optional[str] = None,
    ) -> None:
        self._service._update_progress(
            self._job_id, processed=processed, total=total, message=message
        )

    def record_errors(self, count: int, samples: Iterable[str] = ()) -> None:
        self._service._record_errors(self._job_id, count, samples)

    def merge_result(self, delta: Dict[str, Any]) -> None:
        self._service._merge_result(self._job_id, delta)

    def set_result(self, result: Dict[str, Any]) -> None:
        self._service._set_result(self._job_id, result)

    def commit_result(
        self,
        *,
        publish_callback: PublishCallback,
        result: Dict[str, Any],
        processed: int,
        total: int,
        message: str,
    ) -> bool:
        """Publish external state and settle this job at one lock boundary."""
        return self._service._commit_result(
            self._job_id,
            publish_callback=publish_callback,
            result=result,
            processed=processed,
            total=total,
            message=message,
        )


class BulkJobService:
    """Registry + generic execution engine for token-scoped bulk jobs."""

    def __init__(self) -> None:
        self._jobs: Dict[str, _BulkJob] = {}
        self._lock = threading.Lock()

    # ------------------------------------------------------------------
    # Registry / lifecycle
    # ------------------------------------------------------------------
    def create_job(self, kind: str, *, total: int = 0, message: str = "") -> str:
        """Register a new queued job and return its durable id.

        ``total`` is optional: pass it when the resolved id count is already
        known on the request thread so the first status poll reports a real
        denominator instead of 0.
        """
        if kind not in VALID_JOB_KINDS:
            raise ValueError(f"Unknown bulk job kind: {kind}")
        job_id = uuid.uuid4().hex
        with self._lock:
            self._jobs[job_id] = _BulkJob(
                id=job_id, kind=kind, total=int(total or 0), message=message
            )
            self._prune_unlocked()
        return job_id

    def get_job(self, job_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            job = self._jobs.get(job_id)
            return job.to_public() if job is not None else None

    def list_jobs(self, *, active_only: bool = False) -> List[Dict[str, Any]]:
        with self._lock:
            jobs = list(self._jobs.values())
        if active_only:
            jobs = [job for job in jobs if job.status not in TERMINAL_STATUSES]
        jobs.sort(key=lambda job: job.created_at, reverse=True)
        return [job.to_public() for job in jobs]

    def cancel_job(self, job_id: str) -> Optional[Dict[str, Any]]:
        """Cancel queued work or request running work to stop cooperatively."""
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return None
            if job.status == STATUS_QUEUED:
                job.cancel_event.set()
                job.status = STATUS_CANCELLED
                job.finished_at = time.time()
                job.message = "Cancelled before start"
            elif job.status not in TERMINAL_STATUSES:
                job.cancel_event.set()
                job.message = "Cancellation requested"
            return job.to_public()

    def run_job(self, job_id: str, worker_fn: Callable[[BulkJobHandle], None]) -> None:
        """Execute ``worker_fn`` for a job. Intended as a FastAPI BackgroundTask.

        Marks the job running, runs the worker with a :class:`BulkJobHandle`,
        and settles the terminal state (``done`` / ``cancelled`` / ``error``).
        A queued job cancelled before dispatch is already terminal and cannot run.
        """
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return
            if job.status in TERMINAL_STATUSES:
                return
            if job.cancel_event.is_set():
                job.status = STATUS_CANCELLED
                job.finished_at = time.time()
                job.message = "Cancelled before start"
                return
            job.status = STATUS_RUNNING
            job.started_at = time.time()

        handle = BulkJobHandle(self, job_id)
        try:
            worker_fn(handle)
        except Exception as exc:  # noqa: BLE001 — worker faults must not crash the task
            logger.exception("Bulk job %s failed", job_id)
            with self._lock:
                job = self._jobs.get(job_id)
                if job is not None and job.status not in TERMINAL_STATUSES:
                    job.status = STATUS_ERROR
                    job.finished_at = time.time()
                    job.error_count += 1
                    if len(job.error_samples) < MAX_ERROR_SAMPLES:
                        job.error_samples.append(str(exc))
                    job.message = "Job failed due to an internal error"
            return

        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return
            if job.status in TERMINAL_STATUSES:
                return
            if job.cancel_event.is_set():
                job.status = STATUS_CANCELLED
                job.message = job.message or "Cancelled"
            else:
                job.status = STATUS_DONE
                job.message = job.message or "Completed"
            job.finished_at = time.time()

    # ------------------------------------------------------------------
    # Generic chunked worker
    # ------------------------------------------------------------------
    @staticmethod
    def chunked_worker(
        snapshot_fn: Callable[[], Iterable[int]],
        process_chunk_fn: Callable[[List[int]], Dict[str, Any]],
        *,
        chunk_size: int = DEFAULT_CHUNK_SIZE,
    ) -> Callable[[BulkJobHandle], None]:
        """Build a worker that snapshots IDs, then processes them in chunks.

        ``snapshot_fn`` is called once at the start (before any mutation) and
        materializes the full id list server-side, so rows mutated mid-job
        cannot expand the job's scope. ``process_chunk_fn(chunk_ids)`` returns
        ``{"processed": int, "errors": [str...], "result_delta": {...}}``; the
        engine advances progress, records bounded error samples, and merges the
        result deltas. The cancel flag is checked before every chunk.
        """
        size = max(1, int(chunk_size or DEFAULT_CHUNK_SIZE))

        def worker(handle: BulkJobHandle) -> None:
            ids = list(snapshot_fn())
            handle.set_progress(total=len(ids), processed=0)
            processed = 0
            for start in range(0, len(ids), size):
                if handle.cancelled:
                    return
                chunk = ids[start:start + size]
                outcome = process_chunk_fn(chunk) or {}
                errors = outcome.get("errors") or []
                handle.record_errors(len(errors), errors)
                handle.merge_result(outcome.get("result_delta") or {})
                processed += int(outcome.get("processed", len(chunk)))
                handle.set_progress(processed=processed)

        return worker

    # ------------------------------------------------------------------
    # Lock-guarded mutation helpers (called via BulkJobHandle)
    # ------------------------------------------------------------------
    def _is_cancelled(self, job_id: str) -> bool:
        with self._lock:
            job = self._jobs.get(job_id)
            return bool(job is not None and job.cancel_event.is_set())

    def _update_progress(
        self,
        job_id: str,
        *,
        processed: Optional[int] = None,
        total: Optional[int] = None,
        message: Optional[str] = None,
    ) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return
            if total is not None:
                job.total = int(total)
            if processed is not None:
                job.processed = int(processed)
            if message is not None:
                job.message = str(message)

    def _record_errors(self, job_id: str, count: int, samples: Iterable[str]) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return
            job.error_count += int(count or 0)
            for sample in samples or []:
                if len(job.error_samples) >= MAX_ERROR_SAMPLES:
                    break
                job.error_samples.append(str(sample))

    def _merge_result(self, job_id: str, delta: Dict[str, Any]) -> None:
        if not delta:
            return
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return
            for key, value in delta.items():
                existing = job.result.get(key)
                if key not in job.result:
                    job.result[key] = value
                elif _is_number(existing) and _is_number(value):
                    job.result[key] = existing + value
                elif isinstance(existing, list) and isinstance(value, list):
                    existing.extend(value)
                else:
                    job.result[key] = value

    def _set_result(self, job_id: str, result: Dict[str, Any]) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return
            job.result = dict(result or {})

    def _commit_result(
        self,
        job_id: str,
        *,
        publish_callback: PublishCallback,
        result: Dict[str, Any],
        processed: int,
        total: int,
        message: str,
    ) -> bool:
        """Linearize cancellation against one short external-state publish.

        ``publish_callback`` runs while ``_lock`` is held and therefore must
        only perform the already-prepared atomic publish. It must not call a
        handle or this service because the lock is intentionally non-reentrant.
        """
        committed_result = dict(result)
        committed_processed = int(processed)
        committed_total = int(total)
        committed_message = str(message)
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                raise KeyError(
                    f"Bulk job disappeared before result commit: job_id={job_id}"
                )
            if job.cancel_event.is_set() or job.status == STATUS_CANCELLED:
                return False
            if job.status != STATUS_RUNNING:
                raise RuntimeError(
                    "Bulk job result commit requires running status: "
                    f"job_id={job_id}, status={job.status}"
                )
            try:
                publish_callback()
            except Exception as exc:
                job.status = STATUS_ERROR
                job.finished_at = time.time()
                job.error_count += 1
                if len(job.error_samples) < MAX_ERROR_SAMPLES:
                    job.error_samples.append(str(exc))
                job.message = "Result publish failed"
                raise
            job.result = committed_result
            job.processed = committed_processed
            job.total = committed_total
            job.message = committed_message
            job.status = STATUS_DONE
            job.finished_at = time.time()
            return True

    def _prune_unlocked(self) -> None:
        terminal = [job for job in self._jobs.values() if job.status in TERMINAL_STATUSES]
        excess = len(terminal) - MAX_RETAINED_TERMINAL_JOBS
        if excess <= 0:
            return
        terminal.sort(key=lambda job: job.finished_at or job.created_at)
        for job in terminal[:excess]:
            self._jobs.pop(job.id, None)


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


_bulk_job_provider = ServiceProvider(BulkJobService)


def get_bulk_job_service() -> BulkJobService:
    return _bulk_job_provider.get()


def set_bulk_job_service(service: Optional[BulkJobService]) -> None:
    _bulk_job_provider.set(service)
