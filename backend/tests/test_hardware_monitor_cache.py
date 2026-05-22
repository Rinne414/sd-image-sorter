"""Regression tests for the system_info hardware probe cache.

Hardware probing is expensive (subprocess.run for nvidia-smi + powershell, the
torch import, ONNXRT provider enumeration). The frontend opens the tagger
modal and hits ``/api/system-info`` repeatedly; the previous version
re-probed every call which made each modal open ~4 s.
"""
from __future__ import annotations

import time
from unittest.mock import patch

import pytest

import hardware_monitor


@pytest.fixture(autouse=True)
def _reset_cache():
    hardware_monitor.invalidate_system_info_cache()
    yield
    hardware_monitor.invalidate_system_info_cache()


def test_get_system_info_caches_within_ttl():
    fake = {"total_ram_gb": 32.0, "gpu_name": "RTX 3090"}
    with patch.object(hardware_monitor, "_collect_system_info", return_value=fake) as collect:
        first = hardware_monitor.get_system_info()
        second = hardware_monitor.get_system_info()
        third = hardware_monitor.get_system_info()

    assert collect.call_count == 1, "system info should be probed once and cached"
    assert first == fake
    assert second == fake
    assert third == fake


def test_refresh_flag_forces_reprobe():
    with patch.object(
        hardware_monitor,
        "_collect_system_info",
        side_effect=[{"v": 1}, {"v": 2}],
    ) as collect:
        first = hardware_monitor.get_system_info()
        second = hardware_monitor.get_system_info(refresh=True)

    assert collect.call_count == 2
    assert first == {"v": 1}
    assert second == {"v": 2}


def test_invalidate_forces_reprobe():
    with patch.object(
        hardware_monitor,
        "_collect_system_info",
        side_effect=[{"v": 1}, {"v": 2}],
    ) as collect:
        first = hardware_monitor.get_system_info()
        hardware_monitor.invalidate_system_info_cache()
        second = hardware_monitor.get_system_info()

    assert collect.call_count == 2
    assert first == {"v": 1}
    assert second == {"v": 2}


def test_caller_cannot_mutate_cached_value():
    """``get_system_info`` returns a copy — mutating it must not affect the cache."""
    with patch.object(hardware_monitor, "_collect_system_info", return_value={"foo": 1}):
        first = hardware_monitor.get_system_info()
        first["foo"] = 9999

        second = hardware_monitor.get_system_info()
        assert second["foo"] == 1


def test_cache_expires_after_ttl(monkeypatch):
    monkeypatch.setattr(hardware_monitor, "_SYSTEM_INFO_CACHE_TTL_SECONDS", 0.01)
    with patch.object(
        hardware_monitor,
        "_collect_system_info",
        side_effect=[{"v": 1}, {"v": 2}],
    ) as collect:
        first = hardware_monitor.get_system_info()
        time.sleep(0.05)
        second = hardware_monitor.get_system_info()

    assert collect.call_count == 2
    assert first == {"v": 1}
    assert second == {"v": 2}
