"""SEC1f: tag-start path checks never run while a global job lock is held.

`_validate_tag_request` resolves user model paths; on an offline NAS that is an
SMB timeout. The pipeline's start lock and the gallery transition lock are also
taken by the progress / queue polls, so touching the filesystem under them
stalls every poll. The checks run first, lock-free; the lock section may repeat
them harmlessly.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from services import gallery_job_gate
from services import tagging_pipeline_service as tps
from services.tagging_service import TagRequest


class _Legacy:
    """Gallery service stand-in whose validator records which locks are held."""

    def __init__(self, fail_for=()):
        self.fail_for = set(fail_for)
        self.validated = []
        self.locked_during_validation = []
        self.started = []

    def _validate_tag_request(self, request):
        self.locked_during_validation.append(
            (tps._start_lock.locked(), gallery_job_gate._gallery_job_transition_lock.locked())
        )
        self.validated.append(request.image_ids)
        if tuple(request.image_ids) in self.fail_for:
            raise HTTPException(status_code=400, detail="model path is invalid")

    def start_tagging(self, request, background_tasks):
        self.started.append(request.image_ids)
        return {"status": "started"}

    def get_progress(self):
        return {"status": "idle"}

    def is_worker_active(self):
        return False


@pytest.fixture
def service(monkeypatch):
    monkeypatch.setattr(tps.smart_tag_service, "get_active_job", lambda: None)
    import routers.vlm as vlm_router

    monkeypatch.setattr(vlm_router, "is_caption_batch_active", lambda: False)
    return tps.TaggingPipelineService(auto_dispatch=False)


def _first_validation_ran_lock_free(legacy):
    assert legacy.locked_during_validation, "the request was never validated"
    assert legacy.locked_during_validation[0] == (False, False)


def test_start_validates_the_request_before_taking_the_locks(service):
    legacy = _Legacy()
    service.start_gallery_tagging(
        TagRequest(image_ids=[1]), background_tasks=None, legacy_service=legacy
    )
    _first_validation_ran_lock_free(legacy)
    assert legacy.started == [[1]]


def test_an_invalid_request_is_refused_without_touching_the_queue(service):
    legacy = _Legacy(fail_for={(1,)})
    with pytest.raises(HTTPException) as caught:
        service.start_gallery_tagging(
            TagRequest(image_ids=[1]), background_tasks=None, legacy_service=legacy
        )
    assert caught.value.status_code == 400
    assert legacy.started == []


def test_the_dispatcher_validates_the_head_before_taking_the_locks(service):
    queued = _Legacy()
    # Queue one job behind a busy smart job, then free the runtime.
    busy = {"job": SimpleNamespace(job_id="smart", status="running")}
    tps.smart_tag_service.get_active_job = lambda: busy["job"]
    try:
        service.start_gallery_tagging(
            TagRequest(image_ids=[7]), background_tasks=None, legacy_service=queued
        )
        busy["job"] = None
        queued.locked_during_validation.clear()
        assert service.dispatch_pending_once() is True
    finally:
        pass
    _first_validation_ran_lock_free(queued)
    assert queued.started == [[7]]


def test_a_queued_job_that_fails_validation_is_dropped_and_the_next_one_runs(service):
    legacy = _Legacy(fail_for={(1,)})
    busy = {"job": SimpleNamespace(job_id="smart", status="running")}
    tps.smart_tag_service.get_active_job = lambda: busy["job"]
    service._queue.append(
        tps._QueuedPipelineJob(
            queue_id="q1", kind=tps.KIND_GALLERY,
            payload=TagRequest(image_ids=[1]), legacy_service=legacy,
        )
    )
    service._queue.append(
        tps._QueuedPipelineJob(
            queue_id="q2", kind=tps.KIND_GALLERY,
            payload=TagRequest(image_ids=[2]), legacy_service=legacy,
        )
    )
    busy["job"] = None
    legacy.locked_during_validation.clear()

    assert service.dispatch_pending_once() is True  # q1 fails and is dropped
    assert service.queue_snapshot()["total_queued"] == 1
    error = service.queue_snapshot("gallery-tag")["last_start_error"]
    assert "model path is invalid" in error["error"]
    assert legacy.started == []

    assert service.dispatch_pending_once() is True  # q2 starts
    assert legacy.started == [[2]]
    _first_validation_ran_lock_free(legacy)


def _queue_gallery_jobs(service, legacy, *image_id_lists, library_id=None):
    for index, ids in enumerate(image_id_lists, start=1):
        entry = tps._QueuedPipelineJob(
            queue_id=f"q{index}",
            kind=tps.KIND_GALLERY,
            payload=TagRequest(image_ids=list(ids)),
            legacy_service=legacy,
        )
        if library_id:
            entry.library_id = library_id
        service._queue.append(entry)


def test_the_validator_method_the_pipeline_relies_on_exists():
    from services.tagging_service import TaggingService

    assert callable(getattr(TaggingService, "_validate_tag_request", None)), (
        "tagging_pipeline_service._prevalidate_gallery_request calls "
        "TaggingService._validate_tag_request by name; update it if renamed"
    )


def test_the_queued_head_is_validated_inside_its_own_library(service):
    seen = []

    class _LibraryLegacy(_Legacy):
        def _validate_tag_request(self, request):
            from library_context import get_current_library_id

            seen.append(get_current_library_id())
            super()._validate_tag_request(request)

    legacy = _LibraryLegacy()
    _queue_gallery_jobs(service, legacy, [1], library_id="lib-other")
    assert service.dispatch_pending_once() is True
    assert seen[0] == "lib-other"


def test_a_head_swapped_during_the_lock_free_check_is_not_started_unchecked(service):
    """Cancel + re-queue while the old head's slow check runs: the new head is
    checked lock-free on the next poll, never validated under the locks."""
    class _SwappingLegacy(_Legacy):
        def _validate_tag_request(self, request):
            if tuple(request.image_ids) == (4,):
                service.remove_queued_jobs(tps.KIND_GALLERY)
                _queue_gallery_jobs(service, new, [9])
                return super()._validate_tag_request(request)
            raise AssertionError("unexpected request")

    new = _Legacy()
    old = _SwappingLegacy(fail_for={(4,)})
    _queue_gallery_jobs(service, old, [4])

    assert service.dispatch_pending_once() is False  # old head gone, new unchecked
    assert new.started == [] and new.validated == []
    assert service.queue_snapshot()["total_queued"] == 1  # the new head survived

    assert service.dispatch_pending_once() is True
    assert new.started == [[9]]
    assert new.locked_during_validation[0] == (False, False)
