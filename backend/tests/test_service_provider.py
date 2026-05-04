"""Tests for lazy service provider helper."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from services.service_provider import ServiceProvider  # noqa: E402


def test_service_provider_creates_once_and_reuses_instance():
    calls = []

    def factory():
        calls.append("factory")
        return {"service": len(calls)}

    provider = ServiceProvider(factory)

    first = provider.get()
    second = provider.get()

    assert first is second
    assert calls == ["factory"]


def test_service_provider_set_replaces_and_clear_restores_lazy_factory():
    provider = ServiceProvider(lambda: "factory")

    provider.set("manual")
    assert provider.get() == "manual"

    provider.set(None)
    assert provider.get() == "factory"


def test_service_provider_calls_on_set_for_created_and_manual_instances():
    configured = []
    provider = ServiceProvider(lambda: {"name": "created"}, on_set=configured.append)

    created = provider.get()
    manual = {"name": "manual"}
    provider.set(manual)
    provider.set(None)

    assert configured == [created, manual]
