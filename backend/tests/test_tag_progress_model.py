"""GET /api/tag/progress names the running model and whether it runs on the GPU.

The V4 AI-busy chip reads these two fields to name a tagging run that another
page (or V3.5) started.
"""

from __future__ import annotations

import pytest
from fastapi import BackgroundTasks

from services.tagging_service import (
    TagRequest,
    TaggingService,
    _build_tag_progress_state,
)


def test_progress_carries_the_model_and_the_requested_device_until_it_loads():
    loading = _build_tag_progress_state(
        "running", model="pixai-tagger-v1.0", runtime_backend_target="gpu"
    )
    fell_back = _build_tag_progress_state(
        "running",
        model="pixai-tagger-v1.0",
        runtime_backend_target="gpu",
        runtime_backend_actual="cpu",
    )
    idle = _build_tag_progress_state("idle")

    assert (loading["model"], loading["uses_gpu"]) == ("pixai-tagger-v1.0", True)
    assert fell_back["uses_gpu"] is False
    assert (idle["model"], idle["uses_gpu"]) == ("", False)


def test_start_tagging_names_the_model_at_once():
    service = TaggingService()
    service.set_tagger_getter(lambda **_kwargs: object())

    service.start_tagging(
        TagRequest(model_name="pixai-tagger-v1.0", use_gpu=True), BackgroundTasks()
    )

    progress = service.get_progress()
    assert progress["status"] == "running"
    assert progress["model"] == "pixai-tagger-v1.0"
    assert progress["uses_gpu"] is True


def test_worker_messages_keep_the_model_and_update_the_device():
    service = TaggingService()
    service._active_run_id = 3
    service._progress = _build_tag_progress_state(
        "running",
        run_id=3,
        model="wd-eva02-large-tagger-v3",
        runtime_backend_target="gpu",
    )

    # A message without a model (older worker) keeps the run's model; the
    # device switches to what the model actually loaded on.
    service._apply_worker_progress(
        {
            "status": "running",
            "current": 1,
            "total": 4,
            "runtime_backend_target": "gpu",
            "runtime_backend_actual": "cpu",
        },
        run_id=3,
    )

    progress = service.get_progress()
    assert progress["model"] == "wd-eva02-large-tagger-v3"
    assert progress["uses_gpu"] is False


@pytest.fixture
def isolated_tagging_service():
    from routers.tags import set_tagging_service

    service = TaggingService()
    set_tagging_service(service)
    yield service
    set_tagging_service(TaggingService())


def test_progress_route_returns_the_model_fields(test_client, isolated_tagging_service):
    isolated_tagging_service.set_progress(
        {
            "status": "running",
            "current": 2,
            "total": 9,
            "model": "pixai-tagger-v0.9",
            "runtime_backend_target": "gpu",
            "runtime_backend_actual": "gpu",
        }
    )

    data = test_client.get("/api/tag/progress").json()

    assert data["model"] == "pixai-tagger-v0.9"
    assert data["uses_gpu"] is True
