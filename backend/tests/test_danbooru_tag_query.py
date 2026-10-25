"""DanbooruTagQuery B/16 and L/16 (GitHub issue #20): registry contract, the
two-file vocabulary, the official preprocessing, scoring with a rating taken
from the tags, downloading every file, Model Center and the UI lists."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, List

import numpy as np
import pytest
from PIL import Image

import ai_runtime_guard
import gpu_duty_cycle
import tagger as tagger_module
from config import DEFAULT_TAGGER_MODEL, TAGGER_MODELS
from services.tagging.catalog import TAGGER_MODEL_HINTS

B16 = "danbooru-tag-query-b16"
L16 = "danbooru-tag-query-l16"
REPO_ROOT = Path(__file__).resolve().parents[2]
REVISION = "d2f8da27a23db4adf95c3e663af183b92784ad3e"


@pytest.fixture(autouse=True)
def _isolate(monkeypatch):
    monkeypatch.setattr(ai_runtime_guard, "_gpu_residents", {})
    monkeypatch.setattr(gpu_duty_cycle, "_sleep", lambda _s: None)
    yield


def _vocabulary(folder: Path, *, ids: dict | None = None) -> Path:
    """A small tag_to_id.json with tag_category.json beside it (codes 0/3/4)."""
    tag_to_id = ids or {
        "1girl": 0,
        "long_hair": 1,
        "hatsune_miku": 2,
        "vocaloid": 3,
        "cleavage": 4,
        "nipples": 5,
    }
    categories = {
        "1girl": 0,
        "long_hair": 0,
        "hatsune_miku": 4,
        "vocaloid": 3,
        "cleavage": 0,
        "nipples": 0,
        "twitter_username": 5,  # a removed noise tag: listed, never predicted
    }
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "tag_category.json").write_text(json.dumps(categories), encoding="utf-8")
    path = folder / "tag_to_id.json"
    path.write_text(json.dumps(tag_to_id), encoding="utf-8")
    return path


@pytest.mark.parametrize(
    "variant, sub, tier",
    [
        (B16, "DanbooruTagQuery_b16_448x448", "balanced"),
        (L16, "DanbooruTagQuery_l16_448x448", "heavy"),
    ],
)
def test_registry_pins_the_repo_files_and_the_official_contract(variant, sub, tier):
    entry = TAGGER_MODELS[variant]
    assert entry["repo_id"] == "realphongha/danbooru-tag-query"
    assert entry["revision"] == REVISION
    # The files live in a repo subfolder; the full path is in each name.
    assert entry["model_file"] == f"models/{sub}/model.onnx"
    assert entry["tags_file"] == f"models/{sub}/tag_to_id.json"
    assert entry["external_data_files"] == [f"models/{sub}/tag_category.json"]
    assert "repo_subfolder" not in entry
    assert entry["runtime_safety_tier"] == tier
    assert entry["metadata_format"] == "dtq_json"
    assert entry["input_layout"] == "nchw"
    assert entry["input_normalization"] == "imagenet"
    assert entry["resize_mode"] == "letterbox"
    assert entry["resize_resample"] == "bilinear"
    assert entry["pad_color"] == [0, 0, 0]
    assert entry["output_activation"] == "sigmoid"
    assert entry["rating_fallback_mode"] == "derive_from_tags"
    assert entry["supports_rating"] is False
    assert variant in TAGGER_MODEL_HINTS
    assert "DINOv3" in TAGGER_MODEL_HINTS[variant]["summary"]


def test_the_app_default_stays_swinv2():
    """Adding the models does not change what existing users tag with."""
    assert DEFAULT_TAGGER_MODEL == "wd-swinv2-tagger-v3"
    assert TAGGER_MODEL_HINTS["wd-swinv2-tagger-v3"].get("recommended") is True
    assert not TAGGER_MODEL_HINTS[B16].get("recommended")


def _system(vram_total_mb, vram_free_mb, ram_free_gb=16):
    return {
        "gpu_name": "NVIDIA GeForce RTX 3090",
        "gpu_vram_total_mb": vram_total_mb,
        "gpu_vram_available_mb": vram_free_mb,
        "onnx_providers": ["CUDAExecutionProvider", "CPUExecutionProvider"],
        "total_ram_gb": 32,
        "available_ram_gb": ram_free_gb,
    }


@pytest.mark.parametrize("variant", [B16, L16])
def test_batch_is_sized_from_free_memory_not_the_wd_caps(variant):
    """Each picture needs ~0.6-1.4 GB of working memory (the head holds 11,424
    tag queries against every image patch), many times a WD model. With the WD
    caps a 24 GB card got a batch of 64 and spilled ~39 GB into system RAM.
    The weights share the same memory, so they come off the budget first."""
    from gpu_headroom import model_weights_mb
    from hardware_monitor import recommend_tagger_config

    per_image = TAGGER_MODELS[variant]["activation_mb_per_image"]
    weights = model_weights_mb(TAGGER_MODELS[variant])
    roomy = recommend_tagger_config(_system(24576, 16000), model_name=variant)["recommended_batch_size"]
    busy = recommend_tagger_config(_system(24576, 3000), model_name=variant)["recommended_batch_size"]
    cpu = recommend_tagger_config(_system(24576, 16000, ram_free_gb=16), model_name=variant, use_gpu=False)[
        "recommended_batch_size"
    ]

    assert roomy >= 2 and weights + roomy * per_image <= 16000 * 0.5
    assert busy == 1
    assert cpu >= 1 and weights + cpu * per_image <= max(weights + per_image, 16 * 1024 * 0.25)
    assert recommend_tagger_config(_system(24576, 16000), model_name="wd-swinv2-tagger-v3")["recommended_batch_size"] == 64


def test_the_gpu_is_used_only_when_weights_and_one_picture_fit():
    from gpu_headroom import TAGGER_GPU_NEED_MB, model_weights_mb, tagger_gpu_need_mb

    for variant in (B16, L16):
        config = TAGGER_MODELS[variant]
        need = tagger_gpu_need_mb(variant)
        assert need >= model_weights_mb(config) + config["activation_mb_per_image"]
    assert tagger_gpu_need_mb("wd-swinv2-tagger-v3") == TAGGER_GPU_NEED_MB["balanced"]


def test_cuda_session_gets_a_hard_memory_limit_only_for_memory_hungry_models(monkeypatch):
    """Windows pages video memory that does not fit into system RAM instead of
    failing, so without a limit an oversize batch drains the PC and the
    out-of-memory backoff never runs."""
    import gpu_headroom

    monkeypatch.setattr(gpu_headroom, "free_vram_mb", lambda: 10000.0)
    options = gpu_headroom.tagger_cuda_options(B16)

    assert options == {"arena_extend_strategy": "kSameAsRequested", "gpu_mem_limit": str(6000 * 1024 * 1024)}
    assert gpu_headroom.tagger_cuda_options("wd-swinv2-tagger-v3") is None
    monkeypatch.setattr(gpu_headroom, "free_vram_mb", lambda: None)
    assert gpu_headroom.tagger_cuda_options(L16) == {"arena_extend_strategy": "kSameAsRequested"}
    monkeypatch.setattr(gpu_headroom, "free_vram_mb", lambda: 1000.0)
    limit_mb = int(gpu_headroom.tagger_cuda_options(L16)["gpu_mem_limit"]) / (1024 * 1024)
    floor_mb = gpu_headroom.model_weights_mb(TAGGER_MODELS[L16]) + TAGGER_MODELS[L16]["activation_mb_per_image"] * 2
    assert abs(limit_mb - floor_mb) < 1


def test_the_limit_is_attached_to_the_cuda_provider(monkeypatch):
    import gpu_headroom

    monkeypatch.setattr(gpu_headroom, "free_vram_mb", lambda: 10000.0)
    dtq = object.__new__(tagger_module.WD14Tagger)
    dtq.model_name = B16
    wd = object.__new__(tagger_module.WD14Tagger)
    wd.model_name = "wd-swinv2-tagger-v3"
    providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]

    with_options = dtq._providers_with_options(providers)

    assert with_options[0][0] == "CUDAExecutionProvider" and "gpu_mem_limit" in with_options[0][1]
    assert with_options[1] == "CPUExecutionProvider"
    assert wd._providers_with_options(providers) == providers
    assert dtq._providers_with_options(["CPUExecutionProvider"]) == ["CPUExecutionProvider"]


def test_the_arena_limit_counts_as_out_of_memory_so_the_batch_is_halved():
    """The real message from the B/16 run under a 1.5 GB limit (2026-10-25)."""
    from ai_runtime_guard import looks_like_cuda_oom

    error = RuntimeError(
        "[ONNXRuntimeError] : 6 : RUNTIME_EXCEPTION : Non-zero status code returned while running "
        "Transpose node. Name:'/head/cross_attn/Transpose' Status Message: bfc_arena.cc:376 "
        "onnxruntime::BFCArena::AllocateRawInternal Available memory of 233355776 is smaller "
        "than requested bytes of 280756224"
    )

    assert looks_like_cuda_oom(error)


def _tagger(fmt: str = "dtq_json"):
    tagger = object.__new__(tagger_module.WD14Tagger)
    tagger._metadata_format = fmt
    tagger.model_name = B16
    return tagger


def test_vocabulary_maps_ids_to_output_rows_and_categories(tmp_path):
    tagger = _tagger()

    tagger._load_tags(str(_vocabulary(tmp_path)))

    assert tagger.tags == [
        "1girl",
        "long_hair",
        "hatsune_miku",
        "vocaloid",
        "cleavage",
        "nipples",
    ]
    assert tagger.general_tags == [
        (0, "1girl"),
        (1, "long_hair"),
        (4, "cleavage"),
        (5, "nipples"),
    ]
    assert tagger.character_tags == [(2, "hatsune_miku")]
    assert tagger.copyright_tags == [(3, "vocaloid")]
    assert tagger.rating_tags == []


def test_vocabulary_order_follows_the_ids_not_the_file_order(tmp_path):
    shuffled = {
        "vocaloid": 3,
        "1girl": 0,
        "nipples": 5,
        "hatsune_miku": 2,
        "cleavage": 4,
        "long_hair": 1,
    }
    tagger = _tagger()

    tagger._load_tags(str(_vocabulary(tmp_path, ids=shuffled)))

    assert tagger.tags[0] == "1girl" and tagger.tags[3] == "vocaloid"


def test_vocabulary_with_a_gap_in_the_ids_is_refused(tmp_path):
    tagger = _tagger()

    with pytest.raises(ValueError, match="0 to 2"):
        tagger._load_tags(
            str(_vocabulary(tmp_path, ids={"1girl": 0, "long_hair": 2, "solo": 3}))
        )


def test_vocabulary_without_its_category_file_is_refused(tmp_path):
    path = _vocabulary(tmp_path)
    (tmp_path / "tag_category.json").unlink()
    tagger = _tagger()

    with pytest.raises(ValueError, match="tag_category.json is missing"):
        tagger._load_tags(str(path))


@pytest.mark.parametrize(
    "ids, categories, message",
    [
        (["1girl"], {"1girl": 0}, "another layout"),
        ({"1girl": 0}, ["1girl"], "another layout"),
        ({"1girl": 0}, {"1girl": None, "solo": "x"}, "not a number"),
        ({"1girl": "zero"}, {"1girl": 0}, "not a number"),
    ],
)
def test_a_malformed_vocabulary_is_refused_with_a_clear_message(tmp_path, ids, categories, message):
    (tmp_path / "tag_category.json").write_text(json.dumps(categories), encoding="utf-8")
    path = tmp_path / "tag_to_id.json"
    path.write_text(json.dumps(ids), encoding="utf-8")

    with pytest.raises(ValueError, match=message):
        _tagger()._load_tags(str(path))


def _preprocessor(size: int = 448):
    tagger = object.__new__(tagger_module.WD14Tagger)
    tagger._input_hw = (size, size)
    tagger._input_layout = "nchw"
    tagger._input_normalization = "imagenet"
    tagger._resize_mode = "letterbox"
    tagger._resize_resample = "bilinear"
    tagger._pad_color = (0, 0, 0)
    return tagger


def _official(image: Image.Image, size: int) -> np.ndarray:
    """deploy/danbooru_deploy/core.py preprocess (realphongha/DanbooruTagQuery)."""
    w, h = image.size
    scale = size / max(w, h)
    new_w, new_h = int(w * scale), int(h * scale)
    resized = image.convert("RGB").resize((new_w, new_h), Image.Resampling.BILINEAR)
    canvas = Image.new("RGB", (size, size), (0, 0, 0))
    canvas.paste(resized, ((size - new_w) // 2, (size - new_h) // 2))
    arr = np.asarray(canvas, dtype=np.float32).transpose(2, 0, 1) / 255.0
    mean = np.array([0.485, 0.456, 0.406], dtype=np.float32)[:, None, None]
    std = np.array([0.229, 0.224, 0.225], dtype=np.float32)[:, None, None]
    return (arr - mean) / std


def test_preprocessing_matches_the_official_tensor():
    rng = np.random.default_rng(20)
    image = Image.fromarray(rng.integers(0, 256, (300, 520, 3), dtype=np.uint8))

    out = _preprocessor()._preprocess(image)

    assert out.shape == (3, 448, 448) and out.dtype == np.float32
    assert np.abs(out - _official(image, 448)).max() < 1e-5


def test_bicubic_stays_the_default_for_the_wd_models():
    tagger = _preprocessor(size=64)
    tagger._resize_resample = "bicubic"
    rng = np.random.default_rng(3)
    image = Image.fromarray(rng.integers(0, 256, (90, 150, 3), dtype=np.uint8))

    bicubic = tagger._preprocess(image)
    tagger._resize_resample = "bilinear"
    bilinear = tagger._preprocess(image)

    assert not np.allclose(bicubic, bilinear)
    assert "resize_resample" not in TAGGER_MODELS["wd-swinv2-tagger-v3"]


class _Options:
    def add_session_config_entry(self, *_args) -> None:
        pass


class _DtqSession:
    batches: List[int] = []

    def __init__(self, *_args, providers: Any = None, **_kwargs):
        self._providers = list(providers or [])

    def get_providers(self):
        return list(self._providers)

    def get_inputs(self):
        return [
            type(
                "Input", (), {"shape": ["batch", 3, 448, 448], "name": "pixel_values"}
            )()
        ]

    def run(self, _outputs, inputs):
        batch = inputs["pixel_values"]
        assert batch.shape[1:] == (3, 448, 448)
        _DtqSession.batches.append(batch.shape[0])
        logits = np.full((batch.shape[0], 6), -8.0, dtype=np.float32)
        logits[:, 0] = 3.0  # 1girl
        logits[:, 1] = -1.0  # long_hair: p=0.27 > 0.20
        logits[:, 2] = 0.5  # hatsune_miku: p=0.62
        logits[:, 4] = 0.0  # cleavage: p=0.5 -> questionable
        return [logits]


class _DtqOrt:
    SessionOptions = _Options
    InferenceSession = _DtqSession

    class ExecutionMode:
        ORT_SEQUENTIAL = "ORT_SEQUENTIAL"

    class GraphOptimizationLevel:
        ORT_ENABLE_ALL = "ORT_ENABLE_ALL"

    @staticmethod
    def get_available_providers():
        return ["CPUExecutionProvider"]


def test_tagging_reads_logits_and_takes_the_rating_from_the_tags(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "model.onnx").write_bytes(b"model")
    tags_path = _vocabulary(tmp_path / "vocab")
    monkeypatch.setattr(tagger_module, "ort", _DtqOrt)
    monkeypatch.setattr(tagger_module, "hf_hub", object())
    _DtqSession.batches = []
    paths = []
    for index, size in enumerate([(640, 960), (1200, 800)]):
        path = tmp_path / f"{index}.png"
        Image.new("RGB", size, (200, 180, 160)).save(path)
        paths.append(str(path))
    tagger = tagger_module.WD14Tagger(
        model_name=B16, threshold=0.20, character_threshold=0.35, use_gpu=False
    )
    monkeypatch.setattr(
        tagger, "_get_model_paths", lambda: ("model.onnx", str(tags_path))
    )

    results = tagger.tag_batch(paths, preferred_batch_size=2, copyright_threshold=0.35)

    assert sum(_DtqSession.batches) == 2
    first = results[0]
    assert [t["tag"] for t in first["general_tags"]] == [
        "1girl",
        "cleavage",
        "long_hair",
    ]
    assert [t["tag"] for t in first["character_tags"]] == ["hatsune_miku"]
    assert first["copyright_tags"] == []
    assert first["rating"] == "questionable"


@pytest.mark.parametrize(
    "variant, sub",
    [(B16, "DanbooruTagQuery_b16_448x448"), (L16, "DanbooruTagQuery_l16_448x448")],
)
def test_download_fetches_model_vocabulary_and_categories_at_the_pin(
    monkeypatch, tmp_path, variant, sub
):
    calls = []

    class _Hub:
        @staticmethod
        def hf_hub_download(**kwargs):
            calls.append(kwargs)
            target = Path(kwargs["local_dir"]) / kwargs["filename"]
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(b"x" * (2 * 1024 * 1024))
            return str(target)

    monkeypatch.setattr(tagger_module, "hf_hub", _Hub)
    monkeypatch.setattr(
        "model_download_sources.get_hf_endpoint_order",
        lambda **_k: ["https://huggingface.co"],
    )
    monkeypatch.setattr(
        "tagger_download.get_hf_endpoint_order", lambda **_k: ["https://huggingface.co"]
    )
    tagger = object.__new__(tagger_module.WD14Tagger)
    tagger.model_name = variant
    tagger.model_dir = str(tmp_path)

    model_path, tags_path = tagger._download_model()

    assert sorted(call["filename"] for call in calls) == [
        f"models/{sub}/model.onnx",
        f"models/{sub}/tag_category.json",
        f"models/{sub}/tag_to_id.json",
    ]
    assert {call["revision"] for call in calls} == {REVISION}
    assert Path(model_path) == tmp_path / variant / "models" / sub / "model.onnx"
    assert Path(tags_path).name == "tag_to_id.json"


def test_model_center_lists_both_on_the_wd14_card_and_needs_the_category_file(
    monkeypatch, tmp_path
):
    import model_health
    from tests.test_model_health_pins import _wire_clean_state

    root = _wire_clean_state(monkeypatch, tmp_path)
    target = (
        root / "get_wd14_model_dir" / B16 / "models" / "DanbooruTagQuery_b16_448x448"
    )
    target.mkdir(parents=True)
    (target / "model.onnx").write_bytes(b"m")
    (target / "tag_to_id.json").write_bytes(b"{}")

    def listed() -> dict:
        return {
            item["name"]: item["available"]
            for item in model_health.get_model_health()["wd14"]["installed_models"]
        }

    assert listed()[B16] is False and listed()[L16] is False
    (target / "tag_category.json").write_bytes(b"{}")
    assert listed()[B16] is True


def test_frontends_name_both_models_in_both_languages():
    ui = (REPO_ROOT / "frontend" / "js" / "app" / "tagger-model-ui.js").read_text(
        encoding="utf-8"
    )
    ensure = (REPO_ROOT / "frontend" / "js" / "app" / "ensure-model.js").read_text(
        encoding="utf-8"
    )
    en = (REPO_ROOT / "frontend" / "js" / "lang" / "en.js").read_text(encoding="utf-8")
    zh = (REPO_ROOT / "frontend" / "js" / "lang" / "zh-CN.js").read_text(
        encoding="utf-8"
    )
    vopus = (
        REPO_ROOT / "frontend-v4" / "src" / "features" / "tagging" / "taggers.ts"
    ).read_text(encoding="utf-8")
    vopus_en = (REPO_ROOT / "frontend-v4" / "src" / "i18n" / "en.ts").read_text(
        encoding="utf-8"
    )
    vopus_zh = (REPO_ROOT / "frontend-v4" / "src" / "i18n" / "zh-CN.ts").read_text(
        encoding="utf-8"
    )

    for variant, prefix, note in ((B16, "dtqB16", "dtqB16"), (L16, "dtqL16", "dtqL16")):
        assert f"'{variant}': 'tagger.model.{prefix}'" in ui
        assert f"'{variant}':" in ensure
        assert f"'{variant}':" in vopus
        for key in ("summary", "bestFor", "runtimeNote", "safeModeNote"):
            assert f"'tagger.model.{prefix}.{key}'" in en
            assert f"'tagger.model.{prefix}.{key}'" in zh
        assert (
            f"'tagger.note.{note}'" in vopus_en and f"'tagger.note.{note}'" in vopus_zh
        )


def test_a_batch_size_that_ran_out_of_memory_is_not_tried_again():
    """With a hard GPU limit, raising the batch back after two good runs used to
    hit the same out-of-memory error and rebuild the session every time."""
    from tests.test_tagger_pins import _bare

    tagger = _bare(
        use_gpu=True,
        _learned_stable_gpu_batch_size=None,
        _successful_gpu_batch_runs=0,
        _images_since_session_create=0,
        _session_refresh_interval=0,
        _gpu_oom_chunk_size=None,
    )
    tagger._session_uses_gpu = lambda: True
    rebuilds = []
    tagger._recreate_session = lambda: rebuilds.append(1)
    tagger._process_probs = lambda output, **_kw: {"ok": True}
    sizes: List[int] = []

    def fake_run(batch, *, allow_gpu_fallback=True):
        sizes.append(int(batch.shape[0]))
        if batch.shape[0] > 3:
            raise RuntimeError("BFCArena::AllocateRawInternal Available memory of 1 is smaller than requested bytes of 2")
        return np.zeros((batch.shape[0], 3), dtype=np.float32)

    tagger._run_inference = fake_run
    inputs = [np.zeros((4, 4, 3), dtype=np.float32) for _ in range(20)]

    results, info = tagger._run_true_batch_with_backoff(
        inputs, list(range(20)), [str(i) for i in range(20)], initial_chunk_size=8, retry_cooldown_seconds=0
    )

    assert all(result == {"ok": True} for result in results)
    assert sizes[:2] == [8, 4]
    assert all(size <= 3 for size in sizes[2:])
    assert len(rebuilds) == 2
    assert info["used_cpu_fallback"] is False
