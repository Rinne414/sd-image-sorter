"""Lucida Model Manager and health registration contracts."""
from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).parent.parent))

import model_health
from services import model_service


def _base_health() -> dict:
    return {
        "wd14": {
            "installed_models": [],
            "model_path": None,
            "default_model": "wd-swinv2-tagger-v3",
        },
        "clip": {
            "available": False,
            "runtime_loaded": False,
            "model_path": None,
            "message": "missing",
        },
        "artist": {
            "available": False,
            "checkpoint_path": None,
            "runtime_path": None,
            "message": "missing",
        },
        "lucida": {
            "available": False,
            "checkpoint_path": None,
            "expected_path": "/models/lucida",
            "missing_dependencies": ["transformers"],
            "message": "Lucida setup is incomplete.",
        },
        "censor": {
            "legacy": {
                "available": False,
                "default_model_path": "",
                "message": "missing",
                "files": [],
            },
            "nudenet": {
                "available": False,
                "model_downloaded": False,
                "model_path": None,
                "message": "missing",
            },
            "sam3": {"available": False, "checkpoint_path": None, "message": "missing"},
        },
    }


def test_inventory_includes_lucida_as_optional_training_mask_model(monkeypatch):
    monkeypatch.setattr(model_service, "get_model_health", _base_health)

    inventory = model_service.ModelService().build_model_inventory()
    lucida = next(item for item in inventory if item["id"] == "lucida")

    assert lucida["group"] == "Training Masks"
    assert lucida["group_key"] == "models.group.trainingMasks"
    assert lucida["recommended"] is True
    assert lucida["default_variant"] == "pinned"
    assert lucida["default_model"] == "egeorcun/lucida"
    assert lucida["download_supported"] is True
    assert lucida["message_key"] == "models.lucida.missingDeps"


def test_prepare_lucida_uses_dedicated_pinned_checkpoint_flow(monkeypatch):
    calls = []
    monkeypatch.setattr(
        model_service,
        "ensure_group",
        lambda group: calls.append(group) or model_service.DependencyInstallResult((), False),
    )
    monkeypatch.setitem(
        sys.modules,
        "lucida_matting",
        SimpleNamespace(prepare_checkpoint=lambda: "C:/models/lucida"),
    )

    result = model_service.ModelService().prepare_model("lucida")

    assert calls == ["lucida"]
    assert result == {
        "status": "ok",
        "model_id": "lucida",
        "message": "Lucida runtime and pinned model files are ready.",
        "paths": {"checkpoint_path": "C:/models/lucida"},
    }


def test_lucida_checkpoint_requires_all_remote_code_and_weight_files(monkeypatch, tmp_path):
    model_dir = tmp_path / "lucida"
    model_dir.mkdir()
    monkeypatch.setattr(model_health, "get_lucida_model_dir", lambda: str(model_dir), raising=False)

    for filename in ("config.json", "BiRefNet_config.py", "birefnet.py"):
        (model_dir / filename).write_bytes(b"fixture")
    assert model_health.get_lucida_checkpoint_path() is None

    (model_dir / "model.safetensors").write_bytes(b"")
    assert model_health.get_lucida_checkpoint_path() is None

    (model_dir / "model.safetensors").write_bytes(b"fixture")
    assert model_health.get_lucida_checkpoint_path() == str(model_dir.resolve())


def test_lucida_runtime_dependencies_are_declared():
    repo_root = Path(__file__).resolve().parents[2]
    requirements = (repo_root / "backend" / "requirements.in").read_text(encoding="utf-8")

    assert "kornia==0.8.3" in requirements
    assert "einops>=" in requirements


def test_lucida_ui_and_model_manager_copy_is_bilingual():
    repo_root = Path(__file__).resolve().parents[2]
    en = (repo_root / "frontend" / "js" / "lang" / "en.js").read_text(encoding="utf-8")
    zh = (repo_root / "frontend" / "js" / "lang" / "zh-CN.js").read_text(encoding="utf-8")

    for key in (
        "dataset.maskAutoEngine",
        "dataset.maskAutoRemBg",
        "dataset.maskAutoLucida",
        "dataset.maskLucidaLicense",
        "models.group.trainingMasks",
        "models.lucida.ready",
        "models.lucida.missingDeps",
        "models.lucida.missing",
    ):
        assert f"'{key}':" in en
        assert f"'{key}':" in zh

    assert "research-only" in en
    assert "仅限研究" in zh
