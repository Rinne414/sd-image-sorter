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
    real_create_task = asyncio.create_task

    def fake_create_task(coro):
        scheduled.append(coro)
        return None

    monkeypatch.setattr(vlm_router.asyncio, "create_task", fake_create_task)

    response = test_client.post("/api/vlm/caption-batch", json={"image_ids": [ok_id, error_id]})
    assert response.status_code == 200
    assert scheduled
    monkeypatch.setattr(vlm_router.asyncio, "create_task", real_create_task)
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


def test_vlm_batch_token_source_uses_pre_mutation_snapshot(monkeypatch, test_db):
    """Token/filters batch sources must snapshot IDs before captioning mutates rows.

    Workers persist captions and merged VLM tags while the producer iterates;
    a token filtering on tags/excludeTags the batch rewrites would otherwise
    skip images mid-run (offset pagination over a shrinking matching set).
    """
    import routers.vlm as vlm_router
    import services.tag_export_service as tag_export_service

    observed_snapshot_flags = []
    monkeypatch.setattr(tag_export_service, "count_selection_token_ids", lambda token: 3)

    def fake_iter_selection_token_id_chunks(token, chunk_size, snapshot=False):
        observed_snapshot_flags.append(snapshot)
        return iter([[1, 2, 3]])

    monkeypatch.setattr(
        tag_export_service,
        "iter_selection_token_id_chunks",
        fake_iter_selection_token_id_chunks,
    )

    source = vlm_router._build_batch_image_source(
        vlm_router.BatchCaptionRequest(selection_token="token-abc")
    )

    assert source.source_type == "selection_token"
    assert source.total == 3
    assert list(source.iter_chunks()) == [[1, 2, 3]]
    assert observed_snapshot_flags == [True]


def test_vlm_caption_batch_accepts_selection_token(monkeypatch, test_client, test_db, tmp_path: Path):
    import database as db
    import routers.vlm as vlm_router
    from vlm_providers.base import VLMResult

    image_a = tmp_path / "token-vlm-a.png"
    image_b = tmp_path / "token-vlm-b.png"
    Image.new("RGB", (32, 32), color="white").save(image_a)
    Image.new("RGB", (32, 32), color="black").save(image_b)

    matching_id = db.add_image(path=str(image_a), filename=image_a.name)
    other_id = db.add_image(path=str(image_b), filename=image_b.name)
    db.add_tags(matching_id, [{"tag": "vlm-token-scope", "confidence": 0.9}])
    db.add_tags(other_id, [{"tag": "other-scope", "confidence": 0.9}])

    token_response = test_client.post("/api/images/selection-token", json={
        "tags": ["vlm-token-scope"],
        "tagMode": "and",
        "sortBy": "newest",
    })
    assert token_response.status_code == 200
    selection_token = token_response.json()["selection_token"]

    class FakeProvider:
        name = "fake_vlm"

        def __init__(self, config):
            self.config = config

        def build_user_message(self, tags=None):
            return "caption token scope"

        async def caption_image(self, image_path, *, tags=None):
            return VLMResult(caption=f"captioned {Path(image_path).name}", tokens_used=7, model="m")

    monkeypatch.setattr(vlm_router, "get_provider", lambda config: FakeProvider(config))
    monkeypatch.setattr(
        vlm_router,
        "_build_config",
        lambda overrides=None: vlm_router.VLMConfig(
            endpoint="https://example.test/v1",
            model="m",
            concurrent_requests=2,
        ),
    )
    scheduled = []
    real_create_task = asyncio.create_task

    def fake_create_task(coro):
        scheduled.append(coro)
        return None

    monkeypatch.setattr(vlm_router.asyncio, "create_task", fake_create_task)

    response = test_client.post("/api/vlm/caption-batch", json={"selection_token": selection_token})

    assert response.status_code == 200
    assert response.json()["total"] == 1
    assert response.json()["source"] == "selection_token"
    assert scheduled

    monkeypatch.setattr(vlm_router.asyncio, "create_task", real_create_task)
    asyncio.run(scheduled.pop())
    progress = test_client.get("/api/vlm/caption-batch/progress").json()
    assert progress["completed"] == 1
    assert progress["failed"] == 0

    assert db.get_image_by_id(matching_id)["ai_caption"] == f"captioned {image_a.name}"
    assert not db.get_image_by_id(other_id).get("ai_caption")


def test_vlm_caption_batch_accepts_filters_payload(monkeypatch, test_client, test_db, tmp_path: Path):
    import database as db
    import routers.vlm as vlm_router
    from vlm_providers.base import VLMResult

    image_path = tmp_path / "filters-vlm.png"
    other_path = tmp_path / "filters-vlm-other.png"
    Image.new("RGB", (32, 32), color="white").save(image_path)
    Image.new("RGB", (32, 32), color="black").save(other_path)
    image_id = db.add_image(path=str(image_path), filename=image_path.name, generator="comfyui", prompt="clean prompt")
    other_id = db.add_image(path=str(other_path), filename=other_path.name, prompt="blocked-term")
    db.add_tags(image_id, [{"tag": "vlm-filter-scope", "confidence": 0.9}])
    db.add_tags(other_id, [{"tag": "vlm-filter-scope", "confidence": 0.9}])
    db.set_user_rating(image_id, 5)
    db.set_user_rating(other_id, 5)
    db.update_image_colors(image_id, {"avg_brightness": 220, "color_temperature": "warm"})
    db.update_image_colors(other_id, {"avg_brightness": 20, "color_temperature": "cool"})
    collection = db.create_collection("VLM Filter Contract")
    db.set_collection_membership(int(collection["id"]), image_id, True)

    class FakeProvider:
        def __init__(self, config):
            self.config = config

        def build_user_message(self, tags=None):
            return "caption filters scope"

        async def caption_image(self, image_path, *, tags=None):
            return VLMResult(caption="captioned from filters", model="m")

    monkeypatch.setattr(vlm_router, "get_provider", lambda config: FakeProvider(config))
    monkeypatch.setattr(
        vlm_router,
        "_build_config",
        lambda overrides=None: vlm_router.VLMConfig(
            endpoint="https://example.test/v1",
            model="m",
            concurrent_requests=1,
        ),
    )
    scheduled = []
    real_create_task = asyncio.create_task

    def fake_create_task(coro):
        scheduled.append(coro)
        return None

    monkeypatch.setattr(vlm_router.asyncio, "create_task", fake_create_task)

    response = test_client.post("/api/vlm/caption-batch", json={
        "filters": {
            "tags": ["vlm-filter-scope"],
            "tagMode": "and",
            "sortBy": "newest",
            "minUserRating": 4,
            "excludePrompts": ["blocked-term"],
            "excludeColors": ["cool"],
            "collectionId": int(collection["id"]),
            "folder": str(tmp_path),
            "hasMetadata": True,
        }
    })

    assert response.status_code == 200
    assert response.json()["total"] == 1
    assert response.json()["source"] == "filters"

    monkeypatch.setattr(vlm_router.asyncio, "create_task", real_create_task)
    asyncio.run(scheduled.pop())
    assert db.get_image_by_id(image_id)["ai_caption"] == "captioned from filters"
    assert not db.get_image_by_id(other_id).get("ai_caption")


def test_vlm_run_batch_uses_bounded_gather_for_large_inputs(monkeypatch, test_db):
    import routers.vlm as vlm_router

    monkeypatch.setattr(vlm_router, "get_provider", lambda config: object())
    monkeypatch.setattr(
        vlm_router,
        "_build_config",
        lambda overrides=None: vlm_router.VLMConfig(
            endpoint="https://example.test/v1",
            model="m",
            concurrent_requests=3,
        ),
    )

    gather_sizes = []
    real_gather = asyncio.gather

    async def counting_gather(*aws, **kwargs):
        gather_sizes.append(len(aws))
        return await real_gather(*aws, **kwargs)

    monkeypatch.setattr(vlm_router.asyncio, "gather", counting_gather)

    source = vlm_router._build_batch_image_source(
        vlm_router.BatchCaptionRequest(image_ids=list(range(1, 51)))
    )
    with vlm_router._batch_state_lock:
        vlm_router._batch_state.update({
            "running": True,
            "cancel_requested": False,
            "total": source.total,
            "completed": 0,
            "failed": 0,
            "tokens_used": 0,
            "errors": [],
            "current_image": "",
            "active_requests": 0,
            "api_status": "queued",
            "api_message": "",
            "api_ok": 0,
            "api_error": 0,
            "last_api_latency_ms": None,
            "last_api_error": "",
            "output_format": "nl_caption",
        })

    asyncio.run(vlm_router._run_batch(source))

    assert gather_sizes
    assert max(gather_sizes) <= 4


def test_vlm_settings_reject_invalid_concurrent_requests(test_client):
    response = test_client.post("/api/vlm/settings", json={"concurrent_requests": 0})

    assert response.status_code == 400
    assert "concurrent_requests" in response.text


def test_vlm_settings_preserve_prompt_with_tags(test_client, monkeypatch):
    import routers.vlm as vlm_router

    saved = {}
    monkeypatch.setattr(vlm_router, "_load_vlm_settings", lambda: dict(saved))
    monkeypatch.setattr(vlm_router, "_save_vlm_settings", lambda settings: saved.update(settings))

    response = test_client.post(
        "/api/vlm/settings",
        json={
            "provider": "openai",
            "model": "qa-model",
            "user_prompt": "Describe the image.",
            "user_prompt_with_tags": "Describe the image using these tags: {tags}",
            "include_tags_as_context": True,
        },
    )

    assert response.status_code == 200
    assert saved["user_prompt_with_tags"] == "Describe the image using these tags: {tags}"

    settings_response = test_client.get("/api/vlm/settings")
    assert settings_response.status_code == 200
    assert settings_response.json()["user_prompt_with_tags"] == "Describe the image using these tags: {tags}"

    config = vlm_router._build_config()
    assert config.user_prompt_with_tags == "Describe the image using these tags: {tags}"


def test_vlm_caption_params_roundtrip_and_clamp(test_client, monkeypatch):
    """v3.4.3: caption_max_tokens / caption_temperature flow save → get →
    _build_config, with corrupt values clamped to safe bounds."""
    import routers.vlm as vlm_router

    saved = {}
    monkeypatch.setattr(vlm_router, "_load_vlm_settings", lambda: dict(saved))
    monkeypatch.setattr(vlm_router, "_save_vlm_settings", lambda settings: saved.update(settings))

    response = test_client.post(
        "/api/vlm/settings",
        json={"caption_max_tokens": 2048, "caption_temperature": 0.7},
    )
    assert response.status_code == 200
    assert saved["caption_max_tokens"] == 2048
    assert saved["caption_temperature"] == 0.7

    settings_response = test_client.get("/api/vlm/settings")
    assert settings_response.json()["caption_max_tokens"] == 2048

    config = vlm_router._build_config()
    assert config.caption_max_tokens == 2048
    assert config.caption_temperature == 0.7

    # Corrupt stored values clamp instead of crashing.
    saved.update({"caption_max_tokens": 1, "caption_temperature": 99})
    config = vlm_router._build_config()
    assert config.caption_max_tokens == 64
    assert config.caption_temperature == 2.0


def test_vlm_settings_reject_out_of_range_caption_params(test_client):
    assert test_client.post(
        "/api/vlm/settings", json={"caption_max_tokens": 10}
    ).status_code == 400
    assert test_client.post(
        "/api/vlm/settings", json={"caption_temperature": 5.0}
    ).status_code == 400


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


def test_vlm_caption_batch_queued_while_smart_tag_active(monkeypatch, test_client):
    from types import SimpleNamespace

    import routers.vlm as vlm_router
    from services import tagging_pipeline_service
    from services.tagging_pipeline_service import KIND_VLM, get_tagging_pipeline_service

    monkeypatch.setattr(
        tagging_pipeline_service.smart_tag_service,
        "get_active_job",
        lambda: SimpleNamespace(job_id="smart-active", status="running"),
    )

    response = test_client.post("/api/vlm/caption-batch", json={"image_ids": [1]})

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "queued"
    assert body["pipeline_queued"] is True
    assert body["queue_position"] == 1
    # A queued start must not claim the batch slot.
    assert vlm_router.is_caption_batch_active() is False
    assert get_tagging_pipeline_service().remove_queued_jobs(KIND_VLM) == 1


def test_smart_tag_start_queued_while_vlm_batch_active(test_client):
    import routers.vlm as vlm_router
    from services.tagging_pipeline_service import KIND_SMART, get_tagging_pipeline_service

    with vlm_router._batch_state_lock:
        original_running = vlm_router._batch_state["running"]
        vlm_router._batch_state["running"] = True
    try:
        response = test_client.post(
            "/api/smart-tag/start",
            json={"image_ids": [1], "enable_vlm": False},
        )
        assert response.status_code == 200
        body = response.json()
        assert body["status"] == "queued"
        assert body["pipeline_queued"] is True
    finally:
        with vlm_router._batch_state_lock:
            vlm_router._batch_state["running"] = original_running
        get_tagging_pipeline_service().remove_queued_jobs(KIND_SMART)


def test_gallery_tag_start_queued_while_vlm_batch_active(test_client):
    import routers.vlm as vlm_router
    from services.tagging_pipeline_service import KIND_GALLERY, get_tagging_pipeline_service

    with vlm_router._batch_state_lock:
        original_running = vlm_router._batch_state["running"]
        vlm_router._batch_state["running"] = True
    try:
        response = test_client.post("/api/tag/start", json={"image_ids": [1]})
        assert response.status_code == 200
        body = response.json()
        assert body["status"] == "queued"
        assert body["pipeline_queued"] is True
        assert body["pipeline_mode"] == "gallery-tag"
    finally:
        with vlm_router._batch_state_lock:
            vlm_router._batch_state["running"] = original_running
        get_tagging_pipeline_service().remove_queued_jobs(KIND_GALLERY)


def test_vlm_batch_progress_reports_queued_entry(monkeypatch, test_client):
    from types import SimpleNamespace

    from services import tagging_pipeline_service
    from services.tagging_pipeline_service import KIND_VLM, get_tagging_pipeline_service

    monkeypatch.setattr(
        tagging_pipeline_service.smart_tag_service,
        "get_active_job",
        lambda: SimpleNamespace(job_id="smart-active", status="running"),
    )
    enqueue = test_client.post("/api/vlm/caption-batch", json={"image_ids": [42]})
    assert enqueue.status_code == 200
    assert enqueue.json()["status"] == "queued"

    try:
        progress = test_client.get("/api/vlm/caption-batch/progress")
        assert progress.status_code == 200
        queue_info = progress.json()["pipeline_queue"]
        assert queue_info["total_queued"] == 1
        assert queue_info["queued"][0]["kind"] == "vlm-caption-batch"
        assert queue_info["queued"][0]["position"] == 1
    finally:
        get_tagging_pipeline_service().remove_queued_jobs(KIND_VLM)


def test_vlm_batch_cancel_clears_queued_entries(monkeypatch, test_client):
    from types import SimpleNamespace

    from services import tagging_pipeline_service

    monkeypatch.setattr(
        tagging_pipeline_service.smart_tag_service,
        "get_active_job",
        lambda: SimpleNamespace(job_id="smart-active", status="running"),
    )
    enqueue = test_client.post("/api/vlm/caption-batch", json={"image_ids": [7]})
    assert enqueue.status_code == 200
    assert enqueue.json()["status"] == "queued"

    cancel = test_client.post("/api/vlm/caption-batch/cancel")
    assert cancel.status_code == 200
    body = cancel.json()
    assert body["status"] == "queue_cleared"
    assert body["removed_queued"] == 1

    # Nothing running and nothing queued anymore → the old 400 contract.
    second = test_client.post("/api/vlm/caption-batch/cancel")
    assert second.status_code == 400


def test_start_caption_batch_from_queue_starts_claimed_batch(monkeypatch):
    """The queued-dispatch entry point schedules the batch on the captured loop."""
    import asyncio
    import threading

    import routers.vlm as vlm_router

    started = threading.Event()

    async def fake_run_batch(image_source):
        with vlm_router._batch_state_lock:
            vlm_router._batch_state["running"] = False
        started.set()

    monkeypatch.setattr(vlm_router, "_run_batch", fake_run_batch)
    monkeypatch.setattr(
        vlm_router,
        "_build_batch_image_source",
        lambda request: vlm_router._BatchImageSource(
            source_type="image_ids", total=1, iter_chunks=lambda: iter([[1]])
        ),
    )
    monkeypatch.setattr(
        vlm_router,
        "_build_config",
        lambda overrides=None: vlm_router.VLMConfig(endpoint="https://example.test/v1", model="m"),
    )

    loop = asyncio.new_event_loop()
    thread = threading.Thread(target=loop.run_forever, daemon=True)
    thread.start()
    try:
        vlm_router.claim_caption_batch_slot()
        vlm_router.start_caption_batch_from_queue({"image_ids": [1]}, loop)
        assert started.wait(5.0), "queued batch never started on the captured loop"
    finally:
        loop.call_soon_threadsafe(loop.stop)
        thread.join(timeout=2.0)
        loop.close()
        with vlm_router._batch_state_lock:
            vlm_router._batch_state["running"] = False


def test_vlm_caption_batch_releases_slot_when_source_resolution_fails(monkeypatch, test_client):
    from fastapi import HTTPException

    import routers.vlm as vlm_router

    def boom(request):
        raise HTTPException(400, "selection token no longer decodes")

    monkeypatch.setattr(vlm_router, "_build_batch_image_source", boom)

    response = test_client.post("/api/vlm/caption-batch", json={"image_ids": [1]})

    assert response.status_code == 400
    assert vlm_router.is_caption_batch_active() is False


def test_vlm_caption_batch_resolves_selection_count_off_event_loop(monkeypatch, test_client):
    """Selection-token source resolution must not run on the event loop.

    count_selection_token_ids runs a filtered COUNT over the whole library —
    a slow synchronous SQLite query on 80k+ libraries. caption_batch must
    resolve the image source in a worker thread (same idiom as
    colors.start_analysis), keeping the loop free for progress polls.
    """
    import routers.vlm as vlm_router
    from services import tag_export_service

    observed: dict = {}

    def fake_count(selection_token):
        # Inside a worker thread there is no running loop; on the event loop
        # thread get_running_loop() succeeds.
        try:
            asyncio.get_running_loop()
            observed["ran_on_event_loop"] = True
        except RuntimeError:
            observed["ran_on_event_loop"] = False
        return 0

    monkeypatch.setattr(tag_export_service, "count_selection_token_ids", fake_count)

    scheduled = []
    monkeypatch.setattr(vlm_router.asyncio, "create_task", lambda coro: scheduled.append(coro))

    try:
        response = test_client.post(
            "/api/vlm/caption-batch", json={"selection_token": "token-off-loop"}
        )
        assert response.status_code == 200
        assert response.json()["source"] == "selection_token"
    finally:
        for coro in scheduled:
            coro.close()
        with vlm_router._batch_state_lock:
            vlm_router._batch_state["running"] = False

    assert observed["ran_on_event_loop"] is False
