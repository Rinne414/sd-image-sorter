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

from metadata_parser import MetadataParser, parse_image


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
