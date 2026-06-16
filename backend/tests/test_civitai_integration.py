"""
Integration tests for Civitai resources extraction in metadata parser.
"""

import json
import sys
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from metadata_parser import parse_image


def _write_comfyui_prompt_png(tmp_path: Path, filename: str, workflow: dict, workflow_json: dict = None) -> Path:
    """Create a test PNG with ComfyUI prompt (and optionally workflow) metadata."""
    from PIL import Image
    from PIL.PngImagePlugin import PngInfo

    img_path = tmp_path / filename
    img = Image.new("RGB", (512, 512), color="white")
    metadata = PngInfo()
    metadata.add_text("prompt", json.dumps(workflow))
    if workflow_json is not None:
        metadata.add_text("workflow", json.dumps(workflow_json))
    img.save(img_path, pnginfo=metadata)
    return img_path


class TestCivitaiResourcesIntegration:
    """Test Civitai resources extraction through the full metadata parsing pipeline."""

    def test_civitai_resources_extracted_from_comfyui_prompt(self, tmp_path):
        """Test that Civitai resources are extracted from ComfyUI metadata."""
        # Create a minimal ComfyUI prompt JSON with Civitai resources
        prompt_data = {
            "3": {
                "class_type": "CLIPTextEncode",
                "inputs": {
                    "text": "beautiful landscape\nCivitai resources: [{\"air\":\"urn:air:sd1:lora:civitai:12345@67890\",\"modelName\":\"TestLoRA\",\"versionName\":\"v1.0\",\"weight\":0.8}]",
                    "clip": ["4", 1]
                }
            },
            "4": {
                "class_type": "CheckpointLoader",
                "inputs": {
                    "ckpt_name": "test_checkpoint.safetensors"
                }
            },
            "5": {
                "class_type": "KSampler",
                "inputs": {
                    "seed": 12345,
                    "steps": 20,
                    "positive": ["3", 0]
                }
            }
        }

        # Create test image
        img_path = _write_comfyui_prompt_png(tmp_path, "test.png", prompt_data)

        # Parse the metadata
        result = parse_image(str(img_path))

        # Verify Civitai resources were extracted
        assert result["generator"] == "comfyui"
        assert "civitai_resources" in result
        assert len(result["civitai_resources"]) == 1

        resource = result["civitai_resources"][0]
        assert resource["model_name"] == "TestLoRA"
        assert resource["version_name"] == "v1.0"
        assert resource["weight"] == 0.8
        assert resource["model_id"] == 12345
        assert resource["version_id"] == 67890
        assert resource["air"] == "urn:air:sd1:lora:civitai:12345@67890"
        assert "civitai.red/models/12345" in resource["civitai_url"]

    def test_civitai_resources_extracted_from_workflow(self, tmp_path):
        """Test that Civitai resources are extracted from workflow JSON."""
        prompt_data = {
            "3": {
                "class_type": "CLIPTextEncode",
                "inputs": {
                    "text": "test prompt",
                    "clip": ["4", 1]
                }
            }
        }

        workflow_data = {
            "nodes": [
                {
                    "id": 3,
                    "type": "CLIPTextEncode",
                    "widgets_values": [
                        "test prompt\nCivitai resources: [{\"air\":\"urn:air:sdxl:checkpoint:civitai:99999@11111\",\"modelName\":\"TestCheckpoint\"}]"
                    ]
                }
            ]
        }

        img_path = _write_comfyui_prompt_png(tmp_path, "test.png", prompt_data, workflow_data)
        result = parse_image(str(img_path))

        assert result["generator"] == "comfyui"
        assert "civitai_resources" in result
        assert len(result["civitai_resources"]) == 1

        resource = result["civitai_resources"][0]
        assert resource["model_name"] == "TestCheckpoint"
        assert resource["model_id"] == 99999
        assert resource["version_id"] == 11111

    def test_civitai_resources_deduplicated_across_prompt_and_workflow(self, tmp_path):
        """Test that duplicate Civitai resources are filtered."""
        civitai_marker = 'Civitai resources: [{"air":"urn:air:sd1:lora:civitai:555@666","modelName":"SameLoRA","versionName":"v1"}]'

        prompt_data = {
            "3": {
                "class_type": "CLIPTextEncode",
                "inputs": {
                    "text": f"prompt text\n{civitai_marker}",
                    "clip": ["4", 1]
                }
            }
        }

        workflow_data = {
            "nodes": [
                {
                    "id": 3,
                    "type": "CLIPTextEncode",
                    "widgets_values": [f"prompt text\n{civitai_marker}"]
                }
            ]
        }

        img_path = _write_comfyui_prompt_png(tmp_path, "test.png", prompt_data, workflow_data)
        result = parse_image(str(img_path))

        # Should only have one resource despite appearing in both places
        assert len(result["civitai_resources"]) == 1

    def test_civitai_resources_multiple_loras(self, tmp_path):
        """Test extracting multiple Civitai resources."""
        prompt_data = {
            "3": {
                "class_type": "CLIPTextEncode",
                "inputs": {
                    "text": 'prompt\nCivitai resources: [{"air":"urn:air:sd1:lora:civitai:111@222","modelName":"LoRA1","weight":0.6},{"air":"urn:air:sd1:lora:civitai:333@444","modelName":"LoRA2","weight":0.4}]'
                }
            }
        }

        img_path = _write_comfyui_prompt_png(tmp_path, "test.png", prompt_data)
        result = parse_image(str(img_path))

        assert len(result["civitai_resources"]) == 2
        model_names = {r["model_name"] for r in result["civitai_resources"]}
        assert "LoRA1" in model_names
        assert "LoRA2" in model_names

    def test_civitai_resources_not_present_when_none_found(self, tmp_path):
        """Test that civitai_resources field is absent when no resources are found."""
        prompt_data = {
            "3": {
                "class_type": "CLIPTextEncode",
                "inputs": {
                    "text": "normal prompt without Civitai resources"
                }
            }
        }

        img_path = _write_comfyui_prompt_png(tmp_path, "test.png", prompt_data)
        result = parse_image(str(img_path))

        assert result["generator"] == "comfyui"
        assert "civitai_resources" not in result

    def test_civitai_extraction_error_does_not_break_parsing(self, tmp_path):
        """Test that errors in Civitai extraction don't break the main parsing."""
        # Create malformed Civitai data that will cause extraction to fail
        prompt_data = {
            "3": {
                "class_type": "CLIPTextEncode",
                "inputs": {
                    "text": "prompt\nCivitai resources: {not valid json at all}",
                    "clip": ["4", 1]
                }
            },
            "4": {
                "class_type": "CheckpointLoader",
                "inputs": {
                    "ckpt_name": "test_checkpoint.safetensors"
                }
            }
        }

        img_path = _write_comfyui_prompt_png(tmp_path, "test.png", prompt_data)
        result = parse_image(str(img_path))

        # Main parsing should still succeed
        assert result["generator"] == "comfyui"
        assert result["checkpoint"] == "test_checkpoint.safetensors"
        # civitai_resources should be absent due to extraction failure
        assert "civitai_resources" not in result

    def test_civitai_resources_deeply_nested(self, tmp_path):
        """Test extraction from deeply nested workflow structures."""
        workflow_data = {
            "extra": {
                "ds": {
                    "some_field": 'Civitai resources: [{"air":"urn:air:sd1:lora:civitai:777@888","modelName":"DeepLoRA"}]'
                }
            }
        }

        prompt_data = {
            "3": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": "test"}
            }
        }

        img_path = _write_comfyui_prompt_png(tmp_path, "test.png", prompt_data, workflow_data)
        result = parse_image(str(img_path))

        assert len(result["civitai_resources"]) == 1
        assert result["civitai_resources"][0]["model_name"] == "DeepLoRA"

    def test_civitai_resources_with_full_comfyui_workflow(self, tmp_path):
        """Test with a realistic full ComfyUI workflow structure."""
        prompt_data = {
            "1": {
                "class_type": "CheckpointLoaderSimple",
                "inputs": {
                    "ckpt_name": "realisticVisionV60B1_v51VAE.safetensors"
                }
            },
            "2": {
                "class_type": "LoraLoader",
                "inputs": {
                    "lora_name": "detail_tweaker.safetensors",
                    "strength_model": 0.7,
                    "strength_clip": 0.7,
                    "model": ["1", 0]
                }
            },
            "3": {
                "class_type": "CLIPTextEncode",
                "inputs": {
                    "text": "masterpiece, best quality, landscape\nCivitai resources: [{\"air\":\"urn:air:sd1:lora:civitai:135867@152145\",\"modelName\":\"Detail Tweaker LoRA\",\"versionName\":\"Detail Tweaker LoRA (SD1.5)\",\"weight\":0.7}]",
                    "clip": ["2", 1]
                }
            },
            "4": {
                "class_type": "KSampler",
                "inputs": {
                    "seed": 42,
                    "steps": 25,
                    "cfg": 7.5,
                    "sampler_name": "euler",
                    "scheduler": "normal",
                    "positive": ["3", 0],
                    "model": ["2", 0]
                }
            }
        }

        img_path = _write_comfyui_prompt_png(tmp_path, "test.png", prompt_data)
        result = parse_image(str(img_path))

        # Verify full metadata is parsed correctly
        assert result["generator"] == "comfyui"
        assert result["checkpoint"] == "realisticVisionV60B1_v51VAE.safetensors"
        assert "detail_tweaker.safetensors" in result["loras"]
        assert result["metadata"]["_parsed"]["generation_params"]["seed"] == 42
        assert result["metadata"]["_parsed"]["generation_params"]["steps"] == 25

        # Verify Civitai resources
        assert len(result["civitai_resources"]) == 1
        resource = result["civitai_resources"][0]
        assert resource["model_name"] == "Detail Tweaker LoRA"
        assert resource["version_name"] == "Detail Tweaker LoRA (SD1.5)"
        assert resource["weight"] == 0.7
        assert resource["model_id"] == 135867
        assert resource["version_id"] == 152145
