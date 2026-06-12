"""Contracts for the unified tagging pipeline boundary.

v3.4.1 (Debt-16): when another AI job runs, start requests are QUEUED
(200 + {"status": "queued", ...}) instead of rejected with 409. Probe
failures (sibling status unknowable) still fail closed with the old
409/RuntimeError contract. These tests pin both behaviors plus the FIFO
dispatch lifecycle: auto-start after finish/error/cancel, queue-not-wedged
on start failure, queued-cancel, duplicate collapse, and cross-kind order.
"""

from __future__ import annotations

import time
from types import SimpleNamespace

import pytest
from fastapi import HTTPException


class _FakeLegacyTaggingService:
    def __init__(self, progress=None):
        self.progress = progress or {"status": "idle"}
        self.started = False
        self.start_count = 0
        self.cancelled = False

    def get_progress(self):
        return dict(self.progress)

    def start_tagging(self, request, background_tasks):
        self.started = True
        self.start_count += 1
        return {"status": "started", "message": "legacy started"}

    def cancel_tagging(self):
        self.cancelled = True
        self.progress = {"status": "cancelled"}
        return {"status": "cancelled", "message": "legacy cancelled"}


def _make_service(**kwargs):
    from services.tagging_pipeline_service import TaggingPipelineService

    kwargs.setdefault("auto_dispatch", False)
    return TaggingPipelineService(**kwargs)


def _idle_probes(monkeypatch):
    """Force all three busy probes to 'idle'."""
    import routers.vlm as vlm_router
    from services import tagging_pipeline_service

    monkeypatch.setattr(tagging_pipeline_service.smart_tag_service, "get_active_job", lambda: None)
    monkeypatch.setattr(vlm_router, "is_caption_batch_active", lambda: False)


# ---------------------------------------------------------------------------
# Busy → queued (200) instead of 409
# ---------------------------------------------------------------------------


def test_gallery_start_queues_while_smart_tag_is_active(monkeypatch):
    import routers.vlm as vlm_router
    from services import tagging_pipeline_service
    from services.tagging_service import TagRequest

    service = _make_service()
    legacy = _FakeLegacyTaggingService()
    monkeypatch.setattr(
        tagging_pipeline_service.smart_tag_service,
        "get_active_job",
        lambda: SimpleNamespace(job_id="smart-active", status="running"),
    )
    monkeypatch.setattr(vlm_router, "is_caption_batch_active", lambda: False)

    out = service.start_gallery_tagging(
        TagRequest(image_ids=[1]), background_tasks=None, legacy_service=legacy
    )

    assert out["status"] == "queued"
    assert out["pipeline_queued"] is True
    assert out["queue_position"] == 1
    assert out["queue_id"]
    assert out["pipeline_owner"] == "unified-tagging"
    assert out["pipeline_mode"] == "gallery-tag"
    assert legacy.started is False


def test_smart_start_queues_while_gallery_tag_is_active(monkeypatch):
    import routers.vlm as vlm_router
    from services import tagging_pipeline_service

    service = _make_service()
    legacy = _FakeLegacyTaggingService(progress={"status": "running", "message": "Tagging 1/10"})
    monkeypatch.setattr(tagging_pipeline_service.smart_tag_service, "get_active_job", lambda: None)
    monkeypatch.setattr(vlm_router, "is_caption_batch_active", lambda: False)
    monkeypatch.setattr(
        tagging_pipeline_service.smart_tag_service,
        "start_smart_tag_job",
        lambda _payload: pytest.fail("smart tag should be queued, not started, while gallery tagging is active"),
    )

    out = service.start_smart_tagging({"image_ids": [1]}, legacy_service=legacy)

    assert out["status"] == "queued"
    assert out["pipeline_queued"] is True
    assert out["queue_position"] == 1
    assert out["pipeline_mode"] == "smart-tag"


def test_gallery_self_busy_queues_instead_of_409(monkeypatch):
    """A second gallery-tag start while a live worker runs must queue."""
    from services.tagging_service import TagRequest

    service = _make_service()
    _idle_probes(monkeypatch)

    class _BusyLegacy(_FakeLegacyTaggingService):
        def start_tagging(self, request, background_tasks):
            raise HTTPException(status_code=409, detail="Tagging already in progress")

    out = service.start_gallery_tagging(
        TagRequest(image_ids=[1]), background_tasks=None, legacy_service=_BusyLegacy()
    )

    assert out["status"] == "queued"
    assert out["pipeline_queued"] is True


def test_gallery_validation_409_still_propagates(monkeypatch):
    """Non-busy 409s (e.g. hardware floors) must NOT be converted to queued."""
    from services.tagging_service import TagRequest

    service = _make_service()
    _idle_probes(monkeypatch)

    class _RejectingLegacy(_FakeLegacyTaggingService):
        def start_tagging(self, request, background_tasks):
            raise HTTPException(status_code=409, detail="ToriiGate GPU mode is blocked on this hardware")

    with pytest.raises(HTTPException) as exc:
        service.start_gallery_tagging(
            TagRequest(image_ids=[1]), background_tasks=None, legacy_service=_RejectingLegacy()
        )

    assert exc.value.status_code == 409
    assert "ToriiGate" in str(exc.value.detail)
    assert service.queue_snapshot()["total_queued"] == 0


def test_vlm_start_queues_while_smart_tag_is_active(monkeypatch):
    import routers.vlm as vlm_router
    from services import tagging_pipeline_service

    service = _make_service()
    legacy = _FakeLegacyTaggingService()
    monkeypatch.setattr(
        tagging_pipeline_service.smart_tag_service,
        "get_active_job",
        lambda: SimpleNamespace(job_id="smart-active", status="running"),
    )
    monkeypatch.setattr(vlm_router, "is_caption_batch_active", lambda: False)

    out = service.start_vlm_caption_batch(
        lambda: pytest.fail("the VLM batch slot must not be claimed while Smart Tag runs"),
        payload={"image_ids": [1]},
        loop=None,
        legacy_service=legacy,
    )

    assert out is not None
    assert out["status"] == "queued"
    assert out["pipeline_queued"] is True
    assert out["pipeline_mode"] == "vlm-caption-batch"


def test_vlm_start_queues_while_gallery_tag_is_active(monkeypatch):
    import routers.vlm as vlm_router
    from services import tagging_pipeline_service

    service = _make_service()
    legacy = _FakeLegacyTaggingService(progress={"status": "running", "message": "Tagging 1/10"})
    monkeypatch.setattr(tagging_pipeline_service.smart_tag_service, "get_active_job", lambda: None)
    monkeypatch.setattr(vlm_router, "is_caption_batch_active", lambda: False)

    out = service.start_vlm_caption_batch(
        lambda: pytest.fail("the VLM batch slot must not be claimed while AI Tag runs"),
        payload={"image_ids": [1]},
        loop=None,
        legacy_service=legacy,
    )

    assert out is not None
    assert out["status"] == "queued"


def test_smart_start_queues_while_vlm_batch_is_active(monkeypatch):
    import routers.vlm as vlm_router
    from services import tagging_pipeline_service

    service = _make_service()
    legacy = _FakeLegacyTaggingService()
    monkeypatch.setattr(tagging_pipeline_service.smart_tag_service, "get_active_job", lambda: None)
    monkeypatch.setattr(vlm_router, "is_caption_batch_active", lambda: True)
    monkeypatch.setattr(
        tagging_pipeline_service.smart_tag_service,
        "start_smart_tag_job",
        lambda _payload: pytest.fail("smart tag should be queued, not started, while a VLM batch is active"),
    )

    out = service.start_smart_tagging({"image_ids": [1]}, legacy_service=legacy)

    assert out["status"] == "queued"
    assert out["pipeline_queued"] is True


def test_gallery_start_queues_while_vlm_batch_is_active(monkeypatch):
    import routers.vlm as vlm_router
    from services import tagging_pipeline_service
    from services.tagging_service import TagRequest

    service = _make_service()
    legacy = _FakeLegacyTaggingService()
    monkeypatch.setattr(tagging_pipeline_service.smart_tag_service, "get_active_job", lambda: None)
    monkeypatch.setattr(vlm_router, "is_caption_batch_active", lambda: True)

    out = service.start_gallery_tagging(
        TagRequest(image_ids=[1]), background_tasks=None, legacy_service=legacy
    )

    assert out["status"] == "queued"
    assert legacy.started is False


# ---------------------------------------------------------------------------
# Fail-closed probe behavior (unchanged contract)
# ---------------------------------------------------------------------------


class _BrokenLegacy:
    def get_progress(self):
        raise RuntimeError("status backend exploded")


def test_unified_pipeline_refuses_smart_start_when_legacy_status_probe_raises(monkeypatch):
    from services import tagging_pipeline_service

    service = _make_service()
    monkeypatch.setattr(
        tagging_pipeline_service.smart_tag_service,
        "start_smart_tag_job",
        lambda _payload: pytest.fail("must not start when the AI Tag status is unknown"),
    )

    with pytest.raises(RuntimeError) as exc:
        service.start_smart_tagging({"image_ids": [1]}, legacy_service=_BrokenLegacy())

    assert "AI Tag" in str(exc.value)
    assert service.queue_snapshot()["total_queued"] == 0


def test_unified_pipeline_refuses_vlm_claim_when_legacy_status_probe_raises(monkeypatch):
    from services import tagging_pipeline_service

    service = _make_service()
    monkeypatch.setattr(tagging_pipeline_service.smart_tag_service, "get_active_job", lambda: None)

    with pytest.raises(HTTPException) as exc:
        service.start_vlm_caption_batch(
            lambda: pytest.fail("the VLM batch slot must not be claimed when AI Tag status is unknown"),
            payload={"image_ids": [1]},
            loop=None,
            legacy_service=_BrokenLegacy(),
        )

    assert exc.value.status_code == 409
    assert "AI Tag" in str(exc.value.detail)
    assert service.queue_snapshot()["total_queued"] == 0


def test_gallery_start_refuses_when_vlm_probe_raises(monkeypatch):
    import routers.vlm as vlm_router
    from services import tagging_pipeline_service
    from services.tagging_service import TagRequest

    service = _make_service()
    legacy = _FakeLegacyTaggingService()
    monkeypatch.setattr(tagging_pipeline_service.smart_tag_service, "get_active_job", lambda: None)

    def _boom():
        raise RuntimeError("vlm probe exploded")

    monkeypatch.setattr(vlm_router, "is_caption_batch_active", _boom)

    with pytest.raises(HTTPException) as exc:
        service.start_gallery_tagging(TagRequest(image_ids=[1]), background_tasks=None, legacy_service=legacy)

    assert exc.value.status_code == 409
    assert legacy.started is False
    assert service.queue_snapshot()["total_queued"] == 0


# ---------------------------------------------------------------------------
# Started-now response shapes stay backwards compatible
# ---------------------------------------------------------------------------


def test_unified_pipeline_claims_vlm_batch_when_idle(monkeypatch):
    service = _make_service()
    legacy = _FakeLegacyTaggingService()
    _idle_probes(monkeypatch)

    claimed = []
    out = service.start_vlm_caption_batch(
        lambda: claimed.append(True),
        payload={"image_ids": [1]},
        loop=None,
        legacy_service=legacy,
    )

    assert out is None
    assert claimed == [True]


def test_unified_pipeline_adds_owner_metadata_to_both_start_paths(monkeypatch):
    from services import tagging_pipeline_service
    from services.tagging_service import TagRequest

    service = _make_service()
    legacy = _FakeLegacyTaggingService()
    _idle_probes(monkeypatch)
    monkeypatch.setattr(
        tagging_pipeline_service.smart_tag_service,
        "start_smart_tag_job",
        lambda _payload: {"job_id": "smart-1", "status": "queued"},
    )

    gallery = service.start_gallery_tagging(TagRequest(image_ids=[1]), background_tasks=None, legacy_service=legacy)
    smart = service.start_smart_tagging({"image_ids": [1]}, legacy_service=legacy)

    assert gallery["status"] == "started"
    assert "pipeline_queued" not in gallery
    assert gallery["pipeline_owner"] == "unified-tagging"
    assert gallery["pipeline_mode"] == "gallery-tag"
    assert smart["job_id"] == "smart-1"
    assert smart["pipeline_owner"] == "unified-tagging"
    assert smart["pipeline_mode"] == "smart-tag"


# ---------------------------------------------------------------------------
# FIFO dispatch lifecycle
# ---------------------------------------------------------------------------


def test_queued_job_auto_starts_after_smart_job_finishes(monkeypatch):
    import routers.vlm as vlm_router
    from services import tagging_pipeline_service
    from services.tagging_service import TagRequest

    service = _make_service()
    legacy = _FakeLegacyTaggingService()
    smart_job = {"job": SimpleNamespace(job_id="smart-active", status="running")}
    monkeypatch.setattr(
        tagging_pipeline_service.smart_tag_service, "get_active_job", lambda: smart_job["job"]
    )
    monkeypatch.setattr(vlm_router, "is_caption_batch_active", lambda: False)

    out = service.start_gallery_tagging(TagRequest(image_ids=[1]), background_tasks=None, legacy_service=legacy)
    assert out["status"] == "queued"

    # Still busy: nothing starts.
    assert service.dispatch_pending_once() is False
    assert legacy.started is False

    # Smart Tag finishes (success path) → the queued gallery job starts.
    smart_job["job"] = None
    assert service.dispatch_pending_once() is True
    assert legacy.started is True
    assert service.queue_snapshot()["total_queued"] == 0


def test_queued_job_auto_starts_after_gallery_cancel(monkeypatch):
    from services import tagging_pipeline_service

    service = _make_service()
    legacy = _FakeLegacyTaggingService(progress={"status": "running"})
    _idle_probes(monkeypatch)

    started_payloads = []
    monkeypatch.setattr(
        tagging_pipeline_service.smart_tag_service,
        "start_smart_tag_job",
        lambda payload: started_payloads.append(payload) or {"job_id": "smart-2", "status": "queued"},
    )

    out = service.start_smart_tagging({"image_ids": [7]}, legacy_service=legacy)
    assert out["status"] == "queued"
    assert service.dispatch_pending_once() is False

    # Cancel the running gallery job → probe flips idle → queued job starts.
    service.cancel_gallery_tagging(legacy_service=legacy)
    assert legacy.cancelled is True
    assert service.dispatch_pending_once() is True
    assert started_payloads and started_payloads[0]["image_ids"] == [7]


def test_failed_queued_start_does_not_wedge_queue(monkeypatch):
    """A queued job whose start raises is dropped (error recorded) and the
    next queued job still starts."""
    import routers.vlm as vlm_router
    from services import tagging_pipeline_service
    from services.tagging_service import TagRequest

    service = _make_service()
    smart_job = {"job": SimpleNamespace(job_id="smart-active", status="running")}
    monkeypatch.setattr(
        tagging_pipeline_service.smart_tag_service, "get_active_job", lambda: smart_job["job"]
    )
    monkeypatch.setattr(vlm_router, "is_caption_batch_active", lambda: False)

    class _ExplodingLegacy(_FakeLegacyTaggingService):
        def start_tagging(self, request, background_tasks):
            if request.image_ids == [1]:
                raise HTTPException(status_code=400, detail="selection token no longer decodes")
            return super().start_tagging(request, background_tasks)

    legacy = _ExplodingLegacy()
    first = service.start_gallery_tagging(TagRequest(image_ids=[1]), background_tasks=None, legacy_service=legacy)
    second = service.start_gallery_tagging(TagRequest(image_ids=[2]), background_tasks=None, legacy_service=legacy)
    assert first["queue_position"] == 1
    assert second["queue_position"] == 2

    smart_job["job"] = None

    # First dispatch consumes the broken entry without starting it...
    assert service.dispatch_pending_once() is True
    assert legacy.started is False
    snapshot = service.queue_snapshot("gallery-tag")
    assert snapshot["total_queued"] == 1
    assert "selection token" in str(snapshot["last_start_error"]["error"])

    # ...and the next dispatch starts the surviving entry.
    assert service.dispatch_pending_once() is True
    assert legacy.started is True
    # A successful start clears the recorded error for the kind.
    assert service.queue_snapshot("gallery-tag")["last_start_error"] is None


def test_dispatch_fail_closed_when_probe_unknown(monkeypatch):
    """If a sibling probe is unknowable at dispatch time, the queue waits."""
    import routers.vlm as vlm_router
    from services import tagging_pipeline_service
    from services.tagging_service import TagRequest

    service = _make_service()
    legacy = _FakeLegacyTaggingService()
    smart_job = {"job": SimpleNamespace(job_id="smart-active", status="running")}
    monkeypatch.setattr(
        tagging_pipeline_service.smart_tag_service, "get_active_job", lambda: smart_job["job"]
    )
    monkeypatch.setattr(vlm_router, "is_caption_batch_active", lambda: False)

    service.start_gallery_tagging(TagRequest(image_ids=[1]), background_tasks=None, legacy_service=legacy)
    smart_job["job"] = None

    def _boom():
        raise RuntimeError("vlm probe exploded")

    monkeypatch.setattr(vlm_router, "is_caption_batch_active", _boom)

    assert service.dispatch_pending_once() is False
    assert legacy.started is False
    assert service.queue_snapshot()["total_queued"] == 1


def test_cross_kind_fifo_order(monkeypatch):
    import routers.vlm as vlm_router
    from services import tagging_pipeline_service
    from services.tagging_service import TagRequest

    service = _make_service()
    vlm_active = {"value": True}
    monkeypatch.setattr(tagging_pipeline_service.smart_tag_service, "get_active_job", lambda: None)
    monkeypatch.setattr(vlm_router, "is_caption_batch_active", lambda: vlm_active["value"])

    order = []

    class _RecordingLegacy(_FakeLegacyTaggingService):
        def start_tagging(self, request, background_tasks):
            order.append("gallery-tag")
            return super().start_tagging(request, background_tasks)

    legacy = _RecordingLegacy()
    monkeypatch.setattr(
        tagging_pipeline_service.smart_tag_service,
        "start_smart_tag_job",
        lambda payload: order.append("smart-tag") or {"job_id": "smart-3", "status": "queued"},
    )
    monkeypatch.setattr(
        tagging_pipeline_service,
        "_start_queued_vlm_batch",
        lambda entry: order.append("vlm-caption-batch"),
    )

    g = service.start_gallery_tagging(TagRequest(image_ids=[1]), background_tasks=None, legacy_service=legacy)
    s = service.start_smart_tagging({"image_ids": [2]}, legacy_service=legacy)
    v = service.start_vlm_caption_batch(
        lambda: pytest.fail("must queue, not claim"),
        payload={"image_ids": [3]},
        loop=None,
        legacy_service=legacy,
    )
    assert (g["queue_position"], s["queue_position"], v["queue_position"]) == (1, 2, 3)

    vlm_active["value"] = False
    assert service.dispatch_pending_once() is True
    # The fake starters do not flip any probe to busy, so all three drain.
    assert service.dispatch_pending_once() is True
    assert service.dispatch_pending_once() is True
    assert service.dispatch_pending_once() is False
    assert order == ["gallery-tag", "smart-tag", "vlm-caption-batch"]


def test_duplicate_consecutive_enqueue_collapsed(monkeypatch):
    import routers.vlm as vlm_router
    from services import tagging_pipeline_service
    from services.tagging_service import TagRequest

    service = _make_service()
    legacy = _FakeLegacyTaggingService()
    monkeypatch.setattr(
        tagging_pipeline_service.smart_tag_service,
        "get_active_job",
        lambda: SimpleNamespace(job_id="smart-active", status="running"),
    )
    monkeypatch.setattr(vlm_router, "is_caption_batch_active", lambda: False)

    first = service.start_gallery_tagging(TagRequest(image_ids=[1]), background_tasks=None, legacy_service=legacy)
    dup = service.start_gallery_tagging(TagRequest(image_ids=[1]), background_tasks=None, legacy_service=legacy)
    different = service.start_gallery_tagging(TagRequest(image_ids=[2]), background_tasks=None, legacy_service=legacy)

    assert first["status"] == "queued"
    assert dup["status"] == "queued"
    assert dup["duplicate"] is True
    assert dup["queue_id"] == first["queue_id"]
    assert different.get("duplicate") is None
    assert service.queue_snapshot()["total_queued"] == 2


# ---------------------------------------------------------------------------
# Queued-state exposure + queued-cancel
# ---------------------------------------------------------------------------


def test_progress_payloads_expose_queue_state(monkeypatch):
    import routers.vlm as vlm_router
    from services import tagging_pipeline_service
    from services.tagging_service import TagRequest

    service = _make_service()
    legacy = _FakeLegacyTaggingService()
    monkeypatch.setattr(
        tagging_pipeline_service.smart_tag_service,
        "get_active_job",
        lambda: SimpleNamespace(
            job_id="smart-active",
            status="running",
            snapshot=lambda: {"job_id": "smart-active", "status": "running"},
        ),
    )
    monkeypatch.setattr(vlm_router, "is_caption_batch_active", lambda: False)

    service.start_gallery_tagging(TagRequest(image_ids=[1]), background_tasks=None, legacy_service=legacy)
    service.start_smart_tagging({"image_ids": [2]}, legacy_service=legacy)

    gallery_progress = service.get_gallery_progress(legacy_service=legacy)
    queue_info = gallery_progress["pipeline_queue"]
    assert queue_info["total_queued"] == 2
    assert len(queue_info["queued"]) == 1
    assert queue_info["queued"][0]["kind"] == "gallery-tag"
    assert queue_info["queued"][0]["position"] == 1

    smart_progress = service.get_smart_tag_progress()
    smart_queue = smart_progress["pipeline_queue"]
    assert smart_queue["total_queued"] == 2
    assert len(smart_queue["queued"]) == 1
    assert smart_queue["queued"][0]["kind"] == "smart-tag"
    assert smart_queue["queued"][0]["position"] == 2


def test_cancel_gallery_removes_queued_entries(monkeypatch):
    import routers.vlm as vlm_router
    from services import tagging_pipeline_service
    from services.tagging_service import TagRequest

    service = _make_service()
    legacy = _FakeLegacyTaggingService()
    monkeypatch.setattr(
        tagging_pipeline_service.smart_tag_service,
        "get_active_job",
        lambda: SimpleNamespace(job_id="smart-active", status="running"),
    )
    monkeypatch.setattr(vlm_router, "is_caption_batch_active", lambda: False)

    service.start_gallery_tagging(TagRequest(image_ids=[1]), background_tasks=None, legacy_service=legacy)
    out = service.cancel_gallery_tagging(legacy_service=legacy)

    assert out["removed_queued"] == 1
    assert service.queue_snapshot()["total_queued"] == 0


def test_cancel_smart_clears_queued_when_no_active_job(monkeypatch):
    import routers.vlm as vlm_router
    from services import tagging_pipeline_service

    service = _make_service()
    legacy = _FakeLegacyTaggingService(progress={"status": "running"})
    monkeypatch.setattr(tagging_pipeline_service.smart_tag_service, "get_active_job", lambda: None)
    monkeypatch.setattr(tagging_pipeline_service.smart_tag_service, "cancel_active_job", lambda: None)
    monkeypatch.setattr(vlm_router, "is_caption_batch_active", lambda: False)

    out = service.start_smart_tagging({"image_ids": [1]}, legacy_service=legacy)
    assert out["status"] == "queued"

    cancelled = service.cancel_smart_tagging()
    assert cancelled["status"] == "queue_cleared"
    assert cancelled["removed_queued"] == 1
    assert service.queue_snapshot()["total_queued"] == 0


def test_cancel_smart_still_404_when_nothing_active_or_queued(monkeypatch):
    from services import tagging_pipeline_service

    service = _make_service()
    monkeypatch.setattr(tagging_pipeline_service.smart_tag_service, "cancel_active_job", lambda: None)

    with pytest.raises(HTTPException) as exc:
        service.cancel_smart_tagging()

    assert exc.value.status_code == 404


# ---------------------------------------------------------------------------
# Background dispatcher thread
# ---------------------------------------------------------------------------


def test_dispatcher_thread_auto_starts_queued_job(monkeypatch):
    import routers.vlm as vlm_router
    from services import tagging_pipeline_service
    from services.tagging_service import TagRequest

    service = _make_service(auto_dispatch=True, poll_interval=0.05)
    legacy = _FakeLegacyTaggingService()
    smart_job = {"job": SimpleNamespace(job_id="smart-active", status="running")}
    monkeypatch.setattr(
        tagging_pipeline_service.smart_tag_service, "get_active_job", lambda: smart_job["job"]
    )
    monkeypatch.setattr(vlm_router, "is_caption_batch_active", lambda: False)

    try:
        out = service.start_gallery_tagging(
            TagRequest(image_ids=[1]), background_tasks=None, legacy_service=legacy
        )
        assert out["status"] == "queued"
        time.sleep(0.2)
        assert legacy.started is False  # still blocked by the running smart job

        smart_job["job"] = None
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline and not legacy.started:
            time.sleep(0.05)
        assert legacy.started is True
        assert service.queue_snapshot()["total_queued"] == 0
    finally:
        # Never leave queued entries for a daemon thread to dispatch after
        # the monkeypatches are unwound.
        service.remove_queued_jobs("gallery-tag")
        service.remove_queued_jobs("smart-tag")
        service.remove_queued_jobs("vlm-caption-batch")
