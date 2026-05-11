"""
Unit tests for tagging service runtime planning.
"""

import multiprocessing
import queue
import sys
from pathlib import Path
from unittest.mock import patch

from fastapi import BackgroundTasks, HTTPException
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent.parent))

import database as db  # noqa: E402
import services.tagging_service as tagging_service  # noqa: E402
from services.tagging_service import TagImportRequest, TagRequest, TaggingService  # noqa: E402
from services.tagging_service import _build_tag_progress_state  # noqa: E402
from services.tagging_service import _format_runtime_adjustment_message  # noqa: E402
from services.tagging_service import _iter_rescaling_batches  # noqa: E402
from hardware_monitor import recommend_tagger_config  # noqa: E402


def test_runtime_plan_applies_requested_chunk_size_for_regular_gpu_models():
    service = TaggingService()
    request = TagRequest(
        model_name="wd-swinv2-tagger-v3",
        use_gpu=True,
        batch_size=32,
    )

    with patch("hardware_monitor.get_system_info", return_value={}), patch(
        "hardware_monitor.recommend_tagger_config",
        return_value={
            "recommended_batch_size": 32,
            "recommended_cpu_chunk_size": 12,
            "recommended_session_refresh_interval": 180,
        },
    ):
        runtime_plan = service._build_runtime_plan(request)

    assert runtime_plan["effective_use_gpu"] is True
    assert runtime_plan["gpu_locked"] is False
    assert runtime_plan["fetch_batch_size"] == 32
    assert runtime_plan["commit_interval"] == min(32, 10)
    assert runtime_plan["gc_interval"] == min(32, 8)


def test_runtime_plan_clamps_requested_chunk_size_for_supported_gpu_range():
    service = TaggingService()
    request = TagRequest(
        model_name="wd-eva02-large-tagger-v3",
        use_gpu=True,
        batch_size=32,
    )

    with patch("hardware_monitor.get_system_info", return_value={}), patch(
        "hardware_monitor.recommend_tagger_config",
        return_value={
            "recommended_batch_size": 12,
            "recommended_cpu_chunk_size": 12,
            "recommended_session_refresh_interval": 180,
        },
    ):
        runtime_plan = service._build_runtime_plan(request)

    assert runtime_plan["effective_use_gpu"] is True
    assert runtime_plan["gpu_locked"] is False
    assert runtime_plan["fetch_batch_size"] == 12
    assert runtime_plan["commit_interval"] == min(12, 10)
    assert runtime_plan["gc_interval"] == min(12, 8)


def test_runtime_adjustment_message_reports_gpu_backoff_and_cpu_fallback():
    message = _format_runtime_adjustment_message(
        {
            "backoff_steps": [
                {"mode": "gpu_backoff", "from": 32, "to": 16},
                {"mode": "cpu_fallback", "from": 1, "to": 1},
            ],
            "used_cpu_fallback": True,
            "final_chunk_size": 1,
        }
    )

    assert "GPU batch 32->16" in message
    assert "GPU batch 1->CPU Safe Mode" in message
    assert "continued on CPU" in message


def test_runtime_plan_uses_small_gpu_chunks_for_toriigate():
    service = TaggingService()
    request = TagRequest(
        model_name="toriigate-0.5",
        use_gpu=True,
        batch_size=16,
    )

    runtime_plan = service._build_runtime_plan(request)

    assert runtime_plan["effective_use_gpu"] is True
    assert runtime_plan["fetch_batch_size"] == 1
    assert "multimodal caption backend" in runtime_plan["startup_notice"]


def test_toriigate_validation_blocks_gpu_when_system_ram_is_below_minimum():
    service = TaggingService()

    with patch(
        "hardware_monitor.get_system_info",
        return_value={
            "total_ram_gb": 32,
            "available_ram_gb": 20,
            "gpu_vram_total_mb": 24576,
            "gpu_vram_available_mb": 20000,
            "torch_cuda_available": True,
            "onnx_providers": ["CPUExecutionProvider"],
        },
    ):
        try:
            service._validate_tag_request(
                TagRequest(
                    model_name="toriigate-0.5",
                    use_gpu=True,
                )
            )
        except HTTPException as exc:
            assert exc.status_code == 409
            assert "ToriiGate GPU mode is blocked" in exc.detail
            assert "48 GB RAM" in exc.detail
        else:
            raise AssertionError("Expected ToriiGate hardware validation to reject 32 GB RAM")


def test_toriigate_validation_allows_gpu_when_minimums_are_met():
    service = TaggingService()

    with patch(
        "hardware_monitor.get_system_info",
        return_value={
            "total_ram_gb": 64,
            "available_ram_gb": 28,
            "gpu_vram_total_mb": 24576,
            "gpu_vram_available_mb": 20000,
            "torch_cuda_available": True,
            "onnx_providers": ["CPUExecutionProvider"],
        },
    ):
        service._validate_tag_request(
            TagRequest(
                model_name="toriigate-0.5",
                use_gpu=True,
            )
        )


def test_progress_state_preserves_actual_runtime_and_memory_pressure_fields():
    state = _build_tag_progress_state(
        "running",
        current=3,
        total=10,
        tagged=2,
        errors=1,
        message="GPU fell back to CPU",
        runtime_backend_target="gpu",
        runtime_backend_actual="cpu",
        runtime_backend_reason="CUDA unavailable",
        memory_pressure_warning="Low RAM detected",
    )

    assert state["runtime_backend_target"] == "gpu"
    assert state["runtime_backend_actual"] == "cpu"
    assert state["runtime_backend_reason"] == "CUDA unavailable"
    assert state["memory_pressure_warning"] == "Low RAM detected"


def test_progress_state_defaults_actual_backend_to_empty_when_unknown():
    """Before the tagger session exists, the worker should not claim an actual
    backend. Empty string tells the UI to fall back to the target chip and
    avoids the "GPU target -> GPU actual -> CPU actual" flip when ONNX silently
    downgrades to CPU."""
    state = _build_tag_progress_state(
        "running",
        runtime_backend_target="gpu",
        message="Loading model on GPU...",
    )

    assert state["runtime_backend_target"] == "gpu"
    assert state["runtime_backend_actual"] == ""
    assert state["runtime_backend_reason"] == ""


def test_rescaling_batches_visit_every_id_when_batch_size_shrinks_mid_run():
    """Regression for the memory-pressure path: when batch_size was reduced
    during the outer loop, the old range(0, total, batch_size) iterator kept
    stepping by the ORIGINAL size and silently skipped images. The worker now
    re-reads batch_size each iteration and advances by the slice length, so
    every id is visited exactly once no matter how often the chunk shrinks."""
    all_ids = list(range(20))
    state = {"size": 8}
    visited: list[int] = []

    for idx, (_, batch_ids) in enumerate(_iter_rescaling_batches(all_ids, lambda: state["size"])):
        visited.extend(batch_ids)
        if idx == 0:
            state["size"] = 4  # simulate memory-pressure halving after the first chunk

    assert visited == list(range(20))


def test_rescaling_batches_still_progress_when_batch_size_goes_to_zero():
    """If a caller bug ever drove batch_size to 0, the helper must still make
    forward progress instead of spinning forever. It clamps to at least 1."""
    all_ids = list(range(5))
    visited: list[int] = []

    for _, batch_ids in _iter_rescaling_batches(all_ids, lambda: 0):
        visited.extend(batch_ids)

    assert visited == list(range(5))


def test_hardware_recommendation_prefers_gpu_for_toriigate_with_torch_cuda_only():
    recommendation = recommend_tagger_config(
        {
            "gpu_name": "NVIDIA GeForce RTX 4090",
            "gpu_vram_total_mb": 24576,
            "gpu_vram_available_mb": 20000,
            "torch_cuda_available": True,
            "onnx_providers": ["CPUExecutionProvider"],
        },
        model_name="toriigate-0.5",
    )

    assert recommendation["recommended_use_gpu"] is True
    assert recommendation["risk_level"] == "low"


def _build_custom_runtime_plan(request: TagRequest):
    service = TaggingService()
    with patch(
        "hardware_monitor.get_system_info",
        return_value={
            "gpu_name": "NVIDIA GeForce RTX 4090",
            "gpu_vram_total_mb": 24576,
            "gpu_vram_available_mb": 22000,
            "torch_cuda_available": True,
            "onnx_providers": ["CUDAExecutionProvider", "CPUExecutionProvider"],
            "total_ram_gb": 64,
            "available_ram_gb": 40,
        },
    ):
        return service._build_runtime_plan(request)


def _write_custom_tagger_files(tmp_path: Path, *, profile: str = "wd14") -> tuple[Path, Path]:
    model_path = tmp_path / f"{profile}-custom.onnx"
    model_path.write_bytes(b"fake custom onnx")
    if profile == "camie-tagger-v2":
        tags_path = tmp_path / "camie-tagger-v2-metadata.json"
        tags_path.write_text("{}", encoding="utf-8")
    else:
        tags_path = tmp_path / "selected_tags.csv"
        tags_path.write_text("id,name,category\n0,1girl,0\n", encoding="utf-8")
    return model_path, tags_path


def test_runtime_plan_maps_legacy_custom_model_paths_to_wd14_profile(tmp_path: Path):
    model_path, tags_path = _write_custom_tagger_files(tmp_path)

    plan = _build_custom_runtime_plan(
        TagRequest(
            model_name="custom",
            model_path=str(model_path),
            tags_path=str(tags_path),
            use_gpu=True,
        )
    )

    assert plan["model_name"] == "wd-swinv2-tagger-v3"
    assert plan["request"]["custom_profile"] is None
    assert plan["fetch_batch_size"] == 8
    assert "Custom ONNX model on GPU" in plan["startup_notice"]


def test_custom_model_path_with_legacy_wd_model_name_stays_wd14_compatible(tmp_path: Path):
    service = TaggingService()
    model_path, tags_path = _write_custom_tagger_files(tmp_path)
    request = TagRequest(
        model_name="wd-eva02-large-tagger-v3",
        model_path=str(model_path),
        tags_path=str(tags_path),
        use_gpu=False,
    )

    service._validate_tag_request(request)
    plan = _build_custom_runtime_plan(request)

    assert plan["model_name"] == "wd-swinv2-tagger-v3"


def test_custom_wd14_runtime_plan_ignores_mutable_default_model(monkeypatch, tmp_path: Path):
    import services.tagging_service as tagging_service_module

    monkeypatch.setattr(tagging_service_module, "DEFAULT_TAGGER_MODEL", "camie-tagger-v2")
    model_path, tags_path = _write_custom_tagger_files(tmp_path)

    plan = _build_custom_runtime_plan(
        TagRequest(
            model_name="custom",
            custom_profile="wd14",
            model_path=str(model_path),
            tags_path=str(tags_path),
            use_gpu=True,
        )
    )

    assert plan["model_name"] == "wd-swinv2-tagger-v3"


def test_runtime_plan_uses_custom_camie_profile_for_local_onnx(tmp_path: Path):
    service = TaggingService()
    model_path, tags_path = _write_custom_tagger_files(tmp_path, profile="camie-tagger-v2")
    request = TagRequest(
        model_name="custom",
        custom_profile="camie-tagger-v2",
        model_path=str(model_path),
        tags_path=str(tags_path),
        use_gpu=False,
    )

    service._validate_tag_request(request)
    plan = _build_custom_runtime_plan(request)

    assert plan["model_name"] == "camie-tagger-v2"
    assert plan["fetch_batch_size"] <= 64
    assert "Custom ONNX model on CPU Safe Mode" in plan["startup_notice"]


def test_runtime_plan_uses_custom_pixai_profile_for_local_onnx(tmp_path: Path):
    service = TaggingService()
    model_path, tags_path = _write_custom_tagger_files(tmp_path, profile="pixai-tagger-v0.9")
    request = TagRequest(
        model_name="custom",
        custom_profile="pixai-tagger-v0.9",
        model_path=str(model_path),
        tags_path=str(tags_path),
        use_gpu=True,
    )

    service._validate_tag_request(request)
    plan = _build_custom_runtime_plan(request)

    assert plan["model_name"] == "pixai-tagger-v0.9"
    assert "Custom ONNX model on GPU" in plan["startup_notice"]


def test_custom_camie_profile_rejects_csv_metadata_path(tmp_path: Path):
    service = TaggingService()
    model_path, _ = _write_custom_tagger_files(tmp_path, profile="camie-tagger-v2")
    csv_path = tmp_path / "selected_tags.csv"
    csv_path.write_text("id,name,category\n0,1girl,0\n", encoding="utf-8")

    try:
        service._validate_tag_request(
            TagRequest(
                model_name="custom",
                custom_profile="camie-tagger-v2",
                model_path=str(model_path),
                tags_path=str(csv_path),
            )
        )
    except HTTPException as exc:
        assert exc.status_code == 400
        assert "camie-tagger-v2" in str(exc.detail)
        assert ".json" in str(exc.detail)
    else:
        raise AssertionError("Expected Camie custom profile to reject CSV metadata")


def test_custom_pixai_profile_rejects_json_metadata_path(tmp_path: Path):
    service = TaggingService()
    model_path, _ = _write_custom_tagger_files(tmp_path, profile="pixai-tagger-v0.9")
    json_path = tmp_path / "pixai.json"
    json_path.write_text("{}", encoding="utf-8")

    try:
        service._validate_tag_request(
            TagRequest(
                model_name="custom",
                custom_profile="pixai-tagger-v0.9",
                model_path=str(model_path),
                tags_path=str(json_path),
            )
        )
    except HTTPException as exc:
        assert exc.status_code == 400
        assert "pixai-tagger-v0.9" in str(exc.detail)
        assert ".csv" in str(exc.detail)
    else:
        raise AssertionError("Expected PixAI custom profile to reject JSON metadata")


def test_custom_model_path_must_exist_before_runtime_plan(tmp_path: Path):
    service = TaggingService()
    missing_model_path = tmp_path / "missing.onnx"
    tags_path = tmp_path / "selected_tags.csv"
    tags_path.write_text("id,name,category\n0,1girl,0\n", encoding="utf-8")

    try:
        service._validate_tag_request(
            TagRequest(
                model_name="custom",
                model_path=str(missing_model_path),
                tags_path=str(tags_path),
            )
        )
    except HTTPException as exc:
        assert exc.status_code == 400
        assert "model path is invalid" in str(exc.detail)
        assert "File does not exist" in str(exc.detail)
    else:
        raise AssertionError("Expected missing custom model_path to be rejected")


def test_explicit_custom_tags_path_must_exist(tmp_path: Path):
    service = TaggingService()
    model_path = tmp_path / "custom.onnx"
    model_path.write_bytes(b"fake custom onnx")
    missing_tags_path = tmp_path / "missing-selected-tags.csv"

    try:
        service._validate_tag_request(
            TagRequest(
                model_name="custom",
                model_path=str(model_path),
                tags_path=str(missing_tags_path),
            )
        )
    except HTTPException as exc:
        assert exc.status_code == 400
        assert "tags/metadata path" in str(exc.detail)
        assert "File does not exist" in str(exc.detail)
    else:
        raise AssertionError("Expected missing explicit tags_path to be rejected")


def test_custom_tags_path_without_model_path_is_rejected(tmp_path: Path):
    service = TaggingService()
    tags_path = tmp_path / "selected_tags.csv"
    tags_path.write_text("id,name,category\n0,1girl,0\n", encoding="utf-8")

    try:
        service._validate_tag_request(
            TagRequest(
                model_name="wd-swinv2-tagger-v3",
                tags_path=str(tags_path),
            )
        )
    except HTTPException as exc:
        assert exc.status_code == 400
        assert "requires a Custom ONNX model_path" in str(exc.detail)
    else:
        raise AssertionError("Expected standalone tags_path to be rejected")


def test_custom_paths_are_trimmed_before_extension_and_existence_checks(tmp_path: Path):
    service = TaggingService()
    model_path, tags_path = _write_custom_tagger_files(tmp_path)
    request = TagRequest(
        model_name="custom",
        model_path=f"  {model_path}  ",
        tags_path=f"  {tags_path}  ",
    )

    service._validate_tag_request(request)

    assert request.model_path == str(model_path)
    assert request.tags_path == str(tags_path)


def test_custom_toriigate_profile_is_rejected_because_it_is_not_onnx(tmp_path: Path):
    service = TaggingService()
    model_path, tags_path = _write_custom_tagger_files(tmp_path)

    try:
        service._validate_tag_request(
            TagRequest(
                model_name="custom",
                custom_profile="toriigate-0.5",
                model_path=str(model_path),
                tags_path=str(tags_path),
            )
        )
    except HTTPException as exc:
        assert exc.status_code == 400
        assert "not an ONNX tagger" in str(exc.detail)
    else:
        raise AssertionError("Expected ToriiGate custom profile to be rejected")


def test_import_tags_overwrite_uses_shared_batch_writer_and_refreshes_tag_cache(test_db, tmp_path: Path):
    image_path = tmp_path / "import-overwrite.png"
    Image.new("RGB", (32, 32), color="white").save(image_path)
    image_id = db.add_image(path=str(image_path), filename=image_path.name, metadata_json="{}")
    db.add_tags(image_id, [{"tag": "old_tag", "confidence": 0.1}])

    # Prime cache so the test verifies invalidation, not just first-read behavior.
    cached_before = db.get_all_tags()
    assert any(item["tag"] == "old_tag" for item in cached_before)

    service = TaggingService()
    result = service.import_tags(
        TagImportRequest(
            images=[
                {
                    "path": str(image_path),
                    "filename": image_path.name,
                    "tags": [
                        {"tag": "new_tag", "confidence": 0.8},
                        {"tag": "new_tag", "confidence": 0.9},
                    ],
                }
            ],
            overwrite=True,
        )
    )

    assert result == {"imported": 1, "skipped": 0}

    tags_after = db.get_image_tags(image_id)
    assert tags_after == [{"tag": "new_tag", "confidence": 0.9}]

    with db.get_db() as conn:
        row = conn.execute(
            "SELECT content_fingerprint FROM images WHERE id = ?",
            (image_id,),
        ).fetchone()
    assert row["content_fingerprint"]

    cached_after = db.get_all_tags()
    assert any(item["tag"] == "new_tag" for item in cached_after)
    assert not any(item["tag"] == "old_tag" for item in cached_after)


def test_import_tags_skips_duplicate_rows_for_same_image_when_not_overwriting(test_db, tmp_path: Path):
    image_path = tmp_path / "import-duplicate-skip.png"
    Image.new("RGB", (32, 32), color="white").save(image_path)
    image_id = db.add_image(path=str(image_path), filename=image_path.name, metadata_json="{}")

    service = TaggingService()
    result = service.import_tags(
        TagImportRequest(
            images=[
                {
                    "path": str(image_path),
                    "filename": image_path.name,
                    "tags": [{"tag": "first_tag", "confidence": 0.6}],
                },
                {
                    "path": str(image_path),
                    "filename": image_path.name,
                    "tags": [{"tag": "second_tag", "confidence": 0.7}],
                },
            ],
            overwrite=False,
        )
    )

    assert result == {"imported": 1, "skipped": 1}
    assert db.get_image_tags(image_id) == [{"tag": "first_tag", "confidence": 0.6}]


class _DeadWorker:
    def is_alive(self) -> bool:
        return False


class _StoppingWorker:
    def __init__(self):
        self._alive = True

    def is_alive(self) -> bool:
        return self._alive

    def join(self, timeout=None) -> None:
        self._alive = False

    def terminate(self) -> None:
        self._alive = False

    def kill(self) -> None:
        self._alive = False


class _FakeCancelEvent:
    def __init__(self):
        self.was_set = False

    def set(self) -> None:
        self.was_set = True


def test_start_tagging_recovers_from_stale_cancelling_state_when_worker_is_dead():
    service = TaggingService()
    service.set_tagger_getter(lambda **kwargs: object())
    service._progress = _build_tag_progress_state(
        "cancelling",
        current=3,
        total=10,
        tagged=2,
        errors=1,
        message="Cancelling... (3/10)",
    )
    service._worker_process = _DeadWorker()

    background_tasks = BackgroundTasks()
    result = service.start_tagging(
        TagRequest(
            model_name="wd-swinv2-tagger-v3",
            use_gpu=False,
        ),
        background_tasks,
    )

    progress = service.get_progress()
    assert result["status"] == "started"
    assert progress["status"] == "running"
    assert "Preparing" in progress["message"]
    assert len(background_tasks.tasks) == 1


def test_start_tagging_still_rejects_when_worker_is_actually_alive():
    service = TaggingService()
    service.set_tagger_getter(lambda **kwargs: object())
    service._progress = _build_tag_progress_state("running", current=1, total=10, message="Tagging...")
    service._worker_process = _StoppingWorker()

    try:
        service.start_tagging(
            TagRequest(
                model_name="wd-swinv2-tagger-v3",
                use_gpu=False,
            ),
            BackgroundTasks(),
        )
    except HTTPException as exc:
        assert exc.status_code == 400
        assert exc.detail == "Tagging already in progress"
    else:
        raise AssertionError("Expected start_tagging() to reject a live worker")


def test_cancel_tagging_marks_run_cancelled_once_worker_stops():
    service = TaggingService()
    service._progress = _build_tag_progress_state(
        "running",
        current=4,
        total=12,
        tagged=3,
        errors=1,
        message="Tagging...",
    )
    service._worker_process = _StoppingWorker()
    service._worker_cancel_event = _FakeCancelEvent()

    result = service.cancel_tagging()
    progress = service.get_progress()

    assert result["status"] in {"cancelling", "cancelled"}
    assert service._worker_cancel_event is None
    assert service._worker_process is None
    assert progress["status"] == "cancelled"
    assert progress["current"] == 4
    assert progress["total"] == 12
    assert "cancelled" in progress["message"].lower()


def test_cancel_tagging_invalidates_pending_run_when_worker_not_yet_spawned():
    """Regression for the cancel-vs-spawn race: if the user cancels between
    start_tagging queueing the FastAPI background task and _run_tagging_job
    actually spawning the worker process (i.e. _worker_process is still None),
    cancel_tagging must finalize 'cancelled' immediately AND bump
    _active_run_id so the pending background task aborts when it eventually
    executes. Without the bump, _run_tagging_job's `run_id == _active_run_id`
    branch would clobber progress back to 'running' and spawn a worker that
    nobody can cancel.
    """
    service = TaggingService()
    service._active_run_id = 5
    service._progress = _build_tag_progress_state(
        "running",
        current=0,
        total=0,
        message="Preparing tagger...",
        run_id=5,
    )
    service._worker_process = None
    service._worker_cancel_event = None
    service._cancel_requested = False

    result = service.cancel_tagging()
    progress = service.get_progress()

    assert result["status"] == "cancelled"
    assert progress["status"] == "cancelled"
    assert "cancelled" in progress["message"].lower()
    assert service._active_run_id > 5, (
        "active_run_id must be bumped so the pending _run_tagging_job aborts"
    )
    assert service._cancel_requested is False, (
        "_cancel_requested must not leak into the next run"
    )


def test_run_tagging_job_aborts_when_run_id_was_invalidated_by_pre_spawn_cancel():
    """Companion regression: when _run_tagging_job finally executes after the
    pre-spawn cancellation, it must take the should_abort path because run_id
    no longer matches _active_run_id. Progress must stay 'cancelled' instead
    of being overwritten back to 'running', and no worker process may be
    bound to the service.
    """
    service = TaggingService()
    service.set_tagger_getter(lambda **kwargs: object())

    pending_run_id = 5
    service._active_run_id = pending_run_id + 1
    service._progress = _build_tag_progress_state(
        "cancelled",
        current=0,
        total=0,
        message="Tagging cancelled at 0/0.",
        run_id=pending_run_id,
    )
    service._worker_process = None
    service._worker_cancel_event = None
    service._cancel_requested = False

    request = TagRequest(model_name="wd-swinv2-tagger-v3", use_gpu=False)

    with patch("hardware_monitor.get_system_info", return_value={}), patch(
        "hardware_monitor.recommend_tagger_config",
        return_value={
            "recommended_batch_size": 16,
            "recommended_cpu_chunk_size": 12,
            "recommended_session_refresh_interval": 0,
        },
    ):
        service._run_tagging_job(request, run_id=pending_run_id)

    progress = service.get_progress()
    assert progress["status"] == "cancelled", (
        "abort path must not clobber the cancelled progress"
    )
    assert progress["run_id"] == pending_run_id
    assert service._worker_process is None


def test_e2e_fake_tagger_completes_without_downloading_real_model(test_db, monkeypatch, tmp_path: Path):
    image_path = tmp_path / "fake-tagger.png"
    Image.new("RGB", (16, 16), color=(120, 80, 40)).save(image_path)
    image_id = db.add_image(str(image_path), image_path.name, metadata_json="{}")

    monkeypatch.setenv("SD_IMAGE_SORTER_E2E_FAKE_TAGGER", "1")
    monkeypatch.setattr(tagging_service, "verify_image_readable", lambda path: (True, None))

    payload = {
        "request": {
            "model_name": "wd-swinv2-tagger-v3",
            "image_ids": [image_id],
            "retag_all": False,
            "use_gpu": False,
        },
        "model_name": "wd-swinv2-tagger-v3",
        "effective_use_gpu": False,
        "fetch_batch_size": 2,
    }
    ctx = multiprocessing.get_context("spawn")
    progress_queue = ctx.Queue()
    cancel_event = ctx.Event()

    try:
        tagging_service._tagging_worker_main(payload, progress_queue, cancel_event)
        messages = []
        while True:
            try:
                messages.append(progress_queue.get(timeout=5))
            except queue.Empty:
                break
    finally:
        progress_queue.close()
        progress_queue.join_thread()

    assert messages[-1]["status"] == "done"
    assert messages[-1]["tagged"] == 1
    stored = db.get_image_tags(image_id)
    assert any(tag["tag"] == "e2e_fixture" for tag in stored)


def test_stale_worker_progress_cannot_override_newer_run_state():
    service = TaggingService()
    service._progress = _build_tag_progress_state(
        "running",
        current=1,
        total=8,
        tagged=1,
        message="New run still active",
        run_id=2,
    )
    service._active_run_id = 2

    service._apply_worker_progress(
        _build_tag_progress_state(
            "cancelled",
            current=8,
            total=8,
            tagged=8,
            message="Old run cancelled",
            run_id=1,
        ),
        run_id=1,
    )

    progress = service.get_progress()
    assert progress["run_id"] == 2
    assert progress["status"] == "running"
    assert progress["message"] == "New run still active"
