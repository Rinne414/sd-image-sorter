"""GET /api/models/sources/detect — ModelSourcesService through the models router."""

from __future__ import annotations

import hashlib
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

import model_roots  # noqa: E402
import model_sources  # noqa: E402
import model_sources_store  # noqa: E402
from services.model_sources_service import (  # noqa: E402
    ModelSourcesService,
    get_model_sources_service,
)
from tagger_models import TAGGER_MODELS  # noqa: E402

VIT = "wd-vit-tagger-v3"
EVA02 = "wd-eva02-large-tagger-v3"


def make_comfyui_root(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    (path / "folder_paths.py").write_text("# fake\n", encoding="utf-8")
    (path / "models").mkdir(exist_ok=True)
    (path / "comfyui_version.py").write_text(
        '__version__ = "0.36.0"\n', encoding="utf-8"
    )
    return path


@pytest.fixture
def isolated(tmp_path, monkeypatch):
    import config

    project = tmp_path / "project"
    data = tmp_path / "data"
    (project / "models").mkdir(parents=True)
    (data / "models").mkdir(parents=True)
    (data / "config").mkdir()
    monkeypatch.setattr(config, "PROJECT_ROOT", project)
    monkeypatch.setattr(config, "DATA_DIR", data)
    monkeypatch.setattr(config, "CONFIG_DIR", data / "config")
    monkeypatch.setattr(
        config, "APP_SETTINGS_CONFIG_PATH", data / "config" / "app-settings.json"
    )
    monkeypatch.setattr(model_sources_store, "_scan_state", model_sources_store._ScanState())
    home = tmp_path / "home"
    (home / ".cache" / "huggingface" / "hub").mkdir(parents=True)
    return home


def test_detect_endpoint_returns_service_payload(test_client):
    from main import app

    class FakeService:
        def detect(self, *, rescan: bool = False):
            return {
                "sources": [],
                "matches": [],
                "suggestions": [],
                "rejected": [],
                "reusable_bytes": 0,
                "scan": {"status": "never"},
                "rescan": rescan,
            }

    app.dependency_overrides[get_model_sources_service] = lambda: FakeService()
    try:
        response = test_client.get("/api/models/sources/detect")
        assert response.status_code == 200
        assert response.json()["scan"] == {"status": "never"}
        assert response.json()["rescan"] is False
        response = test_client.get("/api/models/sources/detect?rescan=1")
        assert response.json()["rescan"] is True
    finally:
        app.dependency_overrides.pop(get_model_sources_service, None)


def test_service_reports_sources_matches_rejections_and_bytes(
    isolated, tmp_path, monkeypatch
):
    home = isolated
    comfy = make_comfyui_root(tmp_path / "ComfyUI-aki" / "ComfyUI")
    node_dir = comfy / "custom_nodes" / "comfyui-WD14-Tagger" / "models"
    node_dir.mkdir(parents=True)
    model = b"vit" * 50
    csv = b"tag_id,name\n"
    entry = dict(TAGGER_MODELS[VIT])
    entry["size_bytes"] = len(model)
    entry["sha256"] = hashlib.sha256(model).hexdigest()
    entry["tags_sha256"] = hashlib.sha256(csv).hexdigest()
    monkeypatch.setitem(TAGGER_MODELS, VIT, entry)
    (node_dir / f"{VIT}.onnx").write_bytes(model)
    (node_dir / f"{VIT}.csv").write_bytes(csv)
    (node_dir / f"{EVA02}.onnx").write_bytes(b"wrong size")
    (node_dir / f"{EVA02}.csv").write_bytes(csv)
    hub = home / ".cache" / "huggingface" / "hub"
    # Trusted the way Model Center does it: through model_roots.
    model_roots.add_trusted_model_folder(str(tmp_path / "ComfyUI-aki"))

    service = ModelSourcesService(
        store=model_sources_store.ModelSourcesStore(tmp_path / "model_sources.json"),
        env={},
        home=home,
        probe_known_locations=False,
        background_scan=False,
    )

    payload = service.detect()

    sources = {s["path"]: s for s in payload["sources"]}
    assert sources[str(comfy)]["kind"] == "comfyui"
    assert sources[str(comfy)]["version"] == "0.36.0"
    assert sources[str(comfy)]["model_count"] == 1
    assert sources[str(comfy)]["trusted"] is True
    assert sources[str(comfy)]["network_pending"] is False
    assert sources[str(hub)]["kind"] == "hf_cache"
    assert sources[str(hub)]["model_count"] == 0
    assert sources[str(hub)]["trusted"] is False
    (match,) = payload["matches"]
    assert match["model_id"] == "wd14"
    assert match["variant"] == VIT
    assert match["verify"] == "sha"
    assert match["trusted"] is True
    assert match["origin"] == "trusted"
    assert match["path"] == str(node_dir / f"{VIT}.onnx")
    (rejected,) = payload["rejected"]
    assert rejected["variant"] == EVA02
    assert rejected["reason"] == "size_mismatch"
    assert match["total_bytes"] == len(model) + len(csv)
    # Bytes the user no longer has to download: the model plus its tags file.
    assert payload["reusable_bytes"] == len(model) + len(csv)
    assert payload["suggestions"] == []
    assert payload["scan"]["status"] == "never"
    # The chosen matches are written for the loaders (MS1b) to read back.
    assert service.store.matches()[0]["path"] == match["path"]


def test_service_rescan_starts_the_background_scan_and_serves_its_result(
    isolated, tmp_path, monkeypatch
):
    home = isolated
    drive = tmp_path / "drive"
    found = make_comfyui_root(drive / "ComfyUI")
    monkeypatch.setattr(
        model_sources, "scan_drives_for_comfyui", lambda drives=None: [str(found)]
    )
    service = ModelSourcesService(
        store=model_sources_store.ModelSourcesStore(tmp_path / "model_sources.json"),
        env={},
        home=home,
        probe_known_locations=False,
        background_scan=False,
    )

    before = service.detect()
    assert str(found) not in {s["path"] for s in before["sources"]}

    service.detect(rescan=True)
    assert model_sources_store.wait_for_scans(timeout=5)
    after = service.detect()
    assert {s["path"]: s["origin"] for s in after["sources"]}[str(found)] == "scan"
    assert after["scan"]["status"] == "done"
    assert after["scan"]["roots"] == [str(found)]
