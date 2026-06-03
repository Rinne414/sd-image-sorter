"""
Process-wide scan-activity signal.

A tiny, dependency-free counter that lets unrelated subsystems (e.g. the
thumbnail cache) discover whether a folder scan is actively running, so they
can back off and stop competing with metadata parsing for CPU.

Kept free of any project imports on purpose — every backend module may safely
``import scan_state`` without risk of an import cycle.

The counter (rather than a boolean) tolerates overlapping/concurrent scans:
``is_scan_running()`` stays true until the last in-flight scan finishes.
"""
import threading

_lock = threading.Lock()
_active_scans = 0


def scan_started() -> None:
    """Register the start of a scan. Pairs with exactly one ``scan_finished()``."""
    global _active_scans
    with _lock:
        _active_scans += 1


def scan_finished() -> None:
    """Register the end of a scan. Never drops the counter below zero."""
    global _active_scans
    with _lock:
        if _active_scans > 0:
            _active_scans -= 1


def is_scan_running() -> bool:
    """Return ``True`` while at least one scan is in flight."""
    with _lock:
        return _active_scans > 0


def active_scan_count() -> int:
    """Return the number of scans currently in flight (diagnostics/tests)."""
    with _lock:
        return _active_scans
