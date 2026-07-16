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


def test_model_health_blocks_toriigate_and_sam3_for_windows_cuda13(
    monkeypatch,
    tmp_path,
):
    import model_health

    toriigate_root = tmp_path / "toriigate"
    toriigate_dir = toriigate_root / "toriigate-0.5"
    toriigate_dir.mkdir(parents=True)
    (toriigate_dir / "config.json").write_text("{}", encoding="utf-8")
    (toriigate_dir / "model.safetensors").write_bytes(b"model")
    sam3_checkpoint = tmp_path / "sam3" / "model.safetensors"
    sam3_checkpoint.parent.mkdir(parents=True)
    sam3_checkpoint.write_bytes(b"model")

    monkeypatch.setattr(model_health.platform, "system", lambda: "Windows")
    monkeypatch.setattr(model_health, "get_toriigate_model_dir", lambda: str(toriigate_root))
    monkeypatch.setattr(model_health, "get_sam3_checkpoint_path", lambda: str(sam3_checkpoint))
    monkeypatch.setattr(model_health, "_module_installed", lambda module_name: True)
    monkeypatch.setattr(
        model_health,
        "_probe_torch_runtime",
        lambda: {
            "torch_version": "2.13.0+cu130",
            "torch_cuda_build": "13.0",
            "torch_cuda_available": True,
            "torch_probe_error": None,
            "torch_probe_source": "subprocess",
        },
    )

    health = model_health.get_model_health()

    toriigate = health["toriigate"]
    sam3 = health["censor"]["sam3"]
    assert toriigate["available"] is False
    assert sam3["available"] is False
    assert toriigate["runtime_compatible"] is False
    assert sam3["runtime_compatible"] is False
    assert "Model Manager" in toriigate["message"]
    assert "Prepare" in sam3["message"]
    assert "restart" in sam3["message"]


def test_torch_onnx_runtime_health_keeps_non_windows_cuda13_policy_unchanged(
    monkeypatch,
):
    import model_health

    monkeypatch.setattr(model_health.platform, "system", lambda: "Linux")
    monkeypatch.setattr(
        model_health,
        "_probe_torch_runtime",
        lambda: {
            "torch_version": "2.13.0+cu130",
            "torch_cuda_build": "13.0",
            "torch_cuda_available": True,
            "torch_probe_error": None,
            "torch_probe_source": "subprocess",
        },
    )

    runtime = model_health.get_torch_onnx_runtime_health()

    assert runtime["runtime_compatible"] is True
    assert runtime["runtime_compatibility_error"] is None


def test_model_health_keeps_non_windows_explicit_cpu_toriigate_available(
    monkeypatch,
    tmp_path,
):
    import model_health

    toriigate_root = tmp_path / "toriigate"
    toriigate_dir = toriigate_root / "toriigate-0.5"
    toriigate_dir.mkdir(parents=True)
    (toriigate_dir / "config.json").write_text("{}", encoding="utf-8")
    (toriigate_dir / "model.safetensors").write_bytes(b"model")

    monkeypatch.setattr(model_health.platform, "system", lambda: "Linux")
    monkeypatch.setattr(
        model_health,
        "get_toriigate_model_dir",
        lambda: str(toriigate_root),
    )
    monkeypatch.setattr(
        model_health,
        "_module_installed",
        lambda module_name: module_name in {"torch", "transformers"},
    )
    monkeypatch.setattr(
        model_health,
        "_probe_torch_runtime",
        lambda: {
            "torch_version": "2.13.0+cpu",
            "torch_cuda_build": None,
            "torch_cuda_available": False,
            "torch_probe_error": None,
            "torch_probe_source": "subprocess",
        },
    )

    toriigate = model_health.get_model_health()["toriigate"]

    assert toriigate["available"] is True
    assert toriigate["requires_gpu"] is False
    assert toriigate["runtime_compatible"] is True
    assert toriigate["message"] == "ToriiGate runtime files are ready."


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


# --- Manual-placement detection robustness (Linux user bug reports) ----------
#
# A user who manually downloads or git-clones model files hits two real traps:
#   * HuggingFace hub caches under models--Org--Repo/snapshots/HASH/ (double
#     dash, 3 levels deep), which the old 2-level CLIP glob never reached.
#   * git clone of the Kaloscope repo creates a mixed-case "Kaloscope2.0/"
#     directory; the hardcoded lowercase "kaloscope2.0" path misses it on
#     case-sensitive Linux filesystems.


def test_clip_detection_finds_huggingface_hub_cache_layout(tmp_path, monkeypatch):
    import model_health

    clip_root = tmp_path / "clip"
    # huggingface_hub cache layout: models--{org}--{repo}/snapshots/{hash}/model.onnx
    snapshot = clip_root / "models--Qdrant--clip-ViT-B-32-vision" / "snapshots" / "e0c24abcdeadbeef"
    snapshot.mkdir(parents=True)
    (snapshot / "model.onnx").write_bytes(b"onnx")
    (snapshot / "config.json").write_text("{}", encoding="utf-8")

    monkeypatch.setattr(model_health, "get_clip_model_dir", lambda: str(clip_root))

    found = model_health.get_clip_local_model_path()
    assert found is not None
    assert Path(found, "model.onnx").exists()


def test_clip_detection_still_finds_canonical_slug_layout(tmp_path, monkeypatch):
    import model_health
    from config import CLIP_MODEL_NAME

    clip_root = tmp_path / "clip"
    slug = CLIP_MODEL_NAME.replace("/", "-").replace("\\", "-")
    canonical = clip_root / slug
    canonical.mkdir(parents=True)
    (canonical / "model.onnx").write_bytes(b"onnx")

    monkeypatch.setattr(model_health, "get_clip_model_dir", lambda: str(clip_root))

    found = model_health.get_clip_local_model_path()
    assert found is not None
    assert Path(found).resolve() == canonical.resolve()


def test_artist_checkpoint_detected_in_mixed_case_git_clone_dir(tmp_path, monkeypatch):
    import model_health
    from config import ARTIST_KALOSCOPE_CHECKPOINT, ARTIST_KALOSCOPE_CLASS_MAPPING

    artist_root = tmp_path / "artist"
    # git clone of the model repo creates "Kaloscope2.0" (capital K).
    clone_dir = artist_root / "Kaloscope2.0"
    checkpoint = clone_dir / ARTIST_KALOSCOPE_CHECKPOINT
    checkpoint.parent.mkdir(parents=True)
    checkpoint.write_bytes(b"ckpt")
    (clone_dir / ARTIST_KALOSCOPE_CLASS_MAPPING).write_text("class_id,class_name\n", encoding="utf-8")

    monkeypatch.setattr(model_health, "get_artist_model_dir", lambda: str(artist_root))

    assert model_health.get_artist_checkpoint_path() is not None
    assert model_health.get_artist_class_mapping_path() is not None


def test_artist_checkpoint_detected_when_placed_at_arbitrary_depth(tmp_path, monkeypatch):
    import model_health
    from config import ARTIST_KALOSCOPE_CHECKPOINT, ARTIST_KALOSCOPE_CLASS_MAPPING

    artist_root = tmp_path / "artist"
    nested = artist_root / "whatever" / "deep"
    checkpoint = nested / ARTIST_KALOSCOPE_CHECKPOINT
    checkpoint.parent.mkdir(parents=True)
    checkpoint.write_bytes(b"ckpt")
    (nested / ARTIST_KALOSCOPE_CLASS_MAPPING).write_text("class_id,class_name\n", encoding="utf-8")

    monkeypatch.setattr(model_health, "get_artist_model_dir", lambda: str(artist_root))

    assert model_health.get_artist_checkpoint_path() is not None
    assert model_health.get_artist_class_mapping_path() is not None


def test_artist_checkpoint_canonical_lowercase_still_preferred(tmp_path, monkeypatch):
    import model_health
    from config import ARTIST_KALOSCOPE_CHECKPOINT

    artist_root = tmp_path / "artist"
    canonical = artist_root / "kaloscope2.0" / ARTIST_KALOSCOPE_CHECKPOINT
    canonical.parent.mkdir(parents=True)
    canonical.write_bytes(b"ckpt")

    monkeypatch.setattr(model_health, "get_artist_model_dir", lambda: str(artist_root))

    found = model_health.get_artist_checkpoint_path()
    assert found is not None
    assert Path(found).resolve() == canonical.resolve()


def test_artist_checkpoint_absent_returns_none(tmp_path, monkeypatch):
    import model_health

    artist_root = tmp_path / "artist"
    artist_root.mkdir(parents=True)
    monkeypatch.setattr(model_health, "get_artist_model_dir", lambda: str(artist_root))

    assert model_health.get_artist_checkpoint_path() is None


def test_sam3_checkpoint_detected_in_huggingface_hub_cache_layout(tmp_path, monkeypatch):
    import model_health

    sam3_root = tmp_path / "sam3"
    # HF-hub style nested snapshot dir holding the transformers SAM3 files.
    snapshot = sam3_root / "models--facebook--sam3" / "snapshots" / "abc123"
    snapshot.mkdir(parents=True)
    (snapshot / "config.json").write_text("{}", encoding="utf-8")
    (snapshot / "model.safetensors").write_bytes(b"weights")

    monkeypatch.setattr(model_health, "get_sam3_model_dir", lambda: str(sam3_root))

    found = model_health.get_sam3_checkpoint_path()
    assert found is not None
    assert Path(found, "config.json").exists()
    assert Path(found, "model.safetensors").exists()
