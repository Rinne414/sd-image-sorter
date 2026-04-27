"""
Tests for metadata parser.

Tests metadata extraction for all supported generators:
- ComfyUI (JSON workflow)
- NovelAI (Comment JSON, UserComment)
- WebUI/A1111 (parameters text chunk)
- Forge (WebUI variant)

Priority: HIGH
"""
import os
import sys
import json
import tempfile
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

import metadata_parser as metadata_parser_module
from metadata_parser import MetadataParser, parse_image


def _write_comfyui_prompt_png(tmp_path: Path, filename: str, workflow: dict, color: str = "white") -> Path:
    """Persist a tiny PNG with ComfyUI prompt metadata for parser tests."""
    from PIL import Image
    from PIL.PngImagePlugin import PngInfo

    img_path = tmp_path / filename
    img = Image.new("RGB", (512, 512), color=color)
    metadata = PngInfo()
    metadata.add_text("prompt", json.dumps(workflow))
    img.save(img_path, pnginfo=metadata)
    return img_path


class TestMetadataParserBase:
    """Base tests for MetadataParser."""

    def test_parse_nonexistent_file(self):
        """Parsing nonexistent file should return unknown generator."""
        result = parse_image("/nonexistent/path/file.png")

        assert result["generator"] == "unknown"
        assert result["file_size"] == 0

    def test_parse_returns_required_fields(self, mock_image_file: Path):
        """Parser should return all required fields."""
        result = parse_image(str(mock_image_file))

        assert "generator" in result
        assert "prompt" in result
        assert "negative_prompt" in result
        assert "checkpoint" in result
        assert "loras" in result
        assert "metadata" in result
        assert "width" in result
        assert "height" in result
        assert "file_size" in result

    def test_parse_png_text_metadata_uses_fast_path_without_pillow_open(self, tmp_path: Path, monkeypatch):
        """PNG text metadata should parse without calling Pillow open in the common path."""
        from PIL import Image
        from PIL.PngImagePlugin import PngInfo

        img_path = tmp_path / "fast-path-webui.png"
        metadata = PngInfo()
        metadata.add_text(
            "parameters",
            "masterpiece\nNegative prompt: lowres\nSteps: 20, Sampler: Euler a, CFG scale: 7, Seed: 1, Size: 320x240, Model: demo.safetensors",
        )
        Image.new("RGB", (320, 240), color="white").save(img_path, pnginfo=metadata)

        def fail_open(*args, **kwargs):
            raise AssertionError("PNG fast-path should not call Pillow open")

        monkeypatch.setattr(metadata_parser_module.Image, "open", fail_open)

        result = parse_image(str(img_path))

        assert result["generator"] == "webui"
        assert result["width"] == 320
        assert result["height"] == 240
        assert result["checkpoint"] == "demo.safetensors"

    def test_parse_png_validation_still_runs_verify_open(self, tmp_path: Path, monkeypatch):
        """Scan-time validation should still perform a single verify open after fast metadata parsing."""
        from PIL import Image
        from PIL.PngImagePlugin import PngInfo

        img_path = tmp_path / "validated-fast-path.png"
        metadata = PngInfo()
        metadata.add_text("prompt", json.dumps({"1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "demo.safetensors"}}}))
        Image.new("RGB", (128, 96), color="white").save(img_path, pnginfo=metadata)

        open_calls = {"count": 0}
        original_open = metadata_parser_module.Image.open

        def tracking_open(*args, **kwargs):
            open_calls["count"] += 1
            return original_open(*args, **kwargs)

        monkeypatch.setattr(metadata_parser_module.Image, "open", tracking_open)

        result = parse_image(str(img_path), validate_image_data=True)

        assert result["width"] == 128
        assert result["height"] == 96
        assert open_calls["count"] == 1


class TestComfyUIMetadata:
    """Tests for ComfyUI metadata parsing."""

    def test_parse_comfyui_basic(self, mock_comfyui_image: Path):
        """Basic ComfyUI metadata should be parsed correctly."""
        result = parse_image(str(mock_comfyui_image))

        assert result["generator"] == "comfyui"
        assert "landscape" in result["prompt"].lower()
        assert "ugly" in result["negative_prompt"].lower()
        assert result["checkpoint"] == "sd_xl_base_1.0.safetensors"

    def test_parse_comfyui_dimensions(self, mock_comfyui_image: Path):
        """ComfyUI image dimensions should be extracted."""
        result = parse_image(str(mock_comfyui_image))

        assert result["width"] == 1024
        assert result["height"] == 768

    def test_parse_comfyui_generation_params(self, mock_comfyui_image: Path):
        """ComfyUI generation parameters should be extracted."""
        result = parse_image(str(mock_comfyui_image))

        # Check metadata includes parsed generation params
        assert "_parsed" in result["metadata"]
        gen_params = result["metadata"]["_parsed"].get("generation_params", {})

        # Should have seed, steps, cfg
        if gen_params:
            assert "seed" in gen_params or "steps" in gen_params

    def test_parse_comfyui_with_loras(self, tmp_path: Path):
        """ComfyUI with LoRAs should extract LoRA names."""
        from PIL import Image
        from PIL.PngImagePlugin import PngInfo

        img_path = tmp_path / "comfyui_lora.png"
        img = Image.new("RGB", (512, 512), color="blue")

        workflow = {
            "1": {
                "class_type": "KSampler",
                "inputs": {
                    "seed": 12345,
                    "steps": 20,
                    "cfg": 7.5,
                    "model": ["2", 0],
                    "positive": ["3", 0],
                    "negative": ["4", 0],
                    "latent_image": ["5", 0]
                }
            },
            "2": {
                "class_type": "CheckpointLoaderSimple",
                "inputs": {"ckpt_name": "model.safetensors"}
            },
            "3": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": "test prompt", "clip": ["2", 1]}
            },
            "4": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": "negative", "clip": ["2", 1]}
            },
            "5": {
                "class_type": "EmptyLatentImage",
                "inputs": {"width": 512, "height": 512}
            },
            "6": {
                "class_type": "LoraLoader",
                "inputs": {"lora_name": "style_lora.safetensors", "model": ["2", 0]}
            }
        }

        metadata = PngInfo()
        metadata.add_text("prompt", json.dumps(workflow))
        img.save(img_path, pnginfo=metadata)

        result = parse_image(str(img_path))

        assert result["generator"] == "comfyui"
        # LoRA name may include extension
        loras = result.get("loras", [])
        assert any("style_lora" in lora for lora in loras), f"Expected style_lora in {loras}"

    def test_parse_comfyui_complex_workflow(self, tmp_path: Path):
        """ComfyUI complex workflow with multiple text nodes should be parsed."""
        from PIL import Image
        from PIL.PngImagePlugin import PngInfo

        img_path = tmp_path / "comfyui_complex.png"
        img = Image.new("RGB", (512, 512), color="green")

        # Complex workflow with nested conditioning
        workflow = {
            "1": {
                "class_type": "KSampler",
                "inputs": {
                    "seed": 12345,
                    "steps": 20,
                    "cfg": 7.5,
                    "model": ["2", 0],
                    "positive": ["10", 0],  # ConditioningCombine output
                    "negative": ["4", 0],
                    "latent_image": ["5", 0]
                }
            },
            "2": {
                "class_type": "CheckpointLoaderSimple",
                "inputs": {"ckpt_name": "sd_xl.safetensors"}
            },
            "3": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": "main prompt", "clip": ["2", 1]}
            },
            "4": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": "negative prompt", "clip": ["2", 1]}
            },
            "5": {
                "class_type": "EmptyLatentImage",
                "inputs": {"width": 512, "height": 512}
            },
            "10": {
                "class_type": "ConditioningCombine",
                "inputs": {
                    "conditioning_1": ["3", 0],
                    "conditioning_2": ["11", 0]
                }
            },
            "11": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": "additional prompt", "clip": ["2", 1]}
            }
        }

        metadata = PngInfo()
        metadata.add_text("prompt", json.dumps(workflow))
        img.save(img_path, pnginfo=metadata)

        result = parse_image(str(img_path))

        assert result["generator"] == "comfyui"
        # Should find at least one of the prompts
        assert result["prompt"] is not None

    def test_parse_comfyui_fallback_extracts_checkpoint_from_efficient_loader(self, tmp_path: Path):
        """Generic asset fallback should recover ckpt_name from non-whitelisted loader nodes."""
        from PIL import Image
        from PIL.PngImagePlugin import PngInfo

        img_path = tmp_path / "comfyui_efficient_loader.png"
        img = Image.new("RGB", (512, 512), color="orange")

        workflow = {
            "1": {
                "class_type": "KSampler (Efficient)",
                "inputs": {
                    "seed": 12345,
                    "steps": 20,
                    "cfg": 7.5,
                    "model": ["2", 0],
                    "positive": ["3", 0],
                    "negative": ["4", 0],
                    "latent_image": ["5", 0],
                    "optional_vae": ["2", 4],
                }
            },
            "2": {
                "class_type": "Efficient Loader",
                "inputs": {
                    "ckpt_name": r"Illustrious\merge\real-anime-v3.safetensors",
                    "vae_name": "Baked VAE",
                    "lora_name": "None",
                }
            },
            "3": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": "test prompt", "clip": ["2", 1]}
            },
            "4": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": "negative", "clip": ["2", 1]}
            },
            "5": {
                "class_type": "EmptyLatentImage",
                "inputs": {"width": 512, "height": 512}
            },
        }

        metadata = PngInfo()
        metadata.add_text("prompt", json.dumps(workflow))
        img.save(img_path, pnginfo=metadata)

        result = parse_image(str(img_path))
        model_assets = result["metadata"]["_parsed"].get("model_assets") or {}

        assert result["generator"] == "comfyui"
        assert result["checkpoint"] == r"Illustrious\merge\real-anime-v3.safetensors"
        assert result["loras"] == []
        assert model_assets.get("source") == "activity_subgraph_fallback"
        assert model_assets.get("primary_model_type") == "checkpoint"
        assert model_assets.get("primary_model_name") == r"Illustrious\merge\real-anime-v3.safetensors"

    def test_parse_comfyui_fallback_extracts_lora_from_generic_loader(self, tmp_path: Path):
        """Fallback should recover lora_name even when the node class is unfamiliar."""
        from PIL import Image
        from PIL.PngImagePlugin import PngInfo

        img_path = tmp_path / "comfyui_generic_lora.png"
        img = Image.new("RGB", (512, 512), color="teal")

        workflow = {
            "1": {
                "class_type": "KSampler",
                "inputs": {
                    "seed": 12345,
                    "model": ["2", 0],
                    "positive": ["3", 0],
                    "negative": ["4", 0],
                    "latent_image": ["5", 0]
                }
            },
            "2": {
                "class_type": "TotallyCustomLoaderNode",
                "inputs": {
                    "ckpt_name": "model.safetensors",
                    "lora_name": "style_lora.safetensors",
                    "lora_model_strength": 0.8,
                }
            },
            "3": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": ["6", 0], "clip": ["2", 1]}
            },
            "4": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": "negative", "clip": ["2", 1]}
            },
            "5": {
                "class_type": "EmptyLatentImage",
                "inputs": {"width": 512, "height": 512}
            },
        }

        metadata = PngInfo()
        metadata.add_text("prompt", json.dumps(workflow))
        img.save(img_path, pnginfo=metadata)

        result = parse_image(str(img_path))
        model_assets = result["metadata"]["_parsed"].get("model_assets") or {}

        assert result["checkpoint"] == "model.safetensors"
        assert result["loras"] == ["style_lora.safetensors"]
        assert model_assets.get("loras") == ["style_lora.safetensors"]

    def test_parse_comfyui_fallback_expands_serialized_lora_stack(self, tmp_path: Path):
        """UI-only JSON stacks should resolve to the real LoRA filename, not the raw blob string."""
        from PIL import Image
        from PIL.PngImagePlugin import PngInfo

        img_path = tmp_path / "comfyui_serialized_lora_stack.png"
        img = Image.new("RGB", (512, 512), color="pink")

        workflow = {
            "1": {
                "class_type": "KSampler",
                "inputs": {
                    "seed": 12345,
                    "model": ["2", 0],
                    "positive": ["3", 0],
                    "negative": ["4", 0],
                    "latent_image": ["5", 0]
                }
            },
            "2": {
                "class_type": "Efficient Loader",
                "inputs": {
                    "ckpt_name": "model.safetensors",
                    "lora_name": "None",
                }
            },
            "3": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": ["6", 0], "clip": ["2", 1]}
            },
            "4": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": "negative", "clip": ["2", 1]}
            },
            "5": {
                "class_type": "EmptyLatentImage",
                "inputs": {"width": 512, "height": 512}
            },
            "6": {
                "class_type": "WeiLinPromptUIOnlyLoraStack",
                "inputs": {
                    "text": "prompt",
                    "lora_str": json.dumps([
                        {
                            "name": "display name only",
                            "lora": r"Illustrious\人物\东雪莲\东雪莲-000023.safetensors",
                            "weight": 1,
                        }
                    ]),
                }
            },
        }

        metadata = PngInfo()
        metadata.add_text("prompt", json.dumps(workflow))
        img.save(img_path, pnginfo=metadata)

        result = parse_image(str(img_path))
        model_assets = result["metadata"]["_parsed"].get("model_assets") or {}

        assert result["loras"] == [r"Illustrious\人物\东雪莲\东雪莲-000023.safetensors"]
        assert model_assets.get("loras") == [r"Illustrious\人物\东雪莲\东雪莲-000023.safetensors"]

    def test_parse_comfyui_fallback_uses_unet_when_no_checkpoint_exists(self, tmp_path: Path):
        """Fallback should still surface the active model when only UNet naming is available."""
        from PIL import Image
        from PIL.PngImagePlugin import PngInfo

        img_path = tmp_path / "comfyui_unet_only.png"
        img = Image.new("RGB", (512, 512), color="purple")

        workflow = {
            "1": {
                "class_type": "KSampler",
                "inputs": {
                    "seed": 42,
                    "model": ["2", 0],
                    "positive": ["3", 0],
                    "negative": ["4", 0],
                    "latent_image": ["5", 0]
                }
            },
            "2": {
                "class_type": "Flux Loader Redux",
                "inputs": {
                    "unet_name": "flux_unet_fp8.safetensors",
                }
            },
            "3": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": "prompt", "clip": ["2", 1]}
            },
            "4": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": "negative", "clip": ["2", 1]}
            },
            "5": {
                "class_type": "EmptyLatentImage",
                "inputs": {"width": 512, "height": 512}
            },
        }

        metadata = PngInfo()
        metadata.add_text("prompt", json.dumps(workflow))
        img.save(img_path, pnginfo=metadata)

        result = parse_image(str(img_path))
        model_assets = result["metadata"]["_parsed"].get("model_assets") or {}

        assert result["checkpoint"] == "flux_unet_fp8.safetensors"
        assert model_assets.get("primary_model_type") == "unet"
        assert model_assets.get("primary_model_name") == "flux_unet_fp8.safetensors"

    def test_parse_comfyui_fallback_uses_diffusion_model_when_present(self, tmp_path: Path):
        """Diffusion model loaders should surface as the primary model when no checkpoint exists."""
        workflow = {
            "1": {
                "class_type": "KSampler",
                "inputs": {
                    "seed": 7,
                    "model": ["2", 0],
                    "positive": ["3", 0],
                    "negative": ["4", 0],
                    "latent_image": ["5", 0],
                },
            },
            "2": {
                "class_type": "Flux Custom Loader",
                "inputs": {
                    "diffusion_model": "flux1-dev-fp8.safetensors",
                },
            },
            "3": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": "prompt", "clip": ["2", 1]},
            },
            "4": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": "negative", "clip": ["2", 1]},
            },
            "5": {
                "class_type": "EmptyLatentImage",
                "inputs": {"width": 768, "height": 768},
            },
        }

        img_path = _write_comfyui_prompt_png(
            tmp_path,
            "comfyui_diffusion_model.png",
            workflow,
            color="navy",
        )

        result = parse_image(str(img_path))
        model_assets = result["metadata"]["_parsed"].get("model_assets") or {}

        assert result["checkpoint"] == "flux1-dev-fp8.safetensors"
        assert model_assets.get("primary_model_type") == "diffusion_model"
        assert model_assets.get("primary_model_name") == "flux1-dev-fp8.safetensors"
        assert (model_assets.get("diffusion_model_candidates") or [])[0]["name"] == "flux1-dev-fp8.safetensors"

    def test_parse_comfyui_prefers_explicit_lora_filenames_and_collects_full_graph_yolo_models(self, tmp_path: Path):
        """Detailed asset extraction should keep real LoRA filenames and surface detached YOLO models."""
        workflow = {
            "1": {
                "class_type": "KSampler",
                "inputs": {
                    "seed": 260550204902226,
                    "steps": 30,
                    "cfg": 7.0,
                    "sampler_name": "euler_ancestral",
                    "scheduler": "normal",
                    "model": ["2", 0],
                    "positive": ["3", 0],
                    "negative": ["4", 0],
                    "latent_image": ["5", 0],
                },
            },
            "2": {
                "class_type": "easy comfyLoader",
                "inputs": {
                    "ckpt_name": r"2d\waiNSFWIllustrious_v140.safetensors",
                    "optional_lora_stack": ["10", 0],
                },
            },
            "3": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": "heroine, <lora:through_wall_multiview:0.7>", "clip": ["2", 1]},
            },
            "4": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": "negative", "clip": ["2", 1]},
            },
            "5": {
                "class_type": "EmptyLatentImage",
                "inputs": {"width": 1024, "height": 1536},
            },
            "10": {
                "class_type": "WeiLinPromptUI",
                "inputs": {
                    "positive": "heroine, <lora:through_wall_multiview:0.7>",
                    "lora_str": json.dumps([
                        {
                            "name": r"动作\through_wall_multiview",
                            "lora": r"动作\through_wall_multiview.safetensors",
                        },
                        {
                            "name": r"角色\peiyuhan",
                            "lora": r"角色\peiyuhan.safetensors",
                        },
                    ]),
                },
            },
            "20": {
                "class_type": "UltralyticsDetectorProvider",
                "inputs": {"model_name": "bbox/Eyes.pt"},
            },
            "21": {
                "class_type": "UltralyticsDetectorProvider",
                "inputs": {"model_name": "bbox/PitHandDetailer-v1b-seg.pt"},
            },
        }

        img_path = _write_comfyui_prompt_png(
            tmp_path,
            "comfyui_weilin_yolo.png",
            workflow,
            color="black",
        )

        result = parse_image(str(img_path))
        model_assets = result["metadata"]["_parsed"].get("model_assets") or {}

        assert result["checkpoint"] == r"2d\waiNSFWIllustrious_v140.safetensors"
        assert result["loras"] == [
            r"动作\through_wall_multiview.safetensors",
            r"角色\peiyuhan.safetensors",
        ]
        assert model_assets.get("loras") == result["loras"]
        assert model_assets.get("yolo_models") == [
            "bbox/Eyes.pt",
            "bbox/PitHandDetailer-v1b-seg.pt",
        ]
        global_yolo_candidates = model_assets.get("global_yolo_candidates") or []
        assert {item["name"] for item in global_yolo_candidates} == {
            "bbox/Eyes.pt",
            "bbox/PitHandDetailer-v1b-seg.pt",
        }

    def test_parse_comfyui_multi_lora_loader_ignores_stringified_strength_values(self, tmp_path: Path):
        """Multi-LoRA stacks must not treat weight strings as LoRA names."""
        workflow = {
            "1": {
                "class_type": "KSampler",
                "inputs": {
                    "seed": 1,
                    "model": ["6", 0],
                    "positive": ["3", 0],
                    "negative": ["4", 0],
                    "latent_image": ["5", 0],
                },
            },
            "2": {
                "class_type": "CheckpointLoaderSimple",
                "inputs": {"ckpt_name": "base_model.safetensors"},
            },
            "3": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": "prompt", "clip": ["2", 1]},
            },
            "4": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": "negative", "clip": ["2", 1]},
            },
            "5": {
                "class_type": "EmptyLatentImage",
                "inputs": {"width": 512, "height": 512},
            },
            "6": {
                "class_type": "Power Lora Loader (rgthree)",
                "inputs": {
                    "lora_1_name": "detail_style.safetensors",
                    "lora_1_strength": "0.15",
                    "lora_2_name": "pose_helper.safetensors",
                    "lora_2_strength": "3.00",
                },
            },
        }

        img_path = _write_comfyui_prompt_png(
            tmp_path,
            "comfyui_rgthree_string_weights.png",
            workflow,
            color="silver",
        )

        result = parse_image(str(img_path))

        assert result["loras"] == ["detail_style.safetensors", "pose_helper.safetensors"]

    def test_parse_comfyui_fallback_extracts_inline_loras_from_activity_text(self, tmp_path: Path):
        """Fallback should recover inline <lora:...> tags carried by activity-chain helper nodes."""
        from PIL import Image
        from PIL.PngImagePlugin import PngInfo

        img_path = tmp_path / "comfyui_loratagloader.png"
        img = Image.new("RGB", (512, 512), color="yellow")

        workflow = {
            "10001": {
                "class_type": "ECHOCheckpointLoaderSimple",
                "inputs": {"ckpt_name": "EMS-657705-EMS.safetensors"}
            },
            "10012": {
                "class_type": "LoraTagLoader",
                "inputs": {
                    "clip": ["10001", 1],
                    "model": ["10001", 0],
                    "text": "<lora:EMS-574514-EMS.safetensors:0.600000>, <lora:EMS-862671-EMS.safetensors:0.800000>"
                }
            },
            "10015": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": ["10012", 0], "clip": ["10012", 1]}
            },
            "10016": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": "negative", "clip": ["10012", 1]}
            },
            "10017": {
                "class_type": "KSampler",
                "inputs": {
                    "seed": 1,
                    "model": ["10012", 0],
                    "positive": ["10015", 0],
                    "negative": ["10016", 0],
                    "latent_image": ["10018", 0]
                }
            },
            "10018": {
                "class_type": "EmptyLatentImage",
                "inputs": {"width": 512, "height": 512}
            }
        }

        metadata = PngInfo()
        metadata.add_text("prompt", json.dumps(workflow))
        img.save(img_path, pnginfo=metadata)

        result = parse_image(str(img_path))
        model_assets = result["metadata"]["_parsed"].get("model_assets") or {}

        assert result["checkpoint"] == "EMS-657705-EMS.safetensors"
        assert result["loras"] == ["EMS-574514-EMS.safetensors", "EMS-862671-EMS.safetensors"]
        assert model_assets.get("loras") == ["EMS-574514-EMS.safetensors", "EMS-862671-EMS.safetensors"]

    def test_parse_comfyui_global_candidates_capture_non_active_lora_filename(self, tmp_path: Path):
        """Disconnected nodes with explicit lora_name values should be preserved as global candidates."""
        workflow = {
            "1": {
                "class_type": "KSampler",
                "inputs": {
                    "seed": 123,
                    "model": ["2", 0],
                    "positive": ["3", 0],
                    "negative": ["4", 0],
                    "latent_image": ["5", 0],
                }
            },
            "2": {
                "class_type": "CheckpointLoaderSimple",
                "inputs": {"ckpt_name": "base_model.safetensors"}
            },
            "3": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": "portrait", "clip": ["2", 1]}
            },
            "4": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": "negative", "clip": ["2", 1]}
            },
            "5": {
                "class_type": "EmptyLatentImage",
                "inputs": {"width": 512, "height": 512}
            },
            "90": {
                "class_type": "Lora Loader (LoraManager)",
                "inputs": {
                    "lora_name": r"styles\detached_style.safetensors",
                    "strength_model": 0.8,
                }
            },
        }

        img_path = _write_comfyui_prompt_png(
            tmp_path,
            "comfyui_global_lora_filename.png",
            workflow,
            color="orange",
        )

        result = parse_image(str(img_path))
        model_assets = result["metadata"]["_parsed"].get("model_assets") or {}
        global_candidates = model_assets.get("global_lora_candidates") or []

        assert result["checkpoint"] == "base_model.safetensors"
        assert result["loras"] == []
        assert len(global_candidates) == 1
        assert global_candidates[0]["name"] == r"styles\detached_style.safetensors"
        assert global_candidates[0]["confidence"] == "high"
        assert global_candidates[0]["source_mode"] == "global_candidate_fallback"
        assert global_candidates[0]["match_type"] == "explicit_input"
        assert global_candidates[0]["node_id"] == "90"
        assert global_candidates[0]["input_key"] == "lora_name"

    def test_parse_comfyui_global_candidates_capture_inline_lora_tags_when_not_active(self, tmp_path: Path):
        """Non-active prompt helper nodes should surface inline tags as low-confidence global candidates only."""
        workflow = {
            "1": {
                "class_type": "KSampler",
                "inputs": {
                    "seed": 123,
                    "model": ["2", 0],
                    "positive": ["3", 0],
                    "negative": ["4", 0],
                    "latent_image": ["5", 0],
                }
            },
            "2": {
                "class_type": "CheckpointLoaderSimple",
                "inputs": {"ckpt_name": "base_model.safetensors"}
            },
            "3": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": "portrait", "clip": ["2", 1]}
            },
            "4": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": "negative", "clip": ["2", 1]}
            },
            "5": {
                "class_type": "EmptyLatentImage",
                "inputs": {"width": 512, "height": 512}
            },
            "70": {
                "class_type": "PromptScratchpad",
                "inputs": {
                    "text": "unused helper text <lora:detached_inline:0.75>",
                }
            },
        }

        img_path = _write_comfyui_prompt_png(
            tmp_path,
            "comfyui_global_inline_lora.png",
            workflow,
            color="yellow",
        )

        result = parse_image(str(img_path))
        model_assets = result["metadata"]["_parsed"].get("model_assets") or {}
        global_candidates = model_assets.get("global_lora_candidates") or []

        assert result["loras"] == []
        assert len(global_candidates) == 1
        assert global_candidates[0]["name"] == "detached_inline"
        assert global_candidates[0]["confidence"] == "low"
        assert global_candidates[0]["match_type"] == "inline_lora_tag"
        assert global_candidates[0]["source_mode"] == "global_candidate_fallback"

    def test_parse_comfyui_global_candidates_capture_serialized_lora_json_when_not_active(self, tmp_path: Path):
        """Serialized JSON blobs on disconnected nodes should surface the underlying lora filename."""
        workflow = {
            "1": {
                "class_type": "KSampler",
                "inputs": {
                    "seed": 123,
                    "model": ["2", 0],
                    "positive": ["3", 0],
                    "negative": ["4", 0],
                    "latent_image": ["5", 0],
                }
            },
            "2": {
                "class_type": "CheckpointLoaderSimple",
                "inputs": {"ckpt_name": "base_model.safetensors"}
            },
            "3": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": "portrait", "clip": ["2", 1]}
            },
            "4": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": "negative", "clip": ["2", 1]}
            },
            "5": {
                "class_type": "EmptyLatentImage",
                "inputs": {"width": 512, "height": 512}
            },
            "71": {
                "class_type": "WeiLinPromptUI",
                "inputs": {
                    "temp_payload": json.dumps([
                        {
                            "display_name": "style only",
                            "lora": r"Illustrious\styles\stacked_style.safetensors",
                            "weight": 1.0,
                        }
                    ]),
                }
            },
        }

        img_path = _write_comfyui_prompt_png(
            tmp_path,
            "comfyui_global_serialized_lora.png",
            workflow,
            color="pink",
        )

        result = parse_image(str(img_path))
        model_assets = result["metadata"]["_parsed"].get("model_assets") or {}
        global_candidates = model_assets.get("global_lora_candidates") or []

        assert result["loras"] == []
        assert len(global_candidates) == 1
        assert global_candidates[0]["name"] == r"Illustrious\styles\stacked_style.safetensors"
        assert global_candidates[0]["confidence"] == "high"
        assert global_candidates[0]["match_type"] == "serialized_field"
        assert global_candidates[0]["key_path"].endswith("temp_payload[0].lora")

    def test_parse_comfyui_low_confidence_global_candidates_do_not_pollute_main_loras(self, tmp_path: Path):
        """Low-confidence global hints should remain secondary and never land in the main loras field."""
        workflow = {
            "1": {
                "class_type": "KSampler",
                "inputs": {
                    "seed": 123,
                    "model": ["2", 0],
                    "positive": ["3", 0],
                    "negative": ["4", 0],
                    "latent_image": ["5", 0],
                }
            },
            "2": {
                "class_type": "CheckpointLoaderSimple",
                "inputs": {"ckpt_name": "base_model.safetensors"}
            },
            "3": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": "portrait", "clip": ["2", 1]}
            },
            "4": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": "negative", "clip": ["2", 1]}
            },
            "5": {
                "class_type": "EmptyLatentImage",
                "inputs": {"width": 512, "height": 512}
            },
            "72": {
                "class_type": "PromptScratchpad",
                "inputs": {
                    "temp_blob": json.dumps([
                        {"text": "archived helper <lora:unused_helper:0.9>"}
                    ]),
                }
            },
        }

        img_path = _write_comfyui_prompt_png(
            tmp_path,
            "comfyui_global_low_confidence.png",
            workflow,
            color="teal",
        )

        result = parse_image(str(img_path))
        model_assets = result["metadata"]["_parsed"].get("model_assets") or {}
        global_candidates = model_assets.get("global_lora_candidates") or []

        assert result["loras"] == []
        assert model_assets.get("loras") == []
        assert len(global_candidates) == 1
        assert global_candidates[0]["name"] == "unused_helper"
        assert global_candidates[0]["confidence"] == "low"
        assert global_candidates[0]["match_type"] == "serialized_inline_lora_tag"

    def test_parse_comfyui_recovers_lora_from_workflow_widget_lora_loader(self, tmp_path: Path):
        """Explicit LoRA filenames in workflow widgets should be recovered even when prompt inputs missed them."""
        workflow_prompt = {
            "1": {
                "class_type": "KSampler",
                "inputs": {
                    "seed": 123,
                    "model": ["2", 0],
                    "positive": ["3", 0],
                    "negative": ["4", 0],
                    "latent_image": ["5", 0],
                }
            },
            "2": {
                "class_type": "CheckpointLoaderSimple",
                "inputs": {"ckpt_name": "base_model.safetensors"}
            },
            "3": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": "portrait", "clip": ["2", 1]}
            },
            "4": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": "negative", "clip": ["2", 1]}
            },
            "5": {
                "class_type": "EmptyLatentImage",
                "inputs": {"width": 512, "height": 512}
            },
        }
        workflow_ui = {
            "nodes": [
                {
                    "id": 20,
                    "type": "LoraLoader",
                    "widgets_values": ["add_detail.safetensors", 0.8, 1.0],
                }
            ]
        }

        from PIL import Image
        from PIL.PngImagePlugin import PngInfo
        img_path = tmp_path / "comfyui_workflow_lora_loader.png"
        img = Image.new("RGB", (512, 512), color="navy")
        metadata = PngInfo()
        metadata.add_text("prompt", json.dumps(workflow_prompt))
        metadata.add_text("workflow", json.dumps(workflow_ui))
        img.save(img_path, pnginfo=metadata)

        result = parse_image(str(img_path))
        model_assets = result["metadata"]["_parsed"].get("model_assets") or {}

        assert result["loras"] == ["add_detail.safetensors"]
        widget_candidates = model_assets.get("workflow_widget_lora_candidates") or []
        assert len(widget_candidates) == 1
        assert widget_candidates[0]["name"] == "add_detail.safetensors"
        assert widget_candidates[0]["source_mode"] == "workflow_widget_fallback"

    def test_parse_comfyui_recovers_lora_from_workflow_easy_lora_stack(self, tmp_path: Path):
        """easy loraStack widget values should feed main lora extraction when prompt inputs only say None."""
        workflow_prompt = {
            "26": {
                "class_type": "KSampler (Efficient)",
                "inputs": {
                    "seed": 100,
                    "steps": 20,
                    "cfg": 7,
                    "sampler_name": "euler",
                    "scheduler": "normal",
                    "denoise": 1.0,
                    "model": ["34", 0],
                    "positive": ["34", 1],
                    "negative": ["34", 2],
                    "latent_image": ["33", 0],
                    "optional_vae": ["34", 4],
                }
            },
            "33": {
                "class_type": "EmptyLatentImage",
                "inputs": {"width": 512, "height": 768, "batch_size": 1}
            },
            "34": {
                "class_type": "Efficient Loader",
                "inputs": {
                    "ckpt_name": "chenkin_noob_ep15.safetensors",
                    "lora_name": "None",
                }
            },
        }
        workflow_ui = {
            "nodes": [
                {
                    "id": 201,
                    "type": "easy loraStack",
                    "widgets_values": [
                        True, "simple", 1,
                        r"测试\yhmf v5.safetensors", 1, 1,
                        1, "None", 1, 1,
                    ],
                }
            ]
        }

        from PIL import Image
        from PIL.PngImagePlugin import PngInfo
        img_path = tmp_path / "comfyui_workflow_lorastack.png"
        img = Image.new("RGB", (512, 512), color="olive")
        metadata = PngInfo()
        metadata.add_text("prompt", json.dumps(workflow_prompt))
        metadata.add_text("workflow", json.dumps(workflow_ui))
        img.save(img_path, pnginfo=metadata)

        result = parse_image(str(img_path))
        model_assets = result["metadata"]["_parsed"].get("model_assets") or {}

        assert result["checkpoint"] == "chenkin_noob_ep15.safetensors"
        assert result["loras"] == [r"测试\yhmf v5.safetensors"]
        widget_candidates = model_assets.get("workflow_widget_lora_candidates") or []
        assert any(item["name"] == r"测试\yhmf v5.safetensors" for item in widget_candidates)

    def test_parse_comfyui_workflow_only_uses_widget_checkpoint_when_prompt_graph_missing(self, tmp_path: Path):
        """Workflow-only files should still recover checkpoint and LoRAs from widget state."""
        from PIL import Image
        from PIL.PngImagePlugin import PngInfo

        img_path = tmp_path / "comfyui_workflow_only_checkpoint.png"
        img = Image.new("RGB", (512, 512), color="white")

        workflow_ui = {
            "nodes": [
                {
                    "id": 1,
                    "type": "CheckpointLoaderSimple",
                    "widgets_values": ["checkpoint-e1_s14230(ep12).safetensors"],
                },
                {
                    "id": 2,
                    "type": "Power Lora Loader (rgthree)",
                    "widgets_values": [
                        True,
                        "simple",
                        {"on": True, "lora": "style\\\\rella.safetensors"},
                    ],
                },
            ]
        }

        metadata = PngInfo()
        metadata.add_text("workflow", json.dumps(workflow_ui))
        img.save(img_path, pnginfo=metadata)

        result = parse_image(str(img_path))
        model_assets = result["metadata"]["_parsed"].get("model_assets") or {}

        assert result["generator"] == "comfyui"
        assert result["checkpoint"] == "checkpoint-e1_s14230(ep12).safetensors"
        assert [item.replace("\\\\", "\\") for item in result["loras"]] == ["style\\rella.safetensors"]
        assert model_assets.get("primary_model_name") == "checkpoint-e1_s14230(ep12).safetensors"

    def test_parse_comfyui_workflow_controlnet_stack_does_not_pollute_loras(self, tmp_path: Path):
        """ControlNet stacks in workflow widgets are model files, not LoRAs."""
        workflow_prompt = {
            "1": {
                "class_type": "KSampler",
                "inputs": {
                    "seed": 123,
                    "model": ["2", 0],
                    "positive": ["3", 0],
                    "negative": ["4", 0],
                    "latent_image": ["5", 0],
                }
            },
            "2": {
                "class_type": "CheckpointLoaderSimple",
                "inputs": {"ckpt_name": "base_model.safetensors"}
            },
            "3": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": "portrait", "clip": ["2", 1]}
            },
            "4": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": "negative", "clip": ["2", 1]}
            },
            "5": {
                "class_type": "EmptyLatentImage",
                "inputs": {"width": 512, "height": 512}
            },
        }
        workflow_ui = {
            "nodes": [
                {
                    "id": 28,
                    "type": "CR Multi-ControlNet Stack",
                    "widgets_values": [
                        "Off",
                        "noobaiXLControlnet_openposeModel.safetensors",
                        1, 0, 1,
                        "On",
                        r"dir\noob_v_canny_controlnet_ep20_step280.safetensors",
                        1.1, 0, 1,
                    ],
                }
            ]
        }

        from PIL import Image
        from PIL.PngImagePlugin import PngInfo
        img_path = tmp_path / "comfyui_workflow_controlnet_only.png"
        img = Image.new("RGB", (512, 512), color="maroon")
        metadata = PngInfo()
        metadata.add_text("prompt", json.dumps(workflow_prompt))
        metadata.add_text("workflow", json.dumps(workflow_ui))
        img.save(img_path, pnginfo=metadata)

        result = parse_image(str(img_path))

        assert result["checkpoint"] == "base_model.safetensors"
        assert result["loras"] == []


class TestWebUIMetadata:
    """Tests for WebUI/A1111 metadata parsing."""

    def test_parse_webui_basic(self, mock_webui_image: Path):
        """Basic WebUI metadata should be parsed correctly."""
        result = parse_image(str(mock_webui_image))

        assert result["generator"] == "webui"
        assert "portrait" in result["prompt"].lower()
        assert "blurry" in result["negative_prompt"].lower()

    def test_parse_webui_checkpoint(self, mock_webui_image: Path):
        """WebUI checkpoint should be extracted."""
        result = parse_image(str(mock_webui_image))

        assert "realisticVision" in result["checkpoint"]

    def test_parse_webui_parameters_format(self, tmp_path: Path):
        """WebUI parameters text chunk should be parsed correctly."""
        from PIL import Image
        from PIL.PngImagePlugin import PngInfo

        img_path = tmp_path / "webui_params.png"
        img = Image.new("RGB", (512, 512), color="red")

        parameters = """beautiful sunset over mountains, detailed sky
Negative prompt: ugly, low quality, blurry
Steps: 30, Sampler: DPM++ 2M Karras, CFG scale: 7.0, Seed: 123456789, Size: 512x512, Model: test_model.safetensors"""

        metadata = PngInfo()
        metadata.add_text("parameters", parameters)
        img.save(img_path, pnginfo=metadata)

        result = parse_image(str(img_path))

        assert result["generator"] == "webui"
        assert "sunset" in result["prompt"].lower()
        assert "ugly" in result["negative_prompt"].lower()
        assert result["checkpoint"] == "test_model.safetensors"

    def test_parse_webui_prefers_actual_model_over_adetailer_model_fields(self, tmp_path: Path):
        """ADetailer model fields must not override the real checkpoint."""
        from PIL import Image
        from PIL.PngImagePlugin import PngInfo

        img_path = tmp_path / "webui_adetailer_model_priority.png"
        img = Image.new("RGB", (512, 512), color="purple")

        parameters = (
            "masterpiece\n"
            "Negative prompt: low quality\n"
            "Steps: 20, Sampler: Euler a, CFG scale: 5, Seed: 123, Size: 512x768, "
            "ADetailer model: face_yolov8n.pt, ADetailer confidence: 0.3, "
            "Model hash: abcdef1234, Model: real_model.safetensors"
        )

        metadata = PngInfo()
        metadata.add_text("parameters", parameters)
        img.save(img_path, pnginfo=metadata)

        result = parse_image(str(img_path))

        assert result["generator"] == "webui"
        assert result["checkpoint"] == "real_model.safetensors"

    def test_parse_webui_uses_model_hash_identifier_when_name_missing(self, tmp_path: Path):
        """A missing model name should still surface a stable model-hash identifier."""
        from PIL import Image
        from PIL.PngImagePlugin import PngInfo

        img_path = tmp_path / "webui_model_hash_only.png"
        img = Image.new("RGB", (512, 512), color="brown")

        parameters = (
            "masterpiece\n"
            "Negative prompt: low quality\n"
            "Steps: 20, Sampler: Euler a, CFG scale: 5, Seed: 123, Size: 512x768, "
            "Model hash: 925997e9, Clip skip: 2"
        )

        metadata = PngInfo()
        metadata.add_text("parameters", parameters)
        img.save(img_path, pnginfo=metadata)

        result = parse_image(str(img_path))

        assert result["generator"] == "webui"
        assert result["checkpoint"] == "Model hash 925997e9"

    def test_parse_webui_recovers_lora_names_from_lora_hashes(self, tmp_path: Path):
        """LoRA names should be recovered from the Lora hashes field even without inline tags."""
        from PIL import Image
        from PIL.PngImagePlugin import PngInfo

        img_path = tmp_path / "webui_lora_hashes.png"
        img = Image.new("RGB", (512, 512), color="red")

        parameters = (
            "masterpiece\n"
            "Negative prompt: low quality\n"
            "Steps: 30, Sampler: Euler a, CFG scale: 7, Seed: 123, Size: 512x512, "
            "Model: test_model.safetensors, "
            "Lora hashes: \"style_a: a1b2c3, detail_boost: d4e5f6\""
        )

        metadata = PngInfo()
        metadata.add_text("parameters", parameters)
        img.save(img_path, pnginfo=metadata)

        result = parse_image(str(img_path))

        assert result["generator"] == "webui"
        assert result["loras"] == ["style_a", "detail_boost"]

    def test_parse_webui_weightless_lora_tags_do_not_merge_together(self, tmp_path: Path):
        """Weightless inline tags should still split into distinct LoRA names."""
        from PIL import Image
        from PIL.PngImagePlugin import PngInfo

        img_path = tmp_path / "webui_weightless_loras.png"
        img = Image.new("RGB", (512, 512), color="cyan")

        parameters = (
            "masterpiece, <lora:first_style>, <lora:second_style:0.7>\n"
            "Negative prompt: low quality\n"
            "Steps: 20, Sampler: Euler a, CFG scale: 5, Seed: 123, Size: 512x768, Model: test_model.safetensors"
        )

        metadata = PngInfo()
        metadata.add_text("parameters", parameters)
        img.save(img_path, pnginfo=metadata)

        result = parse_image(str(img_path))

        assert result["loras"] == ["first_style", "second_style"]

    def test_parse_webui_model_assets_include_adetailer_yolo_models(self, tmp_path: Path):
        """Detailed model assets should expose detector models without polluting checkpoint/LoRA summaries."""
        from PIL import Image
        from PIL.PngImagePlugin import PngInfo

        img_path = tmp_path / "webui_adetailer_models.png"
        img = Image.new("RGB", (512, 512), color="crimson")

        parameters = (
            "masterpiece\n"
            "Negative prompt: low quality\n"
            "Steps: 24, Sampler: Euler a, CFG scale: 7, Seed: 123, Size: 512x512, "
            "Model: test_model.safetensors, "
            "ADetailer model: face_yolov8n.pt, "
            "ADetailer model 2: hand_yolov8s.pt"
        )

        metadata = PngInfo()
        metadata.add_text("parameters", parameters)
        img.save(img_path, pnginfo=metadata)

        result = parse_image(str(img_path))
        model_assets = result["metadata"]["_parsed"].get("model_assets") or {}

        assert result["checkpoint"] == "test_model.safetensors"
        assert result["loras"] == []
        assert model_assets.get("primary_model_name") == "test_model.safetensors"
        assert model_assets.get("yolo_models") == ["face_yolov8n.pt", "hand_yolov8s.pt"]

    def test_parse_webui_merges_explicit_workflow_widget_loras_when_parameters_have_none(self, tmp_path: Path):
        """Hybrid files with WebUI params plus ComfyUI workflow should still recover explicit workflow LoRAs."""
        from PIL import Image
        from PIL.PngImagePlugin import PngInfo

        img_path = tmp_path / "webui_with_workflow_loras.png"
        img = Image.new("RGB", (512, 512), color="red")

        parameters = (
            "masterpiece\n"
            "Negative prompt: low quality\n"
            "Steps: 20, Sampler: Euler a, CFG scale: 5, Seed: 123, Size: 512x768, "
            "Model: JANKUV5NSFWTrainedNoobai_v50.safetensors"
        )
        workflow = {
            "nodes": [
                {
                    "id": 59,
                    "type": "LoraLoader",
                    "widgets_values": ["illustriousXLv01_stabilizer_v1.198.safetensors", 0.9, 1],
                },
                {
                    "id": 60,
                    "type": "LoraLoader",
                    "widgets_values": ["AddMicroDetails_Illustrious_v5.safetensors", 0.7, 1],
                },
            ]
        }

        metadata = PngInfo()
        metadata.add_text("parameters", parameters)
        metadata.add_text("workflow", json.dumps(workflow))
        img.save(img_path, pnginfo=metadata)

        result = parse_image(str(img_path))
        model_assets = result["metadata"]["_parsed"].get("model_assets") or {}

        assert result["generator"] == "webui"
        assert result["checkpoint"] == "JANKUV5NSFWTrainedNoobai_v50.safetensors"
        assert result["loras"] == [
            "illustriousXLv01_stabilizer_v1.198.safetensors",
            "AddMicroDetails_Illustrious_v5.safetensors",
        ]
        widget_candidates = model_assets.get("lora_candidates") or []
        assert len(widget_candidates) == 2


class TestForgeMetadata:
    """Tests for Forge metadata parsing."""

    def test_parse_forge_basic(self, mock_forge_image: Path):
        """Basic Forge metadata should be parsed correctly."""
        result = parse_image(str(mock_forge_image))

        assert result["generator"] == "forge"
        assert "cyberpunk" in result["prompt"].lower()
        assert "daylight" in result["negative_prompt"].lower()

    def test_forge_distinguished_from_webui(self, mock_forge_image: Path, mock_webui_image: Path):
        """Forge should be distinguished from WebUI."""
        forge_result = parse_image(str(mock_forge_image))
        webui_result = parse_image(str(mock_webui_image))

        assert forge_result["generator"] == "forge"
        assert webui_result["generator"] == "webui"


class TestCheckpointIdentifierFallbacks:
    """Tests for non-filename model identifiers that should still surface as checkpoint info."""

    def test_parse_nai_uses_source_as_checkpoint_identifier(self, tmp_path: Path):
        from PIL import Image
        from PIL.PngImagePlugin import PngInfo

        img_path = tmp_path / "nai_source_identifier.png"
        img = Image.new("RGB", (512, 512), color="white")

        comment = {
            "prompt": "masterpiece",
            "uc": "low quality",
            "steps": 28,
            "width": 832,
            "height": 1216,
            "scale": 10.0,
            "seed": 12345,
            "sampler": "k_euler",
        }

        metadata = PngInfo()
        metadata.add_text("Comment", json.dumps(comment))
        metadata.add_text("Description", "masterpiece")
        metadata.add_text("Software", "NovelAI")
        metadata.add_text("Source", "NovelAI Diffusion V4.5 4BDE2A90")
        img.save(img_path, pnginfo=metadata)

        result = parse_image(str(img_path))
        model_assets = result["metadata"]["_parsed"].get("model_assets") or {}

        assert result["generator"] == "nai"
        assert result["checkpoint"] == "NovelAI Diffusion V4.5 4BDE2A90"
        assert model_assets.get("primary_model_type") == "checkpoint"
        assert model_assets.get("primary_model_name") == "NovelAI Diffusion V4.5 4BDE2A90"

    def test_parse_nai_usercomment_uses_embedded_source_as_checkpoint_identifier(self, tmp_path: Path):
        from PIL import Image
        from PIL.PngImagePlugin import PngInfo

        img_path = tmp_path / "nai_usercomment_source_identifier.png"
        img = Image.new("RGB", (512, 512), color="white")

        usercomment = (
            "ASCII\0\0\0"
            + json.dumps({
                "Description": "masterpiece",
                "Software": "NovelAI",
                "Source": "Stable Diffusion XL 1120E6A9",
                "Comment": json.dumps({
                    "prompt": "masterpiece",
                    "uc": "low quality",
                    "steps": 28,
                    "width": 832,
                    "height": 1216,
                    "scale": 10.0,
                    "seed": 12345,
                    "sampler": "k_euler",
                }),
            })
        )

        metadata = PngInfo()
        metadata.add_text("UserComment", usercomment)
        metadata.add_text("Software", "NovelAI")
        img.save(img_path, pnginfo=metadata)

        result = parse_image(str(img_path))

        assert result["generator"] == "nai"
        assert result["checkpoint"] == "Stable Diffusion XL 1120E6A9"

    def test_parse_webui_novelai_software_uses_model_identifier_when_model_field_missing(self, tmp_path: Path):
        from PIL import Image
        from PIL.PngImagePlugin import PngInfo

        img_path = tmp_path / "webui_novelai_identifier.png"
        img = Image.new("RGB", (512, 512), color="white")

        user_comment = (
            "masterpiece\\n"
            "Negative prompt: low quality\\n"
            "Steps: 28, Sampler: Euler, CFG scale: 10.0, Seed: 2271736881, Size: 832x1216, Clip skip: 2, ENSD: 31337"
        )

        metadata = PngInfo()
        metadata.add_text("UserComment", user_comment)
        metadata.add_text("Software", "NovelAI")
        metadata.add_text("Model", "Stable Diffusion XL C1E1DE52")
        img.save(img_path, pnginfo=metadata)

        result = parse_image(str(img_path))

        assert result["generator"] == "webui"
        assert result["checkpoint"] == "Stable Diffusion XL C1E1DE52"


class TestNAIMetadata:
    """Tests for NovelAI metadata parsing."""

    def test_parse_nai_basic(self, mock_nai_image: Path):
        """Basic NAI metadata should be parsed correctly."""
        result = parse_image(str(mock_nai_image))

        assert result["generator"] == "nai"
        assert "anime girl" in result["prompt"].lower()
        assert "bad anatomy" in result["negative_prompt"].lower()

    def test_parse_nai_software_tag(self, tmp_path: Path):
        """NAI should be detected from Software tag."""
        from PIL import Image
        from PIL.PngImagePlugin import PngInfo

        img_path = tmp_path / "nai_software.png"
        img = Image.new("RGB", (832, 1216), color="purple")

        metadata = PngInfo()
        metadata.add_text("Software", "NovelAI")
        metadata.add_text("Description", "test prompt from NAI")
        img.save(img_path, pnginfo=metadata)

        result = parse_image(str(img_path))

        assert result["generator"] == "nai"
        assert "test prompt" in result["prompt"].lower()


class TestUnknownMetadata:
    """Tests for unknown/missing metadata."""

    def test_parse_no_metadata(self, mock_image_file: Path):
        """Image with no SD metadata should return unknown generator."""
        result = parse_image(str(mock_image_file))

        assert result["generator"] == "unknown"

    def test_parse_dimensions_extracted(self, mock_image_file: Path):
        """Dimensions should be extracted even without metadata."""
        result = parse_image(str(mock_image_file))

        assert result["width"] == 512
        assert result["height"] == 512

    def test_parse_file_size(self, mock_image_file: Path):
        """File size should be extracted."""
        result = parse_image(str(mock_image_file))

        assert result["file_size"] > 0


class TestEdgeCases:
    """Edge case tests for metadata parsing."""

    def test_parse_jpeg_with_exif(self, tmp_path: Path):
        """JPEG with EXIF should be handled."""
        from PIL import Image

        img_path = tmp_path / "test.jpg"
        img = Image.new("RGB", (512, 512), color="blue")
        img.save(img_path, "JPEG")

        result = parse_image(str(img_path))

        assert result["width"] == 512
        assert result["height"] == 512

    def test_parse_webp(self, tmp_path: Path):
        """WebP images should be handled."""
        from PIL import Image

        img_path = tmp_path / "test.webp"
        img = Image.new("RGB", (512, 512), color="green")
        img.save(img_path, "WEBP")

        result = parse_image(str(img_path))

        assert result["width"] == 512
        assert result["height"] == 512

    def test_parse_corrupted_json_in_metadata(self, tmp_path: Path):
        """Corrupted JSON in metadata should be handled gracefully."""
        from PIL import Image
        from PIL.PngImagePlugin import PngInfo

        img_path = tmp_path / "corrupted.png"
        img = Image.new("RGB", (512, 512), color="red")

        metadata = PngInfo()
        metadata.add_text("prompt", "{invalid json")
        img.save(img_path, pnginfo=metadata)

        # Should not crash
        result = parse_image(str(img_path))
        assert result is not None

    def test_parse_empty_prompt(self, tmp_path: Path):
        """Empty prompt in metadata should be handled."""
        from PIL import Image
        from PIL.PngImagePlugin import PngInfo

        img_path = tmp_path / "empty_prompt.png"
        img = Image.new("RGB", (512, 512), color="blue")

        workflow = {
            "1": {
                "class_type": "KSampler",
                "inputs": {
                    "seed": 12345,
                    "model": ["2", 0],
                    "positive": ["3", 0],
                    "negative": ["4", 0],
                    "latent_image": ["5", 0]
                }
            },
            "2": {
                "class_type": "CheckpointLoaderSimple",
                "inputs": {"ckpt_name": "model.safetensors"}
            },
            "3": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": "", "clip": ["2", 1]}  # Empty prompt
            },
            "4": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": "", "clip": ["2", 1]}
            },
            "5": {
                "class_type": "EmptyLatentImage",
                "inputs": {"width": 512, "height": 512}
            }
        }

        metadata = PngInfo()
        metadata.add_text("prompt", json.dumps(workflow))
        img.save(img_path, pnginfo=metadata)

        result = parse_image(str(img_path))

        assert result["generator"] == "comfyui"

    def test_parse_unicode_in_prompt(self, tmp_path: Path):
        """Unicode characters in prompts should be handled."""
        from PIL import Image
        from PIL.PngImagePlugin import PngInfo

        img_path = tmp_path / "unicode.png"
        img = Image.new("RGB", (512, 512), color="white")

        parameters = """beautiful anime girl, white hair, red eyes, school uniform
Negative prompt: bad anatomy, low quality
Steps: 28, Sampler: euler a, CFG scale: 7.0, Seed: 123, Size: 512x512"""

        metadata = PngInfo()
        metadata.add_text("parameters", parameters)
        img.save(img_path, pnginfo=metadata)

        result = parse_image(str(img_path))

        assert result["generator"] == "webui"
        # Unicode should be preserved
        assert "anime" in result["prompt"].lower() or "girl" in result["prompt"].lower()


class TestImg2ImgDetection:
    """Tests for img2img detection in metadata."""

    def test_webui_img2img_detected(self, tmp_path: Path):
        """WebUI img2img should be detected from denoising strength."""
        from PIL import Image
        from PIL.PngImagePlugin import PngInfo

        img_path = tmp_path / "webui_img2img.png"
        img = Image.new("RGB", (512, 512), color="yellow")

        parameters = """modified image
Negative prompt: bad
Steps: 20, Sampler: euler a, CFG scale: 7.0, Seed: 123, Size: 512x512, Denoising strength: 0.75"""

        metadata = PngInfo()
        metadata.add_text("parameters", parameters)
        img.save(img_path, pnginfo=metadata)

        result = parse_image(str(img_path))

        assert result["generator"] == "webui"
        assert result["metadata"]["_parsed"]["is_img2img"] is True

    def test_comfyui_img2img_detected(self, tmp_path: Path):
        """ComfyUI img2img should be detected from LoadImage and denoise."""
        from PIL import Image
        from PIL.PngImagePlugin import PngInfo

        img_path = tmp_path / "comfyui_img2img.png"
        img = Image.new("RGB", (512, 512), color="cyan")

        workflow = {
            "1": {
                "class_type": "KSampler",
                "inputs": {
                    "seed": 12345,
                    "steps": 20,
                    "denoise": 0.75,  # Less than 1.0
                    "model": ["2", 0],
                    "positive": ["3", 0],
                    "negative": ["4", 0],
                    "latent_image": ["6", 0]  # From LoadImage
                }
            },
            "2": {
                "class_type": "CheckpointLoaderSimple",
                "inputs": {"ckpt_name": "model.safetensors"}
            },
            "3": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": "prompt", "clip": ["2", 1]}
            },
            "4": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": "negative", "clip": ["2", 1]}
            },
            "5": {
                "class_type": "LoadImage",
                "inputs": {"image": "input.png"}
            },
            "6": {
                "class_type": "VAEEncode",
                "inputs": {"pixels": ["5", 0]}
            }
        }

        metadata = PngInfo()
        metadata.add_text("prompt", json.dumps(workflow))
        img.save(img_path, pnginfo=metadata)

        result = parse_image(str(img_path))

        assert result["generator"] == "comfyui"
        # Should detect img2img from LoadImage + denoise < 1.0
        img2img_info = result["metadata"]["_parsed"].get("img2img_info")
        if img2img_info:
            assert img2img_info.get("denoising_strength") == 0.75


class TestPromptNodesExtraction:
    """Tests for prompt nodes extraction in ComfyUI workflows."""

    def test_multiple_prompt_nodes(self, tmp_path: Path):
        """Multiple prompt nodes should be captured."""
        from PIL import Image
        from PIL.PngImagePlugin import PngInfo

        img_path = tmp_path / "multi_prompt.png"
        img = Image.new("RGB", (512, 512), color="magenta")

        workflow = {
            "1": {
                "class_type": "KSampler",
                "inputs": {
                    "seed": 12345,
                    "model": ["2", 0],
                    "positive": ["3", 0],
                    "negative": ["4", 0],
                    "latent_image": ["5", 0]
                }
            },
            "2": {
                "class_type": "CheckpointLoaderSimple",
                "inputs": {"ckpt_name": "model.safetensors"}
            },
            "3": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": "main prompt text", "clip": ["2", 1]}
            },
            "4": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": "negative text here", "clip": ["2", 1]}
            },
            "5": {
                "class_type": "EmptyLatentImage",
                "inputs": {"width": 512, "height": 512}
            }
        }

        metadata = PngInfo()
        metadata.add_text("prompt", json.dumps(workflow))
        img.save(img_path, pnginfo=metadata)

        result = parse_image(str(img_path))

        assert result["generator"] == "comfyui"
        # Prompt nodes should be captured in metadata
        prompt_nodes = result["metadata"]["_parsed"].get("prompt_nodes")
        if prompt_nodes:
            assert len(prompt_nodes) >= 1
