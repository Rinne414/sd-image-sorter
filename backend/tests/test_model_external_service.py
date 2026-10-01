"""MS1b: what ``detect`` keeps for the loaders and offers for a NAS it may not read."""

from __future__ import annotations

import os
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

import model_external  # noqa: E402
import model_sources_store  # noqa: E402
from services.model_sources_service import ModelSourcesService  # noqa: E402

NAS = "\\\\nas-offline\\models"


@pytest.fixture
def isolated(tmp_path, monkeypatch):
    import config

    data = tmp_path / "data"
    (data / "models").mkdir(parents=True)
    (tmp_path / "project" / "models").mkdir(parents=True)
    config_dir = data / "config"
    config_dir.mkdir()
    monkeypatch.setattr(config, "PROJECT_ROOT", tmp_path / "project")
    monkeypatch.setattr(config, "DATA_DIR", data)
    monkeypatch.setattr(config, "CONFIG_DIR", config_dir)
    monkeypatch.setattr(
        config, "APP_SETTINGS_CONFIG_PATH", config_dir / "app-settings.json"
    )
    monkeypatch.setattr(
        model_sources_store, "_scan_state", model_sources_store._ScanState()
    )
    home = tmp_path / "home"
    home.mkdir()
    store = model_sources_store.ModelSourcesStore(config_dir / "model_sources.json")
    return SimpleNamespace(home=home, store=store, tmp=tmp_path)


def make_service(isolated, **overrides) -> ModelSourcesService:
    options = dict(
        store=isolated.store,
        env={},
        home=isolated.home,
        probe_known_locations=False,
        background_scan=False,
    )
    options.update(overrides)
    return ModelSourcesService(**options)


def nas_match() -> dict:
    return {
        "model_id": "aesthetic-waifu",
        "variant": None,
        "path": NAS + "\\waifu.safetensors",
        "source": NAS,
        "folder": NAS,
        "source_kind": "folder",
        "origin": "trusted",
        "verify": "size",
        "size_bytes": 11,
        "mtime_ns": 5,
        "companions": [],
        "notes": [],
        "trusted_rank": 0,
        "is_network": True,
        "total_bytes": 11,
        "trusted": True,
    }


def test_untrusted_network_comfyui_path_is_listed_without_being_read(
    isolated, monkeypatch
):
    touched = []
    real_isdir, real_exists = os.path.isdir, os.path.exists
    monkeypatch.setattr(
        os.path, "isdir", lambda p: touched.append(str(p)) or real_isdir(p)
    )
    monkeypatch.setattr(
        os.path, "exists", lambda p: touched.append(str(p)) or real_exists(p)
    )
    service = make_service(
        isolated,
        env={"COMFYUI_PATH": NAS + "\\ComfyUI"},
        trust_check=lambda _path: False,
    )

    rows = [r for r in service.detect()["sources"] if r.get("network_not_trusted")]

    assert rows == [
        {
            "path": NAS + "\\ComfyUI",
            "kind": "comfyui",
            "origin": "env",
            "is_network": True,
            "version": None,
            "trusted": False,
            "network_pending": False,
            "network_scanned_at": None,
            "network_not_trusted": True,
            "model_count": 0,
        }
    ]
    assert not [p for p in touched if "nas-offline" in p]


def test_trusted_network_comfyui_path_gets_no_hint_row(isolated):
    service = make_service(
        isolated,
        env={"COMFYUI_PATH": NAS + "\\ComfyUI"},
        trusted_provider=lambda: [{"path": NAS, "kind": "auto"}],
        trust_check=lambda _path: True,
    )

    sources = service.detect()["sources"]

    assert not any(r.get("network_not_trusted") for r in sources)
    assert any(r["network_pending"] for r in sources)


def test_local_comfyui_path_gets_no_hint_row(isolated):
    service = make_service(
        isolated, env={"COMFYUI_PATH": str(isolated.tmp / "ComfyUI")}
    )

    assert not any(r.get("network_not_trusted") for r in service.detect()["sources"])


def test_network_match_is_kept_while_the_background_result_is_pending(isolated):
    isolated.store.save_matches([nas_match()])
    service = make_service(
        isolated,
        trusted_provider=lambda: [{"path": NAS, "kind": "auto"}],
        trust_check=lambda _path: True,
    )

    service.detect()

    assert [m["model_id"] for m in isolated.store.matches()] == ["aesthetic-waifu"]
    assert isolated.store.lost() == []


def test_a_local_match_that_is_no_longer_found_becomes_lost(isolated):
    gone = dict(
        nas_match(),
        path=str(isolated.tmp / "x" / "w.safetensors"),
        source=str(isolated.tmp / "x"),
    )
    isolated.store.save_matches([gone])
    service = make_service(isolated)

    service.detect()

    assert isolated.store.matches() == []
    assert [m["model_id"] for m in isolated.store.lost()] == ["aesthetic-waifu"]


def test_lost_entries_do_not_leak_into_the_loaders_unless_trusted(
    isolated, monkeypatch
):
    isolated.store.save_matches([nas_match()])
    isolated.store.save_matches([])
    monkeypatch.setattr(model_external, "_store_provider", lambda: isolated.store)

    assert model_external.problem("aesthetic-waifu") is None  # not under a trusted root
