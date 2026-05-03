"""
Tests for publish-facing model health diagnostics.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from model_health import (  # noqa: E402
    _infer_yolo_model_profile,
    format_startup_readiness_report,
    get_startup_readiness,
)


def test_wenaka_filename_is_treated_as_privacy_detector_even_without_metadata():
    profile = _infer_yolo_model_profile([], "wenaka_yolov8s-seg.onnx")

    assert profile["id"] == "privacy-censor"
    assert profile["recommended_for_censor"] is True


def test_generic_yolov8_filename_stays_general_object_when_no_privacy_labels_exist():
    profile = _infer_yolo_model_profile([], "yolov8s-seg.onnx")

    assert profile["id"] == "general-object"
    assert profile["recommended_for_censor"] is False


def test_model_health_sam3_probe_does_not_import_torch_in_parent(monkeypatch):
    import model_health

    def fake_available(module_name: str) -> bool:
        assert module_name != "torch"
        return False

    installed = {"torch", "transformers", "safetensors", "cv2", "timm"}
    monkeypatch.setattr(model_health, "_module_available", fake_available)
    monkeypatch.setattr(model_health, "_module_installed", lambda module_name: module_name in installed)
    monkeypatch.setattr(
        model_health,
        "_probe_torch_runtime",
        lambda: {
            "torch_version": "2.11.0+cu128",
            "torch_cuda_build": "12.8",
            "torch_cuda_available": True,
            "torch_probe_error": None,
            "torch_probe_source": "subprocess",
        },
    )

    health = model_health.get_model_health()

    assert health["censor"]["sam3"]["missing_dependency_packages"] == []
    assert health["censor"]["sam3"]["torch_probe_source"] == "subprocess"


def test_model_health_marks_sam3_unsupported_on_macos(monkeypatch):
    import model_health

    monkeypatch.setattr(model_health.sys, "platform", "darwin")
    monkeypatch.setattr(
        model_health,
        "_probe_torch_runtime",
        lambda: {
            "torch_version": "2.2.2",
            "torch_cuda_build": None,
            "torch_cuda_available": False,
            "torch_probe_error": None,
            "torch_probe_source": "subprocess",
        },
    )
    monkeypatch.setattr(model_health, "get_sam3_checkpoint_path", lambda: None)

    health = model_health.get_model_health()

    sam3 = health["censor"]["sam3"]
    assert sam3["available"] is False
    assert sam3["missing_dependency_packages"] == []
    assert "disabled on macOS" in sam3["message"]


def test_startup_readiness_marks_gpu_tagger_ready_when_recommendation_prefers_gpu():
    readiness = get_startup_readiness(
        health={
            "wd14": {"available": True},
            "clip": {"available": True, "message": "clip ready"},
            "censor": {
                "legacy": {"available": True},
                "nudenet": {"available": True},
                "sam3": {"available": False, "message": "sam3 missing"},
            },
            "artist": {"available": False, "message": "artist missing"},
        },
        system_info={
            "gpu_name": "RTX 3090",
            "total_ram_gb": 32,
            "gpu_vram_total_mb": 24576,
            "onnx_providers": ["CUDAExecutionProvider", "CPUExecutionProvider"],
            "onnxruntime_conflict": False,
        },
        recommendation={
            "recommended_batch_size": 32,
            "recommended_use_gpu": True,
            "message": "GPU detected and ready",
        },
    )

    assert readiness["features"]["tagger"]["level"] == "ready"
    assert "GPU ready" in readiness["features"]["tagger"]["headline"]
    assert "32" in readiness["features"]["tagger"]["detail"]


def test_startup_readiness_report_mentions_conflict_warning_when_onnxruntime_conflicts():
    report = format_startup_readiness_report(
        readiness={
            "hardware": {
                "summary": "RTX 3090 · 32GB RAM · 24.0GB VRAM",
                "providers": ["CPU"],
                "onnxruntime_conflict": True,
                "recommendation_message": "Running on CPU.",
            },
            "features": {
                "tagger": {"level": "warn", "headline": "WD14 tagging: CPU fallback", "detail": "GPU runtime is not ready."},
                "similarity": {"level": "ready", "headline": "Similar search: ready", "detail": "Local CLIP model and runtime are available."},
                "censor": {"level": "ready", "headline": "Censor tools: ready", "detail": "Privacy YOLO ready"},
                "artist": {"level": "warn", "headline": "Artist ID: setup needed", "detail": "Artist runtime missing"},
                "sam3": {"level": "warn", "headline": "SAM3 Pro masks: setup needed", "detail": "SAM3 missing"},
            },
        }
    )

    assert "ONNX Runtime packages are conflicting" in report
    assert "WD14 tagging: CPU fallback" in report
