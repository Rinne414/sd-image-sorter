"""rembg, the default auto-mask engine, sets up from the app like any model.

Portable users cannot run pip, so rembg needs a Prepare path: the pinned
package through the optional ``rembg`` group, then the u2net weights with
byte progress and the same md5 rembg itself checks.
"""

from __future__ import annotations

import hashlib
import sys
from pathlib import Path

import pytest

import config
import optional_dependencies as deps
import rembg_model
from services import model_service

FAKE_WEIGHTS = b"u2net-weights"


@pytest.fixture
def rembg_home(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    monkeypatch.setattr(rembg_model, "U2NET_MD5", hashlib.md5(FAKE_WEIGHTS).hexdigest())
    return tmp_path / "models" / "rembg"


def _fake_download(payload: bytes, calls: list[str]):
    def download(url: str, dest: Path, *, timeout: int = 300) -> Path:
        calls.append(url)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(payload)
        return dest

    return download


def test_health_reports_not_set_up_without_package_or_weights(rembg_home, monkeypatch):
    monkeypatch.setitem(sys.modules, "rembg", None)

    health = rembg_model.health()

    assert health["available"] is False
    assert health["message_key"] == "models.rembg.missing"
    assert not rembg_home.exists(), "a status poll must not create folders"


def test_prepare_downloads_and_verifies_the_weights(rembg_home):
    calls: list[str] = []

    path = rembg_model.prepare(_fake_download(FAKE_WEIGHTS, calls))

    assert calls == [rembg_model.U2NET_URL]
    assert Path(path) == rembg_home / "u2net.onnx"
    assert Path(path).read_bytes() == FAKE_WEIGHTS


def test_prepare_keeps_a_verified_copy_without_downloading(rembg_home):
    rembg_home.mkdir(parents=True)
    (rembg_home / "u2net.onnx").write_bytes(FAKE_WEIGHTS)
    calls: list[str] = []

    rembg_model.prepare(_fake_download(FAKE_WEIGHTS, calls))

    assert calls == []


def test_prepare_removes_a_corrupt_download(rembg_home):
    with pytest.raises(RuntimeError, match="incomplete or corrupt"):
        rembg_model.prepare(_fake_download(b"truncated", []))

    assert not (rembg_home / "u2net.onnx").exists()


def test_prepare_model_installs_the_pinned_package_then_the_weights(
    rembg_home, monkeypatch
):
    groups: list[str] = []
    calls: list[str] = []
    monkeypatch.setattr(
        model_service,
        "ensure_group",
        lambda group: (
            groups.append(group)
            or model_service.DependencyInstallResult(("rembg==2.0.69",), False)
        ),
    )
    monkeypatch.setattr(
        model_service, "_direct_download_file", _fake_download(FAKE_WEIGHTS, calls)
    )

    result = model_service.ModelService().prepare_model("rembg")

    assert groups == ["rembg"]
    assert result["status"] == "ok"
    assert calls == [rembg_model.U2NET_URL]


def test_rembg_group_is_pinned_to_the_numpy_compatible_release():
    assert deps.OPTIONAL_DEPENDENCY_GROUPS["rembg"] == ("rembg==2.0.69",)
    assert deps.GROUP_IMPORTS["rembg"] == ("rembg",)


def test_models_page_lists_rembg_with_a_prepare_button(test_client):
    cards = test_client.get("/api/models/status").json()["models"]
    rembg_card = next(card for card in cards if card["id"] == "rembg")

    assert rembg_card["download_supported"] is True
    assert rembg_card["group_key"] == "models.group.trainingMasks"
