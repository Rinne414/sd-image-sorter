"""
Unit tests for tagging service runtime planning.
"""

import sys
from pathlib import Path


sys.path.insert(0, str(Path(__file__).parent.parent))

from services.tagging_service import TagRequest, TaggingService  # noqa: E402
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

    runtime_plan = service._build_runtime_plan(request)

    assert runtime_plan["effective_use_gpu"] is True
    assert runtime_plan["gpu_locked"] is False
    assert runtime_plan["fetch_batch_size"] == 32
    assert runtime_plan["commit_interval"] == min(32, 10)
    assert runtime_plan["gc_interval"] == min(32, 8)


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
    assert runtime_plan["fetch_batch_size"] == 2
    assert "multimodal caption backend" in runtime_plan["startup_notice"]


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
