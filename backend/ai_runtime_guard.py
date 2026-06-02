"""Shared guardrails for heavy local AI runtimes.

The app can load several large models from different routes. Running them at the
same time is the common crash pattern: each individual job looks valid, but their
combined RAM/VRAM pressure can freeze or crash the machine. This module provides
a process-local and cross-process exclusive lease for model load/inference work.
"""
from __future__ import annotations

import logging
import os
import threading
import time
from pathlib import Path
from typing import Any, BinaryIO, Dict, List, Optional

from config import get_temp_dir


logger = logging.getLogger(__name__)

AI_RUNTIME_LOCK_DISABLED = os.environ.get(
    "SD_IMAGE_SORTER_DISABLE_AI_RUNTIME_LOCK",
    "false",
).lower() in {"1", "true", "yes"}

# v3.3.0 PERF-2: tiered AI runtime scheduler.
#
# Two tiers replace the old single global lock:
#   - "vram" (DEFAULT): mutually exclusive across threads AND processes (process
#     RLock + cross-process file lock). This is the original crash-prevention
#     behavior — loading/running several large models at once is the common
#     freeze/crash pattern, so VRAM work stays serialized. Existing callers that
#     pass no tier keep EXACTLY the previous semantics (zero behavior change).
#   - "cpu": a bounded concurrent pool for genuinely CPU-only work, so two CPU
#     jobs (or a CPU job and a VRAM job) can run at once instead of being
#     serialized behind the single global lock. Opt-in via tier="cpu".
#
# Reentrancy is preserved per tier so nested leases on the same thread do not
# deadlock (mirrors the previous _lease_depth behavior).
TIER_VRAM = "vram"
TIER_CPU = "cpu"
_VALID_TIERS = {TIER_VRAM, TIER_CPU}


def _default_cpu_pool_size() -> int:
    raw = os.environ.get("SD_IMAGE_SORTER_AI_CPU_POOL", "").strip()
    if raw:
        try:
            return max(1, int(raw))
        except ValueError:
            logger.debug("Invalid SD_IMAGE_SORTER_AI_CPU_POOL=%r; using default", raw)
    # Leave headroom for the rest of the app; never below 1.
    return max(1, (os.cpu_count() or 2) - 1)


_process_lock = threading.RLock()
_lease_depth = 0

# CPU tier concurrency pool + per-thread reentrancy depth.
_CPU_POOL_SIZE = _default_cpu_pool_size()
_cpu_semaphore = threading.BoundedSemaphore(_CPU_POOL_SIZE)
_cpu_thread_local = threading.local()

# Active-job registry for the optional /api/system/ai-jobs status badge.
_jobs_lock = threading.Lock()
_active_jobs: Dict[int, Dict[str, Any]] = {}
_job_seq = 0


def _register_job(label: str, tier: str) -> int:
    global _job_seq
    with _jobs_lock:
        _job_seq += 1
        job_id = _job_seq
        _active_jobs[job_id] = {
            "label": label,
            "tier": tier,
            "started_at": time.time(),
        }
        return job_id


def _unregister_job(job_id: int) -> None:
    with _jobs_lock:
        _active_jobs.pop(job_id, None)


def get_ai_jobs_snapshot() -> Dict[str, Any]:
    """Return a snapshot of in-flight AI runtime leases for a status badge."""
    now = time.time()
    with _jobs_lock:
        jobs: List[Dict[str, Any]] = [
            {
                "label": info["label"],
                "tier": info["tier"],
                "elapsed_seconds": round(max(0.0, now - info["started_at"]), 1),
            }
            for info in _active_jobs.values()
        ]
    jobs.sort(key=lambda j: j["elapsed_seconds"], reverse=True)
    vram = sum(1 for j in jobs if j["tier"] == TIER_VRAM)
    cpu = sum(1 for j in jobs if j["tier"] == TIER_CPU)
    return {
        "active": len(jobs),
        "vram_active": vram,
        "cpu_active": cpu,
        "cpu_pool_size": _CPU_POOL_SIZE,
        "jobs": jobs,
    }



class AiRuntimeLease:
    """Exclusive (VRAM) or bounded-concurrent (CPU) lease for model work."""

    def __init__(self, label: str, tier: str = TIER_VRAM) -> None:
        self.label = str(label or "ai-runtime")
        self.tier = tier if tier in _VALID_TIERS else TIER_VRAM
        self._handle: Optional[BinaryIO] = None
        self._acquired = False
        self._nested = False
        self._job_id: Optional[int] = None

    def acquire(self) -> "AiRuntimeLease":
        if self._acquired:
            return self
        if self.tier == TIER_CPU:
            return self._acquire_cpu()
        return self._acquire_vram()

    def _acquire_cpu(self) -> "AiRuntimeLease":
        # Per-thread reentrancy: a nested CPU lease on the same thread must not
        # consume a second semaphore slot (would deadlock at pool size 1).
        depth = getattr(_cpu_thread_local, "depth", 0)
        if depth > 0:
            _cpu_thread_local.depth = depth + 1
            self._nested = True
            self._acquired = True
            return self
        _cpu_semaphore.acquire()
        _cpu_thread_local.depth = 1
        self._acquired = True
        self._job_id = _register_job(self.label, TIER_CPU)
        logger.debug("Acquired AI runtime lease (cpu): %s", self.label)
        return self

    def _acquire_vram(self) -> "AiRuntimeLease":
        global _lease_depth

        _process_lock.acquire()
        if _lease_depth > 0:
            _lease_depth += 1
            self._nested = True
            self._acquired = True
            return self

        if AI_RUNTIME_LOCK_DISABLED:
            _lease_depth += 1
            self._acquired = True
            self._job_id = _register_job(self.label, TIER_VRAM)
            return self

        lock_path = Path(get_temp_dir()) / "ai-runtime.lock"
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        handle = lock_path.open("a+b")
        try:
            _lock_file(handle)
            handle.seek(0)
            handle.truncate()
            handle.write(f"pid={os.getpid()} label={self.label}\n".encode("utf-8", errors="ignore"))
            handle.flush()
            os.fsync(handle.fileno())
        except Exception:
            handle.close()
            _process_lock.release()
            raise

        self._handle = handle
        self._acquired = True
        _lease_depth += 1
        self._job_id = _register_job(self.label, TIER_VRAM)
        logger.debug("Acquired AI runtime lease (vram): %s", self.label)
        return self

    def release(self) -> None:
        if not self._acquired:
            return
        if self.tier == TIER_CPU:
            self._release_cpu()
        else:
            self._release_vram()

    def _release_cpu(self) -> None:
        try:
            depth = getattr(_cpu_thread_local, "depth", 1)
            _cpu_thread_local.depth = max(0, depth - 1)
            if self._nested:
                self._nested = False
            else:
                _cpu_semaphore.release()
        finally:
            self._acquired = False
            if self._job_id is not None:
                _unregister_job(self._job_id)
                self._job_id = None
            logger.debug("Released AI runtime lease (cpu): %s", self.label)

    def _release_vram(self) -> None:
        global _lease_depth

        try:
            _lease_depth = max(0, _lease_depth - 1)
            if self._nested:
                self._nested = False
            elif self._handle is not None:
                try:
                    self._handle.seek(0)
                    self._handle.truncate()
                    self._handle.flush()
                    _unlock_file(self._handle)
                finally:
                    self._handle.close()
                    self._handle = None
        finally:
            self._acquired = False
            if self._job_id is not None:
                _unregister_job(self._job_id)
                self._job_id = None
            _process_lock.release()
            logger.debug("Released AI runtime lease (vram): %s", self.label)

    def __enter__(self) -> "AiRuntimeLease":
        return self.acquire()

    def __exit__(self, *_args) -> bool:
        self.release()
        return False


def acquire_ai_runtime(label: str, tier: str = TIER_VRAM) -> AiRuntimeLease:
    """Acquire and return a heavy-runtime lease (default tier = exclusive VRAM)."""
    return AiRuntimeLease(label, tier).acquire()


def exclusive_ai_runtime(label: str, tier: str = TIER_VRAM) -> AiRuntimeLease:
    """Context manager for heavy-runtime work (default tier = exclusive VRAM)."""
    return AiRuntimeLease(label, tier)


def _lock_file(handle: BinaryIO) -> None:
    if os.name == "nt":
        import msvcrt

        handle.seek(0)
        handle.write(b"\0")
        handle.flush()
        handle.seek(0)
        msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
        return

    import fcntl

    fcntl.flock(handle.fileno(), fcntl.LOCK_EX)


def _unlock_file(handle: BinaryIO) -> None:
    if os.name == "nt":
        import msvcrt

        handle.seek(0)
        try:
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        except OSError:
            logger.debug("AI runtime Windows file unlock failed", exc_info=True)
        return

    import fcntl

    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    except OSError:
        logger.debug("AI runtime POSIX file unlock failed", exc_info=True)


def cuda_has_headroom(torch_module, *, min_free_mb: int) -> bool:
    """Return True when CUDA exists and has enough free VRAM for another model."""
    try:
        if not torch_module.cuda.is_available():
            return False
        mem_get_info = getattr(torch_module.cuda, "mem_get_info", None)
        if not callable(mem_get_info):
            return True
        free_bytes, _total_bytes = mem_get_info(0)
        return (free_bytes / (1024 ** 2)) >= min_free_mb
    except Exception as exc:
        logger.debug("CUDA headroom check failed; allowing runtime to decide: %s", exc)
        return True


def clear_torch_cuda_cache(torch_module=None) -> None:
    """Best-effort CUDA cache release without importing torch unless needed."""
    try:
        if torch_module is None:
            import torch as torch_module  # type: ignore
        if torch_module.cuda.is_available():
            torch_module.cuda.empty_cache()
    except Exception:
        logger.debug("CUDA cache clear failed", exc_info=True)


def looks_like_cuda_oom(exc: BaseException) -> bool:
    message = str(exc).lower()
    return any(
        token in message
        for token in (
            "cuda out of memory",
            "cublas_status_alloc_failed",
            "cudnn_status_alloc_failed",
            "failed to allocate memory",
            "out of memory",
        )
    )
