"""MS1a re-review: symlinks and junctions, store hygiene, suggestion dedup.

Every root, every extra folder and every file is checked link by link from
the drive root with ``lstat`` + ``readlink`` (local metadata only). A link
whose target is a network location turns a trusted root into a pending one
and drops anything else; a link to a local folder is followed and that
target folder is what a suggestion asks the user to trust. The spy below
records every filesystem call made with a UNC argument on the request
thread: the count must be zero.
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
import model_matchers_tagger  # noqa: E402
import model_roots  # noqa: E402
import model_source_paths  # noqa: E402
import model_sources  # noqa: E402
import model_sources_store  # noqa: E402
from services.model_sources_service import ModelSourcesService  # noqa: E402
from tagger_models import TAGGER_MODELS  # noqa: E402

VIT = "wd-vit-tagger-v3"
CONVNEXT = "wd-convnext-tagger-v3"
BS = "\\"
WIN = sys.platform == "win32"
needs_links = pytest.mark.skipif(not WIN, reason="Windows symlinks and junctions")


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
    return path


def unc_of(local: Path) -> str:
    """The same local folder through the admin share: a real, reachable UNC path."""
    text = str(local)
    assert text[1] == ":", text
    return BS * 2 + "localhost" + BS + text[0] + "$" + text[2:]


def link(kind: str, at: Path, target: str) -> None:
    at.parent.mkdir(parents=True, exist_ok=True)
    command = ["cmd", "/c", "mklink"] + ([kind] if kind else []) + [str(at), target]
    out = subprocess.run(command, capture_output=True, text=True)
    if out.returncode != 0:
        pytest.skip(f"mklink {kind} unavailable: {out.stderr.strip()}")


def pin_variant(
    monkeypatch, variant: str, model_bytes: bytes, tags_bytes: bytes
) -> None:
    entry = dict(TAGGER_MODELS[variant])
    entry["size_bytes"] = len(model_bytes)
    entry["sha256"] = sha256(model_bytes)
    entry["tags_sha256"] = sha256(tags_bytes)
    monkeypatch.setitem(TAGGER_MODELS, variant, entry)


MODEL = b"vit" * 50
CSV = b"tag_id,name\n"


def put_wd14(folder: Path, variant: str = VIT) -> Path:
    write(folder / f"{variant}.csv", CSV)
    return write(folder / f"{variant}.onnx", MODEL)


@pytest.fixture
def isolated(tmp_path, monkeypatch):
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
    pin_variant(monkeypatch, VIT, MODEL, CSV)
    home = tmp_path / "home"
    (home / ".cache" / "huggingface" / "hub").mkdir(parents=True)
    return SimpleNamespace(
        data=data, home=home, store_path=config_dir / "model_sources.json"
    )


_REAL_LSTAT = os.lstat
_REAL_READLINK = os.readlink


def _leads_to_unc(text: str, *, parents_only: bool = False) -> bool:
    """Independent oracle: does the OS reach a UNC location when it follows
    ``text``? Walks every component with the real lstat/readlink."""
    import stat as stat_module

    if text.startswith(BS * 2):
        return True
    drive, tail = os.path.splitdrive(text)
    if not drive:
        return False
    parts = [p for p in tail.split(os.sep) if p]
    if parents_only:
        parts = parts[:-1]
    prefix = drive + os.sep
    for part in parts:
        prefix = os.path.join(prefix, part)
        try:
            info = _REAL_LSTAT(prefix)
        except OSError:
            return False
        reparse = getattr(info, "st_file_attributes", 0) & getattr(
            stat_module, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400
        )
        if not (reparse or stat_module.S_ISLNK(info.st_mode)):
            continue
        try:
            target = _REAL_READLINK(prefix).replace("/", BS)
        except OSError:
            return False
        if target.startswith(BS * 2 + "?" + BS + "UNC" + BS):
            return True
        if target.startswith(BS * 2 + "?" + BS):
            target = target[4:]
        elif target.startswith(BS * 2):
            return True
        if not os.path.isabs(target):
            target = os.path.join(os.path.dirname(prefix), target)
        prefix = os.path.normpath(target)
    return False


@pytest.fixture
def unc_spy(monkeypatch):
    """Every filesystem call that reaches a UNC location, with the calling
    thread: a UNC argument, or a local argument the OS would follow through a
    symlink or junction to a UNC target (the spy walks the chain itself)."""
    import builtins

    calls = []
    following = ("stat", "scandir", "listdir")
    real = {name: getattr(os, name) for name in following + ("lstat", "readlink")}
    real_path = {name: getattr(os.path, name) for name in ("isdir", "isfile", "exists")}
    real_open = builtins.open

    def record(name, path, *, parents_only=False):
        text = os.fspath(path) if not isinstance(path, int) else ""
        if isinstance(text, str) and _leads_to_unc(text, parents_only=parents_only):
            calls.append((name, threading.current_thread().name, text))

    def spy(name, func, parents_only=False):
        def wrapper(path=".", *args, **kwargs):
            record(name, path, parents_only=parents_only)
            return func(path, *args, **kwargs)

        return wrapper

    for name in following:
        monkeypatch.setattr(os, name, spy(name, real[name]))
    monkeypatch.setattr(os, "lstat", spy("lstat", real["lstat"], parents_only=True))
    monkeypatch.setattr(
        os, "readlink", spy("readlink", real["readlink"], parents_only=True)
    )
    for name, func in real_path.items():
        monkeypatch.setattr(os.path, name, spy("path." + name, func))
    monkeypatch.setattr(builtins, "open", spy("open", real_open))
    return calls


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


def request_thread_unc_calls(calls):
    return [c for c in calls if c[1] == threading.current_thread().name]


# ---------------------------------------------------------------------------
# HIGH-A: a symlink to a UNC location anywhere in the chain
# ---------------------------------------------------------------------------


@needs_links
def test_yaml_folder_that_is_a_local_symlink_to_unc_is_not_read(
    isolated, tmp_path, unc_spy
):
    nas = tmp_path / "nas"
    put_wd14(nas / "wd14")
    outside = tmp_path / "outside_link"
    link("/D", outside, unc_of(nas))
    comfy = make_comfyui_root(tmp_path / "auto" / "ComfyUI")
    (comfy / "extra_model_paths.yaml").write_text(
        "s:\n    base_path: " + json.dumps(str(outside)) + "\n    wd14_tagger: wd14\n",
        encoding="utf-8",
    )
    service = make_service(isolated)
    service.store.save_scan([str(comfy)], scanned_at=1.0)

    payload = service.detect()

    assert request_thread_unc_calls(unc_spy) == []
    assert payload["matches"] == [] and payload["suggestions"] == []


@needs_links
def test_comfyui_path_that_is_a_local_symlink_to_unc_is_not_read(
    isolated, tmp_path, unc_spy
):
    nas_comfy = make_comfyui_root(tmp_path / "nas_comfy" / "ComfyUI")
    put_wd14(nas_comfy / "models" / "wd14_tagger")
    link("/D", tmp_path / "comfy_link", unc_of(nas_comfy))

    payload = make_service(
        isolated, env={"COMFYUI_PATH": str(tmp_path / "comfy_link")}
    ).detect()

    assert request_thread_unc_calls(unc_spy) == []
    assert payload["sources"] == [
        s for s in payload["sources"] if s["kind"] == "hf_cache"
    ]
    assert payload["suggestions"] == []


@needs_links
def test_hf_hub_cache_that_is_a_local_symlink_to_unc_is_not_read(
    isolated, tmp_path, unc_spy
):
    import aesthetic

    pin = aesthetic.WAIFU_HEAD_FILE
    snap = (
        tmp_path
        / "nas_hub"
        / ("models--" + pin.repo.replace("/", "--"))
        / "snapshots"
        / pin.revision
    )
    write(snap / pin.remote_path, b"x" * 10)
    link("/D", tmp_path / "hub_link", unc_of(tmp_path / "nas_hub"))

    payload = make_service(
        isolated, env={"HF_HUB_CACHE": str(tmp_path / "hub_link")}
    ).detect()

    assert request_thread_unc_calls(unc_spy) == []
    assert [s["path"] for s in payload["sources"]] == [
        str(isolated.home / ".cache" / "huggingface" / "hub")
    ]
    assert payload["rejected"] == []


@needs_links
def test_a_symlinked_parent_of_a_cached_or_probed_root_is_not_read(
    isolated, tmp_path, unc_spy
):
    nas = tmp_path / "nas"
    make_comfyui_root(nas / "ComfyUI_windows_portable" / "ComfyUI")
    make_comfyui_root(nas / "Documents" / "ComfyUI")
    link("/D", tmp_path / "shell_link", unc_of(nas / "ComfyUI_windows_portable"))
    link("/D", isolated.home / "Documents", unc_of(nas / "Documents"))
    service = make_service(
        isolated, probe_known_locations=True, env={"USERPROFILE": str(isolated.home)}
    )
    service.store.save_scan([str(tmp_path / "shell_link" / "ComfyUI")], scanned_at=1.0)

    payload = service.detect()

    assert request_thread_unc_calls(unc_spy) == []
    assert [s["kind"] for s in payload["sources"]] == ["hf_cache"]


@needs_links
def test_a_trusted_folder_reached_through_a_local_symlink_to_unc_becomes_pending(
    isolated, tmp_path, unc_spy
):
    nas = tmp_path / "nas"
    make_comfyui_root(nas / "ComfyUI")
    unc = unc_of(nas)
    link("/D", tmp_path / "nas_link", unc)
    service = make_service(
        isolated,
        trusted_provider=lambda: [{"path": str(tmp_path / "nas_link"), "kind": "auto"}],
    )

    payload = service.detect()

    assert request_thread_unc_calls(unc_spy) == []
    (row,) = [s for s in payload["sources"] if s["is_network"]]
    assert row["network_pending"] is True and row["trusted"] is True
    assert row["path"] == str(tmp_path / "nas_link")


@needs_links
def test_kaloscope_class_mapping_through_a_symlink_to_unc_is_not_read(
    isolated, tmp_path, unc_spy, monkeypatch
):
    import artist_identifier

    comfy = make_comfyui_root(tmp_path / "ComfyUI")
    lsnet = comfy / "models" / "lsnet" / "Kaloscope"
    write(
        lsnet / "best_checkpoint.pth", b"x"
    )  # size mismatch is fine: the mapping is read first? no: judge first
    monkeypatch.setattr(model_matchers_tagger, "KALOSCOPE_CHECKPOINT_SIZE_BYTES", 1)
    monkeypatch.setattr(
        model_matchers_tagger, "KALOSCOPE_CHECKPOINT_SHA256", sha256(b"x")
    )
    mapping = write(tmp_path / "nas" / "class_mapping.csv", b"class_id,artist\n")
    monkeypatch.setitem(
        artist_identifier._EXPECTED_ARTIST_FILE_SHA256,
        "class_mapping.csv",
        (sha256(mapping.read_bytes()),),
    )
    link("", lsnet / "class_mapping.csv", unc_of(mapping))
    root = model_sources.build_source_root(str(comfy), kind="comfyui", origin="scan")

    report = model_matchers.match_root(root, trust_check=lambda p: False)

    assert request_thread_unc_calls(unc_spy) == []
    assert report.matches == []
    (rejected,) = [r for r in report.rejected if r.model_id == "artist"]
    assert rejected.reason == "missing_companion"


def test_resolve_local_chain_judges_every_component(tmp_path):
    folder = tmp_path / "a" / "b"
    folder.mkdir(parents=True)
    kind, real = model_source_paths.resolve_local_chain(str(folder))
    assert (kind, real) == ("local", str(folder))
    assert (
        model_source_paths.resolve_local_chain(str(tmp_path / "missing" / "x"))[0]
        == "missing"
    )
    assert (
        model_source_paths.resolve_local_chain(
            BS * 2 + "nas" + BS + "share" + BS + "x"
        )[0]
        == "network"
    )
    assert model_source_paths.resolve_local_chain("//nas/share")[0] == "network"


@needs_links
def test_resolve_local_chain_follows_local_links_and_stops_at_network_ones(tmp_path):
    target = tmp_path / "real" / "models"
    target.mkdir(parents=True)
    (target / "sub").mkdir()
    link("/J", tmp_path / "junction", str(target))
    link("/D", tmp_path / "symlink", str(tmp_path / "junction"))
    assert model_source_paths.resolve_local_chain(
        str(tmp_path / "symlink" / "sub")
    ) == ("local", str(target / "sub"))
    link("/D", tmp_path / "to_nas", unc_of(target))
    kind, real = model_source_paths.resolve_local_chain(
        str(tmp_path / "to_nas" / "sub")
    )
    assert kind == "network"
    assert real.lower().startswith((BS * 2 + "localhost").lower())
    # A link loop ends as missing, never spins.
    link("/D", tmp_path / "loop_a", str(tmp_path / "loop_b"))
    link("/D", tmp_path / "loop_b", str(tmp_path / "loop_a"))
    assert (
        model_source_paths.resolve_local_chain(str(tmp_path / "loop_a" / "x"))[0]
        == "missing"
    )


# ---------------------------------------------------------------------------
# MEDIUM-B: local junctions are local, and suggestions name the target folder
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "spelling, expected",
    [
        (r"\\?\C:\shared\models", False),
        (r"\??\C:\shared\models", False),
        (r"\\?\UNC\nas\share\models", True),
        (r"\??\UNC\nas\share", True),
        (r"\\nas\share", True),
        (r"C:\shared\models", False),
    ],
)
def test_nt_prefixed_link_targets_are_classified_correctly(
    spelling, expected, monkeypatch
):
    monkeypatch.setattr(
        model_source_paths, "_drive_type", lambda p: model_source_paths._DRIVE_FIXED
    )
    assert model_source_paths.is_network_path(spelling) is expected
    assert model_source_paths.strip_nt_prefix(r"\\?\C:\x") == r"C:\x"
    assert model_source_paths.strip_nt_prefix(r"\\?\UNC\nas\share") == r"\\nas\share"


@needs_links
def test_local_junction_under_models_is_matched_and_suggested_as_its_target(
    isolated, tmp_path
):
    real_dir = tmp_path / "shared_models" / "wd14"
    put_wd14(real_dir)
    comfy = make_comfyui_root(tmp_path / "junction_comfy" / "ComfyUI")
    link("/J", comfy / "models" / "wd14_tagger", str(real_dir))
    service = make_service(isolated)
    service.store.save_scan([str(comfy)], scanned_at=1.0)

    payload = service.detect()

    assert payload["rejected"] == []
    (suggestion,) = payload["suggestions"]
    assert suggestion["root"] == str(real_dir)
    assert suggestion["kind"] == "folder"
    assert [m["variant"] for m in suggestion["models"]] == [VIT]
    # Trusting the suggested folder is exactly what makes the file load.
    model_roots.add_trusted_model_folder(str(real_dir))
    payload = service.detect()
    assert [m["variant"] for m in payload["matches"]] == [VIT]
    assert payload["matches"][0]["trusted"] is True
    assert payload["suggestions"] == []


@needs_links
def test_a_root_that_is_a_junction_is_reported_as_its_target(isolated, tmp_path):
    real_comfy = make_comfyui_root(tmp_path / "real" / "ComfyUI")
    put_wd14(real_comfy / "models" / "wd14_tagger")
    link("/J", tmp_path / "comfy_junction", str(real_comfy))

    payload = make_service(
        isolated, env={"COMFYUI_PATH": str(tmp_path / "comfy_junction")}
    ).detect()

    (source,) = [s for s in payload["sources"] if s["kind"] == "comfyui"]
    assert source["path"] == str(real_comfy)
    assert payload["suggestions"][0]["root"] == str(real_comfy)


# ---------------------------------------------------------------------------
# MEDIUM-C: the cache never takes detect down
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "entry",
    [
        {"root": None, "matches": [{"model_id": "wd14"}], "rejected": []},
        {"root": "x", "matches": [], "rejected": []},
        {"root": {}, "matches": "nope", "rejected": [{"bad": 1}]},
        "not even a dict",
    ],
)
def test_a_malformed_cached_network_result_is_treated_as_pending(
    isolated, entry, caplog
):
    unc = BS * 2 + "nas" + BS + "models" + BS + "comfy"
    key = model_sources.source_key(unc)
    isolated.store_path.write_text(
        json.dumps(
            {
                "version": model_sources_store.ModelSourcesStore.VERSION,
                "network": {key: entry},
            }
        ),
        encoding="utf-8",
    )
    service = make_service(
        isolated, trusted_provider=lambda: [{"path": unc, "kind": "auto"}]
    )
    with caplog.at_level("WARNING"):
        payload = service.detect()
    (row,) = [s for s in payload["sources"] if s["is_network"]]
    assert row["network_pending"] is True
    assert any("network" in r.message.lower() for r in caplog.records)


def test_a_store_with_another_version_starts_empty(tmp_path, caplog):
    path = tmp_path / "model_sources.json"
    path.write_text(
        json.dumps(
            {"version": 1, "scan": {"roots": [str(tmp_path)]}, "digests": {"k": "v"}}
        ),
        encoding="utf-8",
    )
    with caplog.at_level("INFO"):
        store = model_sources_store.ModelSourcesStore(path)
    assert store.cached_digest("k", 1, 1) is None and store.scan_roots() == []
    store.save_scan([], scanned_at=1.0)
    assert (
        json.loads(path.read_text(encoding="utf-8"))["version"]
        == model_sources_store.ModelSourcesStore.VERSION
    )


# ---------------------------------------------------------------------------
# MEDIUM-E: a NAS added later does not stay pending forever
# ---------------------------------------------------------------------------


def test_a_trusted_nas_added_after_the_first_job_gets_its_own_scan(
    isolated, monkeypatch
):
    unc = BS * 2 + "nas-offline" + BS + "models" + BS + "comfy"
    real_isdir = os.path.isdir
    monkeypatch.setattr(
        model_sources.os.path,
        "isdir",
        lambda p: False if model_roots.is_network_path(p) else real_isdir(p),
    )
    monkeypatch.setattr(
        model_sources, "scan_drives_for_comfyui", lambda drives=None: []
    )
    service = make_service(isolated, background_scan=True)
    service.detect()
    assert model_sources_store.wait_for_scans(timeout=5)
    model_roots.add_trusted_model_folder(unc)

    service.detect()  # the pending root has no cache and no job runs: a new generation starts
    assert model_sources_store.wait_for_scans(timeout=5)
    payload = service.detect()

    (row,) = [s for s in payload["sources"] if s["is_network"]]
    assert row["network_pending"] is False
    assert payload["scan"]["completed_generation"] == 2
    service.detect()  # cached now: no further generation
    assert model_sources_store.scan_status()["completed_generation"] == 2


# ---------------------------------------------------------------------------
# L1: suggestions are deduplicated against adopted models and across folders
# ---------------------------------------------------------------------------


def test_suggestions_skip_adopted_models_dedupe_across_folders_and_total(
    isolated, tmp_path, monkeypatch
):
    trusted = make_comfyui_root(tmp_path / "Trusted" / "ComfyUI")
    put_wd14(trusted / "models" / "wd14_tagger")
    model_roots.add_trusted_model_folder(str(trusted))
    found_a = make_comfyui_root(tmp_path / "A" / "ComfyUI")
    put_wd14(
        found_a / "models" / "wd14_tagger"
    )  # already adopted from the trusted root
    convnext = b"convnext" * 50
    pin_variant(monkeypatch, CONVNEXT, convnext, CSV)
    write(found_a / "models" / "wd14_tagger" / f"{CONVNEXT}.onnx", convnext)
    write(found_a / "models" / "wd14_tagger" / f"{CONVNEXT}.csv", CSV)
    found_b = make_comfyui_root(tmp_path / "B" / "ComfyUI")
    write(found_b / "models" / "wd14_tagger" / f"{CONVNEXT}.onnx", convnext)
    write(found_b / "models" / "wd14_tagger" / f"{CONVNEXT}.csv", CSV)
    service = make_service(isolated)
    service.store.save_scan([str(found_a), str(found_b)], scanned_at=1.0)

    payload = service.detect()

    assert [m["variant"] for m in payload["matches"]] == [VIT]
    (suggestion,) = payload["suggestions"]
    assert suggestion["root"] == str(found_a)
    assert [m["variant"] for m in suggestion["models"]] == [CONVNEXT]
    assert payload["suggested_reusable_bytes"] == len(convnext) + len(CSV)
    assert payload["suggested_reusable_bytes"] == sum(
        s["reusable_bytes"] for s in payload["suggestions"]
    )


def test_the_programs_own_hf_cache_is_never_suggested(isolated, monkeypatch):
    import aesthetic

    pin = aesthetic.WAIFU_HEAD_FILE
    payload_bytes = b"fake head"
    monkeypatch.setattr(
        aesthetic,
        "WAIFU_HEAD_FILE",
        dataclasses.replace(
            pin, sha256=sha256(payload_bytes), size_bytes=len(payload_bytes)
        ),
    )
    own_hub = isolated.data / "hf" / "hub"
    snap = (
        own_hub
        / ("models--" + pin.repo.replace("/", "--"))
        / "snapshots"
        / pin.revision
    )
    write(snap / pin.remote_path, payload_bytes)

    payload = make_service(
        isolated, env={"HF_HOME": str(isolated.data / "hf")}
    ).detect()

    assert str(own_hub) in [s["path"] for s in payload["sources"]]
    assert payload["suggestions"] == []
    assert payload["suggested_reusable_bytes"] == 0


# ---------------------------------------------------------------------------
# L2 / L3
# ---------------------------------------------------------------------------


def test_linux_scan_skips_network_mounts_under_home(tmp_path, monkeypatch):
    drive = tmp_path / "home"
    make_comfyui_root(drive / "nasmount" / "ComfyUI")
    make_comfyui_root(drive / "local" / "ComfyUI")
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(
        model_source_paths,
        "_read_linux_mounts",
        lambda: [(str(drive / "nasmount"), "nfs4")],
    )
    model_source_paths._forget_linux_mounts()
    try:
        found = model_sources.scan_drives_for_comfyui([str(drive)])
    finally:
        model_source_paths._forget_linux_mounts()
    assert found == [str(drive / "local" / "ComfyUI")]


def test_no_private_model_roots_helpers_are_used():
    for name in (
        "model_sources.py",
        "model_source_paths.py",
        "model_sources_store.py",
        "model_matchers.py",
        "services/model_sources_service.py",
    ):
        source = (Path(__file__).parent.parent / name).read_text(encoding="utf-8")
        assert "model_roots._windows_form" not in source, name


def test_detect_keeps_working_while_a_generation_runs(isolated, monkeypatch):
    release = threading.Event()

    def slow(drives=None):
        release.wait(5)
        return []

    monkeypatch.setattr(model_sources, "scan_drives_for_comfyui", slow)
    service = make_service(isolated, background_scan=True)
    try:
        started = time.perf_counter()
        service.detect()
        service.detect()
        assert time.perf_counter() - started < 2
    finally:
        release.set()
    assert model_sources_store.wait_for_scans(timeout=5)


@needs_links
def test_a_pinned_snapshot_folder_that_links_to_unc_is_not_read(
    isolated, tmp_path, unc_spy
):
    import aesthetic

    pin = aesthetic.WAIFU_HEAD_FILE
    snapshots = (
        isolated.home
        / ".cache"
        / "huggingface"
        / "hub"
        / ("models--" + pin.repo.replace("/", "--"))
        / "snapshots"
    )
    write(snapshots / "0ldrevision" / pin.remote_path, b"x" * 10)
    nas = tmp_path / "nas_snap"
    write(nas / pin.remote_path, b"x" * 10)
    link("/D", snapshots / pin.revision, unc_of(nas))

    payload = make_service(isolated).detect()

    assert request_thread_unc_calls(unc_spy) == []
    assert payload["matches"] == []
