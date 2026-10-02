"""MS1a review fixes: trust, network isolation, store resilience, scan generations.

Trust is decided exactly like the loaders (SEC1b): a match is adopted only
when ``model_roots.is_under_allowed_model_root`` says yes, so a card that
shows "ready" never loads a file the loader would refuse. Everything found in
an untrusted root is reported as a *suggestion* so the Model Center can ask
"found ComfyUI with 8.5 GB usable, trust it?".
"""

from __future__ import annotations

import dataclasses
import hashlib
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

import model_matchers  # noqa: E402
import model_roots  # noqa: E402
import model_sources  # noqa: E402
import model_matchers_tagger  # noqa: E402
import model_source_paths  # noqa: E402
import model_sources_store  # noqa: E402
from services.model_sources_service import (  # noqa: E402
    ModelSourcesService,
    get_model_sources_service,
)
from tagger_models import TAGGER_MODELS  # noqa: E402

VIT = "wd-vit-tagger-v3"
CONVNEXT = "wd-convnext-tagger-v3"
WD14_NODE_DIR = Path("custom_nodes") / "comfyui-WD14-Tagger" / "models"
BS = "\\"


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write(path: Path, data: bytes) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


def make_comfyui_root(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    (path / "folder_paths.py").write_text("# fake\n", encoding="utf-8")
    (path / "models").mkdir(exist_ok=True)
    (path / "comfyui_version.py").write_text(
        '__version__ = "0.36.0"\n', encoding="utf-8"
    )
    return path


def pin_variant(
    monkeypatch, variant: str, model_bytes: bytes, tags_bytes: bytes
) -> None:
    entry = dict(TAGGER_MODELS[variant])
    entry["size_bytes"] = len(model_bytes)
    entry["sha256"] = sha256(model_bytes)
    entry["tags_sha256"] = sha256(tags_bytes)
    monkeypatch.setitem(TAGGER_MODELS, variant, entry)


def put_wd14(folder: Path, variant: str, model: bytes, csv: bytes) -> Path:
    write(folder / f"{variant}.csv", csv)
    return write(folder / f"{variant}.onnx", model)


@pytest.fixture
def isolated(tmp_path, monkeypatch):
    """Program folders, settings file and scan state all under tmp_path."""
    import config

    project = tmp_path / "project"
    data = tmp_path / "data"
    config_dir = data / "config"
    (project / "models").mkdir(parents=True)
    (data / "models").mkdir(parents=True)
    config_dir.mkdir(parents=True)
    monkeypatch.setattr(config, "PROJECT_ROOT", project)
    monkeypatch.setattr(config, "DATA_DIR", data)
    monkeypatch.setattr(config, "CONFIG_DIR", config_dir)
    monkeypatch.setattr(
        config, "APP_SETTINGS_CONFIG_PATH", config_dir / "app-settings.json"
    )
    monkeypatch.setattr(
        model_sources_store, "_scan_state", model_sources_store._ScanState()
    )
    home = tmp_path / "home"
    (home / ".cache" / "huggingface" / "hub").mkdir(parents=True)
    return SimpleNamespace(
        project_models=project / "models",
        data_models=data / "models",
        config_dir=config_dir,
        home=home,
        store_path=config_dir / "model_sources.json",
    )


def make_service(isolated, **overrides) -> ModelSourcesService:
    options = dict(
        store=model_sources_store.ModelSourcesStore(isolated.store_path),
        env={},
        home=isolated.home,
        probe_known_locations=False,
        background_scan=False,
    )
    options.update(overrides)
    return ModelSourcesService(**options)


# ---------------------------------------------------------------------------
# MEDIUM-7: trust decided by model_roots; untrusted roots become suggestions
# ---------------------------------------------------------------------------


def test_only_files_under_allowed_roots_are_adopted_rest_become_suggestions(
    isolated, tmp_path, monkeypatch
):
    model = b"vit" * 50
    csv = b"tag_id,name\n"
    pin_variant(monkeypatch, VIT, model, csv)
    trusted = make_comfyui_root(tmp_path / "Trusted" / "ComfyUI")
    put_wd14(trusted / WD14_NODE_DIR, VIT, model, csv)
    model_roots.add_trusted_model_folder(str(trusted))
    found = make_comfyui_root(tmp_path / "Found" / "ComfyUI")
    put_wd14(found / WD14_NODE_DIR, VIT, model, csv)
    convnext = b"convnext" * 50
    pin_variant(monkeypatch, CONVNEXT, convnext, csv)
    put_wd14(found / WD14_NODE_DIR, CONVNEXT, convnext, csv)
    service = make_service(isolated)
    service.store.save_scan([str(found)], scanned_at=1.0)

    payload = service.detect()

    (match,) = payload["matches"]
    assert match["path"] == str(trusted / WD14_NODE_DIR / f"{VIT}.onnx")
    assert match["trusted"] is True
    assert match["origin"] == "trusted"
    # The loaders (MS1b) read back trusted matches only.
    assert [m["path"] for m in service.store.matches()] == [match["path"]]
    assert payload["reusable_bytes"] == len(model) + len(csv)
    (suggestion,) = payload["suggestions"]
    assert suggestion["root"] == str(found)
    assert suggestion["kind"] == "comfyui"
    assert suggestion["origin"] == "scan"
    assert suggestion["version"] == "0.36.0"
    # VIT is already adopted from the trusted root, so only convnext is offered.
    assert [
        (m["model_id"], m["variant"], m["verify"]) for m in suggestion["models"]
    ] == [
        ("wd14", CONVNEXT, "sha"),
    ]
    assert suggestion["reusable_bytes"] == len(convnext) + len(csv)
    assert payload["suggested_reusable_bytes"] == len(convnext) + len(csv)
    sources = {s["path"]: s for s in payload["sources"]}
    assert sources[str(found)]["trusted"] is False
    assert sources[str(found)]["model_count"] == 2
    assert sources[str(trusted)]["model_count"] == 1


def test_trust_follows_the_loader_rule_not_the_root_list(
    isolated, tmp_path, monkeypatch
):
    """A root listed as trusted by the provider but not in model_roots is not adopted."""
    model = b"vit" * 50
    csv = b"tag_id,name\n"
    pin_variant(monkeypatch, VIT, model, csv)
    comfy = make_comfyui_root(tmp_path / "Listed" / "ComfyUI")
    put_wd14(comfy / WD14_NODE_DIR, VIT, model, csv)
    service = make_service(
        isolated, trusted_provider=lambda: [{"path": str(comfy), "kind": "auto"}]
    )

    payload = service.detect()

    assert payload["matches"] == []
    assert payload["suggestions"][0]["root"] == str(comfy)
    # Under the program's own models folder it is trusted without any list entry.
    put_wd14(isolated.data_models / "wd14_tagger", VIT, model, csv)
    service = make_service(
        isolated,
        trusted_provider=lambda: [
            {"path": str(isolated.data_models), "kind": "folder"}
        ],
    )
    payload = service.detect()
    assert [m["trusted"] for m in payload["matches"]] == [True]


def test_default_provider_reads_the_model_roots_list(isolated, tmp_path):
    folder = tmp_path / "shared"
    folder.mkdir()
    model_roots.add_trusted_model_folder(str(folder))
    service = ModelSourcesService(
        store=model_sources_store.ModelSourcesStore(isolated.store_path),
        env={},
        home=isolated.home,
        probe_known_locations=False,
        background_scan=False,
    )
    assert [f["path"] for f in service._trusted_folders()] == [str(folder)]
    assert service._trusted_folders()[0]["kind"] == "auto"


def test_external_match_dict_round_trip_carries_trust_and_origin():
    match = model_matchers.ExternalMatch(
        model_id="wd14",
        variant=VIT,
        path="C:/x/m.onnx",
        source="C:/x",
        folder="C:/x",
        source_kind="comfyui",
        origin="scan",
        verify="sha",
        size_bytes=1,
        mtime_ns=2,
        trusted=False,
    )
    data = match.to_dict()
    assert (
        data["trusted"] is False
        and data["origin"] == "scan"
        and data["folder"] == "C:/x"
    )
    assert model_matchers.ExternalMatch.from_dict(data) == match


# ---------------------------------------------------------------------------
# HIGH-1: network paths inside untrusted roots are never read
# ---------------------------------------------------------------------------


def test_yaml_network_paths_are_dropped_and_never_probed(
    isolated, tmp_path, monkeypatch
):
    comfy = make_comfyui_root(tmp_path / "Found" / "ComfyUI")
    unc = BS * 2 + "nas-offline" + BS + "models" + BS + "wd14"
    (comfy / "extra_model_paths.yaml").write_text(
        "nas:\n    base_path: '"
        + unc
        + "'\n    wd14_tagger: taggers\nlocal:\n    wd14_tagger: "
        + json.dumps(str(tmp_path / "local-taggers"))
        + "\n",
        encoding="utf-8",
    )
    (tmp_path / "local-taggers").mkdir()
    probed = []
    real_isdir = os.path.isdir

    def recording_isdir(path):
        if model_roots.is_network_path(path):
            probed.append(str(path))
            return False
        return real_isdir(path)

    monkeypatch.setattr(model_sources.os.path, "isdir", recording_isdir)
    root = model_sources.build_source_root(str(comfy), kind="comfyui", origin="scan")
    assert root is not None
    assert root.extra_model_paths == {"wd14_tagger": [str(tmp_path / "local-taggers")]}
    model_matchers.match_root(root, trust_check=lambda p: False)
    assert probed == []


@pytest.mark.skipif(sys.platform != "win32", reason="directory junctions")
def test_a_junction_to_a_network_target_under_models_is_not_read(
    isolated, tmp_path, monkeypatch
):
    model = b"vit" * 50
    csv = b"tag_id,name\n"
    pin_variant(monkeypatch, VIT, model, csv)
    comfy = make_comfyui_root(tmp_path / "Found" / "ComfyUI")
    nas_like = tmp_path / "nas-like"
    put_wd14(nas_like, VIT, model, csv)
    link = comfy / "models" / "wd14_tagger"
    result = subprocess.run(
        ["cmd", "/c", "mklink", "/J", str(link), str(nas_like)],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        pytest.skip("mklink /J unavailable: " + result.stderr.strip())
    # The junction target "is" a network location for this test.
    real_is_network = model_source_paths.is_network_path
    monkeypatch.setattr(
        model_source_paths,
        "is_network_path",
        lambda p: (
            os.path.normcase(str(p)).startswith(os.path.normcase(str(nas_like)))
            or real_is_network(p)
        ),
    )
    opened = []
    real_stat = model_matchers._stat_file

    def recording_stat(path):
        opened.append(str(path))
        return real_stat(path)

    monkeypatch.setattr(model_matchers, "_stat_file", recording_stat)
    root = model_sources.build_source_root(str(comfy), kind="comfyui", origin="scan")

    report = model_matchers.match_root(root, trust_check=lambda p: False)

    assert report.matches == []
    assert not any(
        os.path.normcase(p).startswith(os.path.normcase(str(link))) for p in opened
    )
    # Same junction, same files: a background pass that may read the network sees them.
    report = model_matchers.match_root(
        root, trust_check=lambda p: False, network_allowed=True
    )
    assert [m.variant for m in report.matches] == [VIT]
    assert report.matches[0].verify == "size"  # network: never hashed
    assert "hash_skipped_network" in report.matches[0].notes


def test_is_network_path_uses_model_roots_spellings_and_drive_types(monkeypatch):
    for spelling in (r"\\nas\share", "//nas/share", r"\/nas/share", r"\??\UNC\nas\x"):
        assert model_sources.is_network_path(spelling) is True
    # NT-prefixed local paths (what readlink returns for a junction) are local.
    assert model_sources.is_network_path(r"\??\C:\x") is False
    # Drive types are a Windows notion: judge these as a Windows host does.
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(
        model_source_paths,
        "_drive_type",
        lambda p: (
            model_source_paths._DRIVE_REMOTE
            if p.upper().startswith("Z:")
            else model_source_paths._DRIVE_FIXED
        ),
    )
    assert model_sources.is_network_path(r"Z:\models") is True
    assert model_sources.is_network_path(r"C:\models") is False
    monkeypatch.setattr(
        model_source_paths, "_drive_type", lambda p: model_source_paths._DRIVE_REMOVABLE
    )
    assert model_sources.is_network_path(r"E:\models") is True


# ---------------------------------------------------------------------------
# HIGH-2: Linux
# ---------------------------------------------------------------------------


def test_linux_network_mounts_come_from_proc_mounts(monkeypatch, caplog):
    monkeypatch.setattr(sys, "platform", "linux")
    mounts = [
        ("/", "ext4"),
        ("/mnt/nas", "nfs4"),
        ("/home/u/remote", "fuse.sshfs"),
        ("/srv/smb", "cifs"),
    ]
    monkeypatch.setattr(model_source_paths, "_read_linux_mounts", lambda: mounts)
    model_source_paths._forget_linux_mounts()
    assert model_sources.is_network_path("/mnt/nas/models/x.onnx") is True
    assert model_sources.is_network_path("/home/u/remote/x") is True
    assert model_sources.is_network_path("/srv/smb") is True
    assert model_sources.is_network_path("/home/u/local/x") is False
    assert model_sources.is_network_path("/mnt/nas2") is False  # prefix is not a parent

    def unreadable():
        raise OSError("no /proc")

    monkeypatch.setattr(model_source_paths, "_read_linux_mounts", unreadable)
    model_source_paths._forget_linux_mounts()
    with caplog.at_level("WARNING"):
        assert model_sources.is_network_path("/mnt/nas/models") is False
    assert any("proc/mounts" in r.message for r in caplog.records)


def test_linux_scan_roots_exclude_mnt_and_media(monkeypatch):
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(model_sources.os.path, "isdir", lambda p: True)
    drives = model_sources.list_fixed_drives()
    assert "/mnt" not in drives and "/media" not in drives
    assert "/opt" in drives


# ---------------------------------------------------------------------------
# HIGH-3 / MEDIUM-4: the store never takes detect down
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "payload", [b"\xff\xfe\x00garbage{", b"[1, 2, 3]", b"{not json", b'"text"']
)
def test_corrupt_store_is_quarantined_as_bak_and_starts_fresh(
    tmp_path, payload, caplog
):
    path = tmp_path / "model_sources.json"
    path.write_bytes(payload)
    (tmp_path / "model_sources.json.bak").write_bytes(b"older")
    with caplog.at_level("WARNING"):
        store = model_sources_store.ModelSourcesStore(path)
    assert store.scan_roots() == [] and store.matches() == []
    assert (tmp_path / "model_sources.json.bak").read_bytes() == payload
    assert not path.exists() or path.read_bytes() != payload
    assert any("model_sources.json" in r.message for r in caplog.records)
    store.save_scan([], scanned_at=1.0)
    assert json.loads(path.read_text(encoding="utf-8"))["scan"]["scanned_at"] == 1.0


def test_detect_survives_a_corrupt_store_twice(isolated, test_client):
    from main import app

    isolated.store_path.write_bytes(b"\xff\xfe\x00garbage{")
    service = ModelSourcesService(
        env={}, home=isolated.home, probe_known_locations=False, background_scan=False
    )
    app.dependency_overrides[get_model_sources_service] = lambda: service
    try:
        assert test_client.get("/api/models/sources/detect").status_code == 200
        assert test_client.get("/api/models/sources/detect").status_code == 200
    finally:
        app.dependency_overrides.pop(get_model_sources_service, None)


def test_save_failure_keeps_data_in_memory_and_does_not_raise(
    tmp_path, monkeypatch, caplog
):
    store = model_sources_store.ModelSourcesStore(tmp_path / "model_sources.json")

    def deny(src, dst):
        raise PermissionError(13, "being used by another process", str(dst))

    monkeypatch.setattr(model_sources.os, "replace", deny)
    with caplog.at_level("WARNING"):
        store.remember_digest("C:/x", 1, 2, "abc")
    assert store.cached_digest("C:/x", 1, 2) == "abc"
    assert any("model_sources.json" in r.message for r in caplog.records)
    assert not list(tmp_path.glob("*.tmp"))  # the temp file is cleaned up


def test_two_stores_on_one_file_use_unique_temp_names(tmp_path):
    path = tmp_path / "model_sources.json"
    first = model_sources_store.ModelSourcesStore(path)
    second = model_sources_store.ModelSourcesStore(path)
    errors = []

    def hammer(store, tag):
        for index in range(200):
            try:
                store.remember_digest(f"{tag}{index}", 1, 1, "d")
            except (
                Exception
            ) as exc:  # pragma: no cover - the assertion below reports it
                errors.append(repr(exc))

    threads = [
        threading.Thread(target=hammer, args=(first, "a")),
        threading.Thread(target=hammer, args=(second, "b")),
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert errors == []
    json.loads(path.read_text(encoding="utf-8"))


def test_service_store_is_created_once_under_concurrency(isolated, monkeypatch):
    created = []
    real = model_sources_store.ModelSourcesStore

    def slow_store(path):
        time.sleep(0.05)
        created.append(path)
        return real(path)

    monkeypatch.setattr(model_sources_store, "ModelSourcesStore", slow_store)
    service = ModelSourcesService(
        env={}, home=isolated.home, probe_known_locations=False, background_scan=False
    )
    threads = [threading.Thread(target=lambda: service.store) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert len(created) == 1


def test_an_unreadable_file_is_rejected_not_fatal(isolated, tmp_path, monkeypatch):
    import aesthetic

    pin = aesthetic.WAIFU_HEAD_FILE
    hub = isolated.home / ".cache" / "huggingface" / "hub"
    snap = hub / ("models--" + pin.repo.replace("/", "--")) / "snapshots" / pin.revision
    write(snap / pin.remote_path, b"x" * 10)
    monkeypatch.setattr(
        aesthetic, "WAIFU_HEAD_FILE", dataclasses.replace(pin, size_bytes=10)
    )

    def locked(path):
        raise PermissionError(13, "being used by another process", str(path))

    monkeypatch.setattr(model_matchers, "_hash_file", locked)
    payload = make_service(isolated).detect()
    (rejected,) = [r for r in payload["rejected"] if r["model_id"] == "aesthetic-waifu"]
    assert rejected["reason"] == "unreadable"
    assert "being used" in rejected["detail"]


def test_a_matcher_that_raises_is_logged_and_the_others_still_run(
    isolated, tmp_path, monkeypatch, caplog
):
    hub = isolated.home / ".cache" / "huggingface" / "hub"

    def boom(ctx):
        raise RuntimeError("hf matcher exploded")

    monkeypatch.setattr(model_matchers, "match_hf_cache", boom)
    root = model_sources.build_source_root(
        str(hub), kind="hf_cache", origin="hf_default"
    )
    with caplog.at_level("WARNING"):
        report = model_matchers.match_root(root, trust_check=lambda p: True)
    assert report.matches == [] and report.rejected == []
    assert any("hf matcher exploded" in r.message for r in caplog.records)


# ---------------------------------------------------------------------------
# MEDIUM-5: only the WD14 runtime family is matched
# ---------------------------------------------------------------------------


def test_oppai_oracle_is_not_detected_even_with_pins(isolated, tmp_path, monkeypatch):
    folder = tmp_path / "shared"
    payload = b"oppai" * 200
    write(folder / "oppai-oracle-v1.1" / "model.onnx", payload)
    write(folder / "oppai-oracle-v1.1" / "selected_tags.csv", b"x\n")
    entry = dict(TAGGER_MODELS["oppai-oracle-v1.1"])
    entry["size_bytes"] = len(payload)
    entry["sha256"] = sha256(payload)
    monkeypatch.setitem(TAGGER_MODELS, "oppai-oracle-v1.1", entry)
    root = model_sources.build_source_root(
        str(folder), kind="folder", origin="trusted", trusted_rank=0
    )
    assert model_matchers.match_root(root, trust_check=lambda p: True).matches == []
    assert "oppai-oracle-v1.1" not in [
        name for name, _ in model_matchers._wd14_entries()
    ]
    hub = isolated.home / ".cache" / "huggingface" / "hub"
    snap = (
        hub
        / ("models--" + entry["repo_id"].replace("/", "--"))
        / "snapshots"
        / entry["revision"]
    )
    write(snap / "V1.1_onnx" / "model.onnx", payload)
    write(snap / "V1.1_onnx" / "selected_tags.csv", b"x\n")
    hub_root = model_sources.build_source_root(
        str(hub), kind="hf_cache", origin="hf_default"
    )
    report = model_matchers.match_root(hub_root, trust_check=lambda p: True)
    assert not [m for m in report.matches if m.variant == "oppai-oracle-v1.1"]
    assert (
        "size_bytes" not in TAGGER_MODELS["oppai-oracle-v1.1"]
        or entry is TAGGER_MODELS["oppai-oracle-v1.1"]
    )


# ---------------------------------------------------------------------------
# MEDIUM-6: TIPO keeps the verification reason
# ---------------------------------------------------------------------------


def test_tipo_sha_mismatch_is_rejected_and_a_real_sha_match_is_sha(
    isolated, tmp_path, monkeypatch
):
    comfy = make_comfyui_root(tmp_path / "C" / "ComfyUI")
    payload = b"gguf" * 64
    pin = model_matchers.FilePin("TIPO-v2.1-1B-A200M-Q8_0.gguf", len(payload), "0" * 64)
    monkeypatch.setitem(model_matchers.TIPO_FILE_PINS, "v2.1", pin)
    write(comfy / "models" / "kgen" / pin.filename, payload)
    root = model_sources.build_source_root(
        str(comfy), kind="comfyui", origin="trusted", trusted_rank=0
    )

    report = model_matchers.match_root(root, trust_check=lambda p: True)
    assert [m for m in report.matches if m.model_id == "tipo"] == []
    (rejected,) = [r for r in report.rejected if r.model_id == "tipo"]
    assert rejected.reason == "sha_mismatch"

    monkeypatch.setitem(
        model_matchers.TIPO_FILE_PINS,
        "v2.1",
        dataclasses.replace(pin, sha256=sha256(payload)),
    )
    report = model_matchers.match_root(root, trust_check=lambda p: True)
    (match,) = [m for m in report.matches if m.model_id == "tipo"]
    assert match.verify == "sha"


# ---------------------------------------------------------------------------
# Item 7: network roots only on the background thread
# ---------------------------------------------------------------------------


def test_trusted_network_folder_is_never_touched_by_detect(isolated, monkeypatch):
    unc = BS * 2 + "nas-offline" + BS + "models" + BS + "comfy"
    model_roots.add_trusted_model_folder(unc)
    touched = []
    real_isdir = os.path.isdir

    def recording_isdir(path):
        if model_roots.is_network_path(path):
            touched.append(str(path))
            return False
        return real_isdir(path)

    monkeypatch.setattr(model_sources.os.path, "isdir", recording_isdir)
    service = make_service(isolated)

    payload = service.detect()

    assert touched == []
    (source,) = [s for s in payload["sources"] if s["is_network"]]
    assert source["path"] == model_roots.list_trusted_model_folders()[0]  # as stored
    assert source["network_pending"] is True
    assert source["network_scanned_at"] is None
    assert source["trusted"] is True
    assert payload["scan"]["status"] == "never"


def test_background_job_judges_network_roots_and_detect_reports_the_cache(
    isolated, monkeypatch
):
    unc = BS * 2 + "nas-offline" + BS + "models" + BS + "comfy"
    model_roots.add_trusted_model_folder(unc)
    seen = []

    def fake_isdir(path):
        if model_roots.is_network_path(path):
            seen.append((threading.current_thread().name, str(path)))
            return False
        return (
            os.path.isdir.__wrapped__(path)
            if hasattr(os.path.isdir, "__wrapped__")
            else _real_isdir(path)
        )

    _real_isdir = os.path.isdir
    monkeypatch.setattr(model_sources.os.path, "isdir", fake_isdir)
    service = make_service(isolated, background_scan=True)
    monkeypatch.setattr(
        model_sources, "scan_drives_for_comfyui", lambda drives=None: []
    )

    first = service.detect()
    assert model_sources_store.wait_for_scans(timeout=5)
    second = service.detect()

    assert all(name != threading.main_thread().name for name, _ in seen)
    assert seen and seen[0][1] == model_roots.list_trusted_model_folders()[0]
    network = [s for s in second["sources"] if s["is_network"]][0]
    assert network["network_pending"] is False
    assert network["network_scanned_at"] is not None
    assert network["model_count"] == 0
    assert first["scan"]["status"] in {"running", "done"}
    assert second["scan"]["status"] == "done"


def test_rescan_only_triggers_the_background_job(isolated, monkeypatch):
    started = threading.Event()
    release = threading.Event()

    def slow_scan(drives=None):
        started.set()
        release.wait(5)
        return []

    monkeypatch.setattr(model_sources, "scan_drives_for_comfyui", slow_scan)
    service = make_service(isolated)
    try:
        before = time.perf_counter()
        payload = service.detect(rescan=True)
        assert time.perf_counter() - before < 2
        assert started.wait(5)
        assert payload["scan"]["status"] == "running"
    finally:
        release.set()
    assert model_sources_store.wait_for_scans(timeout=5)
    assert service.detect()["scan"]["status"] == "done"


# ---------------------------------------------------------------------------
# LOW-8: reparse points are not followed by the scan or the walks
# ---------------------------------------------------------------------------


@pytest.mark.skipif(sys.platform != "win32", reason="directory junctions")
def test_t2_scan_and_kaloscope_walk_do_not_follow_junctions(tmp_path):
    drive = tmp_path / "drive"
    drive.mkdir()
    elsewhere = tmp_path / "elsewhere"
    make_comfyui_root(elsewhere / "ComfyUI")
    result = subprocess.run(
        ["cmd", "/c", "mklink", "/J", str(drive / "comfy_junction"), str(elsewhere)],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        pytest.skip("mklink /J unavailable: " + result.stderr.strip())
    assert model_sources.scan_drives_for_comfyui([str(drive)]) == []

    lsnet = tmp_path / "lsnet"
    lsnet.mkdir()
    subprocess.run(
        ["cmd", "/c", "mklink", "/J", str(lsnet / "loop"), str(lsnet)],
        capture_output=True,
    )
    write(lsnet / "best_checkpoint.pth", b"x")
    found = model_matchers_tagger._walk_for_name(lsnet, "best_checkpoint.pth", 3)
    assert found == [lsnet / "best_checkpoint.pth"]


# ---------------------------------------------------------------------------
# LOW-9 / LOW-10: scan generations and the persisted shape
# ---------------------------------------------------------------------------


def test_an_older_scan_generation_never_overwrites_a_newer_one(isolated, monkeypatch):
    store = model_sources_store.ModelSourcesStore(isolated.store_path)
    old = make_comfyui_root(isolated.home / "old" / "ComfyUI")
    new = make_comfyui_root(isolated.home / "new" / "ComfyUI")
    release_old = threading.Event()
    calls = []

    def scan(drives=None):
        calls.append(1)
        if len(calls) == 1:
            release_old.wait(5)
            return [str(old)]
        return [str(new)]

    monkeypatch.setattr(model_sources, "scan_drives_for_comfyui", scan)
    assert model_sources_store.start_background_scan(store) is not None
    assert model_sources_store.start_background_scan(store) is None  # once per process
    assert model_sources_store.start_background_scan(store, force=True) is not None
    deadline = time.time() + 5
    while (
        model_sources_store.scan_status(store)["completed_generation"] < 2
        and time.time() < deadline
    ):
        time.sleep(0.01)
    assert store.scan_roots() == [str(new)]
    assert (
        model_sources_store.scan_status(store)["status"] == "running"
    )  # generation 1 still going
    release_old.set()
    assert model_sources_store.wait_for_scans(timeout=5)
    assert store.scan_roots() == [str(new)]
    assert model_sources_store.scan_status(store)["status"] == "done"
    saved = json.loads(isolated.store_path.read_text(encoding="utf-8"))
    assert saved["scan"]["roots"] == [str(new)]  # plain paths, no mtime bookkeeping


# ---------------------------------------------------------------------------
# LOW-11: backbone constants shared with aesthetic.py, no heavy import
# ---------------------------------------------------------------------------


def test_backbone_constants_are_shared_with_aesthetic():
    import aesthetic
    import aesthetic_backbone

    assert (
        aesthetic._AESTHETIC_BACKBONE_REPO_DIR == aesthetic_backbone.BACKBONE_REPO_DIR
    )
    assert (
        aesthetic._AESTHETIC_BACKBONE_FILENAMES == aesthetic_backbone.BACKBONE_FILENAMES
    )
    assert aesthetic_backbone.BACKBONE_REPO == "timm/vit_large_patch14_clip_224.openai"
    source = Path(aesthetic_backbone.__file__).read_text(encoding="utf-8")
    assert "import numpy" not in source and "import torch" not in source
