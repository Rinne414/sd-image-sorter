"""Release AI models nobody has used for a while.

The program can stay in the tray all day. A tagger, CLIP or censor model that
was loaded once in the morning would otherwise keep its RAM (and video memory
ComfyUI needs) until the program quits. Each model holder is described once
as a ``ModelSlot`` (see ``model_residency_slots``); one sweeper thread
releases every slot that has been idle longer than the user's setting, and the
next use loads the model again as it always did.

"Used" comes from the AI runtime leases every model already takes to load and
to run (``ai_runtime_guard``): a lease whose label starts with one of a slot's
prefixes marks that slot used, so the model modules need no timer of their
own. A slot whose lease is held right now - a running job - is never released.
"""

from __future__ import annotations

import gc
import logging
import sys
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable, ContextManager, Dict, List, Optional, Sequence, Tuple

logger = logging.getLogger(__name__)

SWEEP_INTERVAL_SECONDS = 30.0
RELEASE_LEASE_TIMEOUT_SECONDS = 5.0
RELEASE_LEASE_PREFIX = "model-idle-release:"


@dataclass(frozen=True)
class ModelSlot:
    """One place in the program that can hold a loaded model.

    ``probe`` returns "gpu" or "cpu" while the model is loaded and None when it
    is not. ``release`` drops it; the next use loads it again.
    """

    key: str
    prefixes: Tuple[str, ...]
    probe: Callable[[], Optional[str]]
    release: Callable[[], None]

    def matches(self, label: str) -> bool:
        return any(label.startswith(prefix) for prefix in self.prefixes)


def _default_active_labels() -> List[str]:
    from ai_runtime_guard import get_ai_jobs_snapshot

    return [str(job.get("label") or "") for job in get_ai_jobs_snapshot()["jobs"]]


def _default_release_guard(key: str) -> ContextManager[Any]:
    from ai_runtime_guard import exclusive_ai_runtime

    return exclusive_ai_runtime(
        f"{RELEASE_LEASE_PREFIX}{key}", timeout=RELEASE_LEASE_TIMEOUT_SECONDS
    )


def _free_torch_cache() -> None:
    torch_module = sys.modules.get("torch")
    if torch_module is None:
        return
    from ai_runtime_guard import clear_torch_cuda_cache

    clear_torch_cuda_cache(torch_module)


class ModelResidency:
    """Registry of model slots plus the idle-release decision."""

    def __init__(
        self,
        *,
        idle_seconds: Callable[[], float],
        clock: Callable[[], float] = time.monotonic,
        active_labels: Callable[[], Sequence[str]] = _default_active_labels,
        release_guard: Callable[[str], ContextManager[Any]] = _default_release_guard,
        free_cache: Callable[[], None] = _free_torch_cache,
    ) -> None:
        self._idle_seconds = idle_seconds
        self._clock = clock
        self._active_labels = active_labels
        self._release_guard = release_guard
        self._free_cache = free_cache
        self._lock = threading.Lock()
        self._slots: Dict[str, ModelSlot] = {}
        self._last_used: Dict[str, float] = {}
        self._last_release: Optional[Dict[str, Any]] = None

    def register(self, slot: ModelSlot) -> None:
        with self._lock:
            self._slots[slot.key] = slot

    def note_activity(self, label: str) -> None:
        """A lease with this label started or ended: its model was just used."""
        if not label or label.startswith(RELEASE_LEASE_PREFIX):
            return
        now = self._clock()
        with self._lock:
            for slot in self._slots.values():
                if slot.matches(label):
                    self._last_used[slot.key] = now

    # Reading state --------------------------------------------------------

    def _loaded_slots(self) -> List[Tuple[ModelSlot, str]]:
        with self._lock:
            slots = list(self._slots.values())
        loaded: List[Tuple[ModelSlot, str]] = []
        for slot in slots:
            try:
                device = slot.probe()
            except Exception:  # noqa: BLE001 - a broken probe reads as "not loaded"
                logger.debug("Model probe failed for %s", slot.key, exc_info=True)
                device = None
            if device:
                loaded.append((slot, device))
            else:
                with self._lock:
                    self._last_used.pop(slot.key, None)
        return loaded

    def _idle_for(self, slot: ModelSlot, now: float) -> float:
        with self._lock:
            # First seen loaded without a recorded use: its idle time starts now.
            last = self._last_used.setdefault(slot.key, now)
        return max(0.0, now - last)

    def _busy(self, slot: ModelSlot, active: Sequence[str]) -> bool:
        return any(slot.matches(label) for label in active)

    def snapshot(self) -> Dict[str, Any]:
        now = self._clock()
        active = list(self._active_labels())
        models = [
            {
                "key": slot.key,
                "device": device,
                "in_use": self._busy(slot, active),
                "idle_seconds": round(self._idle_for(slot, now), 1),
            }
            for slot, device in self._loaded_slots()
        ]
        with self._lock:
            last_release = dict(self._last_release) if self._last_release else None
        return {
            "idle_seconds": self._idle_seconds(),
            "models": models,
            "last_release": last_release,
        }

    # Releasing ------------------------------------------------------------

    def sweep(self) -> List[str]:
        """Release every loaded, unused slot idle longer than the setting."""
        limit = float(self._idle_seconds() or 0)
        if limit <= 0:
            return []
        now = self._clock()
        active = list(self._active_labels())
        due = [
            (slot, device)
            for slot, device in self._loaded_slots()
            if not self._busy(slot, active) and self._idle_for(slot, now) >= limit
        ]
        return self._release_many(due, reason="idle")["released"]

    def release_now(self) -> Dict[str, List[str]]:
        """ "Unload now": release everything a running job is not using."""
        active = list(self._active_labels())
        loaded = self._loaded_slots()
        busy = [slot.key for slot, _device in loaded if self._busy(slot, active)]
        idle = [(slot, device) for slot, device in loaded if slot.key not in busy]
        result = self._release_many(idle, reason="manual")
        result["busy"] = busy + result["busy"]
        return result

    def _release_many(
        self, slots: Sequence[Tuple[ModelSlot, str]], *, reason: str
    ) -> Dict[str, List[str]]:
        released: List[str] = []
        busy: List[str] = []
        for slot, device in slots:
            if self._release(slot):
                released.append(slot.key)
                logger.info("Released %s model (%s, %s)", slot.key, device, reason)
            else:
                busy.append(slot.key)
        if released:
            gc.collect()
            self._free_cache()
            with self._lock:
                self._last_release = {
                    "keys": released,
                    "reason": reason,
                    "at": time.time(),
                }
        return {"released": released, "busy": busy}

    def _release(self, slot: ModelSlot) -> bool:
        try:
            with self._release_guard(slot.key):
                slot.release()
        except Exception as exc:  # noqa: BLE001 - one model must not stop the others
            logger.warning("Could not release the %s model: %s", slot.key, exc)
            return False
        with self._lock:
            self._last_used.pop(slot.key, None)
        return True


class IdleSweeper:
    """Daemon thread that calls ``ModelResidency.sweep`` every interval."""

    def __init__(
        self, residency: ModelResidency, interval: float = SWEEP_INTERVAL_SECONDS
    ) -> None:
        self._residency = residency
        self._interval = interval
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._run, name="model-idle-sweeper", daemon=True
        )
        self._thread.start()

    def stop(self, timeout: float = 2.0) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout)

    def _run(self) -> None:
        from process_priority import lower_current_thread_priority

        lower_current_thread_priority()
        while not self._stop.wait(self._interval):
            try:
                self._residency.sweep()
            except Exception:  # noqa: BLE001 - the sweeper must keep running
                logger.warning("Idle model sweep failed", exc_info=True)


def _idle_seconds_from_settings() -> float:
    from config_settings import get_model_idle_unload_minutes

    return float(get_model_idle_unload_minutes()) * 60.0


_residency: Optional[ModelResidency] = None
_sweeper: Optional[IdleSweeper] = None
_singleton_lock = threading.Lock()


def get_model_residency() -> ModelResidency:
    """The process-wide registry, with every known model slot registered."""
    global _residency
    with _singleton_lock:
        if _residency is None:
            from ai_runtime_guard import add_activity_listener
            from model_residency_slots import register_default_slots

            residency = ModelResidency(idle_seconds=_idle_seconds_from_settings)
            register_default_slots(residency)
            add_activity_listener(residency.note_activity)
            _residency = residency
        return _residency


def start_idle_sweeper() -> None:
    global _sweeper
    residency = get_model_residency()
    with _singleton_lock:
        if _sweeper is None:
            _sweeper = IdleSweeper(residency)
        _sweeper.start()


def stop_idle_sweeper() -> None:
    with _singleton_lock:
        sweeper = _sweeper
    if sweeper is not None:
        sweeper.stop()
