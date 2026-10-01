"""GET /api/models/sources/detect — ModelSourcesService through the models router."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

import model_sources  # noqa: E402
from services.model_sources_service import (  # noqa: E402
    ModelSourcesService,
    get_model_sources_service,
)
from tagger_models import TAGGER_MODELS  # noqa: E402


def make_comfyui_root(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    (path / "folder_paths.py").write_text("# fake\n", encoding="utf-8")
    (path / "models").mkdir(exist_ok=True)
    (path / "comfyui_version.py").write_text(
        '__version__ = "0.36.0"\n', encoding="utf-8"
    )
    return path


def test_detect_endpoint_returns_service_payload(test_client):
    from main import app

    class FakeService:
        def detect(self, *, rescan: bool = False):
            return {
                "sources": [],
                "matches": [],
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


def test_service_reports_sources_matches_rejections_and_bytes(tmp_path, monkeypatch):
    comfy = make_comfyui_root(tmp_path / "ComfyUI-aki" / "ComfyUI")
    node_dir = comfy / "custom_nodes" / "comfyui-WD14-Tagger" / "models"
    node_dir.mkdir(parents=True)
    model = b"vit" * 50
    csv = b"tag_id,name\n"
    entry = dict(TAGGER_MODELS["wd-vit-tagger-v3"])
    import hashlib

    entry["size_bytes"] = len(model)
    entry["sha256"] = hashlib.sha256(model).hexdigest()
    entry["tags_sha256"] = hashlib.sha256(csv).hexdigest()
    monkeypatch.setitem(TAGGER_MODELS, "wd-vit-tagger-v3", entry)
    (node_dir / "wd-vit-tagger-v3.onnx").write_bytes(model)
    (node_dir / "wd-vit-tagger-v3.csv").write_bytes(csv)
    (node_dir / "wd-eva02-large-tagger-v3.onnx").write_bytes(b"wrong size")
    (node_dir / "wd-eva02-large-tagger-v3.csv").write_bytes(csv)
    hub = tmp_path / "home" / ".cache" / "huggingface" / "hub"
    hub.mkdir(parents=True)

    service = ModelSourcesService(
        trusted_provider=lambda: [
            {"path": str(tmp_path / "ComfyUI-aki"), "kind": "comfyui", "added_at": "x"}
        ],
        store=model_sources.ModelSourcesStore(tmp_path / "model_sources.json"),
        env={},
        home=tmp_path / "home",
        probe_known_locations=False,
        background_scan=False,
    )

    payload = service.detect()

    sources = {s["path"]: s for s in payload["sources"]}
    assert sources[str(comfy)]["kind"] == "comfyui"
    assert sources[str(comfy)]["version"] == "0.36.0"
    assert sources[str(comfy)]["model_count"] == 1
    assert sources[str(comfy)]["trusted"] is True
    assert sources[str(hub)]["kind"] == "hf_cache"
    assert sources[str(hub)]["model_count"] == 0
    assert sources[str(hub)]["trusted"] is False
    (match,) = payload["matches"]
    assert match["model_id"] == "wd14"
    assert match["variant"] == "wd-vit-tagger-v3"
    assert match["verify"] == "sha"
    assert match["path"] == str(node_dir / "wd-vit-tagger-v3.onnx")
    (rejected,) = payload["rejected"]
    assert rejected["variant"] == "wd-eva02-large-tagger-v3"
    assert rejected["reason"] == "size_mismatch"
    assert match["total_bytes"] == len(model) + len(csv)
    # Bytes the user no longer has to download: the model plus its tags file.
    assert payload["reusable_bytes"] == len(model) + len(csv)
    assert payload["scan"]["status"] == "never"
    # The chosen matches are written for the loaders (MS1b) to read back.
    assert service.store.matches()[0]["path"] == match["path"]


def test_service_rescan_runs_the_drive_scan_synchronously(tmp_path, monkeypatch):
    drive = tmp_path / "drive"
    found = make_comfyui_root(drive / "ComfyUI")
    monkeypatch.setattr(
        model_sources, "scan_drives_for_comfyui", lambda drives=None: [str(found)]
    )
    service = ModelSourcesService(
        trusted_provider=lambda: [],
        store=model_sources.ModelSourcesStore(tmp_path / "model_sources.json"),
        env={},
        home=tmp_path / "home",
        probe_known_locations=False,
        background_scan=False,
    )

    before = service.detect()
    assert str(found) not in {s["path"] for s in before["sources"]}

    after = service.detect(rescan=True)
    assert {s["path"]: s["origin"] for s in after["sources"]}[str(found)] == "scan"
    assert after["scan"]["status"] == "done"
    assert after["scan"]["roots"] == [str(found)]
