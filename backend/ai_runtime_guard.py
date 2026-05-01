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
from pathlib import Path
from typing import BinaryIO, Optional

from config import get_temp_dir


logger = logging.getLogger(__name__)

AI_RUNTIME_LOCK_DISABLED = os.environ.get(
    "SD_IMAGE_SORTER_DISABLE_AI_RUNTIME_LOCK",
    "false",
).lower() in {"1", "true", "yes"}


_process_lock = threading.RLock()
_lease_depth = 0


class AiRuntimeLease:
    """Exclusive lease for heavy model load/inference sections."""

    def __init__(self, label: str) -> None:
        self.label = str(label or "ai-runtime")
        self._handle: Optional[BinaryIO] = None
        self._acquired = False
        self._nested = False

    def acquire(self) -> "AiRuntimeLease":
        if self._acquired:
            return self

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
        logger.debug("Acquired AI runtime lease: %s", self.label)
        return self

    def release(self) -> None:
        if not self._acquired:
            return

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
            _process_lock.release()
            logger.debug("Released AI runtime lease: %s", self.label)

    def __enter__(self) -> "AiRuntimeLease":
        return self.acquire()

    def __exit__(self, *_args) -> bool:
        self.release()
        return False


def acquire_ai_runtime(label: str) -> AiRuntimeLease:
    """Acquire and return an exclusive heavy-runtime lease."""
    return AiRuntimeLease(label).acquire()


def exclusive_ai_runtime(label: str) -> AiRuntimeLease:
    """Context manager for exclusive heavy-runtime work."""
    return AiRuntimeLease(label)


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
