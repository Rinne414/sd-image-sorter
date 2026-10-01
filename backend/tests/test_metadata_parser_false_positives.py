"""Metadata false positives: non-ComfyUI JSON and non-prompt text (owner report 2026-10).

Two families, every fixture synthetic:

1. A GIF whose comment is a JSON object with no ComfyUI structure (no
   ``class_type`` nodes, no ``nodes``/``links``) must not be labelled ComfyUI.
   Saved under a ``.jpg`` name, as chat clients do.
2. A ComfyUI graph whose only text never flows into a sampler or conditioning:
   note nodes, device names, text overlays, LLM instructions. None of it is a
   prompt. Text that does flow into a generation step still is.
"""

from __future__ import annotations

import json
from pathlib import Path

from PIL import Image
from PIL.PngImagePlugin import PngInfo

from metadata_parser import MetadataParser, parse_image

NOTE_TEXT = (
    "# Add film grain to a finished picture\n\n"
    "Drag the picture into **LoadImage** and press Run. Compare left and right.\n\n"
    "## Three knobs\n\n- **grain_power** `0.30` - strength, 0.2 is subtle, 0.6 is dirty.\n"
    "- **grain_scale** `0.70` - grain size, larger is coarser.\n"
)
DEVICE_NAME = "0: Example Graphics Adapter 9000 Ti"
OVERLAY_TEXT = "NO.02 · DEPTH 0M · TIDE LINE — ILLUSTRATION @studio"
SYSTEM_PROMPT = (
    "You are an expert cinematic motion prompt writer for animated wallpapers "
    "and image-to-video. Analyze the first frame carefully and write motion."
)
INSTRUCTION_TEXT = (
    "Analyze the image carefully and design subtle, natural, cinematic motion "
    "for a seamless loop with gentle camera drift."
)
# Long comma-free sentences on purpose: a model-written motion prompt that the
# shape heuristics would never score as a tag list.
CACHED_GENERATED_PROMPT = (
    "l1v3w4llp4p3r The silver-haired girl sits serenely on the bench while her scarf "
    "sways in a soft breeze that carries a few petals slowly across the frame; "
    "gentle parallax separates the foreground branches from the distant trees and "
    "the lantern light flickers very slightly without ever changing the composition."
)
MATH_EXPRESSION = "max(5, round(a * 24)) + (5 - (max(5, round(a * 24)) % 17)) % 17"
STYLE_PRESET = "Thin Delicate Outline Romantic Anime-Photographic Hybrid"
KREA_PROMPT = (
    "high quality anime illustration, a girl in a window-side cafe booth, "
    "lowering a teaspoon onto the saucer, afternoon light, 85mm candid framing"
)


def _write_png(tmp_path: Path, name: str, chunks: dict) -> str:
    info = PngInfo()
    for key, value in chunks.items():
        info.add_text(key, value if isinstance(value, str) else json.dumps(value))
    path = tmp_path / name
    Image.new("RGB", (32, 32), color="white").save(path, pnginfo=info)
    return str(path)


def _write_gif(tmp_path: Path, name: str, comment: str) -> str:
    path = tmp_path / name
    Image.new("P", (16, 16), color=0).save(path, "GIF", comment=comment.encode("utf-8"))
    return str(path)


# ---------------------------------------------------------------------------
# 1. GIF comment JSON without ComfyUI structure
# ---------------------------------------------------------------------------


class TestGifCommentJsonIsNotComfyUI:
    def test_vendor_json_comment_in_jpg_named_gif_is_unknown(self, tmp_path: Path):
        comment = json.dumps(
            {"data": {"did": "abc123"}, "source_type": "camera_app_sticker"}
        )
        result = parse_image(_write_gif(tmp_path, "sticker.jpg", comment))

        assert result["generator"] == "unknown"
        assert not result["prompt"]
        assert result["metadata_error"] is None
        # The original comment (and its source_type) stays available on the row.
        assert "camera_app_sticker" in result["metadata"]["Comment"]

    def test_plain_text_comment_that_is_not_a_prompt_stays_unknown(
        self, tmp_path: Path
    ):
        result = parse_image(
            _write_gif(tmp_path, "editor.gif", "Created with an editor")
        )

        assert result["generator"] == "unknown"
        assert not result["prompt"]

    def test_plain_text_prompt_comment_is_still_read(self, tmp_path: Path):
        prompt = "1girl, solo, red scarf, snowy street, lantern light, masterpiece"
        result = parse_image(_write_gif(tmp_path, "prompt.gif", prompt))

        assert result["prompt"] == prompt
        assert result["generator"] == "others"

    def test_comfyui_api_graph_in_gif_comment_is_comfyui(self, tmp_path: Path):
        graph = {
            "1": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": "1girl, red scarf, snowy street"},
            },
            "2": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": "worst quality, low quality, lowres"},
            },
            "3": {
                "class_type": "KSampler",
                "inputs": {
                    "seed": 1,
                    "steps": 20,
                    "positive": ["1", 0],
                    "negative": ["2", 0],
                },
            },
        }
        result = parse_image(_write_gif(tmp_path, "comfy.gif", json.dumps(graph)))

        assert result["generator"] == "comfyui"
        assert result["prompt"] == "1girl, red scarf, snowy street"
        assert result["negative_prompt"] == "worst quality, low quality, lowres"

    def test_comfyui_envelope_in_gif_comment_is_comfyui(self, tmp_path: Path):
        """Video savers wrap both chunks in one JSON object: {"prompt": {...}, "workflow": {...}}."""
        envelope = {
            "prompt": {
                "1": {
                    "class_type": "CLIPTextEncode",
                    "inputs": {"text": "1girl, red scarf, snowy street"},
                },
                "3": {
                    "class_type": "KSampler",
                    "inputs": {"seed": 1, "steps": 20, "positive": ["1", 0]},
                },
            },
            "workflow": {"nodes": [], "links": []},
        }
        result = parse_image(_write_gif(tmp_path, "video.gif", json.dumps(envelope)))

        assert result["generator"] == "comfyui"
        assert result["prompt"] == "1girl, red scarf, snowy street"


# ---------------------------------------------------------------------------
# 2. ComfyUI text that never reaches a sampler
# ---------------------------------------------------------------------------


def _grain_api_graph() -> dict:
    return {
        "1": {
            "class_type": "LoadImage",
            "inputs": {"image": "finished_00084_.png", "upload": "image"},
        },
        "2": {
            "class_type": "LayerFilter: AddGrain",
            "inputs": {"image": ["1", 0], "grain_power": 0.3},
        },
        "4": {
            "class_type": "SaveImage",
            "inputs": {"images": ["2", 0], "filename_prefix": "grain"},
        },
    }


def _grain_ui_workflow(note_text: str) -> dict:
    return {
        "nodes": [
            {
                "id": 6,
                "type": "MarkdownNote",
                "mode": 0,
                "inputs": [],
                "outputs": [],
                "title": "How to use",
                "widgets_values": [note_text],
            },
            {
                "id": 1,
                "type": "LoadImage",
                "mode": 0,
                "inputs": [],
                "outputs": [{"name": "IMAGE", "type": "IMAGE", "links": [9]}],
                "widgets_values": ["finished_00084_.png", "image"],
            },
            {
                "id": 2,
                "type": "LayerFilter: AddGrain",
                "mode": 0,
                "inputs": [{"name": "image", "type": "IMAGE", "link": 9}],
                "outputs": [{"name": "image", "type": "IMAGE", "links": [16]}],
                "widgets_values": [0.3, 0.7, 0.6],
            },
            {
                "id": 4,
                "type": "SaveImage",
                "mode": 0,
                "inputs": [{"name": "images", "type": "IMAGE", "link": 16}],
                "outputs": [],
                "widgets_values": ["grain"],
            },
        ],
        "links": [[9, 1, 0, 2, 0, "IMAGE"], [16, 2, 0, 4, 0, "IMAGE"]],
    }


class TestNoteNodesAreNotPrompts:
    def test_markdown_note_beside_a_post_processing_graph(self, tmp_path: Path):
        result = parse_image(
            _write_png(
                tmp_path,
                "grain.png",
                {
                    "prompt": _grain_api_graph(),
                    "workflow": _grain_ui_workflow(NOTE_TEXT),
                },
            )
        )

        assert result["generator"] == "comfyui"
        assert not result["prompt"], result["prompt"]
        assert not result["negative_prompt"]

    def test_markdown_note_in_a_workflow_only_file(self, tmp_path: Path):
        result = parse_image(
            _write_png(
                tmp_path, "grain_wf.png", {"workflow": _grain_ui_workflow(NOTE_TEXT)}
            )
        )

        assert result["generator"] == "comfyui"
        assert not result["prompt"], result["prompt"]


class TestPipelineSettingsAreNotPrompts:
    def test_device_name_on_an_image_filter_node(self, tmp_path: Path):
        graph = {
            "3": {
                "class_type": "LoadImage",
                "inputs": {"image": "frame_00010_.png", "upload": "image"},
            },
            "9": {
                "class_type": "DepthGuidanceEstimator",
                "inputs": {
                    "image": ["3", 0],
                    "gpu_device": DEVICE_NAME,
                    "depth_strength": 1,
                },
            },
            "10": {
                "class_type": "ImageDirectOutput",
                "inputs": {
                    "image": ["3", 0],
                    "depth": ["9", 0],
                    "gpu_device": DEVICE_NAME,
                },
            },
            "7": {
                "class_type": "SaveImage",
                "inputs": {"images": ["10", 0], "filename_prefix": "out"},
            },
        }
        result = parse_image(_write_png(tmp_path, "device.png", {"prompt": graph}))

        assert result["generator"] == "comfyui"
        assert not result["prompt"], result["prompt"]

    def test_text_overlay_layer_is_not_a_prompt(self, tmp_path: Path):
        graph = {
            "1": {
                "class_type": "LoadImage",
                "inputs": {"image": "base.png", "upload": "image"},
            },
            "12": {
                "class_type": "OverlayText",
                "inputs": {"text": OVERLAY_TEXT, "size": 24},
            },
            "90": {
                "class_type": "LayerComposer",
                "inputs": {"image": ["1", 0], "layers.layer0": ["12", 0]},
            },
            "91": {"class_type": "SaveImage", "inputs": {"images": ["90", 0]}},
        }
        result = parse_image(_write_png(tmp_path, "overlay.png", {"prompt": graph}))

        assert result["generator"] == "comfyui"
        assert not result["prompt"], result["prompt"]


def _llm_video_api_graph() -> dict:
    """LLM writes the motion prompt at run time; its inputs are instructions."""
    return {
        "125": {
            "class_type": "SamplerCustomAdvanced",
            "inputs": {
                "noise": ["129", 0],
                "guider": ["126", 0],
                "latent_image": ["136", 1],
            },
        },
        "129": {"class_type": "RandomNoise", "inputs": {"noise_seed": 7}},
        "126": {
            "class_type": "BasicGuider",
            "inputs": {"model": ["620", 0], "conditioning": ["136", 0]},
        },
        "620": {
            "class_type": "UNETLoader",
            "inputs": {"unet_name": "video_model_int8.safetensors"},
        },
        "136": {
            "class_type": "ReferenceToVideo",
            "inputs": {
                "prompt": ["138", 0],
                "ref_image": ["137", 0],
                "clip": ["128", 0],
            },
        },
        "128": {
            "class_type": "CLIPLoader",
            "inputs": {"clip_name": "text_encoder.safetensors"},
        },
        "137": {
            "class_type": "LoadImage",
            "inputs": {"image": "first_frame.png", "upload": "image"},
        },
        "138": {
            "class_type": "PrimitiveStringMultiline",
            "inputs": {"value": ["660", 0]},
        },
        "660": {"class_type": "PreviewAny", "inputs": {"source": ["658", 0]}},
        "658": {
            "class_type": "llama_cpp_instruct_adv",
            "inputs": {
                "llama_model": ["657", 0],
                "images": ["137", 0],
                "custom_prompt": ["661", 0],
                "system_prompt": SYSTEM_PROMPT,
            },
        },
        "657": {
            "class_type": "llama_cpp_model_loader",
            "inputs": {"model": "small-instruct-q8_0.gguf"},
        },
        "661": {"class_type": "JjkText", "inputs": {"text": INSTRUCTION_TEXT}},
    }


def _llm_video_ui_workflow(cached_prompt: str) -> dict:
    """UI twin of the API graph; node 138 keeps the last generated value as its widget."""
    return {
        "nodes": [
            {
                "id": 125,
                "type": "SamplerCustomAdvanced",
                "mode": 0,
                "inputs": [
                    {"name": "noise", "type": "NOISE", "link": 1},
                    {"name": "guider", "type": "GUIDER", "link": 2},
                    {"name": "latent_image", "type": "LATENT", "link": 3},
                ],
                "outputs": [{"name": "output", "type": "LATENT", "links": None}],
            },
            {
                "id": 129,
                "type": "RandomNoise",
                "mode": 0,
                "inputs": [],
                "outputs": [{"name": "NOISE", "type": "NOISE", "links": [1]}],
                "widgets_values": [7, "fixed"],
            },
            {
                "id": 126,
                "type": "BasicGuider",
                "mode": 0,
                "inputs": [
                    {"name": "model", "type": "MODEL", "link": 4},
                    {"name": "conditioning", "type": "CONDITIONING", "link": 5},
                ],
                "outputs": [{"name": "GUIDER", "type": "GUIDER", "links": [2]}],
            },
            {
                "id": 620,
                "type": "UNETLoader",
                "mode": 0,
                "inputs": [],
                "outputs": [{"name": "MODEL", "type": "MODEL", "links": [4]}],
                "widgets_values": ["video_model_int8.safetensors", "default"],
            },
            {
                "id": 136,
                "type": "ReferenceToVideo",
                "mode": 0,
                "inputs": [
                    {"name": "clip", "type": "CLIP", "link": 6},
                    {"name": "ref_image", "type": "IMAGE", "link": 7},
                    {
                        "name": "prompt",
                        "type": "STRING",
                        "link": 8,
                        "widget": {"name": "prompt"},
                    },
                ],
                "outputs": [
                    {"name": "CONDITIONING", "type": "CONDITIONING", "links": [5]},
                    {"name": "LATENT", "type": "LATENT", "links": [3]},
                ],
                "widgets_values": [""],
            },
            {
                "id": 128,
                "type": "CLIPLoader",
                "mode": 0,
                "inputs": [],
                "outputs": [{"name": "CLIP", "type": "CLIP", "links": [6]}],
                "widgets_values": ["text_encoder.safetensors"],
            },
            {
                "id": 137,
                "type": "LoadImage",
                "mode": 0,
                "inputs": [],
                "outputs": [{"name": "IMAGE", "type": "IMAGE", "links": [7, 9]}],
                "widgets_values": ["first_frame.png", "image"],
            },
            {
                "id": 138,
                "type": "PrimitiveStringMultiline",
                "mode": 0,
                "inputs": [
                    {
                        "name": "value",
                        "type": "STRING",
                        "link": 10,
                        "widget": {"name": "value"},
                    }
                ],
                "outputs": [{"name": "STRING", "type": "STRING", "links": [8]}],
                "widgets_values": [cached_prompt],
            },
            {
                "id": 660,
                "type": "PreviewAny",
                "mode": 0,
                "inputs": [{"name": "source", "type": "*", "link": 11}],
                "outputs": [{"name": "STRING", "type": "STRING", "links": [10]}],
            },
            {
                "id": 658,
                "type": "llama_cpp_instruct_adv",
                "mode": 0,
                "inputs": [
                    {"name": "llama_model", "type": "LLAMA", "link": 12},
                    {"name": "images", "type": "IMAGE", "link": 9},
                    {
                        "name": "custom_prompt",
                        "type": "STRING",
                        "link": 13,
                        "widget": {"name": "custom_prompt"},
                    },
                    {
                        "name": "system_prompt",
                        "type": "STRING",
                        "link": None,
                        "widget": {"name": "system_prompt"},
                    },
                ],
                "outputs": [{"name": "STRING", "type": "STRING", "links": [11]}],
                "widgets_values": ["", SYSTEM_PROMPT],
            },
            {
                "id": 657,
                "type": "llama_cpp_model_loader",
                "mode": 0,
                "inputs": [],
                "outputs": [{"name": "LLAMA", "type": "LLAMA", "links": [12]}],
                "widgets_values": ["small-instruct-q8_0.gguf"],
            },
            {
                "id": 661,
                "type": "JjkText",
                "mode": 0,
                "inputs": [
                    {
                        "name": "text",
                        "type": "STRING",
                        "link": None,
                        "widget": {"name": "text"},
                    }
                ],
                "outputs": [{"name": "STRING", "type": "STRING", "links": [13]}],
                "widgets_values": [INSTRUCTION_TEXT],
            },
        ],
        "links": [
            [1, 129, 0, 125, 0, "NOISE"],
            [2, 126, 0, 125, 1, "GUIDER"],
            [3, 136, 1, 125, 2, "LATENT"],
            [4, 620, 0, 126, 0, "MODEL"],
            [5, 136, 0, 126, 1, "CONDITIONING"],
            [6, 128, 0, 136, 0, "CLIP"],
            [7, 137, 0, 136, 1, "IMAGE"],
            [8, 138, 0, 136, 2, "STRING"],
            [9, 137, 0, 658, 1, "IMAGE"],
            [10, 660, 0, 138, 0, "STRING"],
            [11, 658, 0, 660, 0, "*"],
            [12, 657, 0, 658, 0, "LLAMA"],
            [13, 661, 0, 658, 2, "STRING"],
        ],
    }


class TestLlmInstructionsAreNotPrompts:
    def test_api_graph_alone_yields_no_prompt(self, tmp_path: Path):
        result = parse_image(
            _write_png(tmp_path, "llm_api.png", {"prompt": _llm_video_api_graph()})
        )

        assert result["generator"] == "comfyui"
        prompt = result["prompt"] or ""
        assert "expert cinematic motion prompt writer" not in prompt
        assert "Analyze the image carefully" not in prompt
        assert not prompt, prompt

    def test_stale_widget_value_on_the_conditioning_path_is_not_adopted(
        self, tmp_path: Path
    ):
        """A linked input keeps the value typed before it was wired; the upstream
        result is never written back, so that widget is not the executed prompt."""
        result = parse_image(
            _write_png(
                tmp_path,
                "llm_both.png",
                {
                    "prompt": _llm_video_api_graph(),
                    "workflow": _llm_video_ui_workflow(CACHED_GENERATED_PROMPT),
                },
            )
        )

        assert result["generator"] == "comfyui"
        assert not result["prompt"], result["prompt"]

    def test_instruct_node_text_inputs_are_never_traced(self):
        parser = MetadataParser()
        nodes = _llm_video_api_graph()
        traced = parser._trace_to_text(["658", 0], nodes, set())
        assert traced == []

    def test_encoder_with_a_system_prompt_still_yields_its_user_prompt(
        self, tmp_path: Path
    ):
        """A text ENCODER that takes a system prompt (NewBie, LLM-adapter encoders)
        is not an instruct model: its output is conditioning, so its user prompt
        is the prompt and only the system prompt is ignored."""
        user_prompt = (
            "1girl, silver hair, red scarf, snowy street, lantern light, masterpiece"
        )
        graph = {
            "26": {
                "class_type": "DiffusionModelLoaderKJ",
                "inputs": {"model_name": "dit.safetensors"},
            },
            "52": {
                "class_type": "NewBieCLIPLoader",
                "inputs": {"gemma_model_path": "gemma-3-4b-it"},
            },
            "28": {
                "class_type": "NewBieCLIPTextEncode",
                "inputs": {
                    "clip": ["52", 0],
                    "user_prompt": user_prompt,
                    "system_prompt": SYSTEM_PROMPT,
                },
            },
            "29": {
                "class_type": "NewBieCLIPTextEncode",
                "inputs": {
                    "clip": ["52", 0],
                    "user_prompt": "worst quality, lowres, bad anatomy, blurry",
                    "system_prompt": SYSTEM_PROMPT,
                },
            },
            "3": {
                "class_type": "KSampler",
                "inputs": {
                    "seed": 1,
                    "steps": 20,
                    "model": ["26", 0],
                    "positive": ["28", 0],
                    "negative": ["29", 0],
                },
            },
        }
        result = parse_image(_write_png(tmp_path, "newbie.png", {"prompt": graph}))

        assert result["prompt"] == user_prompt
        assert "expert cinematic" not in (result["prompt"] or "")
        assert result["negative_prompt"] == "worst quality, lowres, bad anatomy, blurry"

    def test_llm_adapter_encoder_text_is_the_prompt(self):
        """System-prompt node consumed as conditioning (through an adapter) is an encoder."""
        parser = MetadataParser()
        nodes = {
            "390": {
                "class_type": "LLMTextEncoder",
                "inputs": {
                    "text": "masterpiece, best quality, a chicken playing basketball",
                    "system_prompt": SYSTEM_PROMPT,
                    "model": ["389", 0],
                },
            },
            "389": {
                "class_type": "LLMGGUFModelLoader",
                "inputs": {"model_name": "gemma.gguf"},
            },
            "393": {
                "class_type": "ApplyLLMToSDXLAdapter",
                "inputs": {"llm_hidden_states": ["390", 0]},
            },
            "261": {
                "class_type": "KSampler",
                "inputs": {"positive": ["393", 0], "model": ["4", 0]},
            },
        }
        assert parser._is_comfyui_instruct_node(nodes["390"], nodes, "390") is False
        pos, _neg = parser._trace_sampler_prompts(nodes)
        assert pos == "masterpiece, best quality, a chicken playing basketball"

    def test_math_expression_on_the_path_is_not_a_prompt(self, tmp_path: Path):
        """A formula upstream of the sampler is a setting, whatever its word count."""
        graph = _llm_video_api_graph()
        graph["131"] = {
            "class_type": "ComfyMathExpression",
            "inputs": {"expression": MATH_EXPRESSION, "a": 5},
        }
        graph["136"]["inputs"]["length"] = ["131", 0]
        result = parse_image(_write_png(tmp_path, "llm_math.png", {"prompt": graph}))

        assert not result["prompt"], result["prompt"]


def _krea_api_graph(prompt_text: str) -> dict:
    return {
        "1": {
            "class_type": "UNETLoader",
            "inputs": {"unet_name": "krea_turbo_int8.safetensors"},
        },
        "2": {
            "class_type": "CLIPLoader",
            "inputs": {"clip_name": "qwen_vl_4b.safetensors", "type": "krea"},
        },
        "3": {
            "class_type": "VAELoader",
            "inputs": {"vae_name": "image_vae.safetensors"},
        },
        "4": {
            "class_type": "LazyLoraStack",
            "inputs": {"模型": ["1", 0], "LoRA_1": "none", "强度_1": 1.0},
        },
        "5": {
            "class_type": "LazyWorkbench",
            "inputs": {
                "风格库": "anime_styles",
                "风格": STYLE_PRESET,
                "图片数据": json.dumps(
                    [{"image": "reference.png", "mask": "", "type": "input"}]
                ),
                "提示词数据": json.dumps([{"text": prompt_text}]),
            },
        },
        "6": {
            "class_type": "LazyGenerate",
            "inputs": {
                "种子": 2232251899,
                "步数": 20,
                "CFG": 1.0,
                "采样器": "euler",
                "调度器": "simple",
                "宽度": 720,
                "高度": 1280,
                "模型": ["4", 0],
                "文本编码": ["2", 0],
                "VAE": ["3", 0],
                "Krea包": ["5", 0],
            },
        },
        "7": {
            "class_type": "SaveImage",
            "inputs": {"images": ["6", 0], "filename_prefix": "z"},
        },
    }


def _krea_ui_workflow(prompt_text: str) -> dict:
    return {
        "nodes": [
            {
                "id": 1,
                "type": "UNETLoader",
                "mode": 0,
                "inputs": [],
                "outputs": [{"name": "MODEL", "type": "MODEL", "links": [1]}],
                "widgets_values": ["krea_turbo_int8.safetensors", "default"],
            },
            {
                "id": 2,
                "type": "CLIPLoader",
                "mode": 0,
                "inputs": [],
                "outputs": [{"name": "CLIP", "type": "CLIP", "links": [4]}],
                "widgets_values": ["qwen_vl_4b.safetensors", "krea", "default"],
            },
            {
                "id": 3,
                "type": "VAELoader",
                "mode": 0,
                "inputs": [],
                "outputs": [{"name": "VAE", "type": "VAE", "links": [5]}],
                "widgets_values": ["image_vae.safetensors"],
            },
            {
                "id": 4,
                "type": "LazyLoraStack",
                "mode": 0,
                "inputs": [{"name": "模型", "type": "MODEL", "link": 1}],
                "outputs": [{"name": "模型", "type": "MODEL", "links": [2]}],
                "widgets_values": [1, True, "none", 1.0],
            },
            {
                "id": 5,
                "type": "LazyWorkbench",
                "mode": 0,
                "inputs": [
                    {"name": "图像1", "type": "IMAGE", "link": None},
                    {"name": "提示词", "type": "STRING", "link": None},
                ],
                "outputs": [
                    {"name": "Krea包", "type": "KREA_PACK", "links": [3]},
                    {"name": "正向提示", "type": "STRING", "links": None},
                ],
                "widgets_values": [
                    "anime_styles",
                    STYLE_PRESET,
                    json.dumps(
                        [{"image": "reference.png", "mask": "", "type": "input"}]
                    ),
                    json.dumps([{"text": prompt_text}]),
                    "",
                ],
            },
            {
                "id": 6,
                "type": "LazyGenerate",
                "mode": 0,
                "inputs": [
                    {"name": "模型", "type": "MODEL", "link": 2},
                    {"name": "文本编码", "type": "CLIP", "link": 4},
                    {"name": "VAE", "type": "VAE", "link": 5},
                    {"name": "Krea包", "type": "KREA_PACK", "link": 3},
                ],
                "outputs": [{"name": "图像", "type": "IMAGE", "links": [6]}],
                "widgets_values": [2232251899, 20, 1, "euler", "simple", 720, 1280],
            },
            {
                "id": 7,
                "type": "SaveImage",
                "mode": 0,
                "inputs": [{"name": "images", "type": "IMAGE", "link": 6}],
                "outputs": [],
                "widgets_values": ["z"],
            },
            {
                "id": 8,
                "type": "Note",
                "mode": 0,
                "inputs": [],
                "outputs": [],
                "widgets_values": [""],
            },
        ],
        "links": [
            [1, 1, 0, 4, 0, "MODEL"],
            [2, 4, 0, 6, 0, "MODEL"],
            [3, 5, 0, 6, 3, "KREA_PACK"],
            [4, 2, 0, 6, 1, "CLIP"],
            [5, 3, 0, 6, 2, "VAE"],
            [6, 6, 0, 7, 0, "IMAGE"],
        ],
    }


class TestAllInOneGeneratorPromptPayload:
    """A generator node with no KSampler: the prompt is the text wired into it,
    not the style preset name sitting next to it."""

    def test_api_graph_reads_the_wired_prompt_payload(self, tmp_path: Path):
        result = parse_image(
            _write_png(
                tmp_path, "krea_api.png", {"prompt": _krea_api_graph(KREA_PROMPT)}
            )
        )

        assert result["generator"] == "comfyui"
        assert result["prompt"] == KREA_PROMPT
        assert result["checkpoint"] == "krea_turbo_int8.safetensors"

    def test_api_plus_ui_graph_reads_the_wired_prompt_payload(self, tmp_path: Path):
        result = parse_image(
            _write_png(
                tmp_path,
                "krea_both.png",
                {
                    "prompt": _krea_api_graph(KREA_PROMPT),
                    "workflow": _krea_ui_workflow(KREA_PROMPT),
                },
            )
        )

        assert result["prompt"] == KREA_PROMPT
        assert STYLE_PRESET not in (result["prompt"] or "")


EDIT_PROMPT = (
    "The girls in the first image standing and looking at the whale in the second "
    "image, soft morning light, wide shot"
)
TEMPLATE_PREFIX = (
    "You are an assistant designed to generate anime images based on textual prompts. "
    "<Prompt Start>"
)
GENERATED_TAIL = (
    "Cyberpunk anime illustration, album cover design aesthetic, neon rain, masterwork"
)


class TestGeneratorsWithoutASampler:
    def test_cloud_image_node_prompt_is_read(self, tmp_path: Path):
        """A node that takes a ``prompt`` and emits an image IS the generation step."""
        graph = {
            "60": {
                "class_type": "LoadImage",
                "inputs": {"image": "reference.png", "upload": "image"},
            },
            "41": {
                "class_type": "CloudImageAIO",
                "inputs": {
                    "image_1": ["60", 0],
                    "model_name": "cloud-image-preview",
                    "prompt": EDIT_PROMPT,
                },
            },
            "30": {
                "class_type": "SaveImage",
                "inputs": {"images": ["41", 0], "filename_prefix": "out"},
            },
            "4": {"class_type": "PreviewAny", "inputs": {"source": ["41", 0]}},
        }
        result = parse_image(_write_png(tmp_path, "cloud.png", {"prompt": graph}))

        assert result["generator"] == "comfyui"
        assert result["prompt"] == EDIT_PROMPT

    def test_template_prefix_concatenated_with_llm_output_reads_the_executed_prompt(
        self, tmp_path: Path
    ):
        """Template text (``Text`` key) + LLM output are concatenated into the encoder;
        the display node holds the executed whole, which is the completed form."""
        full = f"{TEMPLATE_PREFIX} {GENERATED_TAIL}"
        graph = {
            "72": {"class_type": "DF_Text_Box", "inputs": {"Text": TEMPLATE_PREFIX}},
            "135": {
                "class_type": "GeminiChat",
                "inputs": {
                    "user_prompt": "draw something unusual",
                    "system_prompt": SYSTEM_PROMPT,
                },
            },
            "74": {"class_type": "DF_Text_Box", "inputs": {"Text": ["135", 0]}},
            "86": {
                "class_type": "easy promptConcat",
                "inputs": {"prompt1": ["72", 0], "prompt2": ["74", 0]},
            },
            "92": {
                "class_type": "easy showAnything",
                "inputs": {"anything": ["86", 0], "text": full},
            },
            "76": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": ["86", 0], "clip": ["8", 0]},
            },
            "77": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": "worst quality, lowres, blurry", "clip": ["8", 0]},
            },
            "8": {
                "class_type": "CLIPLoader",
                "inputs": {"clip_name": "encoder.safetensors"},
            },
            "132": {
                "class_type": "KSampler",
                "inputs": {
                    "seed": 1,
                    "steps": 20,
                    "positive": ["76", 0],
                    "negative": ["77", 0],
                },
            },
        }
        result = parse_image(_write_png(tmp_path, "template.png", {"prompt": graph}))

        assert result["prompt"] == full
        assert "draw something unusual" not in (result["prompt"] or "")


class TestJsonPromptPayloads:
    def test_ui_token_state_does_not_outrank_the_rendered_prompt(self):
        """A prompt UI's token list ([{"id": ..., "text": "1girl"}, ...]) is UI state
        rendered as the plain ``positive`` string beside it; neither one tag nor the
        re-joined list may replace that rendered prompt."""
        from prompt_text_scorer import harvest_prompt_candidates, pick_positive_negative

        full = "1girl, solo, silver hair, braid, hair between eyes, red scarf, snowy street, lantern light"
        # The token state carries one tag the rendered text does not.
        tokens = json.dumps(
            [
                {"id": f"token_{i}", "text": tag}
                for i, tag in enumerate(full.split(", ") + ["narrow waist"])
            ]
        )
        nodes = {
            "667": {
                "class_type": "WeiLinPromptUI",
                "inputs": {"positive": full, "temp_str": tokens},
            },
        }
        pos, _neg = pick_positive_negative(
            harvest_prompt_candidates(nodes, ("CLIPTextEncode",))
        )
        assert pos == full


class TestPromptEligibility:
    """The graph rule behind the cases above, on the API node map directly."""

    def test_upstream_of_sampler_minus_instruct_inputs(self):
        parser = MetadataParser()
        nodes = _llm_video_api_graph()
        eligible, skipped = parser._comfyui_prompt_eligible_nodes(nodes)
        assert "138" in eligible and "136" in eligible
        assert "658" in skipped
        # Nothing behind the LLM's instruction inputs is reachable.
        assert "661" not in eligible and "657" not in eligible

    def test_graph_without_generation_step_keeps_only_standalone_text(self):
        parser = MetadataParser()
        nodes = {
            "1": {"class_type": "LoadImage", "inputs": {"image": "base.png"}},
            "12": {"class_type": "OverlayText", "inputs": {"text": OVERLAY_TEXT}},
            "90": {
                "class_type": "LayerComposer",
                "inputs": {"image": ["1", 0], "layer": ["12", 0]},
            },
            "99": {
                "class_type": "XyzUnknownBox",
                "inputs": {"text": "1girl, red scarf, snowy street"},
            },
        }
        eligible, _skipped = parser._comfyui_prompt_eligible_nodes(nodes)
        assert eligible == {"99"}
