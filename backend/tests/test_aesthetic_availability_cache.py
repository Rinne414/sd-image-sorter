"""Tests for the aesthetic predictor's is_available() caching behaviour.

The frontend polls ``/api/aesthetic/status`` every few seconds while the
aesthetic settings panel is open. Before the cache landed, every poll checked
torch again and emitted a fresh "Aesthetic predictor torch import failed:
No module named 'torch'" WARNING, flooding the launcher console for any user
running in lightweight mode (the default since v3.2.2 / PR #11). These tests
pin the behaviour so the spam does not return.

Since 2026-11-08 the check imports nothing heavy into the server (importing
torch and open_clip cost 4.6 s and 811 MB on every start): torch is tried in
a subprocess (``_torch_import_error``) and open_clip is only located
(``_clip_installed``). The tests replace those two seams.
"""

from __future__ import annotations

import logging
import sys
from pathlib import Path

import pytest


sys.path.insert(0, str(Path(__file__).parent.parent))

import aesthetic


@pytest.fixture(autouse=True)
def _reset_cache_around_each_test():
    """Each test starts with a clean module-level cache so the order of
    tests does not change observable behaviour."""
    aesthetic.reset_availability_cache()
    yield
    aesthetic.reset_availability_cache()


def _torch_checks(monkeypatch, *, missing: bool = True) -> dict:
    """Route the torch check through a counter; ``state['missing']`` flips it."""
    state = {"missing": missing, "calls": 0}

    def torch_import_error():
        state["calls"] += 1
        return "No module named 'torch'" if state["missing"] else None

    monkeypatch.setattr(aesthetic, "_torch_import_error", torch_import_error)
    monkeypatch.setattr(aesthetic, "_clip_installed", lambda: True)
    return state


def test_is_available_caches_negative_result(monkeypatch):
    """Once is_available() decides torch is missing, subsequent calls
    must reuse that answer without checking torch again."""
    state = _torch_checks(monkeypatch)

    assert aesthetic.is_available() is False
    assert aesthetic.is_available() is False
    assert aesthetic.is_available() is False

    assert state["calls"] == 1, (
        "is_available() must only check torch once per process; "
        "the cached negative result must short-circuit subsequent polls."
    )


def test_is_available_logs_torch_failure_only_once(monkeypatch, caplog):
    """The aesthetic settings panel polls /api/aesthetic/status every few
    seconds. Repeated polls must not produce repeated WARNING entries."""
    _torch_checks(monkeypatch)

    with caplog.at_level(logging.WARNING, logger="aesthetic"):
        aesthetic.is_available()
        aesthetic.is_available()
        aesthetic.is_available()
        aesthetic.is_available()

    matching = [
        record
        for record in caplog.records
        if "Aesthetic predictor torch import failed" in record.getMessage()
    ]
    assert len(matching) == 1, (
        f"Expected exactly one torch-failed WARNING per process; got {len(matching)}: "
        f"{[r.getMessage() for r in matching]}"
    )


def test_reset_availability_cache_re_runs_import_check(monkeypatch):
    """After Prepare for Aesthetic Score installs torch + open_clip, the
    model service calls reset_availability_cache() so the next status poll
    discovers the freshly-installed runtime."""
    state = _torch_checks(monkeypatch)

    # First poll: torch missing -> False, cache populated with False.
    assert aesthetic.is_available() is False
    assert aesthetic._availability_cache is False

    # Simulate Prepare succeeding. Without the reset, the cached False would
    # stick for the rest of this process.
    state["missing"] = False
    aesthetic.reset_availability_cache()
    assert aesthetic._availability_cache is None, (
        "reset_availability_cache() must clear the cached value back to None "
        "so the next is_available() call actually re-runs the check."
    )

    # Second poll: torch present -> True, cache populated with True.
    assert aesthetic.is_available() is True
    assert aesthetic._availability_cache is True


def test_reset_availability_cache_re_arms_warning(monkeypatch, caplog):
    """If a Prepare attempt fails and the runtime is still missing, the
    next is_available() call after reset_availability_cache() should emit
    the WARNING again (otherwise the user has no breadcrumb at all when
    re-investigating after a failed prepare)."""
    _torch_checks(monkeypatch)

    with caplog.at_level(logging.WARNING, logger="aesthetic"):
        aesthetic.is_available()  # logs warning #1

    aesthetic.reset_availability_cache()

    with caplog.at_level(logging.WARNING, logger="aesthetic"):
        aesthetic.is_available()  # logs warning #2

    matching = [
        record
        for record in caplog.records
        if "Aesthetic predictor torch import failed" in record.getMessage()
    ]
    assert len(matching) == 2, (
        "After reset_availability_cache() the next failure should re-log "
        f"the WARNING once. Got {len(matching)} messages: "
        f"{[r.getMessage() for r in matching]}"
    )


def test_torch_present_without_clip_is_unavailable(monkeypatch):
    _torch_checks(monkeypatch, missing=False)
    monkeypatch.setattr(aesthetic, "_clip_installed", lambda: False)
    assert aesthetic.is_available() is False


def test_the_check_never_imports_torch_into_the_server(monkeypatch):
    """The answer comes from the subprocess probe; torch stays out of this process."""
    import model_health_probes

    monkeypatch.delitem(sys.modules, "torch", raising=False)
    monkeypatch.setattr(
        model_health_probes,
        "_probe_torch_runtime",
        lambda: {"torch_version": "2.7.0+cu128", "torch_probe_error": None},
    )
    monkeypatch.setattr(aesthetic, "_clip_installed", lambda: True)
    assert aesthetic.is_available() is True
    assert "torch" not in sys.modules


def test_a_broken_torch_reads_as_unavailable(monkeypatch):
    import model_health_probes

    monkeypatch.delitem(sys.modules, "torch", raising=False)
    monkeypatch.setattr(
        model_health_probes,
        "_probe_torch_runtime",
        lambda: {
            "torch_version": "2.7.0",
            "torch_probe_error": "[WinError 126] fbgemm.dll could not be found",
        },
    )
    monkeypatch.setattr(aesthetic, "_clip_installed", lambda: True)
    assert aesthetic.is_available() is False
