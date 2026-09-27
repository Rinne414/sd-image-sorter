"""Reader save keeps the image's own metadata format (V3.5 issue #20).

A NovelAI PNG edited in the Reader used to gain an A1111 ``parameters`` block
next to its ``Comment`` record. The app's parser reads ``parameters`` first,
so the saved image came back as a WebUI image. An A1111 image lost every
setting the editor does not show (Clip skip, Lora hashes, extension keys).

Now a NovelAI record takes the edit itself, and an A1111 block keeps the
settings the editor does not show, verbatim. ComfyUI graphs keep the existing
hybrid (graph plus an executed-parameters block) and still read as ComfyUI.
"""

from __future__ import annotations

import json
from pathlib import Path

from PIL import Image
from PIL.PngImagePlugin import PngInfo

import metadata_parser

NAI_V4_COMMENT = {
    "prompt": "ORIGINAL nai positive",
    "uc": "ORIGINAL nai negative",
    "steps": 28,
    "sampler": "k_euler_ancestral",
    "seed": 111222333,
    "scale": 5.0,
    "width": 832,
    "height": 1216,
    "noise_schedule": "karras",
    "v4_prompt": {
        "caption": {
            "base_caption": "ORIGINAL nai positive",
            "char_captions": [
                {"char_caption": "1girl, red hair", "centers": [{"x": 0.5, "y": 0.5}]}
            ],
        },
        "use_coords": False,
    },
    "v4_negative_prompt": {
        "caption": {"base_caption": "ORIGINAL nai negative", "char_captions": []}
    },
}
NAI_CHUNKS = {
    "Title": "NovelAI generated image",
    "Description": "ORIGINAL nai positive",
    "Software": "NovelAI",
    "Source": "NovelAI Diffusion V4.5 4BDE2A90",
    "Comment": json.dumps(NAI_V4_COMMENT),
}
RICH_WEBUI_PARAMETERS = (
    "a prompt\nNegative prompt: a negative\n"
    "Steps: 20, Sampler: Euler a, Schedule type: Karras, CFG scale: 7, Seed: 42, Size: 32x32, "
    'Model hash: abc123, Model: anima_v3, Clip skip: 2, Lora hashes: "detail: 1a2b, style: 3c4d", '
    "ADetailer model: face_yolov8n.pt, Version: v1.10.1"
)
COMFY_API_GRAPH = {
    "3": {
        "class_type": "KSampler",
        "inputs": {
            "seed": 42,
            "steps": 20,
            "cfg": 7.0,
            "positive": ["6", 0],
            "negative": ["7", 0],
        },
    },
    "4": {
        "class_type": "CheckpointLoaderSimple",
        "inputs": {"ckpt_name": "anima_v3.safetensors"},
    },
    "6": {
        "class_type": "CLIPTextEncode",
        "inputs": {"text": "ORIGINAL comfy positive"},
    },
    "7": {
        "class_type": "CLIPTextEncode",
        "inputs": {"text": "ORIGINAL comfy negative"},
    },
}


def _write_png(path: Path, chunks: dict[str, str]) -> Path:
    info = PngInfo()
    for key, value in chunks.items():
        info.add_text(key, value)
    Image.new("RGB", (32, 32), (10, 20, 30)).save(path, pnginfo=info)
    return path


def _text_chunks(path: Path) -> dict[str, str]:
    with Image.open(path) as image:
        return {
            key: value for key, value in image.info.items() if isinstance(value, str)
        }


def _save(test_client, source: Path, output: Path, metadata: dict) -> dict:
    response = test_client.post(
        "/api/image-metadata/save-edited",
        json={
            "source_path": str(source),
            "output_path": str(output),
            "format": "png",
            "metadata": metadata,
            "allow_overwrite": False,
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def _nai_edit(**overrides) -> dict:
    edit = {
        "prompt": "EDITED nai positive",
        "negative_prompt": "EDITED nai negative",
        "steps": 30,
        "seed": "777",
        "sampler": "k_dpmpp_2m",
        "cfg_scale": 6.5,
        "size": "896x1152",
        "model": "NovelAI Diffusion V4.5 4BDE2A90",
    }
    edit.update(overrides)
    return edit


class TestNovelAIRecordTakesTheEdit:
    def test_saved_novelai_png_reads_back_as_novelai_with_the_edit(
        self, test_client, tmp_path
    ):
        source = _write_png(tmp_path / "nai.png", NAI_CHUNKS)
        output = tmp_path / "nai-edited.png"

        _save(test_client, source, output, _nai_edit())

        parsed = metadata_parser.parse_image(str(output))
        assert parsed["generator"] == "nai"
        assert parsed["prompt"] == "EDITED nai positive"
        assert parsed["negative_prompt"] == "EDITED nai negative"
        assert parsed["checkpoint"] == "NovelAI Diffusion V4.5 4BDE2A90"

    def test_no_other_format_is_mixed_in(self, test_client, tmp_path):
        source = _write_png(tmp_path / "nai.png", NAI_CHUNKS)
        output = tmp_path / "nai-edited.png"

        _save(test_client, source, output, _nai_edit())

        chunks = _text_chunks(output)
        assert "parameters" not in chunks
        # no loose per-field chunks either: the record holds the edit
        for loose in (
            "prompt",
            "negative_prompt",
            "steps",
            "seed",
            "sampler",
            "cfg_scale",
            "size",
            "model",
        ):
            assert loose not in chunks, loose
        assert chunks["Software"] == "NovelAI"
        assert chunks["Title"] == "NovelAI generated image"
        assert chunks["Source"] == "NovelAI Diffusion V4.5 4BDE2A90"
        assert chunks["Description"] == "EDITED nai positive"

    def test_the_record_holds_every_edited_field_and_keeps_the_rest(
        self, test_client, tmp_path
    ):
        source = _write_png(tmp_path / "nai.png", NAI_CHUNKS)
        output = tmp_path / "nai-edited.png"

        result = _save(test_client, source, output, _nai_edit())

        record = json.loads(_text_chunks(output)["Comment"])
        assert record["prompt"] == "EDITED nai positive"
        assert record["uc"] == "EDITED nai negative"
        assert record["v4_prompt"]["caption"]["base_caption"] == "EDITED nai positive"
        assert (
            record["v4_negative_prompt"]["caption"]["base_caption"]
            == "EDITED nai negative"
        )
        assert record["steps"] == 30
        assert record["seed"] == 777
        assert record["sampler"] == "k_dpmpp_2m"
        assert record["scale"] == 6.5
        assert (record["width"], record["height"]) == (896, 1152)
        # untouched parts of the record stay as they were
        assert record["noise_schedule"] == "karras"
        assert (
            record["v4_prompt"]["caption"]["char_captions"]
            == NAI_V4_COMMENT["v4_prompt"]["caption"]["char_captions"]
        )
        assert result["warnings"] == []

    def test_a_changed_model_goes_to_the_source_chunk(self, test_client, tmp_path):
        source = _write_png(tmp_path / "nai.png", NAI_CHUNKS)
        output = tmp_path / "nai-edited.png"

        _save(
            test_client, source, output, _nai_edit(model="NovelAI Diffusion V4 Curated")
        )

        assert _text_chunks(output)["Source"] == "NovelAI Diffusion V4 Curated"

    def test_loras_have_no_place_in_a_novelai_record_and_say_so(
        self, test_client, tmp_path
    ):
        source = _write_png(tmp_path / "nai.png", NAI_CHUNKS)
        output = tmp_path / "nai-edited.png"

        result = _save(test_client, source, output, _nai_edit(loras="detail_lora:0.8"))

        warnings = " ".join(result["warnings"])
        assert "LoRAs" in warnings
        assert "detail_lora" not in json.dumps(_text_chunks(output))


class TestA1111KeepsTheSettingsTheEditorDoesNotShow:
    def _edit(self, **overrides) -> dict:
        edit = {
            "prompt": "EDITED prompt",
            "negative_prompt": "a negative",
            "steps": 25,
            "sampler": "Euler a",
            "cfg_scale": 7,
            "seed": "43",
            "size": "32x32",
            "model": "anima_v3",
        }
        edit.update(overrides)
        return edit

    def test_unshown_settings_are_kept_verbatim(self, test_client, tmp_path):
        source = _write_png(
            tmp_path / "webui.png", {"parameters": RICH_WEBUI_PARAMETERS}
        )
        output = tmp_path / "webui-edited.png"

        result = _save(test_client, source, output, self._edit())

        settings = _text_chunks(output)["parameters"].splitlines()[-1]
        for kept in (
            "Schedule type: Karras",
            "Model hash: abc123",
            "Clip skip: 2",
            'Lora hashes: "detail: 1a2b, style: 3c4d"',
            "ADetailer model: face_yolov8n.pt",
            "Version: v1.10.1",
        ):
            assert kept in settings, kept
        assert "Steps: 25" in settings and "Seed: 43" in settings
        assert result["warnings"] == []

        parsed = metadata_parser.parse_image(str(output))
        assert parsed["prompt"] == "EDITED prompt"
        assert parsed["generator"] in {"webui", "forge"}

    def test_a_changed_model_drops_its_stale_hash_and_says_so(
        self, test_client, tmp_path
    ):
        source = _write_png(
            tmp_path / "webui.png", {"parameters": RICH_WEBUI_PARAMETERS}
        )
        output = tmp_path / "webui-edited.png"

        result = _save(test_client, source, output, self._edit(model="other_model"))

        settings = _text_chunks(output)["parameters"].splitlines()[-1]
        assert "Model hash" not in settings
        assert "Model: other_model" in settings
        assert "Clip skip: 2" in settings
        assert "Model hash" in " ".join(result["warnings"])

    def test_a_field_the_editor_shows_and_the_user_cleared_is_not_brought_back(
        self, test_client, tmp_path
    ):
        source = _write_png(
            tmp_path / "webui.png", {"parameters": RICH_WEBUI_PARAMETERS}
        )
        output = tmp_path / "webui-edited.png"
        edit = self._edit()
        del edit["seed"]

        _save(test_client, source, output, edit)

        assert "Seed:" not in _text_chunks(output)["parameters"]


def test_comfyui_png_still_reads_back_as_comfyui_with_the_edit(test_client, tmp_path):
    source = _write_png(tmp_path / "comfy.png", {"prompt": json.dumps(COMFY_API_GRAPH)})
    output = tmp_path / "comfy-edited.png"

    _save(
        test_client,
        source,
        output,
        {"prompt": "EDITED comfy", "steps": 20, "sampler": "Euler a"},
    )

    parsed = metadata_parser.parse_image(str(output))
    assert parsed["generator"] == "comfyui"
    assert parsed["prompt"] == "EDITED comfy"
    assert json.loads(_text_chunks(output)["prompt"]) == COMFY_API_GRAPH
