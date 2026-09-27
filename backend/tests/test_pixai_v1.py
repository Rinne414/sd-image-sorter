"""PixAI Tagger v1.0: registry contract, official preprocessing, tag table,
download of the external weights file, GPU cap, Model Center and UI lists."""

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
from config import TAGGER_MODELS
from hardware_monitor import recommend_tagger_config
from services.tagging.catalog import TAGGER_MODEL_HINTS
from services.tagging.request import resolve_request_thresholds

MODEL = "pixai-tagger-v1.0"


@pytest.fixture(autouse=True)
def _isolate(monkeypatch):
    monkeypatch.setattr(ai_runtime_guard, "_gpu_residents", {})
    monkeypatch.setattr(gpu_duty_cycle, "_sleep", lambda _s: None)
    yield


def _tags_json(path: Path) -> Path:
    categories = [
        ("general", ["1girl", "solo"]),
        ("character", ["hatsune_miku"]),
        ("copyright", ["vocaloid"]),
        ("style", ["bkub"]),
        ("meta", ["highres"]),
        ("rating", ["rating:s", "rating:g", "rating:q", "rating:e"]),
    ]
    payload = {
        "num_classes": 10,
        "category_order": [c for c, _ in categories],
        "categories": [],
    }
    offset = 0
    for name, tags in categories:
        payload["categories"].append(
            {"name": name, "offset": offset, "count": len(tags), "tags": tags}
        )
        offset += len(tags)
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def test_registry_entry_pins_the_community_onnx_and_official_contract():
    entry = TAGGER_MODELS[MODEL]
    assert entry["repo_id"] == "noaione/pixai-tagger-v1.0-onnx"
    assert entry["revision"] == "68e8f4f02dd56a5f40c1b7474489fa0f599dec34"
    assert entry["model_file"] == "model.onnx"
    assert entry["external_data_files"] == ["model.onnx.data"]
    assert entry["tags_file"] == "tags.json"
    assert entry["runtime_safety_tier"] == "heavy"
    assert entry["image_size"] == 1008
    assert entry["resize_mode"] == "rescale_pad"
    assert entry["input_normalization"] == "minus_one_to_one"
    assert entry["output_activation"] == "sigmoid"
    assert entry["metadata_format"] == "pixai_v1"
    # Official per-category best thresholds (config.json category_best_threshold).
    assert (
        entry["default_threshold"],
        entry["default_character_threshold"],
        entry["default_copyright_threshold"],
    ) == (0.17, 0.27, 0.24)
    # v0.9 stays available next to it.
    assert "pixai-tagger-v0.9" in TAGGER_MODELS
    assert MODEL in TAGGER_MODEL_HINTS


def test_request_thresholds_default_to_the_official_values():
    assert resolve_request_thresholds(MODEL, None, None) == (0.17, 0.27)


def test_gpu_batch_cap_is_scaled_for_the_1008_px_input():
    info = {
        "gpu_name": "NVIDIA GeForce RTX 3090",
        "gpu_vram_total_mb": 24576,
        "gpu_vram_available_mb": 21617,
        "onnx_providers": ["CUDAExecutionProvider", "CPUExecutionProvider"],
        "total_ram_gb": 32,
        "available_ram_gb": 20,
    }
    assert (
        recommend_tagger_config(info, model_name=MODEL)["recommended_batch_size"] == 9
    )
    assert (
        recommend_tagger_config(info, model_name="pixai-tagger-v0.9")[
            "recommended_batch_size"
        ]
        == 48
    )


def _preprocessor(size: int = 1008):
    tagger = object.__new__(tagger_module.WD14Tagger)
    tagger._input_hw = (size, size)
    tagger._input_layout = "nchw"
    tagger._input_normalization = "minus_one_to_one"
    tagger._resize_mode = "rescale_pad"
    tagger._pad_color = (0, 0, 0)
    return tagger


def test_rescale_pad_centres_the_image_on_black_padding():
    tagger = _preprocessor()
    image = Image.new("RGB", (504, 1008), (255, 0, 51))

    out = tagger._preprocess(image)

    assert out.shape == (3, 1008, 1008) and out.dtype == np.float32
    # 504 px wide content centred: columns 252..755 hold the image.
    assert np.allclose(out[:, :, :252], -1.0) and np.allclose(out[:, :, 756:], -1.0)
    content = out[:, :, 252:756]
    assert np.allclose(content[0], 1.0) and np.allclose(content[1], -1.0)
    assert np.allclose(content[2], 51 / 255 * 2 - 1, atol=1e-6)


def test_rescale_pad_resizes_the_float_image_without_8bit_rounding():
    tagger = _preprocessor(size=8)
    gradient = np.tile(np.arange(16, dtype=np.uint8) * 17, (16, 1))
    image = Image.fromarray(np.stack([gradient] * 3, axis=-1))

    out = tagger._preprocess(image)

    expected_plane = np.asarray(
        Image.fromarray(gradient.astype(np.float32) / 255.0).resize(
            (8, 8), Image.Resampling.BILINEAR
        )
    )
    assert np.allclose(out[0], expected_plane * 2 - 1, atol=1e-6)
    # An 8-bit resize would snap to multiples of 1/255; the float path does not.
    levels = (out[0] + 1.0) / 2.0 * 255.0
    assert not np.allclose(levels, np.round(levels))


def test_rescale_pad_composites_transparency_on_white():
    tagger = _preprocessor(size=16)
    image = Image.new("RGBA", (16, 16), (0, 0, 0, 0))

    out = tagger._preprocess(image)

    assert np.allclose(out, 1.0)


def test_tag_table_maps_categories_style_to_artist_and_ratings(tmp_path):
    tagger = object.__new__(tagger_module.WD14Tagger)
    tagger._metadata_format = "pixai_v1"

    tagger._load_tags(str(_tags_json(tmp_path / "tags.json")))

    assert tagger.general_tags == [
        (0, "1girl"),
        (1, "solo"),
        (4, "bkub"),
        (5, "highres"),
    ]
    assert tagger.character_tags == [(2, "hatsune_miku")]
    assert tagger.copyright_tags == [(3, "vocaloid")]
    assert tagger._general_category_overrides == {"bkub": "artist", "highres": "meta"}
    assert tagger.rating_indices == {
        "sensitive": 6,
        "general": 7,
        "questionable": 8,
        "explicit": 9,
    }
    assert len(tagger.tags) == 10


def test_tag_table_rejects_a_file_that_does_not_match_the_model(tmp_path):
    path = _tags_json(tmp_path / "tags.json")
    payload = json.loads(path.read_text(encoding="utf-8"))
    payload["num_classes"] = 11
    path.write_text(json.dumps(payload), encoding="utf-8")
    tagger = object.__new__(tagger_module.WD14Tagger)
    tagger._metadata_format = "pixai_v1"

    with pytest.raises(ValueError, match="expects 11"):
        tagger._load_tags(str(path))


class _Options:
    def add_session_config_entry(self, *_args) -> None:
        pass


class _PixAIV1Session:
    batches: List[int] = []

    def __init__(self, *_args, providers: Any = None, **_kwargs):
        self._providers = list(providers or [])

    def get_providers(self):
        return list(self._providers)

    def get_inputs(self):
        return [
            type("Input", (), {"shape": [1, 3, 1008, 1008], "name": "pixel_values"})()
        ]

    def run(self, _outputs, inputs):
        batch = inputs["pixel_values"]
        assert batch.shape == (1, 3, 1008, 1008)
        _PixAIV1Session.batches.append(batch.shape[0])
        logits = np.full((1, 10), -8.0, dtype=np.float32)
        logits[0, 0] = 3.0  # 1girl
        logits[0, 2] = 0.0  # hatsune_miku: p=0.5 > 0.27
        logits[0, 3] = -1.5  # vocaloid: p=0.18 < 0.24
        logits[0, 4] = -1.2  # bkub: p=0.23 > 0.17 (artist)
        logits[0, 7] = 4.0  # rating:g
        return [logits]


class _PixAIV1Ort:
    SessionOptions = _Options
    InferenceSession = _PixAIV1Session

    class ExecutionMode:
        ORT_SEQUENTIAL = "ORT_SEQUENTIAL"

    class GraphOptimizationLevel:
        ORT_ENABLE_ALL = "ORT_ENABLE_ALL"

    @staticmethod
    def get_available_providers():
        return ["CUDAExecutionProvider", "CPUExecutionProvider"]


def test_tagging_uses_logits_thresholds_and_one_image_per_call(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "model.onnx").write_bytes(b"model")
    tags_path = _tags_json(tmp_path / "tags.json")
    monkeypatch.setattr(tagger_module, "ort", _PixAIV1Ort)
    monkeypatch.setattr(tagger_module, "hf_hub", object())
    _PixAIV1Session.batches = []
    paths = []
    for index, size in enumerate([(640, 960), (1200, 800), (1008, 1008)]):
        path = tmp_path / f"{index}.png"
        Image.new("RGB", size, (200, 180, 160)).save(path)
        paths.append(str(path))
    tagger = tagger_module.WD14Tagger(
        model_name=MODEL, threshold=0.17, character_threshold=0.27, use_gpu=True
    )
    monkeypatch.setattr(
        tagger, "_get_model_paths", lambda: ("model.onnx", str(tags_path))
    )

    results = tagger.tag_batch(paths, preferred_batch_size=9, copyright_threshold=0.24)

    assert _PixAIV1Session.batches == [1, 1, 1]
    first = results[0]
    assert [t["tag"] for t in first["general_tags"]] == ["1girl", "bkub"]
    assert first["general_tags"][1]["category"] == "artist"
    assert [t["tag"] for t in first["character_tags"]] == ["hatsune_miku"]
    assert first["copyright_tags"] == []
    assert first["rating"] == "general"


def test_download_fetches_the_external_weights_at_the_pinned_revision(
    monkeypatch, tmp_path
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
    tagger.model_name = MODEL
    tagger.model_dir = str(tmp_path)

    model_path, tags_path = tagger._download_model()

    assert sorted(call["filename"] for call in calls) == [
        "model.onnx",
        "model.onnx.data",
        "tags.json",
    ]
    assert {call["revision"] for call in calls} == {TAGGER_MODELS[MODEL]["revision"]}
    assert Path(model_path).name == "model.onnx" and Path(tags_path).name == "tags.json"


def test_model_center_lists_v1_on_the_wd14_card_and_requires_the_weights_file(
    monkeypatch, tmp_path
):
    import model_health
    from tests.test_model_health_pins import _wire_clean_state

    root = _wire_clean_state(monkeypatch, tmp_path)
    target = root / "get_wd14_model_dir" / MODEL
    target.mkdir(parents=True)
    (target / "model.onnx").write_bytes(b"m")
    (target / "tags.json").write_bytes(b"{}")

    def listed() -> dict:
        return {
            item["name"]: item["available"]
            for item in model_health.get_model_health()["wd14"]["installed_models"]
        }

    assert listed()[MODEL] is False
    (target / "model.onnx.data").write_bytes(b"d")
    assert listed()[MODEL] is True
