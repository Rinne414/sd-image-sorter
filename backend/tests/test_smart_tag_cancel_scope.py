"""Cancelling one Smart Tag run leaves the other queued Smart Tag runs alone.

``POST /api/smart-tag/cancel`` used to drop every queued Smart Tag run along
with the active one, so a page cancelling its own run also removed runs other
pages had queued. With ``job_id`` and/or ``queue_id`` only that run is touched:
its queue entry is dropped while it waits, and its job is cancelled when it is
the active one. Without either (older clients) nothing changes.
"""

from __future__ import annotations

import threading

import pytest
from fastapi import HTTPException


class _Gate:
    """A fake Smart Tag pipeline: running until released, then completed."""

    def __init__(self) -> None:
        self.release = threading.Event()
        self.started = threading.Event()

    def run(self, job, req) -> None:
        from services.smart_tag import pipeline

        job.status = "running"
        job.total = len(req.image_ids)
        self.started.set()
        self.release.wait(10)
        job.processed = job.succeeded = job.total
        job.status = "cancelled" if job.cancel_requested else "completed"
        with pipeline._jobs_lock:
            if pipeline._active_job_id == job.job_id:
                pipeline._active_job_id = None


@pytest.fixture
def smart_registry(monkeypatch):
    from services.smart_tag import pipeline

    gate = _Gate()
    monkeypatch.setattr(pipeline, "_jobs", {})
    monkeypatch.setattr(pipeline, "_active_job_id", None)
    monkeypatch.setattr(pipeline, "_run_pipeline", gate.run)
    yield gate
    gate.release.set()


class _Legacy:
    def __init__(self, busy: bool = True) -> None:
        self.progress = {"status": "running" if busy else "idle"}
        self.worker_active = busy

    def get_progress(self):
        return dict(self.progress)

    def is_worker_active(self) -> bool:
        return self.worker_active


def _service(monkeypatch):
    import routers.vlm as vlm_router
    from services.tagging_pipeline_service import TaggingPipelineService

    monkeypatch.setattr(vlm_router, "is_caption_batch_active", lambda: False)
    return TaggingPipelineService(auto_dispatch=False)


def _payload(first_id: int) -> dict:
    return {
        "image_ids": [first_id, first_id + 1],
        "enable_vlm": False,
        "tagger_model": "wd-swinv2-tagger-v3",
    }


def _queued_ids(service) -> list[str]:
    return [item["queue_id"] for item in service.queue_snapshot("smart-tag")["queued"]]


def test_cancelling_a_queued_run_keeps_the_other_queued_runs(
    monkeypatch, smart_registry
):
    service = _service(monkeypatch)
    legacy = _Legacy(busy=True)
    mine = service.start_smart_tagging(_payload(1), legacy_service=legacy)
    theirs = service.start_smart_tagging(_payload(11), legacy_service=legacy)
    assert mine["status"] == theirs["status"] == "queued"

    out = service.cancel_smart_tagging(queue_id=mine["queue_id"])

    assert out["removed_queued"] == 1
    assert out["cancel_requested"] is False
    assert _queued_ids(service) == [theirs["queue_id"]]


def test_cancelling_the_active_run_keeps_the_queued_runs(monkeypatch, smart_registry):
    service = _service(monkeypatch)
    started = service.start_smart_tagging(
        _payload(1), legacy_service=_Legacy(busy=False)
    )
    assert smart_registry.started.wait(5)
    queued = service.start_smart_tagging(
        _payload(11), legacy_service=_Legacy(busy=False)
    )
    assert queued["status"] == "queued"

    out = service.cancel_smart_tagging(job_id=started["job_id"])

    assert out["cancel_requested"] is True
    assert out["job_id"] == started["job_id"]
    assert out["removed_queued"] == 0
    assert _queued_ids(service) == [queued["queue_id"]]


def test_a_queue_place_that_already_started_cancels_that_job(
    monkeypatch, smart_registry
):
    service = _service(monkeypatch)
    legacy = _Legacy(busy=True)
    mine = service.start_smart_tagging(_payload(1), legacy_service=legacy)
    theirs = service.start_smart_tagging(_payload(11), legacy_service=legacy)
    legacy.progress = {"status": "done"}
    legacy.worker_active = False
    assert service.dispatch_pending_once() is True
    assert smart_registry.started.wait(5)

    out = service.cancel_smart_tagging(queue_id=mine["queue_id"])

    assert out["cancel_requested"] is True
    assert out["removed_queued"] == 0
    assert _queued_ids(service) == [theirs["queue_id"]]


def test_a_job_that_is_not_the_active_one_is_not_cancelled(monkeypatch, smart_registry):
    service = _service(monkeypatch)
    service.start_smart_tagging(_payload(1), legacy_service=_Legacy(busy=False))
    assert smart_registry.started.wait(5)

    with pytest.raises(HTTPException) as exc_info:
        service.cancel_smart_tagging(job_id="not-the-active-job")
    assert exc_info.value.status_code == 404

    from services import smart_tag_service

    assert smart_tag_service.get_active_job().cancel_requested is False


def test_without_a_run_named_every_queued_run_is_still_removed(
    monkeypatch, smart_registry
):
    service = _service(monkeypatch)
    legacy = _Legacy(busy=True)
    service.start_smart_tagging(_payload(1), legacy_service=legacy)
    service.start_smart_tagging(_payload(11), legacy_service=legacy)

    out = service.cancel_smart_tagging()

    assert out["removed_queued"] == 2
    assert _queued_ids(service) == []


def test_the_route_passes_the_run_it_names(test_client):
    from services.tagging_pipeline_service import (
        get_tagging_pipeline_service,
        set_tagging_pipeline_service,
    )

    seen = []

    class _Fake:
        def cancel_smart_tagging(self, job_id=None, queue_id=None):
            seen.append((job_id, queue_id))
            return {"status": "queue_cleared", "removed_queued": 1}

    previous = get_tagging_pipeline_service()
    set_tagging_pipeline_service(_Fake())
    try:
        assert test_client.post("/api/smart-tag/cancel?queue_id=q7").status_code == 200
        assert test_client.post("/api/smart-tag/cancel?job_id=abc").status_code == 200
        assert test_client.post("/api/smart-tag/cancel").status_code == 200
    finally:
        set_tagging_pipeline_service(previous)
    assert seen == [(None, "q7"), ("abc", None), (None, None)]
