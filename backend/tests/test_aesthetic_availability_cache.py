"""Tests for the aesthetic predictor's is_available() caching behaviour.

The frontend polls ``/api/aesthetic/status`` every few seconds while the
aesthetic settings panel is open. Before the cache landed, every poll ran
``import torch`` again and emitted a fresh
"Aesthetic predictor torch import failed: No module named 'torch'" WARNING,
flooding the launcher console for any user running in lightweight mode
(the default since v3.2.2 / PR #11). These tests pin the new behaviour so
the spam does not return.
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


def _force_torch_import_to_fail(monkeypatch):
    """Make ``import torch`` inside ``is_available`` raise ImportError.

    Removing the module from ``sys.modules`` and inserting a sentinel that
    raises on attribute access mirrors what users see in lightweight mode
    where torch was never installed.
    """
    monkeypatch.delitem(sys.modules, "torch", raising=False)

    real_import = __builtins__["__import__"] if isinstance(__builtins__, dict) else __builtins__.__import__

    def fake_import(name, globals=None, locals=None, fromlist=(), level=0):
        if name == "torch" or name.startswith("torch."):
            raise ImportError("No module named 'torch'")
        return real_import(name, globals, locals, fromlist, level)

    monkeypatch.setattr("builtins.__import__", fake_import)


def test_is_available_caches_negative_result(monkeypatch):
    """Once is_available() decides torch is missing, subsequent calls
    must reuse that answer without re-running ``import torch``."""
    _force_torch_import_to_fail(monkeypatch)

    import_calls = {"count": 0}
    real_import = __builtins__["__import__"] if isinstance(__builtins__, dict) else __builtins__.__import__

    def counting_import(name, globals=None, locals=None, fromlist=(), level=0):
        if name == "torch" or name.startswith("torch."):
            import_calls["count"] += 1
            raise ImportError("No module named 'torch'")
        return real_import(name, globals, locals, fromlist, level)

    monkeypatch.setattr("builtins.__import__", counting_import)

    assert aesthetic.is_available() is False
    assert aesthetic.is_available() is False
    assert aesthetic.is_available() is False

    assert import_calls["count"] == 1, (
        "is_available() must only attempt the torch import once per process; "
        "the cached negative result must short-circuit subsequent polls."
    )


def test_is_available_logs_torch_failure_only_once(monkeypatch, caplog):
    """The aesthetic settings panel polls /api/aesthetic/status every few
    seconds. Repeated polls must not produce repeated WARNING entries."""
    _force_torch_import_to_fail(monkeypatch)

    with caplog.at_level(logging.WARNING, logger="aesthetic"):
        aesthetic.is_available()
        aesthetic.is_available()
        aesthetic.is_available()
        aesthetic.is_available()

    matching = [
        record for record in caplog.records
        if "Aesthetic predictor torch import failed" in record.getMessage()
    ]
    assert len(matching) == 1, (
        f"Expected exactly one torch-failed WARNING per process; got {len(matching)}: "
        f"{[r.getMessage() for r in matching]}"
    )


def test_reset_availability_cache_re_runs_import_check(monkeypatch):
    """After Prepare for Aesthetic Score installs torch + open_clip, the
    model service calls reset_availability_cache() so the next status poll
    discovers the freshly-installed runtime.

    The test routes ``import torch`` / ``import open_clip`` through fake
    ``ModuleType`` instances instead of deleting the real torch from
    ``sys.modules``. CI environments install torch via requirements-dev.txt;
    deleting it and letting the real import run a second time would trigger
    a ``RuntimeError: Only a single TORCH_LIBRARY can be used to register
    the namespace triton`` because torch's C++ globals are already
    registered in this interpreter.
    """
    import types

    real_import = __builtins__["__import__"] if isinstance(__builtins__, dict) else __builtins__.__import__
    fail_torch = {"on": True}
    fake_torch = types.ModuleType("torch")
    fake_open_clip = types.ModuleType("open_clip")

    def routed_import(name, globals=None, locals=None, fromlist=(), level=0):
        if name == "torch" or name.startswith("torch."):
            if fail_torch["on"]:
                raise ImportError("No module named 'torch'")
            return fake_torch
        if name == "open_clip" or name.startswith("open_clip."):
            return fake_open_clip
        return real_import(name, globals, locals, fromlist, level)

    monkeypatch.setattr("builtins.__import__", routed_import)

    # First poll: torch missing → False, cache populated with False.
    assert aesthetic.is_available() is False
    assert aesthetic._availability_cache is False

    # Simulate Prepare succeeding: torch is now importable. Without the
    # reset, the cached False would stick for the rest of this process.
    fail_torch["on"] = False
    aesthetic.reset_availability_cache()
    assert aesthetic._availability_cache is None, (
        "reset_availability_cache() must clear the cached value back to None "
        "so the next is_available() call actually re-runs the import check."
    )

    # Second poll: torch present → True, cache populated with True.
    assert aesthetic.is_available() is True
    assert aesthetic._availability_cache is True


def test_reset_availability_cache_re_arms_warning(monkeypatch, caplog):
    """If a Prepare attempt fails and the runtime is still missing, the
    next is_available() call after reset_availability_cache() should emit
    the WARNING again (otherwise the user has no breadcrumb at all when
    re-investigating after a failed prepare)."""
    _force_torch_import_to_fail(monkeypatch)

    with caplog.at_level(logging.WARNING, logger="aesthetic"):
        aesthetic.is_available()  # logs warning #1

    aesthetic.reset_availability_cache()

    with caplog.at_level(logging.WARNING, logger="aesthetic"):
        aesthetic.is_available()  # logs warning #2

    matching = [
        record for record in caplog.records
        if "Aesthetic predictor torch import failed" in record.getMessage()
    ]
    assert len(matching) == 2, (
        "After reset_availability_cache() the next failure should re-log "
        f"the WARNING once. Got {len(matching)} messages: "
        f"{[r.getMessage() for r in matching]}"
    )
