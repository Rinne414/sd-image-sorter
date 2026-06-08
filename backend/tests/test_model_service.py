from __future__ import annotations

import io
import json
import sys
import zipfile
from pathlib import Path
from types import SimpleNamespace

import pytest

from services import model_service


class FakeResponse:
    def __init__(self, payload: bytes, *, content_type: str = "application/octet-stream") -> None:
        self._payload = payload
        self.headers = {"Content-Type": content_type}

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def read(self, size: int = -1) -> bytes:
        if size is None or size < 0:
            data, self._payload = self._payload, b""
            return data
        data, self._payload = self._payload[:size], self._payload[size:]
        return data


def _zip_payload(files: dict[str, bytes]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, payload in files.items():
            archive.writestr(name, payload)
    return buffer.getvalue()


def _fake_health(default_model_path: str = "") -> dict:
    return {
        "wd14": {"installed_models": [], "model_path": None},
        "toriigate": {"available": False, "model_name": "toriigate-0.5", "model_dir": "/models/toriigate/toriigate-0.5", "message": "missing"},
        "clip": {"available": False, "runtime_loaded": False, "model_path": None, "message": "missing"},
        "artist": {"available": False, "checkpoint_path": None, "runtime_path": None, "message": "missing"},
        "censor": {
            "legacy": {"available": False, "default_model_path": default_model_path, "message": "missing"},
            "nudenet": {"available": False, "model_downloaded": False, "model_path": None, "message": "missing"},
            "sam3": {"available": False, "checkpoint_path": None, "message": "missing"},
        },
    }


def test_model_inventory_is_built_without_router_imports(monkeypatch):
    monkeypatch.setattr(model_service, "get_model_health", lambda: _fake_health())
    monkeypatch.setitem(sys.modules, "aesthetic", SimpleNamespace(is_available=lambda: False))

    inventory = model_service.ModelService().build_model_inventory()

    model_ids = {item["id"] for item in inventory}
    assert {"wd14", "toriigate", "clip", "aesthetic", "artist", "censor-legacy", "censor-nudenet", "sam3"}.issubset(model_ids)
    assert all("status" in item and "download_supported" in item for item in inventory)


def test_model_inventory_flags_recommended_essentials(monkeypatch):
    # MODELS-07: every inventory entry carries a `recommended` flag so the
    # Model Manager can render essentials first; it must match the curated set.
    monkeypatch.setattr(model_service, "get_model_health", lambda: _fake_health())
    monkeypatch.setitem(sys.modules, "aesthetic", SimpleNamespace(is_available=lambda: False))

    inventory = model_service.ModelService().build_model_inventory()

    assert all("recommended" in item for item in inventory)
    for item in inventory:
        assert item["recommended"] == (item["id"] in model_service.RECOMMENDED_MODEL_IDS)
    recommended_ids = {item["id"] for item in inventory if item["recommended"]}
    assert {"wd14", "censor-nudenet", "clip", "aesthetic", "artist", "sam3"} == recommended_ids
    # Optional/advanced models must NOT be flagged as essentials.
    assert not any(item["recommended"] for item in inventory if item["id"] in {"toriigate", "oppai-oracle", "censor-legacy"})


def test_recommended_ids_match_bulk_bundle():
    # MODELS-07 sync guard: the "essentials" set surfaced in the Model Manager
    # must stay identical to the "Download all recommended models" bundle so the
    # two cannot silently drift.
    from routers.models import BULK_MODEL_BUNDLE

    bundle_ids = {item["id"] for item in BULK_MODEL_BUNDLE}
    assert bundle_ids == set(model_service.RECOMMENDED_MODEL_IDS)


def test_prepare_wd14_repairs_windows_onnx_runtime(monkeypatch):
    repair_calls = []

    class FakeWD14Tagger:
        def __init__(self, model_name, use_gpu=False):
            self.model_name = model_name
            self.use_gpu = use_gpu

        def _get_model_paths(self):
            return ("C:/models/wd14/model.onnx", "C:/models/wd14/selected_tags.csv")

    monkeypatch.setattr(model_service.platform, "system", lambda: "Windows")
    monkeypatch.setitem(sys.modules, "tagger", SimpleNamespace(DEFAULT_MODEL="wd-swinv2-tagger-v3", WD14Tagger=FakeWD14Tagger))
    monkeypatch.setitem(
        sys.modules,
        "repair_onnxruntime",
        SimpleNamespace(
            repair_windows_onnxruntime=lambda stream_pip=False: repair_calls.append(stream_pip) or {
                "repaired": True,
                "actions": ["Installed onnxruntime-gpu CUDA runtime"],
                "providers_after_repair": ["CUDAExecutionProvider", "CPUExecutionProvider"],
                "gpu_vendor_primary": "nvidia",
                "target_runtime": "onnxruntime-gpu",
            }
        ),
    )

    result = model_service.ModelService().prepare_model("wd14", variant="wd-swinv2-tagger-v3")

    assert repair_calls == [True]
    assert result["status"] == "ok"
    assert result["restart_recommended"] is True
    assert result["runtime_repair"]["ok"] is True
    assert result["runtime_repair"]["providers_after_repair"] == ["CUDAExecutionProvider", "CPUExecutionProvider"]


def test_prepare_wd14_warns_when_windows_onnx_repair_fails(monkeypatch):
    class FakeWD14Tagger:
        def __init__(self, model_name, use_gpu=False):
            self.model_name = model_name
            self.use_gpu = use_gpu

        def _get_model_paths(self):
            return ("C:/models/wd14/model.onnx", "C:/models/wd14/selected_tags.csv")

    monkeypatch.setattr(model_service.platform, "system", lambda: "Windows")
    monkeypatch.setitem(sys.modules, "tagger", SimpleNamespace(DEFAULT_MODEL="wd-swinv2-tagger-v3", WD14Tagger=FakeWD14Tagger))
    monkeypatch.setitem(
        sys.modules,
        "repair_onnxruntime",
        SimpleNamespace(
            repair_windows_onnxruntime=lambda stream_pip=False: {
                "repaired": False,
                "actions": ["CPU-only runtime remained installed"],
                "providers_after_repair": ["CPUExecutionProvider"],
                "gpu_vendor_primary": "nvidia",
                "target_runtime": "onnxruntime-gpu",
            }
        ),
    )

    result = model_service.ModelService().prepare_model("wd14")

    assert result["status"] == "warning"
    assert result["runtime_repair"]["ok"] is False
    assert "may stay on CPU" in result["message"]


def test_download_privacy_yolo_bundle_extracts_safe_zip(monkeypatch, tmp_path):
    target_dir = tmp_path / "models" / "yolo"
    zip_payload = _zip_payload({"nested/model.onnx": b"onnx"})
    responses = [
        FakeResponse(json.dumps({"modelVersions": [{"downloadUrl": "https://example.test/model.zip"}]}).encode("utf-8"), content_type="application/json"),
        FakeResponse(zip_payload, content_type="application/zip"),
    ]

    monkeypatch.setattr(model_service, "get_yolo_model_dir", lambda: str(target_dir))
    monkeypatch.setattr(model_service, "urlopen_with_ua", lambda _url, timeout=30: responses.pop(0))
    monkeypatch.setattr(model_service, "get_model_health", lambda: _fake_health(str(target_dir / "nested" / "model.onnx")))

    result = model_service.ModelService().download_privacy_yolo_bundle()

    assert (target_dir / "nested" / "model.onnx").read_bytes() == b"onnx"
    assert result["model_dir"] == str(target_dir.resolve())
    assert result["default_model_path"].endswith("model.onnx")


@pytest.mark.parametrize("member_name", ["../escape.onnx", "..\\escape.onnx", "/tmp/escape.onnx", "C:/escape.onnx"])
def test_download_privacy_yolo_bundle_rejects_zip_path_traversal(monkeypatch, tmp_path, member_name):
    target_dir = tmp_path / "models" / "yolo"
    zip_payload = _zip_payload({member_name: b"bad"})
    responses = [
        FakeResponse(b"{}", content_type="application/json"),
        FakeResponse(zip_payload, content_type="application/zip"),
    ]

    monkeypatch.setattr(model_service, "get_yolo_model_dir", lambda: str(target_dir))
    monkeypatch.setattr(model_service, "urlopen_with_ua", lambda _url, timeout=30: responses.pop(0))

    with pytest.raises(model_service.ModelPreparationFailedError) as exc_info:
        model_service.ModelService().download_privacy_yolo_bundle()

    assert exc_info.value.payload["type"] == "ModelPreparationFailed"
    assert "unsafe path" in exc_info.value.payload["reason"]
    assert not (tmp_path / "models" / "escape.onnx").exists()


def test_download_privacy_yolo_bundle_rejects_oversized_zip(monkeypatch, tmp_path):
    target_dir = tmp_path / "models" / "yolo"
    zip_payload = _zip_payload({"nested/model.onnx": b"12345"})
    responses = [
        FakeResponse(b"{}", content_type="application/json"),
        FakeResponse(zip_payload, content_type="application/zip"),
    ]

    monkeypatch.setattr(model_service, "_MAX_PRIVACY_YOLO_UNCOMPRESSED_BYTES", 4)
    monkeypatch.setattr(model_service, "get_yolo_model_dir", lambda: str(target_dir))
    monkeypatch.setattr(model_service, "urlopen_with_ua", lambda _url, timeout=30: responses.pop(0))

    with pytest.raises(model_service.ModelPreparationFailedError) as exc_info:
        model_service.ModelService().download_privacy_yolo_bundle()

    assert "uncompressed size exceeded" in exc_info.value.payload["reason"]
    assert not (target_dir / "nested" / "model.onnx").exists()


def test_download_privacy_yolo_bundle_returns_auth_payload_for_html_login(monkeypatch, tmp_path):
    target_dir = tmp_path / "models" / "yolo"
    responses = [
        FakeResponse(b"{}", content_type="application/json"),
        FakeResponse(b"<html>login</html>", content_type="text/html"),
    ]

    monkeypatch.setattr(model_service, "get_yolo_model_dir", lambda: str(target_dir))
    monkeypatch.setattr(model_service, "urlopen_with_ua", lambda _url, timeout=30: responses.pop(0))

    with pytest.raises(model_service.ExternalAuthRequiredError) as exc_info:
        model_service.ModelService().download_privacy_yolo_bundle()

    assert exc_info.value.status_code == 409
    assert exc_info.value.payload["type"] == "CivitaiLoginRequired"
    assert exc_info.value.payload["external_url"] == model_service.PRIVACY_YOLO_PAGE_URL




def test_prepare_model_returns_restart_hint_when_optional_dependencies_installed(monkeypatch):
    installed_groups = []

    monkeypatch.setattr(
        model_service,
        "ensure_group",
        lambda group: installed_groups.append(group) or model_service.DependencyInstallResult(("fastembed>=0.4.0",), True),
    )
    monkeypatch.setitem(
        sys.modules,
        "similarity",
        SimpleNamespace(ensure_clip_model_ready=lambda: "/models/clip/model.onnx"),
    )

    result = model_service.ModelService().prepare_model("clip")

    assert installed_groups == ["clip"]
    assert result["restart_recommended"] is True
    assert result["installed_packages"] == ["fastembed>=0.4.0"]

def test_prepare_model_unknown_id_is_domain_error():
    with pytest.raises(ValueError, match="cannot be prepared"):
        model_service.ModelService().prepare_model("not-a-model")


def test_prepare_sam3_existing_checkpoint_reports_runtime_gap(monkeypatch):
    checkpoint = "/models/sam3/facebook-sam3-modelscope/model.safetensors"
    health = _fake_health()
    health["censor"]["sam3"] = {
        "available": False,
        "checkpoint_path": checkpoint,
        "missing_dependencies": ["transformers", "safetensors"],
        "missing_dependency_packages": ["transformers", "safetensors"],
        "cuda_available": False,
        "torch_cuda_build": None,
        "message": "SAM3 checkpoint is installed, but SAM3 is not ready: missing Python packages: transformers, safetensors; this app's Python has CPU-only PyTorch; SAM3 needs a CUDA-enabled Torch build.",
    }
    monkeypatch.setattr(model_service, "get_sam3_checkpoint_path", lambda: checkpoint)
    monkeypatch.setattr(model_service, "get_model_health", lambda: health)
    monkeypatch.setattr(model_service, "ensure_group", lambda group: model_service.DependencyInstallResult((), False))

    result = model_service.ModelService().prepare_model("sam3")

    assert result["status"] == "needs_runtime"
    assert result["ready"] is False
    assert result["paths"]["checkpoint_path"] == checkpoint
    assert result["missing_dependency_packages"] == ["transformers", "safetensors"]
    assert "checkpoint is installed" in result["message"]
    assert "CPU-only PyTorch" in result["message"]


def test_sam3_default_download_urls_do_not_fallback_to_sam2_checkpoint(monkeypatch):
    """SAM3 download URLs must (a) cover the full transformers checkpoint
    (weights + config + tokenizer files) and (b) never silently fall back
    to a SAM2 mirror — pulling SAM2 .pt and saving it as SAM3 safetensors
    has historically corrupted user installs."""
    monkeypatch.delenv("SD_IMAGE_SORTER_SAM3_BASE_URL", raising=False)
    monkeypatch.delenv("SD_IMAGE_SORTER_SAM3_URLS", raising=False)

    pairs = model_service._sam3_download_urls()

    assert pairs
    assert all(isinstance(p, tuple) and len(p) == 2 for p in pairs)
    filenames = {name for name, _ in pairs}
    urls = [url for _, url in pairs]
    assert all("sam2" not in url.lower() for url in urls)
    assert "model.safetensors" in filenames
    assert "config.json" in filenames
    assert "tokenizer.json" in filenames


def test_prepare_sam3_existing_checkpoint_repairs_runtime_before_final_status(monkeypatch):
    checkpoint = "/models/sam3/facebook-sam3-modelscope/model.safetensors"
    before = _fake_health()
    before["censor"]["sam3"] = {
        "available": False,
        "checkpoint_path": checkpoint,
        "missing_dependencies": ["sam3"],
        "missing_dependency_packages": ["sam3"],
        "cuda_available": False,
        "torch_cuda_build": None,
        "message": "SAM3 checkpoint is installed, but runtime is incomplete.",
    }
    after = _fake_health()
    after["censor"]["sam3"] = {
        "available": True,
        "checkpoint_path": checkpoint,
        "missing_dependencies": [],
        "missing_dependency_packages": [],
        "cuda_available": True,
        "torch_cuda_build": "12.8",
        "message": "SAM3 checkpoint and runtime dependencies are ready.",
    }
    health_results = iter([before, after])
    repair_calls = []

    monkeypatch.setattr(model_service, "get_sam3_checkpoint_path", lambda: checkpoint)
    monkeypatch.setattr(model_service, "get_model_health", lambda: next(health_results))
    monkeypatch.setattr(model_service, "ensure_group", lambda group: model_service.DependencyInstallResult((), False))
    monkeypatch.setattr(
        model_service,
        "_repair_sam3_runtime_if_possible",
        lambda: repair_calls.append(True) or {"attempted": True, "ok": True},
    )

    result = model_service.ModelService().prepare_model("sam3")

    assert repair_calls == [True]
    assert result["status"] == "ok"
    assert result["ready"] is True
    assert result["runtime_repair"] == {"attempted": True, "ok": True}


def test_model_inventory_explains_sam3_checkpoint_with_missing_runtime(monkeypatch):
    checkpoint = "/models/sam3/facebook-sam3-modelscope/model.safetensors"
    health = _fake_health()
    health["censor"]["sam3"] = {
        "available": False,
        "checkpoint_path": checkpoint,
        "missing_dependencies": ["transformers", "safetensors"],
        "missing_dependency_packages": ["transformers", "safetensors"],
        "cuda_available": False,
        "torch_version": "2.11.0+cpu",
        "torch_cuda_build": None,
        "message": "SAM3 checkpoint is installed, but runtime is incomplete.",
    }
    monkeypatch.setattr(model_service, "get_model_health", lambda: health)
    monkeypatch.setitem(sys.modules, "aesthetic", SimpleNamespace(is_available=lambda: False))

    inventory = model_service.ModelService().build_model_inventory()
    sam3 = next(model for model in inventory if model["id"] == "sam3")

    assert sam3["status"] == "missing"
    assert sam3["message_key"] == "models.sam3.missingDepsCpuTorch"
    assert sam3["message_params"] == {"deps": "transformers, safetensors"}
    assert sam3["path"] == checkpoint


def test_prepare_router_marks_runtime_gap_as_warning(monkeypatch):
    from routers import models as models_router

    class FakeService:
        def prepare_model(self, model_id, source=None, variant=None):
            return {"status": "needs_runtime", "message": "runtime missing"}

    with models_router._prepare_lock:
        models_router._prepare_result.update(active=True, model_id="sam3", status="downloading", message="", error="")

    models_router._run_prepare_blocking(FakeService(), "sam3", None, None)

    with models_router._prepare_lock:
        assert models_router._prepare_result["active"] is False
        assert models_router._prepare_result["status"] == "warning"
        assert models_router._prepare_result["message"] == "runtime missing"


def test_prepare_toriigate_returns_restart_hint_when_runtime_installed(monkeypatch):
    installed_groups = []

    monkeypatch.setattr(
        model_service,
        "ensure_group",
        lambda group: installed_groups.append(group) or model_service.DependencyInstallResult(("torch>=2.0.0",), True),
    )

    result = model_service.ModelService().prepare_model("toriigate")

    assert installed_groups == ["toriigate"]
    assert result["status"] == "needs_restart"
    assert result["restart_recommended"] is True


def test_prepare_toriigate_downloads_after_runtime_exists(monkeypatch, tmp_path):
    installed_groups = []
    fake_tagger_calls = []
    model_dir = tmp_path / "toriigate"

    class FakeToriiGateTagger:
        def __init__(self, model_name="toriigate-0.5", model_dir=None, use_gpu=False):
            fake_tagger_calls.append((model_name, model_dir, use_gpu))

        def _download_model(self):
            target = model_dir / "toriigate-0.5"
            target.mkdir(parents=True)
            (target / "config.json").write_text("{}", encoding="utf-8")
            (target / "model.safetensors").write_bytes(b"model")
            return str(target)

    monkeypatch.setattr(
        model_service,
        "ensure_group",
        lambda group: installed_groups.append(group) or model_service.DependencyInstallResult((), False),
    )
    monkeypatch.setattr(model_service, "get_toriigate_model_dir", lambda: str(model_dir))
    monkeypatch.setitem(sys.modules, "toriigate_tagger", SimpleNamespace(ToriiGateTagger=FakeToriiGateTagger))

    result = model_service.ModelService().prepare_model("toriigate")

    assert installed_groups == ["toriigate"]
    assert fake_tagger_calls == [("toriigate-0.5", str(model_dir), False)]
    assert result["status"] == "ok"
    assert Path(result["paths"]["model_dir"]).name == "toriigate-0.5"


def test_prepare_artist_delegates_to_runtime_artist_asset_preparer(monkeypatch, tmp_path):
    runtime = tmp_path / "runtime"
    checkpoint = tmp_path / "kaloscope2.0" / "448-90.13" / "best_checkpoint.pth"
    mapping = tmp_path / "kaloscope2.0" / "class_mapping.csv"
    runtime.mkdir(parents=True)
    checkpoint.parent.mkdir(parents=True)
    mapping.parent.mkdir(parents=True, exist_ok=True)
    checkpoint.write_bytes(b"ckpt")
    mapping.write_text("class\n", encoding="utf-8")
    calls = []

    monkeypatch.setattr(
        model_service,
        "ensure_group_with_soft_deps",
        lambda group: model_service.DependencyInstallResult((), False),
    )
    import artist_identifier

    monkeypatch.setattr(
        artist_identifier,
        "prepare_artist_assets",
        lambda source="auto": calls.append(source) or {
            "runtime_path": str(runtime),
            "checkpoint_path": str(checkpoint),
            "class_mapping_path": str(mapping),
            "source": source,
        },
    )

    result = model_service.ModelService().prepare_model("artist", source="modelscope")

    assert calls == ["modelscope"]
    assert result["status"] == "ok"
    assert result["paths"]["checkpoint_path"] == str(checkpoint.resolve())


def test_toriigate_download_uses_shared_hf_endpoint_order(monkeypatch, tmp_path):
    import toriigate_tagger

    calls = []

    class FakeHub:
        def snapshot_download(self, **kwargs):
            calls.append(kwargs)
            Path(kwargs["local_dir"]).mkdir(parents=True, exist_ok=True)
            (Path(kwargs["local_dir"]) / "config.json").write_text("{}", encoding="utf-8")
            return kwargs["local_dir"]

    monkeypatch.setattr(toriigate_tagger, "hf_hub", FakeHub())
    monkeypatch.setattr(
        toriigate_tagger,
        "get_hf_endpoint_order",
        lambda model_name="": ["https://hf-mirror.com", "https://huggingface.co"],
    )

    tagger = toriigate_tagger.ToriiGateTagger.__new__(toriigate_tagger.ToriiGateTagger)
    tagger.model_name = "toriigate-0.5"
    tagger.model_dir = str(tmp_path)

    result = tagger._download_model()

    assert Path(result).name == "toriigate-0.5"
    assert calls
    assert calls[0]["endpoint"] == "https://hf-mirror.com"
