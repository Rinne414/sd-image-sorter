"""MS1a: finding ComfyUI installs, Hugging Face caches and trusted folders.

The yaml cases mirror ComfyUI 0.36.0 ``utils/extra_config.py`` line by line:
``base_path`` is expandvars + expanduser and relative to the yaml's folder,
``is_default`` puts the section's folders first, every other key is a
newline-separated list joined under ``base_path`` (or the yaml folder when
there is none), and ``unet`` / ``clip`` map to their current names.
"""

from __future__ import annotations

import json
import os
import sys
import threading
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

import model_sources  # noqa: E402
import model_sources_store  # noqa: E402


def make_comfyui_root(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    (path / "folder_paths.py").write_text("# fake\n", encoding="utf-8")
    (path / "models").mkdir(exist_ok=True)
    return path


# ---------------------------------------------------------------------------
# extra_model_paths.yaml, compared against ComfyUI's own loader behaviour
# ---------------------------------------------------------------------------


def test_extra_model_paths_follow_comfyui_loader(tmp_path, monkeypatch):
    monkeypatch.setenv("MS1A_BASE", str(tmp_path / "envbase"))
    # os.path.expandvars, as ComfyUI calls it: %VAR% on Windows, $VAR elsewhere.
    env_base = "%MS1A_BASE%" if os.name == "nt" else "${MS1A_BASE}"
    yaml_dir = tmp_path / "ComfyUI"
    yaml_dir.mkdir()
    yaml_path = yaml_dir / "extra_model_paths.yaml"
    yaml_path.write_text(
        "\n".join(
            [
                "a111:",
                "    base_path: ../webui/",
                "    checkpoints: models/Stable-diffusion",
                "    loras: |",
                "         models/Lora",
                "         models/LyCORIS",
                "    unet: models/unet",
                "envsec:",
                f"    base_path: '{env_base}/sub'",
                "    is_default: true",
                "    kgen: gguf",
                "homesec:",
                "    base_path: ~/comfy-home",
                "    clip: text",
                "nobase:",
                "    wd14_tagger: taggers",
                "    lsnet: " + json.dumps(str(tmp_path / "abs" / "lsnet")),
                "empty:",
                "",
            ]
        ),
        encoding="utf-8",
    )

    paths = model_sources.load_extra_model_paths(yaml_path)

    webui = os.path.abspath(os.path.join(str(yaml_dir), "../webui/"))
    assert paths["checkpoints"] == [
        os.path.normpath(os.path.join(webui, "models/Stable-diffusion"))
    ]
    # A multi-line key keeps its order and drops the empty trailing line.
    assert paths["loras"] == [
        os.path.normpath(os.path.join(webui, "models/Lora")),
        os.path.normpath(os.path.join(webui, "models/LyCORIS")),
    ]
    # Legacy names map like folder_paths.map_legacy.
    assert "unet" not in paths
    assert paths["diffusion_models"] == [
        os.path.normpath(os.path.join(webui, "models/unet"))
    ]
    assert "clip" not in paths
    assert paths["text_encoders"] == [
        os.path.normpath(os.path.join(os.path.expanduser("~/comfy-home"), "text"))
    ]
    # The variable expands; the section is still just a list of folders.
    assert paths["kgen"] == [
        os.path.normpath(os.path.join(str(tmp_path / "envbase" / "sub"), "gguf"))
    ]
    # No base_path: relative entries resolve against the yaml folder; absolute stay.
    assert paths["wd14_tagger"] == [
        os.path.normpath(os.path.join(str(yaml_dir), "taggers"))
    ]
    assert paths["lsnet"] == [os.path.normpath(str(tmp_path / "abs" / "lsnet"))]


def test_extra_model_paths_is_default_section_goes_first(tmp_path):
    yaml_path = tmp_path / "extra_model_paths.yaml"
    yaml_path.write_text(
        "\n".join(
            [
                "later:",
                "    base_path: /b",
                "    is_default: true",
                "    kgen: one",
                "first:",
                "    base_path: /a",
                "    kgen: two",
            ]
        ),
        encoding="utf-8",
    )
    # Sections are read in file order; a later is_default section is inserted at 0.
    yaml_path.write_text(
        yaml_path.read_text(encoding="utf-8")
        .replace("later:", "zz:", 1)
        .replace("first:", "aa:", 1),
        encoding="utf-8",
    )
    paths = model_sources.load_extra_model_paths(yaml_path)
    assert paths["kgen"][0] == os.path.normpath("/b/one")


def test_extra_model_paths_missing_or_broken_yaml_is_empty(tmp_path):
    assert model_sources.load_extra_model_paths(tmp_path / "nope.yaml") == {}
    broken = tmp_path / "extra_model_paths.yaml"
    broken.write_text("a111: [unclosed", encoding="utf-8")
    assert model_sources.load_extra_model_paths(broken) == {}


# ---------------------------------------------------------------------------
# What counts as a ComfyUI root
# ---------------------------------------------------------------------------


def test_comfyui_root_needs_folder_paths_and_models(tmp_path):
    root = make_comfyui_root(tmp_path / "ComfyUI")
    assert model_sources.is_comfyui_root(root)
    (root / "models").rmdir()
    assert not model_sources.is_comfyui_root(root)
    bare = tmp_path / "bare"
    bare.mkdir()
    (bare / "models").mkdir()
    assert not model_sources.is_comfyui_root(bare)


def test_resolve_comfyui_root_looks_one_level_into_aki_and_portable_shells(tmp_path):
    shell = tmp_path / "ComfyUI-aki-v1.6"
    inner = make_comfyui_root(shell / "ComfyUI")
    assert model_sources.resolve_comfyui_root(shell) == inner
    assert model_sources.resolve_comfyui_root(inner) == inner
    assert model_sources.resolve_comfyui_root(tmp_path / "missing") is None


def test_comfyui_version_is_read_from_version_file(tmp_path):
    root = make_comfyui_root(tmp_path / "ComfyUI")
    assert model_sources.read_comfyui_version(root) is None
    (root / "comfyui_version.py").write_text(
        '__version__ = "0.36.0"\n', encoding="utf-8"
    )
    assert model_sources.read_comfyui_version(root) == "0.36.0"


# ---------------------------------------------------------------------------
# Hugging Face cache roots
# ---------------------------------------------------------------------------


def test_hf_cache_roots_env_first_then_global_default(tmp_path):
    home = tmp_path / "home"
    env = {
        "HF_HUB_CACHE": str(tmp_path / "hubcache"),
        "HF_HOME": str(tmp_path / "hfhome"),
    }
    roots = model_sources.hf_cache_roots(env=env, home=home)
    assert roots == [
        os.path.normpath(str(tmp_path / "hubcache")),
        os.path.normpath(str(tmp_path / "hfhome" / "hub")),
        os.path.normpath(str(home / ".cache" / "huggingface" / "hub")),
    ]
    # The launcher points HF_HOME at data/hf; the user's global cache must still be listed.
    only_default = model_sources.hf_cache_roots(env={}, home=home)
    assert only_default == [
        os.path.normpath(str(home / ".cache" / "huggingface" / "hub"))
    ]


# ---------------------------------------------------------------------------
# T0 / T1 / cached T2 merge
# ---------------------------------------------------------------------------


def test_detect_source_roots_trusted_first_env_probe_then_hf(tmp_path):
    home = tmp_path / "home"
    trusted_comfy = make_comfyui_root(tmp_path / "Trusted" / "ComfyUI")
    (trusted_comfy / "models" / "hub").mkdir()
    env_comfy = make_comfyui_root(tmp_path / "EnvComfy")
    probe_comfy = make_comfyui_root(home / "Documents" / "ComfyUI")
    scanned = make_comfyui_root(tmp_path / "D" / "ComfyUI_windows_portable" / "ComfyUI")
    nas = tmp_path / "nas-models"
    nas.mkdir()
    global_hub = home / ".cache" / "huggingface" / "hub"
    global_hub.mkdir(parents=True)

    trusted = [
        {
            "path": str(tmp_path / "Trusted"),
            "kind": "comfyui",
            "added_at": "2026-10-01",
        },
        {"path": str(nas), "kind": "folder", "added_at": "2026-10-01"},
        # Same root twice (shell and inner) collapses to one.
        {"path": str(trusted_comfy), "kind": "auto", "added_at": "2026-10-01"},
    ]
    env = {"COMFYUI_PATH": str(env_comfy), "USERPROFILE": str(home)}

    roots, pending = model_sources.detect_source_roots(
        trusted, env=env, home=home, scan_cache=[str(scanned)]
    )

    assert pending == []
    by_path = {r.path: r for r in roots}
    order = [r.path for r in roots]
    assert order[:2] == [str(trusted_comfy), str(nas)]
    assert by_path[str(trusted_comfy)].origin == "trusted"
    assert by_path[str(trusted_comfy)].kind == "comfyui"
    assert by_path[str(trusted_comfy)].trusted_rank == 0
    assert by_path[str(nas)].kind == "folder"
    assert by_path[str(nas)].trusted_rank == 1
    assert by_path[str(env_comfy)].origin == "env"
    assert by_path[str(probe_comfy)].origin == "probe"
    assert by_path[str(scanned)].origin == "scan"
    assert by_path[str(global_hub)].kind == "hf_cache"
    assert by_path[str(global_hub)].origin == "hf_default"
    # A ComfyUI models/hub folder is a Hugging Face cache too.
    assert by_path[str(trusted_comfy / "models" / "hub")].kind == "hf_cache"
    assert by_path[str(trusted_comfy / "models" / "hub")].origin == "comfyui_hub"
    # A hub inside a trusted install inherits that install's rank; everything
    # found automatically sorts after every trusted entry.
    assert by_path[str(trusted_comfy / "models" / "hub")].trusted_rank == 0
    assert all(
        by_path[p].trusted_rank >= 1000
        for p in order[2:]
        if by_path[p].origin != "comfyui_hub"
    )
    assert len(order) == len(set(os.path.normcase(p) for p in order))


def test_detect_source_roots_skips_missing_and_non_comfy_entries(tmp_path):
    roots, pending = model_sources.detect_source_roots(
        [{"path": str(tmp_path / "gone"), "kind": "comfyui"}],
        env={"COMFYUI_PATH": str(tmp_path / "not-comfy")},
        home=tmp_path / "home",
    )
    assert roots == [] and pending == []


def test_detect_source_roots_queues_network_entries_without_touching_them(
    tmp_path, monkeypatch
):
    unc = "\\\\nas\\models"
    touched = []
    real_isdir = os.path.isdir

    def recording_isdir(path):
        if str(path).startswith("\\\\"):
            touched.append(str(path))
        return real_isdir(path)

    monkeypatch.setattr(model_sources.os.path, "isdir", recording_isdir)
    roots, pending = model_sources.detect_source_roots(
        [{"path": unc, "kind": "auto"}, {"path": unc + "\\", "kind": "auto"}],
        env={"COMFYUI_PATH": "//nas2/comfy", "HF_HUB_CACHE": r"\\nas3\hub"},
        home=tmp_path / "home",
        probe=False,
    )
    assert touched == []
    assert [r.kind for r in roots] == []
    # Only a trusted entry earns a background look; network paths found any
    # other way (env, caches) are dropped, and the two spellings collapse.
    assert [(p.origin, p.kind) for p in pending] == [("trusted", "auto")]
    assert pending[0].trusted_rank == 0


def test_network_or_removable_paths_are_flagged():
    assert model_sources.is_network_path(r"\\nas\models") is True
    assert model_sources.is_network_path("//nas/models") is True
    assert model_sources.is_network_path(str(Path(__file__).resolve())) is False


# ---------------------------------------------------------------------------
# T2 drive scan: depth 2, name match, background generations, persisted
# ---------------------------------------------------------------------------


def test_scan_drives_matches_comfy_names_two_levels_deep_only(tmp_path):
    drive = tmp_path / "drive"
    aki = make_comfyui_root(drive / "ComfyUI-aki-v1.6" / "ComfyUI")
    direct = make_comfyui_root(drive / "tools" / "comfyui")
    make_comfyui_root(drive / "a" / "b" / "ComfyUI_deep")  # depth 3: not scanned
    (drive / "comfy-notes").mkdir()  # name matches but not a root
    make_comfyui_root(drive / "tools" / "other-ui")  # root but name does not match

    found = model_sources.scan_drives_for_comfyui(drives=[str(drive)])

    assert found == sorted({str(aki), str(direct)})


def test_background_scan_runs_once_per_process_and_persists(tmp_path, monkeypatch):
    drive = tmp_path / "drive"
    root = make_comfyui_root(drive / "ComfyUI")
    store = model_sources_store.ModelSourcesStore(tmp_path / "model_sources.json")
    calls = []
    work_calls = []
    done = threading.Event()

    def fake_scan(drives=None):
        calls.append(drives)
        return [str(root)]

    monkeypatch.setattr(model_sources, "scan_drives_for_comfyui", fake_scan)
    monkeypatch.setattr(
        model_sources_store, "_scan_state", model_sources_store._ScanState()
    )

    first = model_sources_store.start_background_scan(
        store, work=work_calls.append, on_done=done.set
    )
    assert first == 1
    assert done.wait(5)
    second = model_sources_store.start_background_scan(store, on_done=done.set)
    assert second is None
    assert len(calls) == 1
    assert work_calls == [1]  # the extra work ran with the generation number

    saved = json.loads((tmp_path / "model_sources.json").read_text(encoding="utf-8"))
    assert saved["scan"]["roots"] == [str(root)]
    assert saved["scan"]["scanned_at"] > 0
    assert store.scan_roots() == [str(root)]
    assert model_sources_store.scan_status()["status"] == "done"
    assert model_sources_store.scan_status()["completed_generation"] == 1


def test_store_drops_cached_roots_that_vanished(tmp_path):
    root = make_comfyui_root(tmp_path / "ComfyUI")
    store = model_sources_store.ModelSourcesStore(tmp_path / "model_sources.json")
    store.save_scan([str(root), str(tmp_path / "gone")], scanned_at=1.0)
    assert store.scan_roots() == [str(root)]


def test_store_digest_cache_keyed_by_size_and_mtime(tmp_path):
    store = model_sources_store.ModelSourcesStore(tmp_path / "model_sources.json")
    store.remember_digest("C:/x/model.onnx", 10, 20, "abc")
    assert store.cached_digest("C:/x/model.onnx", 10, 20) == "abc"
    assert store.cached_digest("C:/x/model.onnx", 11, 20) is None
    assert store.cached_digest("C:/x/model.onnx", 10, 21) is None
    reloaded = model_sources_store.ModelSourcesStore(tmp_path / "model_sources.json")
    assert reloaded.cached_digest("C:/x/model.onnx", 10, 20) == "abc"


def test_store_survives_corrupt_file(tmp_path):
    path = tmp_path / "model_sources.json"
    path.write_text("{not json", encoding="utf-8")
    store = model_sources_store.ModelSourcesStore(path)
    assert store.scan_roots() == []
    assert (tmp_path / "model_sources.json.bak").read_text(
        encoding="utf-8"
    ) == "{not json"
    store.save_scan([], scanned_at=2.0)
    assert json.loads(path.read_text(encoding="utf-8"))["scan"]["scanned_at"] == 2.0


@pytest.mark.skipif(sys.platform != "win32", reason="drive letters")
def test_list_fixed_drives_returns_only_fixed_local_drives():
    drives = model_sources.list_fixed_drives()
    assert drives
    assert all(len(d) == 3 and d[1:] == ":\\" for d in drives)
    assert os.environ.get("SystemDrive", "C:") + "\\" in drives
