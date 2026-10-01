"""MS1a: matching the models this program needs against files found elsewhere.

Big files are sparse (truncate on a sparse NTFS file writes nothing), so the
real pinned sizes are exercised without multi-GB fixtures; small files carry
real SHA-256 digests and the catalog pins are pointed at them per test.
"""

from __future__ import annotations

import dataclasses
import hashlib
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

import model_matchers  # noqa: E402
import model_sources  # noqa: E402
from tagger_models import TAGGER_MODELS  # noqa: E402

EVA02 = "wd-eva02-large-tagger-v3"
CONVNEXT = "wd-convnext-tagger-v3"
SWINV2 = "wd-swinv2-tagger-v3"
VIT = "wd-vit-tagger-v3"
PIXAI09 = "pixai-tagger-v0.9"


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def make_file_of_size(path: Path, size: int, head: bytes = b"") -> Path:
    """A file that stats as ``size`` bytes without allocating them.

    On Windows CPython's ``truncate`` goes through ``_chsize_s``, which
    zero-fills (3 s and 3 GB of disk per Kaloscope fixture), so the file is
    marked sparse and extended with ``SetEndOfFile`` instead.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as handle:
        handle.write(head)
        handle.flush()
        if sys.platform != "win32":
            handle.truncate(size)
            return path
        import ctypes
        import msvcrt

        kernel32 = ctypes.windll.kernel32
        raw = ctypes.c_void_p(msvcrt.get_osfhandle(handle.fileno()))
        fsctl_set_sparse = 0x000900C4
        returned = ctypes.c_ulong(0)
        assert kernel32.DeviceIoControl(
            raw, fsctl_set_sparse, None, 0, None, 0, ctypes.byref(returned), None
        )
        assert kernel32.SetFilePointerEx(raw, ctypes.c_longlong(size), None, 0)
        assert kernel32.SetEndOfFile(raw)
    assert path.stat().st_size == size
    return path


def write(path: Path, data: bytes) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


def make_comfyui_root(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    (path / "folder_paths.py").write_text("# fake\n", encoding="utf-8")
    (path / "models").mkdir(exist_ok=True)
    return path


def comfy_root(path: Path, rank: int = 0) -> model_sources.SourceRoot:
    root = model_sources.build_source_root(
        str(path), kind="comfyui", origin="trusted", trusted_rank=rank
    )
    assert root is not None
    return root


def folder_root(path: Path, rank: int = 0) -> model_sources.SourceRoot:
    root = model_sources.build_source_root(
        str(path), kind="folder", origin="trusted", trusted_rank=rank
    )
    assert root is not None
    return root


def hf_root(path: Path, rank: int = 1000) -> model_sources.SourceRoot:
    path.mkdir(parents=True, exist_ok=True)
    root = model_sources.build_source_root(
        str(path), kind="hf_cache", origin="hf_default", trusted_rank=rank
    )
    assert root is not None
    return root


def pin_variant(
    monkeypatch, variant: str, model_bytes: bytes, tags_bytes: bytes
) -> None:
    entry = dict(TAGGER_MODELS[variant])
    entry["size_bytes"] = len(model_bytes)
    entry["sha256"] = sha256(model_bytes)
    entry["tags_sha256"] = sha256(tags_bytes)
    monkeypatch.setitem(TAGGER_MODELS, variant, entry)


def pin_tags_only(monkeypatch, variant: str, tags_bytes: bytes) -> None:
    entry = dict(TAGGER_MODELS[variant])
    entry["tags_sha256"] = sha256(tags_bytes)
    monkeypatch.setitem(TAGGER_MODELS, variant, entry)


def matches_for(report, model_id: str, variant: str | None = None):
    return [
        m
        for m in report.matches
        if m.model_id == model_id and (variant is None or m.variant == variant)
    ]


def rejected_for(report, model_id: str, variant: str | None = None):
    return [
        r
        for r in report.rejected
        if r.model_id == model_id and (variant is None or r.variant == variant)
    ]


@pytest.fixture
def comfy(tmp_path):
    return make_comfyui_root(tmp_path / "ComfyUI")


WD14_NODE_DIR = Path("custom_nodes") / "comfyui-WD14-Tagger" / "models"
BOORU_NODE_DIR = Path("custom_nodes") / "ComfyUI-Booru-Tagger" / "models"


# ---------------------------------------------------------------------------
# WD14 family
# ---------------------------------------------------------------------------


def test_wd14_big_onnx_matches_by_size_when_csv_verifies(comfy, monkeypatch):
    csv = b"tag_id,name,category,count\n1,1girl,0,1\n"
    pin_tags_only(monkeypatch, EVA02, csv)
    onnx = make_file_of_size(
        comfy / WD14_NODE_DIR / f"{EVA02}.onnx",
        TAGGER_MODELS[EVA02]["size_bytes"],
        b"ONNX",
    )
    write(comfy / WD14_NODE_DIR / f"{EVA02}.csv", csv)

    report = model_matchers.match_root(comfy_root(comfy))

    (match,) = matches_for(report, "wd14", EVA02)
    assert match.verify == "size"
    assert match.path == str(onnx)
    assert match.source == str(comfy)
    assert match.source_kind == "comfyui"
    assert match.size_bytes == TAGGER_MODELS[EVA02]["size_bytes"]
    assert match.total_bytes == TAGGER_MODELS[EVA02]["size_bytes"] + len(csv)
    assert str(comfy / WD14_NODE_DIR / f"{EVA02}.csv") in match.companions
    assert "hash_skipped_large" in match.notes
    assert rejected_for(report, "wd14") == []


def test_wd14_small_onnx_matches_by_sha(comfy, monkeypatch):
    model = b"small-onnx-" * 100
    csv = b"tag_id,name\n"
    pin_variant(monkeypatch, CONVNEXT, model, csv)
    write(comfy / WD14_NODE_DIR / f"{CONVNEXT}.onnx", model)
    write(comfy / WD14_NODE_DIR / f"{CONVNEXT}.csv", csv)

    report = model_matchers.match_root(comfy_root(comfy))

    (match,) = matches_for(report, "wd14", CONVNEXT)
    assert match.verify == "sha"


def test_wd14_sha_mismatch_is_rejected_even_when_size_matches(comfy, monkeypatch):
    model = b"x" * 500
    csv = b"tag_id,name\n"
    pin_variant(monkeypatch, CONVNEXT, model, csv)
    write(comfy / WD14_NODE_DIR / f"{CONVNEXT}.onnx", b"y" * 500)
    write(comfy / WD14_NODE_DIR / f"{CONVNEXT}.csv", csv)

    report = model_matchers.match_root(comfy_root(comfy))

    assert matches_for(report, "wd14") == []
    (rejected,) = rejected_for(report, "wd14", CONVNEXT)
    assert rejected.reason == "sha_mismatch"


def test_wd14_size_mismatch_is_rejected(comfy, monkeypatch):
    csv = b"tag_id,name\n"
    pin_tags_only(monkeypatch, EVA02, csv)
    make_file_of_size(
        comfy / WD14_NODE_DIR / f"{EVA02}.onnx", TAGGER_MODELS[EVA02]["size_bytes"] - 1
    )
    write(comfy / WD14_NODE_DIR / f"{EVA02}.csv", csv)

    report = model_matchers.match_root(comfy_root(comfy))

    assert matches_for(report, "wd14") == []
    (rejected,) = rejected_for(report, "wd14", EVA02)
    assert rejected.reason == "size_mismatch"
    assert str(TAGGER_MODELS[EVA02]["size_bytes"]) in rejected.detail


def test_wd14_without_csv_is_rejected(comfy, monkeypatch):
    make_file_of_size(
        comfy / WD14_NODE_DIR / f"{EVA02}.onnx", TAGGER_MODELS[EVA02]["size_bytes"]
    )

    report = model_matchers.match_root(comfy_root(comfy))

    assert matches_for(report, "wd14") == []
    (rejected,) = rejected_for(report, "wd14", EVA02)
    assert rejected.reason == "missing_companion"


def test_wd14_csv_with_other_content_is_rejected(comfy, monkeypatch):
    pin_tags_only(monkeypatch, EVA02, b"expected csv\n")
    make_file_of_size(
        comfy / WD14_NODE_DIR / f"{EVA02}.onnx", TAGGER_MODELS[EVA02]["size_bytes"]
    )
    write(comfy / WD14_NODE_DIR / f"{EVA02}.csv", b"different csv\n")

    report = model_matchers.match_root(comfy_root(comfy))

    assert matches_for(report, "wd14") == []
    (rejected,) = rejected_for(report, "wd14", EVA02)
    assert rejected.reason == "companion_mismatch"


def test_wd14_on_network_root_is_size_verified_without_hashing(comfy, monkeypatch):
    model = b"x" * 500
    csv = b"tag_id,name\n"
    pin_variant(monkeypatch, CONVNEXT, model, csv)
    # Same size, different bytes: a hash would reject it; a network root is not hashed.
    write(comfy / WD14_NODE_DIR / f"{CONVNEXT}.onnx", b"y" * 500)
    write(comfy / WD14_NODE_DIR / f"{CONVNEXT}.csv", csv)
    root = dataclasses.replace(comfy_root(comfy), is_network=True)

    report = model_matchers.match_root(root)

    (match,) = matches_for(report, "wd14", CONVNEXT)
    assert match.verify == "size"
    assert "hash_skipped_network" in match.notes


def test_wd14_app_layout_inside_trusted_folder(tmp_path, monkeypatch):
    model = b"vit" * 50
    csv = b"tag_id,name\n"
    pin_variant(monkeypatch, VIT, model, csv)
    folder = tmp_path / "shared-models"
    write(folder / VIT / "model.onnx", model)
    write(folder / VIT / "selected_tags.csv", csv)

    report = model_matchers.match_root(folder_root(folder))

    (match,) = matches_for(report, "wd14", VIT)
    assert match.verify == "sha"
    assert match.path == str(folder / VIT / "model.onnx")
    assert match.source_kind == "folder"


def test_wd14_booru_tagger_node_dir_and_models_dirs_are_searched(comfy, monkeypatch):
    model = b"pixai" * 40
    csv = b"tag_id,name\n"
    pin_variant(monkeypatch, PIXAI09, model, csv)
    write(comfy / BOORU_NODE_DIR / f"{PIXAI09}.onnx", model)
    write(comfy / BOORU_NODE_DIR / f"{PIXAI09}.csv", csv)
    vit = b"vit" * 50
    pin_variant(monkeypatch, VIT, vit, csv)
    write(comfy / "models" / "wd14_tagger" / f"{VIT}.onnx", vit)
    write(comfy / "models" / "wd14_tagger" / f"{VIT}.csv", csv)

    report = model_matchers.match_root(comfy_root(comfy))

    assert len(matches_for(report, "wd14", PIXAI09)) == 1
    assert len(matches_for(report, "wd14", VIT)) == 1


def test_wd14_extra_model_paths_folder_is_searched(comfy, tmp_path, monkeypatch):
    model = b"vit" * 50
    csv = b"tag_id,name\n"
    pin_variant(monkeypatch, VIT, model, csv)
    external = tmp_path / "central" / "taggers"
    write(external / f"{VIT}.onnx", model)
    write(external / f"{VIT}.csv", csv)
    (comfy / "extra_model_paths.yaml").write_text(
        "central:\n    base_path: ../central\n    wd14_tagger: taggers\n",
        encoding="utf-8",
    )

    report = model_matchers.match_root(comfy_root(comfy))

    (match,) = matches_for(report, "wd14", VIT)
    assert match.path == str(external / f"{VIT}.onnx")


def test_wd14_unknown_stems_are_ignored(comfy):
    write(comfy / WD14_NODE_DIR / "wd-v1-4-moat-tagger-v2.onnx", b"old")
    write(comfy / WD14_NODE_DIR / "wd-v1-4-moat-tagger-v2.csv", b"old")

    report = model_matchers.match_root(comfy_root(comfy))

    assert report.matches == []
    assert report.rejected == []


# ---------------------------------------------------------------------------
# Kaloscope (artist)
# ---------------------------------------------------------------------------


def kaloscope_tree(
    comfy: Path, monkeypatch, *, size: int | None = None, runtime_rev: str | None = None
):
    import artist_identifier

    mapping = b"class_id,artist\n0,alice\n"
    monkeypatch.setitem(
        artist_identifier._EXPECTED_ARTIST_FILE_SHA256,
        "class_mapping.csv",
        (sha256(mapping),),
    )
    checkpoint = make_file_of_size(
        comfy / "models" / "lsnet" / "Kaloscope" / "best_checkpoint.pth",
        model_matchers.KALOSCOPE_CHECKPOINT_SIZE_BYTES if size is None else size,
    )
    write(comfy / "models" / "lsnet" / "Kaloscope" / "class_mapping.csv", mapping)
    runtime = comfy / "custom_nodes" / "comfyui-lsnet"
    if runtime_rev is not None:
        (runtime / "lsnet_model").mkdir(parents=True)
        (runtime / ".git" / "refs" / "heads").mkdir(parents=True)
        (runtime / ".git" / "HEAD").write_text(
            "ref: refs/heads/main\n", encoding="utf-8"
        )
        (runtime / ".git" / "refs" / "heads" / "main").write_text(
            runtime_rev + "\n", encoding="utf-8"
        )
    return checkpoint, runtime


def test_kaloscope_matches_by_size_with_verified_mapping_and_runtime(
    comfy, monkeypatch
):
    import artist_identifier

    checkpoint, runtime = kaloscope_tree(
        comfy, monkeypatch, runtime_rev=artist_identifier.ARTIST_LSNET_RUNTIME_REVISION
    )

    report = model_matchers.match_root(comfy_root(comfy))

    (match,) = matches_for(report, "artist")
    assert match.variant == "kaloscope2.0"
    assert match.verify == "size"
    assert match.path == str(checkpoint)
    assert str(checkpoint.parent / "class_mapping.csv") in match.companions
    assert str(runtime) in match.companions
    assert "runtime_revision_verified" in match.notes


def test_kaloscope_runtime_at_another_revision_is_still_usable_but_unverified(
    comfy, monkeypatch
):
    _, runtime = kaloscope_tree(comfy, monkeypatch, runtime_rev="0" * 40)

    report = model_matchers.match_root(comfy_root(comfy))

    (match,) = matches_for(report, "artist")
    assert str(runtime) in match.companions
    assert "runtime_revision_unverified" in match.notes


def test_kaloscope_runtime_revision_resolves_packed_refs(comfy, monkeypatch):
    import artist_identifier

    _, runtime = kaloscope_tree(comfy, monkeypatch, runtime_rev="0" * 40)
    (runtime / ".git" / "refs" / "heads" / "main").unlink()
    (runtime / ".git" / "packed-refs").write_text(
        "# pack-refs with: peeled fully-peeled sorted\n"
        f"{artist_identifier.ARTIST_LSNET_RUNTIME_REVISION} refs/heads/main\n",
        encoding="utf-8",
    )

    assert (
        model_matchers.read_git_head_commit(runtime)
        == artist_identifier.ARTIST_LSNET_RUNTIME_REVISION
    )


def test_kaloscope_without_runtime_still_matches(comfy, monkeypatch):
    kaloscope_tree(comfy, monkeypatch)

    report = model_matchers.match_root(comfy_root(comfy))

    (match,) = matches_for(report, "artist")
    assert "runtime_missing" in match.notes


def test_kaloscope_wrong_size_or_missing_mapping_is_rejected(comfy, monkeypatch):
    kaloscope_tree(
        comfy, monkeypatch, size=model_matchers.KALOSCOPE_CHECKPOINT_SIZE_BYTES + 1
    )
    report = model_matchers.match_root(comfy_root(comfy))
    assert matches_for(report, "artist") == []
    assert rejected_for(report, "artist")[0].reason == "size_mismatch"

    (comfy / "models" / "lsnet" / "Kaloscope" / "best_checkpoint.pth").unlink()
    kaloscope_tree(comfy, monkeypatch)
    (comfy / "models" / "lsnet" / "Kaloscope" / "class_mapping.csv").unlink()
    report = model_matchers.match_root(comfy_root(comfy))
    assert matches_for(report, "artist") == []
    assert rejected_for(report, "artist")[0].reason == "missing_companion"


def test_kaloscope_mapping_with_other_content_is_rejected(comfy, monkeypatch):
    kaloscope_tree(comfy, monkeypatch)
    write(
        comfy / "models" / "lsnet" / "Kaloscope" / "class_mapping.csv",
        b"something else\n",
    )

    report = model_matchers.match_root(comfy_root(comfy))

    assert matches_for(report, "artist") == []
    assert rejected_for(report, "artist")[0].reason == "companion_mismatch"


# ---------------------------------------------------------------------------
# Hugging Face cache layout
# ---------------------------------------------------------------------------


def snapshot_dir(hub: Path, repo: str, revision: str) -> Path:
    path = hub / ("models--" + repo.replace("/", "--")) / "snapshots" / revision
    path.mkdir(parents=True, exist_ok=True)
    return path


def test_hf_cache_florence_matches_on_pinned_revision_dir(tmp_path):
    import florence2_captioner

    hub = tmp_path / "hub"
    snap = snapshot_dir(
        hub,
        florence2_captioner.FLORENCE2_MODEL_ID,
        florence2_captioner.FLORENCE2_REVISION,
    )
    for name in florence2_captioner.FLORENCE2_REQUIRED_FILES:
        write(snap / name, b"x")

    report = model_matchers.match_root(hf_root(hub))

    (match,) = matches_for(report, "florence2")
    assert match.verify == "revision"
    assert match.path == str(snap)
    assert match.source_kind == "hf_cache"


def test_hf_cache_incomplete_snapshot_is_rejected(tmp_path):
    import florence2_captioner

    hub = tmp_path / "hub"
    snap = snapshot_dir(
        hub,
        florence2_captioner.FLORENCE2_MODEL_ID,
        florence2_captioner.FLORENCE2_REVISION,
    )
    for name in florence2_captioner.FLORENCE2_REQUIRED_FILES[:-1]:
        write(snap / name, b"x")
    write(
        snap / florence2_captioner.FLORENCE2_REQUIRED_FILES[-1], b""
    )  # empty counts as missing

    report = model_matchers.match_root(hf_root(hub))

    assert matches_for(report, "florence2") == []
    (rejected,) = rejected_for(report, "florence2")
    assert rejected.reason == "incomplete"
    assert florence2_captioner.FLORENCE2_REQUIRED_FILES[-1] in rejected.detail


def test_hf_cache_other_revision_is_rejected_as_version_mismatch(tmp_path):
    import florence2_captioner

    hub = tmp_path / "hub"
    snap = snapshot_dir(hub, florence2_captioner.FLORENCE2_MODEL_ID, "f" * 40)
    for name in florence2_captioner.FLORENCE2_REQUIRED_FILES:
        write(snap / name, b"x")

    report = model_matchers.match_root(hf_root(hub))

    assert matches_for(report, "florence2") == []
    (rejected,) = rejected_for(report, "florence2")
    assert rejected.reason == "version_mismatch"
    assert florence2_captioner.FLORENCE2_REVISION[:8] in rejected.detail


def test_hf_cache_pinned_file_sha_is_checked(tmp_path, monkeypatch):
    import aesthetic

    hub = tmp_path / "hub"
    pin = aesthetic.WAIFU_HEAD_FILE
    snap = snapshot_dir(hub, pin.repo, pin.revision)
    # Same size as the pinned head, other bytes: only the hash can tell.
    make_file_of_size(snap / pin.remote_path, pin.size_bytes, b"not the real head")
    report = model_matchers.match_root(hf_root(hub))
    assert matches_for(report, "aesthetic-waifu") == []
    assert rejected_for(report, "aesthetic-waifu")[0].reason == "sha_mismatch"

    payload = b"fake head"
    monkeypatch.setattr(
        aesthetic,
        "WAIFU_HEAD_FILE",
        dataclasses.replace(pin, sha256=sha256(payload), size_bytes=len(payload)),
    )
    write(snap / pin.remote_path, payload)
    report = model_matchers.match_root(hf_root(hub))
    (match,) = matches_for(report, "aesthetic-waifu")
    assert match.verify == "sha"
    assert match.path == str(snap / pin.remote_path)


def test_hf_cache_anime_aesthetic_needs_both_files_and_sha(tmp_path, monkeypatch):
    import anime_aesthetic

    hub = tmp_path / "hub"
    model = b"onnx-bytes"
    samples = b"npz-bytes"
    monkeypatch.setattr(
        anime_aesthetic,
        "MODEL_FILE",
        dataclasses.replace(
            anime_aesthetic.MODEL_FILE, sha256=sha256(model), size_bytes=len(model)
        ),
    )
    monkeypatch.setattr(
        anime_aesthetic,
        "SAMPLES_FILE",
        dataclasses.replace(
            anime_aesthetic.SAMPLES_FILE,
            sha256=sha256(samples),
            size_bytes=len(samples),
        ),
    )
    snap = snapshot_dir(
        hub, anime_aesthetic.MODEL_FILE.repo, anime_aesthetic.MODEL_FILE.revision
    )
    write(snap / anime_aesthetic.MODEL_FILE.remote_path, model)

    report = model_matchers.match_root(hf_root(hub))
    assert matches_for(report, "aesthetic-anime") == []
    assert rejected_for(report, "aesthetic-anime")[0].reason == "incomplete"

    write(snap / anime_aesthetic.SAMPLES_FILE.remote_path, samples)
    report = model_matchers.match_root(hf_root(hub))
    (match,) = matches_for(report, "aesthetic-anime")
    assert match.verify == "sha"
    assert str(snap / anime_aesthetic.SAMPLES_FILE.remote_path) in match.companions


def test_hf_cache_backbone_is_taken_from_any_snapshot_by_name(tmp_path):
    hub = tmp_path / "hub"
    snap = snapshot_dir(hub, "timm/vit_large_patch14_clip_224.openai", "18d05354")
    write(snap / "open_clip_model.safetensors", b"backbone")

    report = model_matchers.match_root(hf_root(hub))

    (match,) = matches_for(report, "aesthetic", "backbone")
    assert match.verify == "name"
    assert match.path == str(snap / "open_clip_model.safetensors")


def test_hf_cache_wd14_variant_csv_only_is_incomplete(tmp_path, monkeypatch):
    hub = tmp_path / "hub"
    entry = TAGGER_MODELS[SWINV2]
    snap = snapshot_dir(hub, entry["repo_id"], entry["revision"])
    write(snap / "selected_tags.csv", b"tag_id,name\n")
    report = model_matchers.match_root(hf_root(hub))
    assert matches_for(report, "wd14", SWINV2) == []
    assert rejected_for(report, "wd14", SWINV2)[0].reason == "incomplete"

    model = b"swin" * 20
    pin_variant(monkeypatch, SWINV2, model, b"tag_id,name\n")
    write(snap / "model.onnx", model)
    report = model_matchers.match_root(hf_root(hub))
    (match,) = matches_for(report, "wd14", SWINV2)
    assert match.verify == "sha"
    assert match.path == str(snap / "model.onnx")


def test_hf_cache_symlinked_snapshot_files_resolve_to_blobs(tmp_path):
    import florence2_captioner

    hub = tmp_path / "hub"
    repo_dir = hub / (
        "models--" + florence2_captioner.FLORENCE2_MODEL_ID.replace("/", "--")
    )
    blobs = repo_dir / "blobs"
    blobs.mkdir(parents=True)
    snap = snapshot_dir(
        hub,
        florence2_captioner.FLORENCE2_MODEL_ID,
        florence2_captioner.FLORENCE2_REVISION,
    )
    for index, name in enumerate(florence2_captioner.FLORENCE2_REQUIRED_FILES):
        blob = write(blobs / f"blob{index}", b"x")
        try:
            os.symlink(os.path.relpath(blob, snap), snap / name)
        except OSError:
            pytest.skip("symlinks need developer mode on this Windows account")
    broken = snap / florence2_captioner.FLORENCE2_REQUIRED_FILES[0]
    report = model_matchers.match_root(hf_root(hub))
    assert len(matches_for(report, "florence2")) == 1

    (blobs / "blob0").unlink()  # dangling symlink: the file is gone
    assert broken.is_symlink()
    report = model_matchers.match_root(hf_root(hub))
    assert matches_for(report, "florence2") == []
    assert rejected_for(report, "florence2")[0].reason == "incomplete"


# ---------------------------------------------------------------------------
# Privacy YOLO, TIPO
# ---------------------------------------------------------------------------


def test_privacy_yolo_wenaka_is_adopted_by_name_and_others_stay_candidates(comfy):
    wenaka = write(
        comfy / "models" / "ultralytics" / "segm" / "wenaka_yolov8s-seg.pt", b"pt"
    )
    write(comfy / "models" / "ultralytics" / "bbox" / "erax_nsfw_yolo11m.pt", b"pt")
    write(comfy / "models" / "yolo" / "yolov10m.onnx", b"onnx")

    report = model_matchers.match_root(comfy_root(comfy))

    (match,) = matches_for(report, "censor-legacy")
    assert match.path == str(wenaka)
    assert match.verify == "name"
    candidates = rejected_for(report, "censor-legacy")
    assert {Path(c.path).name for c in candidates} == {
        "erax_nsfw_yolo11m.pt",
        "yolov10m.onnx",
    }
    assert all(c.reason == "unverified" for c in candidates)


def test_tipo_exact_name_and_size_match_and_older_build_rejected(comfy):
    pins = model_matchers.TIPO_FILE_PINS["v2.1"]
    exact = make_file_of_size(
        comfy / "models" / "kgen" / pins.filename, pins.size_bytes
    )
    make_file_of_size(
        comfy / "models" / "kgen" / "TIPOv2-1B-A200M-Q8_0.gguf", pins.size_bytes + 32
    )
    # kgen's download_gguf names files <repo>_<file>; the size is still exact.
    repo_named = make_file_of_size(
        comfy / "models" / "kgen" / f"TIPO-v2.1-1B-A200M_{pins.filename}",
        pins.size_bytes,
    )
    # The exact pinned name with another size (partial download, other build).
    truncated = make_file_of_size(
        comfy / "models" / "kgen" / "gguf" / pins.filename, pins.size_bytes - 1
    )

    report = model_matchers.match_root(comfy_root(comfy))

    tipo = matches_for(report, "tipo", "v2.1")
    assert {m.path for m in tipo} == {str(exact), str(repo_named)}
    assert all(m.verify == "size" for m in tipo)
    rejected = rejected_for(report, "tipo")
    assert {r.path for r in rejected} == {
        str(comfy / "models" / "kgen" / "TIPOv2-1B-A200M-Q8_0.gguf"),
        str(truncated),
    }
    assert all(r.reason == "version_mismatch" for r in rejected)


def test_sam3_checkpoint_is_never_matched(comfy):
    make_file_of_size(comfy / "models" / "sam3" / "sam3.pt", 3_450_062_241)
    report = model_matchers.match_root(comfy_root(comfy))
    assert matches_for(report, "sam3") == []


# ---------------------------------------------------------------------------
# Choosing between several copies
# ---------------------------------------------------------------------------


def make_match(**overrides):
    base = dict(
        model_id="wd14",
        variant=VIT,
        path="C:/a/model.onnx",
        source="C:/a",
        source_kind="comfyui",
        verify="size",
        size_bytes=1,
        mtime_ns=1,
        companions=(),
        notes=(),
        trusted_rank=1000,
        is_network=False,
    )
    base.update(overrides)
    return model_matchers.ExternalMatch(**base)


def test_select_best_prefers_trusted_order_then_sha_then_local_disk():
    trusted_size = make_match(path="T/size.onnx", verify="size", trusted_rank=0)
    untrusted_sha = make_match(path="U/sha.onnx", verify="sha", trusted_rank=1000)
    assert (
        model_matchers.select_best([untrusted_sha, trusted_size])[0].path
        == "T/size.onnx"
    )

    same_rank_size = make_match(path="A/size.onnx", verify="size", trusted_rank=0)
    same_rank_sha = make_match(path="B/sha.onnx", verify="sha", trusted_rank=0)
    assert (
        model_matchers.select_best([same_rank_size, same_rank_sha])[0].path
        == "B/sha.onnx"
    )

    network = make_match(
        path="N/x.onnx", verify="size", trusted_rank=0, is_network=True
    )
    local = make_match(path="Z/x.onnx", verify="size", trusted_rank=0)
    assert model_matchers.select_best([network, local])[0].path == "Z/x.onnx"

    # Full tie: sorted path order, deterministic.
    first = make_match(path="A/x.onnx")
    second = make_match(path="B/x.onnx")
    assert model_matchers.select_best([second, first])[0].path == "A/x.onnx"


def test_select_best_keeps_one_per_model_and_variant():
    eva = make_match(variant=EVA02, path="A/eva.onnx")
    vit_a = make_match(variant=VIT, path="A/vit.onnx")
    vit_b = make_match(variant=VIT, path="B/vit.onnx")
    chosen = model_matchers.select_best([vit_b, eva, vit_a])
    assert [(m.variant, m.path) for m in chosen] == [
        (EVA02, "A/eva.onnx"),
        (VIT, "A/vit.onnx"),
    ]


def test_digest_cache_prevents_rehashing_unchanged_files(comfy, tmp_path, monkeypatch):
    model = b"small-onnx-" * 100
    csv = b"tag_id,name\n"
    pin_variant(monkeypatch, CONVNEXT, model, csv)
    write(comfy / WD14_NODE_DIR / f"{CONVNEXT}.onnx", model)
    write(comfy / WD14_NODE_DIR / f"{CONVNEXT}.csv", csv)
    store = model_sources.ModelSourcesStore(tmp_path / "model_sources.json")
    hashed = []
    real = model_matchers._hash_file

    def counting(path):
        hashed.append(str(path))
        return real(path)

    monkeypatch.setattr(model_matchers, "_hash_file", counting)

    model_matchers.match_root(comfy_root(comfy), digest_cache=store)
    first = len(hashed)
    model_matchers.match_root(comfy_root(comfy), digest_cache=store)

    assert first >= 1
    assert len(hashed) == first


# ---------------------------------------------------------------------------
# Pins (values taken from HTTP HEAD on the pinned revisions, 2026-10-01)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "variant, size_bytes, sha_prefix, tags_prefix",
    [
        (EVA02, 1_260_435_999, "9e768793", "298633d9"),
        (SWINV2, 467_460_978, "e6774bff", "298633d9"),
        (CONVNEXT, 394_990_732, "1b8a7abf", "298633d9"),
        (VIT, 378_536_310, "35f23693", "298633d9"),
        ("wd-vit-large-tagger-v3", 1_260_645_673, "e4c8001b", "298633d9"),
        ("camie-tagger-v2", 788_983_561, "ab0aaf25", "de9f962e"),
        (PIXAI09, 1_271_365_854, "a8d47909", "76b5dd39"),
        ("pixai-tagger-v1.0", 2_633_225, "563f4576", "0d34f207"),
    ],
)
def test_tagger_catalog_size_and_sha_pins(variant, size_bytes, sha_prefix, tags_prefix):
    entry = TAGGER_MODELS[variant]
    assert entry["size_bytes"] == size_bytes
    assert entry["sha256"].startswith(sha_prefix) and len(entry["sha256"]) == 64
    assert (
        entry["tags_sha256"].startswith(tags_prefix) and len(entry["tags_sha256"]) == 64
    )


def test_pixai_v1_external_data_pin():
    pins = TAGGER_MODELS["pixai-tagger-v1.0"]["external_data_pins"]
    assert pins["model.onnx.data"]["size_bytes"] == 1_955_123_200
    assert pins["model.onnx.data"]["sha256"].startswith("4de1c25a")


def test_oppai_oracle_size_pin_present():
    entry = TAGGER_MODELS["oppai-oracle-v1.1"]
    assert entry["size_bytes"] == 993_246_982
    assert entry["sha256"].startswith("8567852d")


def test_kaloscope_and_tipo_pins_match_ledger():
    import artist_identifier

    assert model_matchers.KALOSCOPE_CHECKPOINT_SIZE_BYTES == 2_937_892_740
    assert (
        model_matchers.KALOSCOPE_CHECKPOINT_SHA256
        in artist_identifier._EXPECTED_ARTIST_FILE_SHA256[
            "448-90.13/best_checkpoint.pth"
        ]
    )
    v21 = model_matchers.TIPO_FILE_PINS["v2.1"]
    assert v21.size_bytes == 1_072_689_600
    assert v21.sha256.startswith("0847e9e2")
    assert v21.filename == "TIPO-v2.1-1B-A200M-Q8_0.gguf"
