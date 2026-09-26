"""GPU duty cycle for tagger inference (decision D46, after the 2026-09-26 crash).

A long tagging run used to hold the GPU at full load from the first batch to the
last. After every GPU inference batch the tagger now rests for a fraction of that
batch's own compute time, so the card is busy about ``busy_fraction`` of the time
(default 85%) and power draw and heat get short gaps instead of one unbroken peak.

``SD_IMAGE_SORTER_GPU_DUTY_CYCLE`` sets the busy fraction:

* unset: 0.85;
* a fraction such as ``0.7``, or a percentage such as ``70`` / ``70%``;
* ``1``, ``100%``, ``0``, ``off``, ``false`` or ``no``: no pause (disabled).

Busy fractions below 0.1 are raised to 0.1 so a typo cannot stretch a run tenfold.
The value is read on every call, so a spawned tagging worker inherits it.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from contextlib import contextmanager
from typing import Callable, Iterator, Optional

logger = logging.getLogger(__name__)

GPU_DUTY_CYCLE_ENV = "SD_IMAGE_SORTER_GPU_DUTY_CYCLE"
DEFAULT_GPU_BUSY_FRACTION = 0.85
MIN_GPU_BUSY_FRACTION = 0.1
MIN_PAUSE_SECONDS = 0.005
_DISABLED_VALUES = frozenset({"0", "off", "false", "no", "none", "disabled"})

_warned_values: set = set()
_warned_lock = threading.Lock()


def _warn_once(raw: str) -> None:
    with _warned_lock:
        if raw in _warned_values:
            return
        _warned_values.add(raw)
    logger.warning(
        "Invalid %s=%r; using the default GPU busy fraction %.2f.",
        GPU_DUTY_CYCLE_ENV,
        raw,
        DEFAULT_GPU_BUSY_FRACTION,
    )


def parse_gpu_busy_fraction(raw: str | None) -> float:
    """Turn the setting into a busy fraction in [0.1, 1.0]; 1.0 means no pause."""
    text = (raw or "").strip().lower()
    if not text:
        return DEFAULT_GPU_BUSY_FRACTION
    if text in _DISABLED_VALUES:
        return 1.0
    is_percent = text.endswith("%")
    try:
        value = float(text.rstrip("%").strip())
    except ValueError:
        _warn_once(text)
        return DEFAULT_GPU_BUSY_FRACTION
    if is_percent or value > 1.0:
        value /= 100.0
    if value <= 0.0 or value != value:  # negative or NaN
        _warn_once(text)
        return DEFAULT_GPU_BUSY_FRACTION
    return max(MIN_GPU_BUSY_FRACTION, min(1.0, value))


def gpu_busy_fraction() -> float:
    """The busy fraction currently configured through the environment."""
    return parse_gpu_busy_fraction(os.environ.get(GPU_DUTY_CYCLE_ENV))


def duty_cycle_pause_seconds(busy_seconds: float, busy_fraction: float) -> float:
    """Pause that keeps the GPU busy ``busy_fraction`` of the time after a batch."""
    if busy_fraction >= 1.0:
        return 0.0
    busy = max(0.0, float(busy_seconds))
    return max(MIN_PAUSE_SECONDS, busy * (1.0 - busy_fraction) / busy_fraction)


# Module-level so tests can swap in a fake clock without patching ``time``.
_clock: Callable[[], float] = time.perf_counter
_sleep: Callable[[float], None] = time.sleep


@contextmanager
def gpu_duty_cycle(
    uses_gpu: bool,
    *,
    clock: Optional[Callable[[], float]] = None,
    sleep: Optional[Callable[[float], None]] = None,
) -> Iterator[None]:
    """Time the wrapped GPU inference, then rest in proportion to it.

    No pause for CPU work, and none when the inference raised: the caller's
    error path (OOM backoff, CPU fallback) has its own cooldown.
    """
    if not uses_gpu:
        yield
        return
    read_clock = clock or _clock
    started = read_clock()
    yield
    pause = duty_cycle_pause_seconds(read_clock() - started, gpu_busy_fraction())
    if pause > 0.0:
        (sleep or _sleep)(pause)
