"""Unit tests for POST /api/vlm/probe-concurrency."""
from __future__ import annotations

import asyncio
from typing import Any, Dict



class _FakeProvider:
    def __init__(self) -> None:
        self.calls = 0

    async def test_connection(self) -> Dict[str, Any]:
        self.calls += 1
        await asyncio.sleep(0)
        return {"status": "ok", "models": []}


class _ThresholdProvider:
    """Succeed while concurrent wave size stays at/below threshold."""

    def __init__(self, threshold: int) -> None:
        self.threshold = threshold
        self.calls = 0
        self._inflight = 0
        self._lock = asyncio.Lock()

    async def test_connection(self) -> Dict[str, Any]:
        async with self._lock:
            self.calls += 1
            self._inflight += 1
            current = self._inflight
        await asyncio.sleep(0.01)
        async with self._lock:
            self._inflight -= 1
        if current > self.threshold:
            return {"status": "error", "error": "rate limited", "error_type": "rate_limit"}
        return {"status": "ok", "models": []}


def test_run_concurrency_probe_level_all_ok():
    from routers.vlm import _run_concurrency_probe_level

    provider = _FakeProvider()
    summary = asyncio.run(_run_concurrency_probe_level(provider, 3))
    assert summary["level"] == 3
    assert summary["ok"] == 3
    assert summary["failed"] == 0
    assert summary["success"] is True
    assert provider.calls == 3


def test_probe_endpoint_recommends_threshold(monkeypatch, test_client, tmp_path):
    from routers import vlm

    settings_path = tmp_path / "vlm-settings.json"
    settings_path.write_text(
        '{"provider":"openai_compat","endpoint":"http://127.0.0.1:9/v1","api_key":"","model":"x"}',
        encoding="utf-8",
    )
    monkeypatch.setattr(vlm, "VLM_SETTINGS_PATH", settings_path)

    provider = _ThresholdProvider(threshold=3)
    monkeypatch.setattr(vlm, "get_provider", lambda config: provider)
    monkeypatch.setattr(
        vlm,
        "_build_config",
        lambda overrides=None: vlm.VLMConfig(
            provider="openai_compat",
            endpoint="http://127.0.0.1:9/v1",
            concurrent_requests=2,
        ),
    )

    resp = test_client.post(
        "/api/vlm/probe-concurrency",
        json={"max_level": 6, "apply": True},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ok"
    assert data["recommended"] == 3
    assert data["applied"] is True
    assert data["levels"][0]["success"] is True
    assert any(row["level"] == 4 and not row["success"] for row in data["levels"])

    saved = settings_path.read_text(encoding="utf-8")
    assert '"concurrent_requests": 3' in saved or '"concurrent_requests":3' in saved


def test_probe_endpoint_requires_endpoint(monkeypatch, test_client):
    from routers import vlm

    monkeypatch.setattr(
        vlm,
        "_build_config",
        lambda overrides=None: vlm.VLMConfig(
            provider="openai_compat", endpoint="", use_vertex=False
        ),
    )
    resp = test_client.post("/api/vlm/probe-concurrency", json={"max_level": 4})
    assert resp.status_code == 400
