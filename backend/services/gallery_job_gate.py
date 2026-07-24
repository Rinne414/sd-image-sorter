"""Shared transition gate for Gallery-index jobs and destructive clearing."""

from contextlib import contextmanager
import threading
from typing import Iterator


_gallery_job_transition_lock = threading.Lock()
_gallery_job_activity_lock = threading.Lock()
_gallery_job_activity_counts: dict[str, int] = {}


@contextmanager
def gallery_job_transition() -> Iterator[None]:
    """Serialize job state claims with Clear Gallery validation and deletion."""
    with _gallery_job_transition_lock:
        yield


def _register_gallery_job_activity(job: str) -> None:
    if not isinstance(job, str) or not job:
        raise ValueError("Gallery job activity name must be a non-empty string")
    with _gallery_job_activity_lock:
        _gallery_job_activity_counts[job] = (
            _gallery_job_activity_counts.get(job, 0) + 1
        )


def _release_gallery_job_activity(job: str) -> None:
    with _gallery_job_activity_lock:
        count = _gallery_job_activity_counts.get(job)
        if count is None:
            raise RuntimeError(f"Gallery job activity was not registered: {job}")
        if count == 1:
            del _gallery_job_activity_counts[job]
        else:
            _gallery_job_activity_counts[job] = count - 1


@contextmanager
def gallery_job_activity(job: str) -> Iterator[None]:
    """Register a bounded route activity before it can read Gallery state."""
    with gallery_job_transition():
        _register_gallery_job_activity(job)
    try:
        yield
    finally:
        _release_gallery_job_activity(job)


def get_gallery_job_activity() -> tuple[str, ...]:
    """Return active bounded route jobs in deterministic registration order."""
    with _gallery_job_activity_lock:
        return tuple(_gallery_job_activity_counts)
