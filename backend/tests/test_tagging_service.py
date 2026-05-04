"""
Unit tests for tagging service runtime planning.
"""

import sys
from pathlib import Path
from unittest.mock import patch

from fastapi import BackgroundTasks, HTTPException
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent.parent))

import database as db  # noqa: E402
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


def test_runtime_plan_uses_custom_profile_for_custom_model_paths():
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
        plan = service._build_runtime_plan(
            TagRequest(
                model_path="C:/models/custom-model.onnx",
                tags_path="C:/models/selected_tags.csv",
                use_gpu=True,
            )
        )

    assert plan["model_name"] == "custom"
    assert plan["fetch_batch_size"] == 8
    assert "Custom ONNX model on GPU" in plan["startup_notice"]


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
