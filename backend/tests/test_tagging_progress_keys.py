"""Tagging progress carries message_key + message_args so the UI can localise it.

The English ``message`` stays for API compatibility. The worker runs in
process here with the deterministic stub tagger (see test_tagging_pins_worker).
"""

from __future__ import annotations

from pathlib import Path

import pytest

import services.tagging_service as tsvc
from services.tagging_service import TaggingService
from tests.test_tagging_pins_worker import (  # noqa: F401  (fixtures and helpers)
    _StaticEvent,
    _RecorderQueue,
    _add_image,
    _payload,
    _run_worker,
    fake_tagger_env,
)


def _keys(messages):
    return [m.get("message_key") for m in messages]


def test_default_state_has_empty_key_and_args():
    state = tsvc._build_tag_progress_state("idle")

    assert state["message_key"] == ""
    assert state["message_args"] == {}


def test_worker_lifecycle_keys_and_counts(fake_tagger_env, tmp_path: Path) -> None:
    image_id = _add_image(tmp_path, "lifecycle.png")

    messages = _run_worker(_payload([image_id]))
    keys = _keys(messages)

    assert "loading_model" in keys
    assert "collecting" in keys
    started = next(m for m in messages if m.get("message_key") == "tagging_started")
    assert started["total"] == 1
    assert "image_done" in keys
    done_image = next(m for m in messages if m.get("message_key") == "image_done")
    assert done_image["message_args"]["item"] == "lifecycle.png"
    terminal = messages[-1]
    assert terminal["status"] == "done"
    assert terminal["message_key"] == "done"
    assert terminal["tagged"] == 1


def test_loading_model_key_names_the_device(fake_tagger_env, tmp_path: Path) -> None:
    image_id = _add_image(tmp_path, "device.png")

    messages = _run_worker(_payload([image_id]))
    loading = next(m for m in messages if m.get("message_key") == "loading_model")

    assert loading["message_args"]["device"] == "cpu"


def test_cancel_before_processing_has_key(fake_tagger_env, tmp_path: Path) -> None:
    image_id = _add_image(tmp_path, "cancel_early.png")

    messages = _run_worker(_payload([image_id]), cancelled=True)

    assert messages[-1]["message_key"] == "cancelled_early"


def test_unreadable_image_key_carries_only_the_file_name(
    fake_tagger_env, monkeypatch, tmp_path: Path
) -> None:
    image_id = _add_image(tmp_path, "gone_missing.png")
    monkeypatch.setattr(
        tsvc, "resolve_existing_indexed_image_path", lambda *args, **kwargs: None
    )

    messages = _run_worker(_payload([image_id]))
    skipped = next(m for m in messages if m.get("message_key") == "skipped_unreadable")

    assert skipped["message_args"] == {"item": "gone_missing.png"}
    assert messages[-1]["message_key"] == "done"
    assert messages[-1]["errors"] == 1


def test_worker_error_has_key_and_raw_detail(
    fake_tagger_env, monkeypatch, tmp_path: Path
) -> None:
    image_id = _add_image(tmp_path, "boom.png")

    def boom(*args, **kwargs):
        raise RuntimeError("model exploded")

    monkeypatch.setattr(tsvc, "verify_image_readable", boom)
    messages = _run_worker(_payload([image_id]))
    terminal = messages[-1]

    assert terminal["status"] == "error"
    assert terminal["message_key"] == "error"
    assert terminal["message_args"]["detail"] == "model exploded"


def test_cancelling_and_cancelled_states_have_keys(test_db) -> None:
    service = TaggingService.__new__(TaggingService)
    service.__init__()
    service.set_progress({"status": "running", "current": 2, "total": 5})
    service._active_run_id = 1
    service._pending_run_id = None

    result = service.cancel_tagging()

    assert result["status"] == "cancelled"
    progress = service.get_progress()
    assert progress["message_key"] == "cancelled"
    assert progress["current"] == 2
    assert progress["total"] == 5


def test_start_response_has_started_key(test_db, monkeypatch) -> None:
    from fastapi import BackgroundTasks

    from services.tagging_service import TagRequest

    service = TaggingService()
    service._get_tagger = lambda *a, **k: object()
    result = service.start_tagging(
        TagRequest(image_ids=[1], model_name="wd-swinv2-tagger-v3"),
        BackgroundTasks(),
    )

    assert result["message_key"] == "started"
    assert service.get_progress()["message_key"] == "preparing"


def test_gpu_fallback_and_runtime_notice_carry_their_reason(
    fake_tagger_env, monkeypatch, tmp_path: Path
) -> None:
    image_id = _add_image(tmp_path, "gpu.png")
    payload = _payload([image_id])
    payload["startup_notice"] = "Auto runtime is using the highest batched throughput."
    payload["effective_use_gpu"] = True
    payload["request"]["use_gpu"] = True

    messages = _run_worker(payload)
    notice = next(m for m in messages if m.get("message_key") == "runtime_notice")
    assert notice["message_args"]["notice"].startswith("Auto runtime")
    failed = [m for m in messages if m.get("message_key") == "gpu_load_failed"]
    for message in failed:
        assert message["message_args"]["reason"]


def test_monitor_error_carries_the_raw_detail() -> None:
    import inspect

    from services.tagging import jobs

    source = inspect.getsource(jobs)
    assert 'message_key="monitor_error"' in source
    assert 'message_args={"detail": str(error)}' in source.split('message_key="monitor_error"')[1][:120]


def test_bulk_job_snapshot_carries_the_message_key() -> None:
    from services.bulk_job_service import BulkJobService

    service = BulkJobService()
    job_id = service.create_job(
        "export_sidecars", total=3, message="Exporting 3 images...", message_key="exporting"
    )

    assert service.get_job(job_id)["message_key"] == "exporting"
