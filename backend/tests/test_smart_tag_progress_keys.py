"""Smart Tag progress carries message_key + message_args so the UI can localise it.

The English ``message`` stays for API compatibility. Counts the UI needs
(``succeeded`` / ``failed`` / ``skipped`` / ``processed`` / ``total``) are
already snapshot fields.
"""

from __future__ import annotations

import pytest

import services.smart_tag_service as smart_tag_service
from services.smart_tag.jobs import SmartTagJobState
from services.smart_tag.pipeline import cancel_active_job, cancel_job_if_active
from services.smart_tag.request import SmartTagRequest
from services.smart_tag_service import _run_pipeline


@pytest.fixture
def stubbed_sources(monkeypatch):
    monkeypatch.setattr(
        smart_tag_service,
        "_resolve_image_paths",
        lambda ids: {int(i): f"/tmp/image-{i}.png" for i in ids},
    )
    monkeypatch.setattr(smart_tag_service, "_already_tagged_ids", lambda ids: set())
    persisted = []
    monkeypatch.setattr(
        smart_tag_service,
        "_persist_result",
        lambda image_id, result, merge_strategy, **_: persisted.append(image_id),
    )
    return persisted


def _request(ids, **overrides):
    values = {"image_ids": ids, "enable_wd14": False, "enable_vlm": False}
    values.update(overrides)
    return SmartTagRequest(**values)


def test_default_snapshot_has_empty_key_and_args() -> None:
    snapshot = SmartTagJobState(job_id="idle").snapshot()

    assert snapshot["message_key"] == ""
    assert snapshot["message_args"] == {}


def test_completed_run_has_done_key_and_counts(stubbed_sources) -> None:
    job = SmartTagJobState(job_id="done")

    _run_pipeline(job, _request([1, 2, 3]))
    snapshot = job.snapshot()

    assert snapshot["status"] == "completed"
    assert snapshot["message_key"] == "done"
    assert (snapshot["succeeded"], snapshot["failed"], snapshot["skipped"]) == (3, 0, 0)


def test_skip_existing_keeps_the_done_key_with_the_skipped_count(
    monkeypatch, stubbed_sources
) -> None:
    monkeypatch.setattr(smart_tag_service, "_already_tagged_ids", lambda ids: {1, 3})
    job = SmartTagJobState(job_id="skip")

    _run_pipeline(job, _request([1, 2, 3, 4], skip_existing=True))
    snapshot = job.snapshot()

    assert snapshot["message_key"] == "done"
    assert snapshot["skipped"] == 2


def test_run_that_fails_every_image_has_failed_all_key_and_raw_detail(
    monkeypatch, stubbed_sources
) -> None:
    def boom(*args, **kwargs):
        raise RuntimeError("disk is full")

    monkeypatch.setattr(smart_tag_service, "_persist_result", boom)
    job = SmartTagJobState(job_id="failed-all")

    _run_pipeline(job, _request([1, 2]))
    snapshot = job.snapshot()

    assert snapshot["status"] == "failed"
    assert snapshot["message_key"] == "failed_all"
    assert snapshot["message_args"]["detail"] == "disk is full"


def test_run_with_some_failures_has_the_warning_key(
    monkeypatch, stubbed_sources
) -> None:
    calls = []

    def flaky(image_id, result, merge_strategy, **_):
        calls.append(image_id)
        if image_id == 2:
            raise RuntimeError("bad image")

    monkeypatch.setattr(smart_tag_service, "_persist_result", flaky)
    job = SmartTagJobState(job_id="warn")

    _run_pipeline(job, _request([1, 2, 3]))
    snapshot = job.snapshot()

    assert snapshot["status"] == "warning"
    assert snapshot["message_key"] == "done_warning"


def test_empty_selection_has_no_images_key(monkeypatch, stubbed_sources) -> None:
    monkeypatch.setattr(smart_tag_service, "_request_total", lambda req: 0)
    job = SmartTagJobState(job_id="empty")

    _run_pipeline(job, _request([1]))

    assert job.status == "failed"
    assert job.message_key == "no_images"


def test_unexpected_exception_has_failed_key_and_raw_detail(
    monkeypatch, stubbed_sources
) -> None:
    def boom(req):
        raise RuntimeError("selection token is stale")

    monkeypatch.setattr(smart_tag_service, "_request_total", boom)
    job = SmartTagJobState(job_id="boom")

    _run_pipeline(job, _request([1]))

    assert job.status == "failed"
    assert job.message_key == "failed"
    assert job.message_args["detail"] == "selection token is stale"


def test_cancel_request_has_the_cancel_requested_key(monkeypatch) -> None:
    from services.smart_tag import pipeline

    job = SmartTagJobState(job_id="cancel-me", status="running")
    monkeypatch.setattr(pipeline, "_jobs", {"cancel-me": job})
    monkeypatch.setattr(pipeline, "_active_job_id", "cancel-me")

    assert cancel_job_if_active("cancel-me") is job
    assert job.message_key == "cancel_requested"

    job.message_key = ""
    assert cancel_active_job() is job
    assert job.message_key == "cancel_requested"


def test_cancelled_run_has_the_cancelled_key(stubbed_sources) -> None:
    job = SmartTagJobState(job_id="cancelled")
    job.cancel_requested = True

    _run_pipeline(job, _request([1, 2]))

    assert job.status == "cancelled"
    assert job.message_key == "cancelled"


def test_queue_lookup_answers_carry_keys(monkeypatch) -> None:
    import routers.vlm as vlm_router
    from services.tagging_pipeline_service import TaggingPipelineService

    monkeypatch.setattr(vlm_router, "is_caption_batch_active", lambda: False)
    service = TaggingPipelineService(auto_dispatch=False)
    monkeypatch.setattr(smart_tag_service, "get_job_by_queue_id", lambda queue_id: None)

    answer = service.get_smart_tag_progress(queue_id="q404")

    assert answer["status"] == "unknown"
    assert answer["message_key"] == "queued_unknown"


def test_device_fallback_is_flagged_on_later_messages_and_the_terminal_state(
    stubbed_sources,
) -> None:
    job = SmartTagJobState(job_id="cpu")
    job.set_message("phase2", "Phase 2/2", count=1, captioner="Florence-2 Base")
    assert "device_note" not in job.message_args

    job.caption_device_note = "Florence-2 ran on the CPU because there is no CUDA GPU."
    job.set_message("captioning_progress", "VLM captioning 1/2")
    assert job.message_args["device_note"] == "cpu_fallback"

    _run_pipeline_with_note = SmartTagJobState(job_id="cpu-done")
    _run_pipeline_with_note.caption_device_note = "x"
    _run_pipeline(_run_pipeline_with_note, _request([1, 2]))
    assert _run_pipeline_with_note.message_key == "done"
    assert _run_pipeline_with_note.message_args["device_note"] == "cpu_fallback"
