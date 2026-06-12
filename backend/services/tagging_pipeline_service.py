"""Unified backend boundary for AI tagging entry points.

The regular Gallery AI Tag job, the Dataset Smart Tag job, and the VLM
caption batch keep their specialized execution adapters, but public route
starts/cancels/progress go through this coordinator so the app cannot run
two heavyweight tagging jobs at the same time.

v3.4.1 (Debt-16, TODO #19): a start request that arrives while another AI
job runs is no longer rejected with 409. It is appended to an in-memory
FIFO queue and auto-started by a background dispatcher thread when the
running job finishes (success, error, or cancel all release the busy
probes the dispatcher polls). Contract notes:

- The queue lives in this process only. It does NOT survive a backend
  restart (consistent with all other in-memory job state in this app).
- There is intentionally NO queue depth cap.
- Exact-duplicate *consecutive* enqueues of the same kind+payload collapse
  into the existing queued entry (response carries ``duplicate: true``).
- A queued job that fails to start is dropped so the queue never wedges;
  its error is recorded per kind and surfaced through the kind's progress
  endpoint under ``pipeline_queue.last_start_error``.
- Cancel mechanism: each job kind's existing cancel endpoint also removes
  that kind's queued entries (`removed_queued` in the response).
- Fail-closed probing is preserved: if a sibling job's status is
  unknowable at *start* time the request is refused exactly as before
  (409 / RuntimeError), and at *dispatch* time the queue simply waits.
"""

from __future__ import annotations

import json
import logging
import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Tuple, TYPE_CHECKING

from fastapi import HTTPException

from services import smart_tag_service
from services.service_provider import ServiceProvider

if TYPE_CHECKING:  # pragma: no cover - imported for type checkers only
    import asyncio

    from services.tagging_service import TagRequest, TaggingService


logger = logging.getLogger(__name__)

PIPELINE_OWNER = "unified-tagging"
LEGACY_ACTIVE_STATUSES = {"running", "cancelling"}
SMART_ACTIVE_STATUSES = {"queued", "running"}

# Queue job kinds (also used as the ``pipeline_mode`` value in responses).
KIND_GALLERY = "gallery-tag"
KIND_SMART = "smart-tag"
KIND_VLM = "vlm-caption-batch"

# Exact busy detail raised by TaggingService.start_tagging when a live
# worker is already running. Matching it lets the coordinator convert the
# legacy same-kind 409 into a queued entry while still propagating
# validation 409s (e.g. hardware-floor rejections) unchanged.
LEGACY_SELF_BUSY_DETAIL = "Tagging already in progress"

# Probe states. "unknown" means the status could not be determined; starts
# fail closed on it and the dispatcher waits instead of starting anything.
_PROBE_IDLE = "idle"
_PROBE_BUSY = "busy"
_PROBE_UNKNOWN = "unknown"

QUEUED_MESSAGE = (
    "Queued — starts automatically after the current AI job finishes. "
    "已加入队列，当前 AI 任务完成后自动开始。"
)
DUPLICATE_QUEUED_MESSAGE = (
    "An identical job is already queued; not adding it twice. "
    "相同任务已在队列中，未重复添加。"
)

# Held across every check+start path (gallery AI Tag / Smart Tag / VLM
# caption batch) AND every queue mutation. Each underlying service keeps its
# own state lock, but those are independent, so without one shared start
# lock two simultaneous starts could each pass their cross-service checks
# (TOCTOU) and double-load multi-GB models onto the GPU.
_start_lock = threading.Lock()


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def _exception_detail(exc: BaseException) -> str:
    detail = getattr(exc, "detail", None)
    if detail:
        return str(detail)
    return str(exc) or exc.__class__.__name__


def _with_owner(payload: Dict[str, Any], mode: str) -> Dict[str, Any]:
    out = dict(payload or {})
    out["pipeline_owner"] = PIPELINE_OWNER
    out["pipeline_mode"] = mode
    return out


def _probe_legacy(legacy_service: Optional["TaggingService"], *, target: str) -> Tuple[str, str]:
    """Probe the gallery AI Tag job. Returns (state, message).

    If the status probe itself fails the state is "unknown": silently
    assuming "idle" could double-start two GPU tagging jobs.
    """
    if legacy_service is None:
        return (_PROBE_IDLE, "")
    try:
        status = str((legacy_service.get_progress() or {}).get("status") or "idle").lower()
    except Exception:
        logger.exception("Could not determine AI Tag status; refusing to start %s", target)
        return (
            _PROBE_UNKNOWN,
            f"Could not determine AI Tag status, so {target} was not started "
            "to avoid running two tagging jobs at once. "
            "无法确认 AI 打标状态，已拒绝启动以避免同时运行两个打标任务。",
        )
    if status in LEGACY_ACTIVE_STATUSES:
        return (_PROBE_BUSY, f"AI Tag is already running; {target} was queued behind it.")
    return (_PROBE_IDLE, "")


def _active_smart_job():
    try:
        job = smart_tag_service.get_active_job()
    except Exception:
        return None
    if job is None:
        return None
    status = str(getattr(job, "status", "") or "").lower()
    return job if status in SMART_ACTIVE_STATUSES else None


def _probe_smart(target: str) -> Tuple[str, str]:
    """Probe the Smart Tag job. Returns (state, message)."""
    active_smart = _active_smart_job()
    if active_smart is None:
        return (_PROBE_IDLE, "")
    job_id = str(getattr(active_smart, "job_id", "") or "").strip()
    suffix = f" ({job_id})" if job_id else ""
    return (_PROBE_BUSY, f"Smart Tag is already running{suffix}; {target} was queued behind it.")


def _probe_vlm() -> Tuple[str, str]:
    """Probe the VLM caption batch. Returns (state, message).

    Queries the vlm router through its narrow ``is_caption_batch_active``
    accessor instead of reaching into router internals. A failed probe
    reports "unknown" (same fail-closed direction as ``_probe_legacy``).
    """
    try:
        from routers.vlm import is_caption_batch_active

        active = bool(is_caption_batch_active())
    except Exception:
        logger.exception("Could not determine VLM caption batch status; refusing to start")
        return (
            _PROBE_UNKNOWN,
            "Could not determine VLM captioning status, so the job was not "
            "started to avoid running two tagging jobs at once. "
            "无法确认 VLM 批量打标状态，已拒绝启动以避免同时运行两个打标任务。",
        )
    if active:
        return (_PROBE_BUSY, "VLM captioning is already running; the new job was queued behind it.")
    return (_PROBE_IDLE, "")


def _fingerprint(kind: str, payload: Any) -> str:
    """Stable identity for trivially-detectable duplicate enqueues."""
    try:
        data = payload.model_dump() if hasattr(payload, "model_dump") else payload
        return f"{kind}:{json.dumps(data, sort_keys=True, default=str)}"
    except Exception:
        # Unfingerprintable payloads never collapse as duplicates.
        return ""


class _ThreadLaunchBackgroundTasks:
    """Duck-typed stand-in for ``fastapi.BackgroundTasks`` at dispatch time.

    A queued gallery job starts long after its original HTTP request
    finished, so the request's BackgroundTasks object is gone.
    ``TaggingService.start_tagging`` only calls ``add_task(fn, *args)``;
    running the job in a daemon thread matches how Starlette executes sync
    background tasks (off the event loop).
    """

    def add_task(self, func: Callable[..., Any], *args: Any, **kwargs: Any) -> None:
        threading.Thread(
            target=func,
            args=args,
            kwargs=kwargs,
            name="queued-gallery-tag-job",
            daemon=True,
        ).start()


@dataclass
class _QueuedPipelineJob:
    queue_id: str
    kind: str
    payload: Any
    legacy_service: Any = None
    loop: Any = None
    fingerprint: str = ""
    enqueued_at: str = field(default_factory=_utc_now_iso)


def _start_queued_vlm_batch(entry: _QueuedPipelineJob) -> None:
    """Claim the VLM batch slot and schedule the queued batch start.

    Module-level (not a method) so tests can monkeypatch it. Runs on the
    dispatcher thread under ``_start_lock``; the actual source resolution +
    batch task happen asynchronously on the server event loop captured at
    enqueue time.
    """
    from routers import vlm

    vlm.claim_caption_batch_slot()
    try:
        vlm.start_caption_batch_from_queue(entry.payload, entry.loop)
    except BaseException:
        vlm.release_caption_batch_slot()
        raise


class TaggingPipelineService:
    """Coordinator shared by `/api/tag/*`, `/api/smart-tag/*`, and `/api/vlm/caption-batch`."""

    def __init__(self, *, poll_interval: float = 1.0, auto_dispatch: bool = True) -> None:
        # FIFO queue of jobs waiting for the AI runtime. In-memory only —
        # it does not survive a backend restart.
        self._queue: List[_QueuedPipelineJob] = []
        self._queue_seq = 0
        self._poll_interval = max(0.01, float(poll_interval))
        # auto_dispatch=False lets tests drive dispatch deterministically
        # via dispatch_pending_once() without a background thread.
        self._auto_dispatch = bool(auto_dispatch)
        self._dispatcher_thread: Optional[threading.Thread] = None
        self._dispatcher_wake = threading.Event()
        # Latest failed-to-start error per kind; cleared by the next
        # successful start of that kind. Surfaced via queue_snapshot().
        self._last_start_errors: Dict[str, Dict[str, Any]] = {}

    # ------------------------------------------------------------------
    # Start paths
    # ------------------------------------------------------------------

    def start_gallery_tagging(
        self,
        request: "TagRequest",
        background_tasks: Any,
        *,
        legacy_service: "TaggingService",
    ) -> Dict[str, Any]:
        with _start_lock:
            smart_state, _smart_msg = _probe_smart("AI Tag")
            vlm_state, vlm_msg = _probe_vlm()
            if vlm_state == _PROBE_UNKNOWN:
                # Fail closed: an unknowable sibling status refuses the
                # start instead of queueing behind a phantom job.
                raise HTTPException(status_code=409, detail=vlm_msg)
            if smart_state == _PROBE_BUSY or vlm_state == _PROBE_BUSY:
                return self._enqueue_locked(
                    kind=KIND_GALLERY, payload=request, legacy_service=legacy_service
                )
            try:
                out = _with_owner(
                    legacy_service.start_tagging(request, background_tasks),
                    KIND_GALLERY,
                )
            except HTTPException as exc:
                # Same-kind busy: the legacy service still raises its own
                # 409 after checking that the worker is truly alive (it
                # recovers stale states itself). Convert exactly that busy
                # answer into a queued entry; validation 409s propagate.
                if exc.status_code == 409 and str(exc.detail) == LEGACY_SELF_BUSY_DETAIL:
                    return self._enqueue_locked(
                        kind=KIND_GALLERY, payload=request, legacy_service=legacy_service
                    )
                raise
            self._last_start_errors.pop(KIND_GALLERY, None)
            return out

    def start_smart_tagging(
        self,
        payload: Dict[str, Any],
        *,
        legacy_service: Optional["TaggingService"] = None,
    ) -> Dict[str, Any]:
        with _start_lock:
            legacy_state, legacy_msg = _probe_legacy(legacy_service, target="Smart Tag")
            if legacy_state == _PROBE_UNKNOWN:
                raise RuntimeError(legacy_msg)
            vlm_state, vlm_msg = _probe_vlm()
            if vlm_state == _PROBE_UNKNOWN:
                raise RuntimeError(vlm_msg)
            smart_state, _ = _probe_smart("Smart Tag")
            if _PROBE_BUSY in (legacy_state, vlm_state, smart_state):
                return self._enqueue_locked(
                    kind=KIND_SMART,
                    payload=dict(payload or {}),
                    legacy_service=legacy_service,
                )
            out = _with_owner(smart_tag_service.start_smart_tag_job(payload), KIND_SMART)
            self._last_start_errors.pop(KIND_SMART, None)
            return out

    def start_vlm_caption_batch(
        self,
        claim: Callable[[], None],
        *,
        payload: Dict[str, Any],
        loop: Optional["asyncio.AbstractEventLoop"] = None,
        legacy_service: Optional["TaggingService"] = None,
    ) -> Optional[Dict[str, Any]]:
        """Claim the VLM batch slot now, or queue the batch if the AI runtime is busy.

        ``claim`` is the vlm router's own check-and-set: it raises
        HTTPException(409) if a caption batch is already running and
        otherwise marks the batch state as running. Running it under the
        shared start lock means a Smart Tag or AI Tag start can never
        interleave between these checks and the claim.

        Returns ``None`` when the slot was claimed (the caller proceeds to
        resolve the image source and launch the batch) or the queued
        response payload when the batch was enqueued. ``loop`` is the
        server event loop captured by the route handler; the queued start
        is scheduled onto it at dispatch time.
        """
        with _start_lock:
            smart_state, _smart_msg = _probe_smart("VLM captioning")
            legacy_state, legacy_msg = _probe_legacy(legacy_service, target="VLM captioning")
            if legacy_state == _PROBE_UNKNOWN:
                raise HTTPException(status_code=409, detail=legacy_msg)
            vlm_state, vlm_msg = _probe_vlm()
            if vlm_state == _PROBE_UNKNOWN:
                raise HTTPException(status_code=409, detail=vlm_msg)
            if _PROBE_BUSY in (smart_state, legacy_state, vlm_state):
                return self._enqueue_locked(
                    kind=KIND_VLM,
                    payload=dict(payload or {}),
                    legacy_service=legacy_service,
                    loop=loop,
                )
            claim()
            self._last_start_errors.pop(KIND_VLM, None)
            return None

    # ------------------------------------------------------------------
    # Progress / cancel paths
    # ------------------------------------------------------------------

    def get_gallery_progress(self, *, legacy_service: "TaggingService") -> Dict[str, Any]:
        # Read the queue BEFORE the live status: if the dispatcher starts a
        # queued job between the two reads, the response shows a live
        # status with an already-empty queue (harmless) instead of
        # "idle + empty queue" for a job that is actually starting.
        queue_info = self.queue_snapshot(KIND_GALLERY)
        payload = _with_owner(legacy_service.get_progress(), KIND_GALLERY)
        payload["pipeline_queue"] = queue_info
        return payload

    def cancel_gallery_tagging(self, *, legacy_service: "TaggingService") -> Dict[str, Any]:
        removed = self.remove_queued_jobs(KIND_GALLERY)
        out = _with_owner(legacy_service.cancel_tagging(), KIND_GALLERY)
        out["removed_queued"] = removed
        return out

    def get_smart_tag_progress(self, job_id: Optional[str] = None) -> Dict[str, Any]:
        queue_info = self.queue_snapshot(KIND_SMART)  # before status; see get_gallery_progress
        job = smart_tag_service.get_job(job_id) if job_id else smart_tag_service.get_active_job()
        if job is None:
            snapshot: Dict[str, Any] = {"status": "idle", "active": False}
        else:
            snapshot = job.snapshot()
            snapshot["active"] = job.status in SMART_ACTIVE_STATUSES
        out = _with_owner(snapshot, KIND_SMART)
        out["pipeline_queue"] = queue_info
        return out

    def cancel_smart_tagging(self) -> Dict[str, Any]:
        removed = self.remove_queued_jobs(KIND_SMART)
        job = smart_tag_service.cancel_active_job()
        if job is None:
            if removed > 0:
                return _with_owner(
                    {
                        "status": "queue_cleared",
                        "removed_queued": removed,
                        "cancel_requested": False,
                    },
                    KIND_SMART,
                )
            raise HTTPException(status_code=404, detail="No active Smart Tag job to cancel.")
        out = _with_owner(
            {"job_id": job.job_id, "status": job.status, "cancel_requested": True},
            KIND_SMART,
        )
        out["removed_queued"] = removed
        return out

    # ------------------------------------------------------------------
    # Queue management
    # ------------------------------------------------------------------

    def queue_snapshot(self, kind: Optional[str] = None) -> Dict[str, Any]:
        """Queue state for progress endpoints.

        ``position`` is 1-based across the WHOLE queue (all kinds), so the
        UI can show the true FIFO wait order. ``queued`` lists only the
        requested kind's entries when ``kind`` is given.
        """
        with _start_lock:
            entries = []
            for index, item in enumerate(self._queue):
                if kind is not None and item.kind != kind:
                    continue
                entries.append(
                    {
                        "queue_id": item.queue_id,
                        "kind": item.kind,
                        "position": index + 1,
                        "enqueued_at": item.enqueued_at,
                    }
                )
            last_error: Any
            if kind is None:
                last_error = dict(self._last_start_errors) or None
            else:
                last_error = self._last_start_errors.get(kind)
            return {
                "total_queued": len(self._queue),
                "queued": entries,
                "last_start_error": last_error,
            }

    def remove_queued_jobs(self, kind: str) -> int:
        """Drop every queued entry of ``kind`` (queued-job cancellation)."""
        with _start_lock:
            before = len(self._queue)
            self._queue = [entry for entry in self._queue if entry.kind != kind]
            removed = before - len(self._queue)
        if removed:
            logger.info("Removed %d queued %s job(s)", removed, kind)
        return removed

    def dispatch_pending_once(self) -> bool:
        """Start the head queued job if every AI job kind is idle.

        Returns True when the queue changed (a job started, or a job that
        failed to start was dropped). The background dispatcher thread
        calls this in a poll loop; tests call it directly for
        deterministic lifecycle coverage.
        """
        with _start_lock:
            if not self._queue:
                return False
            head = self._queue[0]
            if self._runtime_busy_or_unknown(head.legacy_service):
                return False
            entry = self._queue.pop(0)
            try:
                self._start_queued_entry(entry)
            except BaseException as exc:  # noqa: BLE001 — a failed start must never wedge the queue
                detail = _exception_detail(exc)
                logger.exception(
                    "Queued %s job %s failed to start; continuing with the next queued job",
                    entry.kind,
                    entry.queue_id,
                )
                self._last_start_errors[entry.kind] = {
                    "kind": entry.kind,
                    "queue_id": entry.queue_id,
                    "error": detail,
                    "at": _utc_now_iso(),
                }
            else:
                logger.info("Queued %s job %s auto-started", entry.kind, entry.queue_id)
                self._last_start_errors.pop(entry.kind, None)
            return True

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _runtime_busy_or_unknown(self, legacy_service: Any) -> bool:
        states = (
            _probe_legacy(legacy_service, target="the queued job")[0],
            _probe_smart("the queued job")[0],
            _probe_vlm()[0],
        )
        return any(state != _PROBE_IDLE for state in states)

    def _start_queued_entry(self, entry: _QueuedPipelineJob) -> None:
        if entry.kind == KIND_GALLERY:
            if entry.legacy_service is None:
                raise RuntimeError("Gallery tagging service unavailable for the queued start")
            entry.legacy_service.start_tagging(entry.payload, _ThreadLaunchBackgroundTasks())
        elif entry.kind == KIND_SMART:
            smart_tag_service.start_smart_tag_job(entry.payload)
        elif entry.kind == KIND_VLM:
            _start_queued_vlm_batch(entry)
        else:  # pragma: no cover - defensive
            raise RuntimeError(f"Unknown queued job kind: {entry.kind}")

    def _enqueue_locked(
        self,
        *,
        kind: str,
        payload: Any,
        legacy_service: Any = None,
        loop: Any = None,
    ) -> Dict[str, Any]:
        fingerprint = _fingerprint(kind, payload)
        if fingerprint and self._queue and self._queue[-1].fingerprint == fingerprint:
            last = self._queue[-1]
            return _with_owner(
                {
                    "status": "queued",
                    "pipeline_queued": True,
                    "duplicate": True,
                    "queue_id": last.queue_id,
                    "queue_position": len(self._queue),
                    "queue_length": len(self._queue),
                    "message": DUPLICATE_QUEUED_MESSAGE,
                },
                kind,
            )
        self._queue_seq += 1
        entry = _QueuedPipelineJob(
            queue_id=f"q{self._queue_seq}",
            kind=kind,
            payload=payload,
            legacy_service=legacy_service,
            loop=loop,
            fingerprint=fingerprint,
        )
        self._queue.append(entry)
        position = len(self._queue)
        self._ensure_dispatcher_locked()
        logger.info("Queued %s job %s at position %d", kind, entry.queue_id, position)
        return _with_owner(
            {
                "status": "queued",
                "pipeline_queued": True,
                "queue_id": entry.queue_id,
                "queue_position": position,
                "queue_length": position,
                "message": QUEUED_MESSAGE,
            },
            kind,
        )

    def _ensure_dispatcher_locked(self) -> None:
        """Start (or wake) the dispatcher thread. Caller holds ``_start_lock``."""
        if not self._auto_dispatch:
            return
        thread = self._dispatcher_thread
        if thread is not None and thread.is_alive():
            self._dispatcher_wake.set()
            return
        thread = threading.Thread(
            target=self._dispatcher_loop,
            name="tagging-pipeline-queue",
            daemon=True,
        )
        self._dispatcher_thread = thread
        thread.start()

    def _dispatcher_loop(self) -> None:
        """Poll-based queue drainer.

        Polling (instead of completion hooks inside the three services)
        keeps the dispatch logic robust against every terminal path —
        success, error, cancel, and even crashed workers that an internal
        hook would have missed. The thread exits when the queue empties
        and is restarted by the next enqueue; both transitions happen
        under ``_start_lock`` so no enqueue can be stranded without a
        dispatcher.
        """
        while True:
            with _start_lock:
                if not self._queue:
                    if self._dispatcher_thread is threading.current_thread():
                        self._dispatcher_thread = None
                    return
            try:
                progressed = self.dispatch_pending_once()
            except Exception:  # pragma: no cover - dispatch_pending_once already guards
                logger.exception("Tagging pipeline dispatcher iteration failed")
                progressed = False
            if progressed:
                continue
            self._dispatcher_wake.clear()
            self._dispatcher_wake.wait(self._poll_interval)


_tagging_pipeline_provider = ServiceProvider(TaggingPipelineService)


def get_tagging_pipeline_service() -> TaggingPipelineService:
    return _tagging_pipeline_provider.get()


def set_tagging_pipeline_service(service: Optional[TaggingPipelineService]) -> None:
    _tagging_pipeline_provider.set(service)
