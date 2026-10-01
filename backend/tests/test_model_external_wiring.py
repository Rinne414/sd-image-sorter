"""MS1b: Model Center health, cards and loaders use a trusted copy of a model.

The program's own folder wins; a trusted copy (a ComfyUI install, a Hugging
Face cache) is used only when the own folder lacks the file; a copy that went
missing turns the card into "missing" with its path and is never swapped for
another file.
"""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

import model_external  # noqa: E402
from config import TAGGER_MODELS  # noqa: E402
from tests._external_helpers import GGUF, ExternalWorld  # noqa: E402

DEFAULT = "wd-swinv2-tagger-v3"
NODE_DIR = "custom_nodes/comfyui-WD14-Tagger/models"
TORCH_OFF = {
    "torch_version": None,
    "torch_cuda_build": None,
    "torch_cuda_available": False,
    "torch_probe_error": None,
    "torch_probe_source": "test",
}


@pytest.fixture
def world(tmp_path, monkeypatch) -> ExternalWorld:
    return ExternalWorld(tmp_path, monkeypatch)


@pytest.fixture
def own(tmp_path, monkeypatch) -> Path:
    """Empty own folders for every family these tests touch."""
    import aesthetic
    import anime_aesthetic
    import anime_censor_models
    import model_health

    base = tmp_path / "own"
    dirs = {
        "get_wd14_model_dir": base / "wd14",
        "get_florence2_model_dir": base / "florence2",
        "get_lucida_model_dir": base / "lucida",
        "get_artist_model_dir": base / "artist",
        "get_yolo_model_dir": base / "yolo",
    }
    for name, path in dirs.items():
        path.mkdir(parents=True)
        monkeypatch.setattr(model_health, name, lambda p=path: str(p))
    # config.get_wd14_model_dir (used by the tagger and Prepare) reads this
    # module constant: without it a developer's real data/models copy wins.
    import config

    monkeypatch.setattr(config, "WD14_MODEL_DIR", str(dirs["get_wd14_model_dir"]))
    aesthetic_dir = base / "aesthetic"
    aesthetic_dir.mkdir()
    monkeypatch.setattr(aesthetic, "_get_models_dir", lambda: aesthetic_dir)
    monkeypatch.setattr(anime_aesthetic, "models_dir", lambda: aesthetic_dir)
    monkeypatch.setattr(
        anime_censor_models,
        "censor_model_path",
        lambda: dirs["get_yolo_model_dir"] / "censor.onnx",
    )
    monkeypatch.setattr(
        anime_censor_models, "face_model_path", lambda: base / "face" / "face.onnx"
    )
    monkeypatch.setattr(model_health, "_probe_torch_runtime", lambda: dict(TORCH_OFF))
    monkeypatch.setenv("SD_IMAGE_SORTER_TIPO_DIR", str(base / "tipo"))
    monkeypatch.setenv("SD_IMAGE_SORTER_DISABLE_LEGACY_MODEL_COPY", "1")
    return base


def add_default_wd14(world: ExternalWorld) -> Path:
    cfg = TAGGER_MODELS[DEFAULT]
    path = world.add_file(
        "wd14",
        DEFAULT,
        f"{NODE_DIR}/{DEFAULT}.onnx",
        b"onnx" * 300_000,
        companions={f"{NODE_DIR}/{DEFAULT}.csv": b"tag_id,name,category,count\n"},
    )
    assert cfg["model_file"] and cfg["tags_file"]
    return path


def health():
    import model_health

    return model_health.get_model_health()


def cards():
    from services.model_service import ModelService

    return {card["id"]: card for card in ModelService().build_model_inventory()}


# ---------------------------------------------------------------- WD14


def test_default_wd14_comes_from_the_trusted_copy_when_the_own_folder_is_empty(
    world, own
):
    path = add_default_wd14(world)

    wd14 = health()["wd14"]

    assert wd14["available"] is True
    assert wd14["model_path"] == str(path)
    assert wd14["tags_path"].endswith(f"{DEFAULT}.csv")
    assert wd14["source"]["kind"] == "comfyui"
    by_name = {m["name"]: m for m in wd14["installed_models"]}
    assert by_name[DEFAULT]["available"] is True
    assert by_name[DEFAULT]["source"]["path"] == str(path)


def test_the_programs_own_wd14_wins_over_a_trusted_copy(world, own):
    add_default_wd14(world)
    cfg = TAGGER_MODELS[DEFAULT]
    own_dir = own / "wd14" / DEFAULT
    own_dir.mkdir()
    (own_dir / cfg["model_file"]).write_bytes(b"mine")
    (own_dir / cfg["tags_file"]).write_bytes(b"tag_id,name,category,count\n")

    wd14 = health()["wd14"]

    assert wd14["model_path"] == str((own_dir / cfg["model_file"]).resolve())
    assert wd14["source"] is None
    assert [m["source"] for m in wd14["installed_models"] if m["name"] == DEFAULT] == [
        None
    ]


def test_card_says_where_the_ready_model_comes_from(world, own):
    path = add_default_wd14(world)

    card = cards()["wd14"]

    assert card["status"] == "ready"
    assert card["path"] == str(path)
    assert card["source"] == {
        "kind": "comfyui",
        "root": str(world.root),
        "path": str(path),
        "verify": "size",
        "is_network": False,
        "size_bytes": path.stat().st_size,
    }
    assert card["variant_sources"] == {DEFAULT: card["source"]}


def test_card_path_points_at_the_trusted_variant_when_only_it_is_installed(world, own):
    variant = "wd-eva02-large-tagger-v3"
    path = world.add_file(
        "wd14",
        variant,
        f"{NODE_DIR}/{variant}.onnx",
        b"o" * 10,
        companions={f"{NODE_DIR}/{variant}.csv": b"tag_id,name,category,count"},
    )

    card = cards()["wd14"]

    assert card["status"] == "missing"  # the default variant is not there
    assert card["installed_variants"] == [variant]
    assert card["path"] == str(path)
    assert card["source"]["path"] == str(path)


def test_card_turns_missing_and_names_the_path_when_the_trusted_file_is_gone(
    world, own
):
    path = add_default_wd14(world)
    path.unlink()

    wd14 = health()["wd14"]
    card = cards()["wd14"]

    assert wd14["available"] is False
    assert card["status"] == "missing"
    assert card["message_key"] == "models.external.gone"
    assert str(path) in card["message"]
    assert card["message_params"]["path"] == str(path)
    assert card["message_params"]["kind"] == "comfyui"


def test_the_message_survives_the_next_detect(world, own):
    path = add_default_wd14(world)
    path.unlink()
    world.store.save_matches([])  # detect no longer finds it

    card = cards()["wd14"]

    assert card["status"] == "missing"
    assert str(path) in card["message"]


def test_a_changed_trusted_file_is_reported_not_swapped(world, own):
    path = add_default_wd14(world)
    path.write_bytes(b"different")

    card = cards()["wd14"]

    assert card["status"] == "missing"
    assert card["message_key"] == "models.external.changed"
    assert health()["wd14"]["model_path"] is None


def test_an_untrusted_recorded_file_is_never_used(world, own):
    add_default_wd14(world)
    world.trusted.clear()

    wd14 = health()["wd14"]
    card = cards()["wd14"]

    assert wd14["available"] is False
    assert card["status"] == "missing"
    assert "models.external" not in card.get("message_key", "")


def test_tagger_loads_the_trusted_copy_without_downloading(world, own, monkeypatch):
    import tagger

    path = add_default_wd14(world)

    def no_download(**_kwargs):
        raise AssertionError("downloaded although a trusted copy exists")

    monkeypatch.setattr(tagger, "hf_hub", SimpleNamespace(hf_hub_download=no_download))
    instance = tagger.WD14Tagger(
        model_name=DEFAULT, model_dir=str(own / "wd14"), use_gpu=False
    )

    model_path, tags_path = instance._get_model_paths()

    assert model_path == str(path)
    assert tags_path.endswith(f"{DEFAULT}.csv")


def assert_shown_as_written(message: str) -> None:
    """The rules errors.js applies: a longer or path-carrying message is replaced
    by "failed, try again", which would never help here."""
    import re

    assert re.search(r"[A-Za-z]:\\", message) is None, message
    assert chr(10) not in message and len(message) < 180, (len(message), message)


def _recording_hub(monkeypatch):
    import tagger

    calls = []

    def record(**kwargs):
        calls.append(kwargs)
        raise RuntimeError("network off")

    monkeypatch.setattr(tagger, "hf_hub", SimpleNamespace(hf_hub_download=record))
    return calls


def _default_tagger(own):
    import tagger

    return tagger.WD14Tagger(
        model_name=DEFAULT, model_dir=str(own / "wd14"), use_gpu=False
    )


def test_tagger_does_not_download_when_the_trusted_copy_changed(
    world, own, monkeypatch
):
    path = add_default_wd14(world)
    path.write_bytes(b"different")
    calls = _recording_hub(monkeypatch)

    with pytest.raises(model_external.ExternalModelUnavailable) as raised:
        _default_tagger(own)._get_model_paths()

    message = str(raised.value)
    assert not calls, "a second copy must not be downloaded behind the user's back"
    assert_shown_as_written(message)
    assert "gone or changed" in message
    assert "已不见或已变更" in message and "模型中心" in message
    assert "app" not in message.split(" / ")[-1].lower()


def test_tagger_does_not_download_when_the_trusted_copy_is_gone(
    world, own, monkeypatch
):
    path = add_default_wd14(world)
    path.unlink()
    world.store.save_matches([])  # the next detect no longer finds it
    calls = _recording_hub(monkeypatch)

    with pytest.raises(model_external.ExternalModelUnavailable) as raised:
        _default_tagger(own)._get_model_paths()

    assert not calls
    assert_shown_as_written(str(raised.value))
    assert "gone or changed" in str(raised.value) and "已不见或已变更" in str(
        raised.value
    )


def test_fresh_install_still_downloads_on_first_use(world, own, monkeypatch):
    calls = _recording_hub(monkeypatch)

    with pytest.raises(RuntimeError, match="network off"):
        _default_tagger(own)._get_model_paths()

    assert calls and all(str(world.root) not in call["local_dir"] for call in calls)


def test_prepare_downloads_into_the_program_folder_after_the_copy_was_lost(
    world, own, monkeypatch
):
    path = add_default_wd14(world)
    path.write_bytes(b"different")
    calls = _recording_hub(monkeypatch)
    model_external.forget("wd14", DEFAULT)

    with pytest.raises(RuntimeError, match="network off"):
        _default_tagger(own)._get_model_paths()

    assert calls and all(str(world.root) not in call["local_dir"] for call in calls)
    assert model_external.problem("wd14", DEFAULT) is None


def test_the_prepare_button_downloads_after_the_copy_was_lost(world, own, monkeypatch):
    from services import model_service, model_service_prepare

    path = add_default_wd14(world)
    path.unlink()
    world.store.save_matches([])
    calls = _recording_hub(monkeypatch)
    monkeypatch.setattr(
        model_service,
        "_repair_wd14_onnxruntime_if_possible",
        lambda: {"attempted": False},
    )
    import tagger

    monkeypatch.setattr(
        tagger,
        "get_wd14_model_dir",
        lambda: str(own / "wd14"),
    )

    with pytest.raises(RuntimeError, match="network off"):
        model_service_prepare._prepare_model(None, "wd14", variant=DEFAULT)

    assert calls


def test_a_corrupt_trusted_file_is_never_deleted(world, own, monkeypatch):
    path = add_default_wd14(world)
    instance = _default_tagger(own)
    monkeypatch.setattr(
        instance,
        "_create_verified_session",
        lambda *_a, **_k: (_ for _ in ()).throw(RuntimeError("INVALID_PROTOBUF")),
    )

    with pytest.raises(RuntimeError, match="never changes it"):
        instance._create_session(str(path), "tags.csv", None, [])

    assert path.exists()


def test_tipo_does_not_download_when_its_trusted_weight_vanished(
    world, own, monkeypatch
):
    from services import tipo_service

    weight = world.add_file("tipo", "v2.1", "models/kgen/TIPO.gguf", GGUF, verify="sha")
    weight.unlink()
    calls = []
    monkeypatch.setattr(
        tipo_service, "_download_weight", lambda *a, **k: calls.append(a)
    )
    fake_models = SimpleNamespace(model_dir=None, text_model=None)
    monkeypatch.setattr(tipo_service, "_import_kgen", lambda: {"models": fake_models})
    monkeypatch.setattr(tipo_service, "_loaded_model_key", None)

    with pytest.raises(tipo_service.TipoError, match="gone or changed"):
        tipo_service._ensure_model_loaded("v2.1")

    assert not calls


def test_tipo_fresh_install_still_downloads(world, own, monkeypatch):
    from services import tipo_service

    calls = []

    def fake_download(spec, dest_dir):
        calls.append(spec)
        raise tipo_service.TipoError("network off")

    monkeypatch.setattr(tipo_service, "_download_weight", fake_download)
    fake_models = SimpleNamespace(model_dir=None, text_model=None)
    monkeypatch.setattr(tipo_service, "_import_kgen", lambda: {"models": fake_models})
    monkeypatch.setattr(tipo_service, "_loaded_model_key", None)

    with pytest.raises(tipo_service.TipoError, match="network off"):
        tipo_service._ensure_model_loaded("v2.1")

    assert calls


# ---------------------------------------------------- folder-style models


FLORENCE_FILES = {"config.json": b"{}", "model.safetensors": b"w" * 40}


def test_florence_uses_the_trusted_snapshot_and_prepare_does_not_download(
    world, own, monkeypatch
):
    import florence2_captioner
    import model_health_paths

    monkeypatch.setattr(
        florence2_captioner, "get_florence2_model_dir", lambda: str(own / "florence2")
    )
    snapshot = world.add_folder("florence2", "base", "hub/snap", FLORENCE_FILES)

    assert florence2_captioner.get_checkpoint_path() == str(snapshot)
    assert model_health_paths.get_florence2_checkpoint_path() == str(snapshot)
    assert florence2_captioner.prepare_checkpoint() == str(snapshot)

    florence = health()["florence2"]
    assert florence["checkpoint_path"] == str(snapshot)
    assert florence["source"]["kind"] == "hf_cache"
    assert cards()["florence2"]["source"]["path"] == str(snapshot)


def test_florence_own_folder_wins(world, own, monkeypatch):
    import florence2_captioner

    monkeypatch.setattr(
        florence2_captioner, "get_florence2_model_dir", lambda: str(own / "florence2")
    )
    world.add_folder("florence2", "base", "hub/snap", FLORENCE_FILES)
    monkeypatch.setattr(
        florence2_captioner, "missing_checkpoint_files", lambda _dir: ()
    )

    assert florence2_captioner.get_checkpoint_path() == str(
        (own / "florence2").resolve()
    )


def test_lucida_uses_the_trusted_snapshot(world, own, monkeypatch):
    import lucida_matting

    monkeypatch.setattr(
        lucida_matting, "get_lucida_model_dir", lambda: str(own / "lucida")
    )
    snapshot = world.add_folder(
        "lucida", "pinned", "hub/lucida", {"config.json": b"{}"}
    )

    assert lucida_matting.get_checkpoint_path() == str(snapshot)
    assert lucida_matting.prepare_checkpoint() == str(snapshot)
    assert health()["lucida"]["checkpoint_path"] == str(snapshot)


# ------------------------------------------------------------- Kaloscope


def add_kaloscope(world: ExternalWorld) -> Path:
    runtime = world.root / "custom_nodes" / "comfyui-lsnet"
    (runtime / "lsnet_model").mkdir(parents=True)
    checkpoint = world.add_file(
        "artist",
        "kaloscope2.0",
        "models/lsnet/Kaloscope/best_checkpoint.pth",
        b"c" * 64,
        companions={"models/lsnet/Kaloscope/class_mapping.csv": b"a,b\n"},
    )
    world.entries[-1]["companions"].append(str(runtime))
    world.save()
    return checkpoint


def test_kaloscope_files_and_runtime_come_from_the_trusted_comfyui(
    world, own, monkeypatch
):
    import artist_identifier as ai

    monkeypatch.setattr(ai, "_get_artist_model_root", lambda: own / "artist")
    monkeypatch.setattr(ai, "ARTIST_LSNET_CODE_PATH", None)
    monkeypatch.setattr(ai, "get_artist_model_dir", lambda: str(own / "artist"))
    checkpoint = add_kaloscope(world)

    found = ai._locate_existing_kaloscope_files()

    assert found == (str(checkpoint), str(checkpoint.parent / "class_mapping.csv"))
    assert ai._resolve_lsnet_runtime_path() == str(
        world.root / "custom_nodes" / "comfyui-lsnet"
    )

    artist = health()["artist"]
    assert artist["checkpoint_path"] == str(checkpoint)
    assert artist["class_mapping_path"].endswith("class_mapping.csv")
    assert artist["runtime_path"].endswith("comfyui-lsnet")
    assert artist["source"]["kind"] == "comfyui"


def test_kaloscope_gone_means_no_files_and_a_named_card(world, own, monkeypatch):
    import artist_identifier as ai

    monkeypatch.setattr(ai, "_get_artist_model_root", lambda: own / "artist")
    checkpoint = add_kaloscope(world)
    checkpoint.unlink()

    assert ai._locate_existing_kaloscope_files() is None
    card = cards()["artist"]
    assert card["status"] == "missing"
    assert str(checkpoint) in card["message"]


# --------------------------------------------------------- aesthetic etc.


def test_waifu_head_from_a_trusted_copy_and_prepare_leaves_it_alone(world, own):
    import aesthetic

    head = world.add_file("aesthetic-waifu", None, "models/waifu_scorer_v3.safetensors")

    report = aesthetic.waifu_health()

    assert report["available"] is True
    assert report["head_path"] == str(head)
    assert report["source"]["path"] == str(head)
    assert report["expected_path"].startswith(str(own))
    assert (
        aesthetic.prepare_waifu_head(lambda *a, **k: pytest.fail("downloaded")) == head
    )


def test_waifu_own_file_wins(world, own):
    import aesthetic

    world.add_file("aesthetic-waifu", None, "models/waifu.safetensors")
    mine = own / "aesthetic" / aesthetic.WAIFU_HEAD_FILENAME
    mine.write_bytes(b"mine")

    report = aesthetic.waifu_health()

    assert report["head_path"] == str(mine)
    assert report["source"] is None


def test_anime_grade_needs_the_whole_trusted_pair(world, own):
    import anime_aesthetic

    model = world.add_file(
        "aesthetic-anime",
        None,
        "hub/model.onnx",
        b"m" * 20,
        companions={"hub/samples.npz": b"s" * 10},
        verify="sha",
    )

    report = anime_aesthetic.health()

    assert report["available"] is True
    assert report["model_path"] == str(model)
    assert report["source"]["verify"] == "sha"
    assert anime_aesthetic.files_in_use()[1] == world.root / "hub" / "samples.npz"
    assert anime_aesthetic.prepare(lambda *a, **k: pytest.fail("downloaded"))[
        "model_path"
    ] == str(model)

    (world.root / "hub" / "samples.npz").unlink()
    assert anime_aesthetic.health()["available"] is False


def test_anime_censor_detector_and_face_guard_use_trusted_copies(world, own):
    import anime_censor_models

    censor = world.add_file("censor-anime", "censor", "hub/censor.onnx", b"c" * 8)
    face = world.add_file("censor-anime", "face", "hub/face.onnx", b"f" * 8)

    report = anime_censor_models.health()

    assert report["available"] is True
    assert report["censor_model_path"] == str(censor)
    assert report["face_model_path"] == str(face)
    assert anime_censor_models.face_model_in_use() == face
    assert anime_censor_models._prepare_one(
        anime_censor_models.FACE_FILE, lambda *a, **k: pytest.fail("downloaded")
    ) == str(face)


def test_privacy_yolo_from_a_trusted_copy_is_the_default_and_listed(world, own):
    import model_health_paths

    yolo = world.add_file(
        "censor-legacy", None, "models/ultralytics/segm/wenaka.onnx", b"y" * 32
    )

    assert model_health_paths.get_default_legacy_model_path() == str(yolo)
    legacy = health()["censor"]["legacy"]
    assert legacy["available"] is True
    assert legacy["source"]["path"] == str(yolo)
    assert legacy["privacy_model_count"] == 1
    assert cards()["censor-legacy"]["source"]["kind"] == "comfyui"


def test_own_yolo_file_wins_over_a_trusted_one(world, own):
    import model_health_paths

    world.add_file("censor-legacy", None, "models/wenaka.onnx", b"y" * 32)
    mine = own / "yolo" / "yolov8s-seg.onnx"
    mine.write_bytes(b"mine")

    assert model_health_paths.get_default_legacy_model_path() == str(mine.resolve())


def test_tipo_weights_from_a_trusted_kgen_folder(world, own):
    from services import tipo_service

    weight = world.add_file(
        "tipo", "v2.1", "models/kgen/TIPO-v2.1-1B-A200M-Q8_0.gguf", GGUF, verify="sha"
    )

    probe = tipo_service.probe_tipo_installation()

    assert "v2.1" in probe["installed_variants"]
    assert probe["source"]["path"] == str(weight)
    assert tipo_service._weight_in_use("v2.1") == weight


def test_a_cleared_index_changes_nothing(own):
    wd14 = health()["wd14"]

    assert wd14["source"] is None
    assert model_external.lookup("wd14", DEFAULT) is None


def test_the_message_fits_the_page_for_the_longest_names(world):
    for kind, model_id, variant, name in (
        ("comfyui", "wd14", "wd-eva02-large-tagger-v3", "wd-eva02-large-tagger-v3"),
        ("hf_cache", "wd14", "wd-eva02-large-tagger-v3", "wd-eva02-large-tagger-v3"),
        ("folder", "tipo", "v2.1", "TIPO v2.1"),
    ):
        world.entries.clear()
        path = world.add_file(model_id, variant, f"m/{name}.bin", kind=kind)
        path.unlink()
        with pytest.raises(model_external.ExternalModelUnavailable) as raised:
            model_external.require_available(model_id, variant, name)
        assert_shown_as_written(str(raised.value))


def test_pressing_prepare_on_an_intact_trusted_copy_changes_and_downloads_nothing(
    world, own, monkeypatch
):
    from services import model_service, model_service_prepare

    path = add_default_wd14(world)
    calls = _recording_hub(monkeypatch)
    monkeypatch.setattr(
        model_service,
        "_repair_wd14_onnxruntime_if_possible",
        lambda: {"attempted": False},
    )

    result = model_service_prepare._prepare_model(None, "wd14", variant=DEFAULT)

    assert not calls
    assert result["paths"]["model_path"] == str(path)
    assert [e["model_id"] for e in world.store.matches()] == ["wd14"]


def test_pressing_prepare_on_an_intact_tipo_copy_keeps_its_record(
    world, own, monkeypatch
):
    from services import model_service, model_service_prepare

    world.add_file("tipo", "v2.1", "models/kgen/TIPO.gguf", GGUF, verify="sha")
    monkeypatch.setattr(model_service, "ensure_group", lambda _g: {"ok": True})
    monkeypatch.setattr(
        model_service, "_dependency_restart_result", lambda *_a, **_k: None
    )
    monkeypatch.setattr(model_service, "_with_dependency_result", lambda r, _d: r)

    model_service_prepare._prepare_model(None, "tipo")

    assert [e["model_id"] for e in world.store.matches()] == ["tipo"]
