"""
Unit tests for tagging service runtime planning.
"""

import sys
from pathlib import Path


sys.path.insert(0, str(Path(__file__).parent.parent))

from services.tagging_service import TagRequest, TaggingService  # noqa: E402
from services.tagging_service import _format_runtime_adjustment_message  # noqa: E402


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
