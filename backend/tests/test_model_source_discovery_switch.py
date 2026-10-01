"""SD_IMAGE_SORTER_MODEL_SOURCE_DISCOVERY=0 switches off the automatic finding.

COMFYUI_PATH, the fixed install folders, the drive scan and the global Hugging
Face cache are not looked at; folders the user trusted still are. The
end-to-end server and the test suite run this way so the machine they run on
cannot change what Model Center shows.
"""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

import model_sources  # noqa: E402
import model_sources_store  # noqa: E402
from services.model_sources_service import ModelSourcesService  # noqa: E402

OFF = {model_sources.DISCOVERY_ENV: "0"}


def comfy_root(path: Path) -> Path:
    (path / "models").mkdir(parents=True)
    (path / "folder_paths.py").write_text("# fake\n", encoding="utf-8")
    return path


@pytest.fixture
def calls(monkeypatch):
    seen = SimpleNamespace(probe=0, scan=0, hf=0)

    def probe(**_kw):
        seen.probe += 1
        return []

    def scan(*_a, **_kw):
        seen.scan += 1
        return []

    def hf(**_kw):
        seen.hf += 1
        return []

    monkeypatch.setattr(model_sources, "probe_known_locations", probe)
    monkeypatch.setattr(model_sources, "scan_drives_for_comfyui", scan)
    monkeypatch.setattr(model_sources, "hf_cache_roots", hf)
    return seen


@pytest.mark.parametrize("value", ["0", "false", "No", "off"])
def test_the_switch_reads_the_usual_off_spellings(value):
    assert (
        model_sources.discovery_enabled({model_sources.DISCOVERY_ENV: value}) is False
    )


def test_it_is_on_unless_told_otherwise():
    assert model_sources.discovery_enabled({}) is True
    assert model_sources.discovery_enabled({model_sources.DISCOVERY_ENV: "1"}) is True


def test_off_means_no_probe_no_global_cache_no_comfyui_path(tmp_path, calls):
    env_comfy = comfy_root(tmp_path / "from-env")

    roots, pending = model_sources.detect_source_roots(
        [],
        env={**OFF, "COMFYUI_PATH": str(env_comfy)},
        home=tmp_path,
        scan_cache=["X:\\cached"],
    )

    assert roots == [] and pending == []
    assert (calls.probe, calls.hf) == (0, 0)


def test_on_still_finds_comfyui_path_and_asks_the_probes(tmp_path, calls):
    env_comfy = comfy_root(tmp_path / "from-env")

    roots, _ = model_sources.detect_source_roots(
        [], env={"COMFYUI_PATH": str(env_comfy)}, home=tmp_path
    )

    assert [r.origin for r in roots] == ["env"]
    assert calls.probe == 1 and calls.hf == 1


def test_off_still_reads_a_folder_the_user_trusted(tmp_path, calls):
    trusted = comfy_root(tmp_path / "mine")

    roots, _ = model_sources.detect_source_roots(
        [{"path": str(trusted), "kind": "auto"}], env=OFF, home=tmp_path
    )

    assert [(r.path, r.origin) for r in roots] == [(str(trusted), "trusted")]


def test_off_service_starts_no_drive_scan_and_shows_no_unread_nas(
    tmp_path, calls, monkeypatch
):
    monkeypatch.setattr(
        model_sources_store, "_scan_state", model_sources_store._ScanState()
    )
    store = model_sources_store.ModelSourcesStore(tmp_path / "idx.json")
    service = ModelSourcesService(
        store=store,
        env={**OFF, "COMFYUI_PATH": "\\\\nas\\ComfyUI"},
        home=tmp_path,
        trusted_provider=lambda: [],
        background_scan=True,
    )

    payload = service.detect(rescan=True)
    model_sources_store.wait_for_scans(5)

    assert calls.scan == 0 and (calls.probe, calls.hf) == (0, 0)
    assert payload["sources"] == []
    assert payload["scan"]["status"] == "never"
