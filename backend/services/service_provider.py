"""Small lazy-service holder for FastAPI router dependencies."""

from __future__ import annotations

from collections.abc import Callable
from threading import RLock
from typing import Generic, TypeVar


T = TypeVar("T")


class ServiceProvider(Generic[T]):
    """Thread-safe lazy service provider with optional state binding hook."""

    def __init__(
        self,
        factory: Callable[[], T],
        *,
        on_set: Callable[[T], None] | None = None,
    ) -> None:
        self._factory = factory
        self._on_set = on_set
        self._instance: T | None = None
        self._lock = RLock()

    def get(self) -> T:
        """Return the configured service, creating it lazily on first use."""
        if self._instance is not None:
            return self._instance

        with self._lock:
            if self._instance is None:
                self._set_unlocked(self._factory())
            assert self._instance is not None
            return self._instance

    def set(self, service: T | None) -> None:
        """Replace or clear the configured service."""
        with self._lock:
            self._set_unlocked(service)

    def _set_unlocked(self, service: T | None) -> None:
        self._instance = service
        if service is not None and self._on_set is not None:
            self._on_set(service)
