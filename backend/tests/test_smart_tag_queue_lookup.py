"""A queued Smart Tag run can be found again by its place in the AI queue.

A run queued behind other AI work has no job id when it is queued; the
dispatcher starts it later, maybe while no page watches. The started job
records the queue entry it came from (``settings.queue_id`` and
``settings.queue_enqueued_at``), and ``GET /api/smart-tag/progress?queue_id=``
answers with that job while it runs and after it ends, for as long as the
backend keeps finished Smart Tag jobs. An entry it no longer knows is said
plainly (``found: false``). Additive: V3.5 never sends ``queue_id``.
"""

from __future__ import annotations

import threading
from types import SimpleNamespace

import pytest


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
        job.status = "completed"
        job.message = "Done."
        with pipeline._jobs_lock:
            if pipeline._active_job_id == job.job_id:
                pipeline._active_job_id = None


@pytest.fixture
def smart_registry(monkeypatch):
    """An empty Smart Tag job registry and a gated pipeline (no tagger runs)."""
    from services.smart_tag import pipeline

    gate = _Gate()
    monkeypatch.setattr(pipeline, "_jobs", {})
    monkeypatch.setattr(pipeline, "_active_job_id", None)
    monkeypatch.setattr(pipeline, "_run_pipeline", gate.run)
    yield gate
    gate.release.set()


def _service(monkeypatch):
    import routers.vlm as vlm_router
    from services.tagging_pipeline_service import TaggingPipelineService

    monkeypatch.setattr(vlm_router, "is_caption_batch_active", lambda: False)
    return TaggingPipelineService(auto_dispatch=False)


class _Legacy:
    def __init__(self) -> None:
        self.progress = {"status": "running"}
        self.worker_active = True

    def get_progress(self):
        return dict(self.progress)

    def is_worker_active(self) -> bool:
        return self.worker_active


PAYLOAD = {
    "image_ids": [11, 12, 13],
    "enable_vlm": False,
    "tagger_model": "wd-swinv2-tagger-v3",
}


def _queue_behind_gallery(service, legacy):
    queued = service.start_smart_tagging(dict(PAYLOAD), legacy_service=legacy)
    assert queued["status"] == "queued"
    return queued


def test_the_queued_answer_says_when_the_entry_was_queued(monkeypatch, smart_registry):
    service = _service(monkeypatch)
    queued = _queue_behind_gallery(service, _Legacy())

    assert queued["queue_id"].startswith("q")
    assert queued["enqueued_at"] == service.queue_snapshot()["queued"][0]["enqueued_at"]


def test_while_it_waits_the_queue_place_answers_queued(monkeypatch, smart_registry):
    service = _service(monkeypatch)
    queued = _queue_behind_gallery(service, _Legacy())

    out = service.get_smart_tag_progress(queue_id=queued["queue_id"])

    assert out["found"] is True
    assert out["status"] == "queued"
    assert out["active"] is False
    assert out["queue_id"] == queued["queue_id"]
    assert "job_id" not in out


def test_a_run_started_while_no_page_watched_is_found_running_and_after_it_ended(
    monkeypatch, smart_registry
):
    service = _service(monkeypatch)
    legacy = _Legacy()
    queued = _queue_behind_gallery(service, legacy)

    # the gallery run ends; the dispatcher starts the queued Smart Tag run
    legacy.progress = {"status": "done"}
    legacy.worker_active = False
    assert service.dispatch_pending_once() is True
    assert smart_registry.started.wait(5)

    running = service.get_smart_tag_progress(queue_id=queued["queue_id"])
    assert running["found"] is True
    assert running["status"] == "running"
    assert running["active"] is True
    assert running["total"] == 3
    assert running["settings"]["queue_id"] == queued["queue_id"]
    assert running["settings"]["queue_enqueued_at"] == queued["enqueued_at"]
    job_id = running["job_id"]

    # it ends while nobody looks; the queue place still names it
    smart_registry.release.set()
    for _ in range(100):
        if service.get_smart_tag_progress(job_id=job_id)["status"] == "completed":
            break
        threading.Event().wait(0.05)
    ended = service.get_smart_tag_progress(queue_id=queued["queue_id"])
    assert ended["found"] is True
    assert ended["job_id"] == job_id
    assert ended["status"] == "completed"
    assert ended["active"] is False
    # asking without a queue place is unchanged: no run is active now
    assert service.get_smart_tag_progress()["status"] == "idle"


def test_a_place_the_backend_no_longer_knows_is_said_plainly(
    monkeypatch, smart_registry
):
    service = _service(monkeypatch)

    out = service.get_smart_tag_progress(queue_id="q404")

    assert out["found"] is False
    assert out["active"] is False
    assert out["queue_id"] == "q404"
    assert "job_id" not in out


def test_an_entry_that_failed_to_start_answers_failed(monkeypatch, smart_registry):
    from services import tagging_pipeline_service

    service = _service(monkeypatch)
    legacy = _Legacy()
    queued = _queue_behind_gallery(service, legacy)
    monkeypatch.setattr(
        tagging_pipeline_service.smart_tag_service,
        "start_smart_tag_job",
        lambda _payload: (_ for _ in ()).throw(ValueError("VLM endpoint missing")),
    )
    legacy.progress = {"status": "done"}
    legacy.worker_active = False
    assert service.dispatch_pending_once() is True

    out = service.get_smart_tag_progress(queue_id=queued["queue_id"])

    assert out["found"] is True
    assert out["status"] == "failed"
    assert "VLM endpoint missing" in out["message"]


def test_a_start_not_from_the_queue_carries_no_queue_place(monkeypatch, smart_registry):
    service = _service(monkeypatch)
    legacy = _Legacy()
    legacy.progress = {"status": "idle"}
    legacy.worker_active = False

    started = service.start_smart_tagging(dict(PAYLOAD), legacy_service=legacy)

    assert started["status"] in ("queued", "running")
    assert "queue_id" not in started["settings"]


def test_the_route_passes_the_queue_place(test_client):
    """GET /api/smart-tag/progress?queue_id= reaches the service (V3.5's calls are unchanged)."""
    from services.tagging_pipeline_service import set_tagging_pipeline_service

    seen = []

    def fake_progress(job_id=None, queue_id=None):
        seen.append((job_id, queue_id))
        return {"status": "queued", "found": True, "queue_id": queue_id}

    set_tagging_pipeline_service(SimpleNamespace(get_smart_tag_progress=fake_progress))
    assert (
        test_client.get("/api/smart-tag/progress", params={"queue_id": "q7"}).json()[
            "queue_id"
        ]
        == "q7"
    )
    test_client.get("/api/smart-tag/progress", params={"job_id": "abc"})
    test_client.get("/api/smart-tag/progress")
    assert seen == [(None, "q7"), ("abc", None), (None, None)]
