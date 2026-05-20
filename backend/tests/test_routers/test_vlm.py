from __future__ import annotations

import asyncio
from pathlib import Path

from PIL import Image


def test_vlm_batch_progress_and_debug_chat(monkeypatch, test_client, test_db, tmp_path: Path):
    import database as db
    import routers.vlm as vlm_router
    from vlm_providers.base import VLMResult

    image_a = tmp_path / "vlm-ok.png"
    image_b = tmp_path / "vlm-error.png"
    Image.new("RGB", (32, 32), color="white").save(image_a)
    Image.new("RGB", (32, 32), color="black").save(image_b)

    ok_id = db.add_image(path=str(image_a), filename=image_a.name)
    error_id = db.add_image(path=str(image_b), filename=image_b.name)
    db.add_tags(ok_id, [{"tag": "1girl", "confidence": 0.9}])

    class FakeProvider:
        name = "fake_vlm"

        def __init__(self, config):
            self.config = config

        def build_user_message(self, tags=None):
            return f"Describe this image. Tags: {', '.join(tags or [])}"

        async def caption_image(self, image_path, *, tags=None):
            await asyncio.sleep(0.01)
            if Path(image_path).name == image_b.name:
                return VLMResult(
                    error="HTTP 401: bad key",
                    error_type="auth",
                    model="debug-model",
                    raw_text="",
                )
            return VLMResult(
                caption="A clean test caption.",
                tokens_used=42,
                model="debug-model",
                raw_text="A clean test caption.",
            )

    monkeypatch.setattr(vlm_router, "get_provider", lambda config: FakeProvider(config))
    monkeypatch.setattr(
        vlm_router,
        "_build_config",
        lambda overrides=None: vlm_router.VLMConfig(
            provider="openai_compat",
            endpoint="https://example.test/v1",
            api_key="sk-secret-should-not-appear",
            model="debug-model",
            system_prompt="You are a captioner.",
            user_prompt="Describe this image.",
            concurrent_requests=1,
        ),
    )
    scheduled = []

    def fake_create_task(coro):
        scheduled.append(coro)
        return None

    monkeypatch.setattr(vlm_router.asyncio, "create_task", fake_create_task)

    response = test_client.post("/api/vlm/caption-batch", json={"image_ids": [ok_id, error_id]})
    assert response.status_code == 200
    assert scheduled
    asyncio.run(scheduled.pop())

    progress = {}
    for _ in range(50):
        progress = test_client.get("/api/vlm/caption-batch/progress").json()
        if not progress["running"]:
            break
        asyncio.run(asyncio.sleep(0.02))

    assert progress["completed"] == 1
    assert progress["failed"] == 1
    assert progress["api_ok"] == 1
    assert progress["api_error"] == 1
    assert progress["api_status"] == "done_with_errors"
    assert progress["last_api_error"] == "HTTP 401: bad key"

    debug = test_client.get("/api/vlm/caption-batch/debug-chat").json()
    events = debug["events"]
    assert any(event["phase"] == "request" and event["system_prompt"] == "You are a captioner." for event in events)
    assert any(event["phase"] == "response" and event["caption"] == "A clean test caption." for event in events)
    assert any(event["phase"] == "error" and event["error"] == "HTTP 401: bad key" for event in events)

    serialized = str(events)
    assert "sk-secret-should-not-appear" not in serialized
    assert "base64," not in serialized
    assert "data:image" not in serialized


def test_vlm_settings_reject_invalid_concurrent_requests(test_client):
    response = test_client.post("/api/vlm/settings", json={"concurrent_requests": 0})

    assert response.status_code == 400
    assert "concurrent_requests" in response.text


def test_vlm_build_config_clamps_corrupt_concurrent_requests(monkeypatch):
    import routers.vlm as vlm_router

    monkeypatch.setattr(vlm_router, "_load_vlm_settings", lambda: {
        "provider": "openai_compat",
        "endpoint": "https://example.test",
        "concurrent_requests": 0,
        "max_retries": -5,
        "timeout_seconds": 0,
        "max_image_size": 99,
    })

    config = vlm_router._build_config()

    assert config.endpoint == "https://example.test/v1"
    assert config.concurrent_requests == 1
    assert config.max_retries == 0
    assert config.timeout_seconds == 1
    assert config.max_image_size == 128


def test_vlm_debug_request_endpoint_redacts_userinfo_query_and_fragment():
    import routers.vlm as vlm_router

    event = vlm_router._build_debug_request_event(
        image_id=1,
        image_name="sample.png",
        config=vlm_router.VLMConfig(
            endpoint="https://user:secret@example.test/v1/chat?token=abc#frag",
            model="m",
        ),
        provider_name="fake",
        tags=[],
        user_message="describe",
    )

    assert event["endpoint"] == "https://example.test/v1/chat?..."
    assert "secret" not in event["endpoint"]
    assert "token=abc" not in event["endpoint"]
    assert "frag" not in event["endpoint"]


def test_vlm_caption_single_resolves_indexed_path(monkeypatch, test_client, tmp_path: Path):
    import database as db
    import routers.vlm as vlm_router
    from vlm_providers.base import VLMResult

    runtime_path = tmp_path / "resolved-caption.png"
    Image.new("RGB", (32, 32), color="white").save(runtime_path)
    image_id = db.add_image(path="I:\\missing\\resolved-caption.png", filename=runtime_path.name)

    monkeypatch.setattr(
        vlm_router,
        "resolve_existing_indexed_image_path",
        lambda primary_path, *, backend_file, allow_symlink=False: str(runtime_path),
    )

    seen_paths = []

    class FakeProvider:
        def __init__(self, config):
            self.config = config

        async def caption_image(self, image_path, *, tags=None):
            seen_paths.append(image_path)
            return VLMResult(caption="resolved ok", model="m")

    monkeypatch.setattr(vlm_router, "get_provider", lambda config: FakeProvider(config))
    monkeypatch.setattr(
        vlm_router,
        "_build_config",
        lambda overrides=None: vlm_router.VLMConfig(endpoint="https://example.test/v1", model="m"),
    )

    response = test_client.post("/api/vlm/caption", json={"image_id": image_id})

    assert response.status_code == 200
    assert response.json()["caption"] == "resolved ok"
    assert seen_paths == [str(runtime_path)]
