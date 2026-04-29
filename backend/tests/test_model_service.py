from __future__ import annotations

import io
import json
import sys
import zipfile
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
    assert {"wd14", "clip", "aesthetic", "artist", "censor-legacy", "censor-nudenet", "sam3"}.issubset(model_ids)
    assert all("status" in item and "download_supported" in item for item in inventory)


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


def test_prepare_model_unknown_id_is_domain_error():
    with pytest.raises(ValueError, match="cannot be prepared"):
        model_service.ModelService().prepare_model("not-a-model")
