"""
Tests for Civitai resources extractor.
"""

from civitai_extractor import CivitaiResourceExtractor, extract_civitai_resources


class TestCivitaiResourceExtractor:
    """Test Civitai resource extraction from ComfyUI metadata."""

    def setup_method(self):
        """Set up test fixtures."""
        self.extractor = CivitaiResourceExtractor()

    def test_parse_civitai_resource_item_valid(self):
        """Test parsing a valid Civitai resource item."""
        item = {
            "air": "urn:air:sd1:lora:civitai:123456@7890",
            "modelName": "MyLoRA",
            "versionName": "v1.0",
            "weight": 0.8
        }

        result = self.extractor._parse_civitai_resource_item(item)

        assert result is not None
        assert result["model_name"] == "MyLoRA"
        assert result["version_name"] == "v1.0"
        assert result["weight"] == 0.8
        assert result["air"] == "urn:air:sd1:lora:civitai:123456@7890"
        assert result["model_id"] == 123456
        assert result["version_id"] == 7890
        assert result["civitai_url"] == "https://civitai.red/models/123456?modelVersionId=7890"

    def test_parse_civitai_resource_item_minimal(self):
        """Test parsing a minimal Civitai resource item (only AIR)."""
        item = {
            "air": "urn:air:sdxl:checkpoint:civitai:999999@111111"
        }

        result = self.extractor._parse_civitai_resource_item(item)

        assert result is not None
        assert result["model_name"] == "Civitai model 999999"
        assert result["version_name"] is None
        assert result["weight"] is None
        assert result["model_id"] == 999999
        assert result["version_id"] == 111111

    def test_parse_civitai_resource_item_invalid_air(self):
        """Test parsing an item with invalid AIR format."""
        item = {
            "air": "not a valid air",
            "modelName": "ShouldBeIgnored"
        }

        result = self.extractor._parse_civitai_resource_item(item)

        assert result is None

    def test_parse_civitai_resource_item_no_air(self):
        """Test parsing an item without AIR field."""
        item = {
            "modelName": "NoAIR"
        }

        result = self.extractor._parse_civitai_resource_item(item)

        assert result is None

    def test_parse_civitai_resource_item_weight_types(self):
        """Test parsing weight field with various types."""
        # Integer weight
        item1 = {
            "air": "urn:air:sd1:lora:civitai:123@456",
            "weight": 1
        }
        result1 = self.extractor._parse_civitai_resource_item(item1)
        assert result1["weight"] == 1.0

        # String weight (should be converted)
        item2 = {
            "air": "urn:air:sd1:lora:civitai:123@456",
            "weight": "0.75"
        }
        result2 = self.extractor._parse_civitai_resource_item(item2)
        assert result2["weight"] == 0.75

        # Invalid weight (should be None)
        item3 = {
            "air": "urn:air:sd1:lora:civitai:123@456",
            "weight": "not a number"
        }
        result3 = self.extractor._parse_civitai_resource_item(item3)
        assert result3["weight"] is None

    def test_parse_civitai_resources_field_valid(self):
        """Test parsing a valid Civitai resources field."""
        text = 'Some text before Civitai resources: [{"air":"urn:air:sd1:lora:civitai:123@456","modelName":"LoRA1"},{"air":"urn:air:sd1:lora:civitai:789@101","modelName":"LoRA2"}] and text after'

        result = self.extractor._parse_civitai_resources_field(text)

        assert len(result) == 2
        assert result[0]["air"] == "urn:air:sd1:lora:civitai:123@456"
        assert result[0]["modelName"] == "LoRA1"
        assert result[1]["air"] == "urn:air:sd1:lora:civitai:789@101"
        assert result[1]["modelName"] == "LoRA2"

    def test_parse_civitai_resources_field_no_marker(self):
        """Test parsing text without Civitai marker."""
        text = "No marker here"

        result = self.extractor._parse_civitai_resources_field(text)

        assert result == []

    def test_parse_civitai_resources_field_invalid_json(self):
        """Test parsing with invalid JSON after marker."""
        text = "Civitai resources: {not valid json}"

        result = self.extractor._parse_civitai_resources_field(text)

        assert result == []

    def test_parse_civitai_resources_field_not_array(self):
        """Test parsing when JSON is not an array."""
        text = 'Civitai resources: {"air":"urn:air:sd1:lora:civitai:123@456"}'

        result = self.extractor._parse_civitai_resources_field(text)

        assert result == []

    def test_scan_json_recursive_dict_with_marker(self):
        """Test scanning a dict with Civitai marker in a field."""
        data = {
            "node1": {
                "inputs": {
                    "text": 'Civitai resources: [{"air":"urn:air:sd1:lora:civitai:123@456","modelName":"TestLoRA"}]'
                }
            }
        }
        seen = set()

        result = self.extractor._scan_json_recursive(data, seen)

        assert len(result) == 1
        assert result[0]["model_name"] == "TestLoRA"
        assert result[0]["model_id"] == 123
        assert result[0]["version_id"] == 456

    def test_scan_json_recursive_string_with_marker(self):
        """Test scanning a standalone string with Civitai marker."""
        data = 'Text with Civitai resources: [{"air":"urn:air:sd1:lora:civitai:789@101","modelName":"StringLoRA"}] more text'
        seen = set()

        result = self.extractor._scan_json_recursive(data, seen)

        assert len(result) == 1
        assert result[0]["model_name"] == "StringLoRA"

    def test_scan_json_recursive_list(self):
        """Test scanning a list containing items with Civitai marker."""
        data = [
            "Normal string",
            'Civitai resources: [{"air":"urn:air:sd1:lora:civitai:111@222","modelName":"ListLoRA"}]',
            {"nested": "dict"}
        ]
        seen = set()

        result = self.extractor._scan_json_recursive(data, seen)

        assert len(result) == 1
        assert result[0]["model_name"] == "ListLoRA"

    def test_scan_json_recursive_deeply_nested(self):
        """Test scanning deeply nested structures."""
        data = {
            "level1": {
                "level2": {
                    "level3": [
                        {
                            "field": 'Civitai resources: [{"air":"urn:air:sd1:lora:civitai:333@444","modelName":"DeepLoRA"}]'
                        }
                    ]
                }
            }
        }
        seen = set()

        result = self.extractor._scan_json_recursive(data, seen)

        assert len(result) == 1
        assert result[0]["model_name"] == "DeepLoRA"

    def test_scan_json_recursive_deduplication(self):
        """Test that duplicate resources are filtered out."""
        data = {
            "field1": 'Civitai resources: [{"air":"urn:air:sd1:lora:civitai:555@666","modelName":"DupLoRA","versionName":"v1"}]',
            "field2": 'Civitai resources: [{"air":"urn:air:sd1:lora:civitai:555@666","modelName":"DupLoRA","versionName":"v1"}]'
        }
        seen = set()

        result = self.extractor._scan_json_recursive(data, seen)

        assert len(result) == 1

    def test_extract_from_comfyui_metadata_prompt_only(self):
        """Test extracting from prompt JSON only."""
        prompt_json = {
            "1": {
                "inputs": {
                    "text": 'Civitai resources: [{"air":"urn:air:sd1:lora:civitai:777@888","modelName":"PromptLoRA"}]'
                }
            }
        }

        result = self.extractor.extract_from_comfyui_metadata(prompt_json, None)

        assert len(result) == 1
        assert result[0]["model_name"] == "PromptLoRA"

    def test_extract_from_comfyui_metadata_workflow_only(self):
        """Test extracting from workflow JSON only."""
        workflow_json = {
            "nodes": [
                {
                    "widgets_values": [
                        'Civitai resources: [{"air":"urn:air:sd1:lora:civitai:999@1010","modelName":"WorkflowLoRA"}]'
                    ]
                }
            ]
        }

        result = self.extractor.extract_from_comfyui_metadata(None, workflow_json)

        assert len(result) == 1
        assert result[0]["model_name"] == "WorkflowLoRA"

    def test_extract_from_comfyui_metadata_both(self):
        """Test extracting from both prompt and workflow JSON."""
        prompt_json = {
            "1": {
                "inputs": {
                    "text": 'Civitai resources: [{"air":"urn:air:sd1:lora:civitai:111@222","modelName":"PromptLoRA"}]'
                }
            }
        }
        workflow_json = {
            "nodes": [
                {
                    "widgets_values": [
                        'Civitai resources: [{"air":"urn:air:sd1:lora:civitai:333@444","modelName":"WorkflowLoRA"}]'
                    ]
                }
            ]
        }

        result = self.extractor.extract_from_comfyui_metadata(prompt_json, workflow_json)

        assert len(result) == 2
        model_names = {r["model_name"] for r in result}
        assert "PromptLoRA" in model_names
        assert "WorkflowLoRA" in model_names

    def test_extract_from_comfyui_metadata_deduplication_across_sources(self):
        """Test that duplicates across prompt and workflow are filtered."""
        prompt_json = {
            "1": {
                "inputs": {
                    "text": 'Civitai resources: [{"air":"urn:air:sd1:lora:civitai:555@666","modelName":"SameLoRA","versionName":"v1"}]'
                }
            }
        }
        workflow_json = {
            "nodes": [
                {
                    "widgets_values": [
                        'Civitai resources: [{"air":"urn:air:sd1:lora:civitai:555@666","modelName":"SameLoRA","versionName":"v1"}]'
                    ]
                }
            ]
        }

        result = self.extractor.extract_from_comfyui_metadata(prompt_json, workflow_json)

        assert len(result) == 1

    def test_extract_from_comfyui_metadata_empty(self):
        """Test extracting from empty metadata."""
        result = self.extractor.extract_from_comfyui_metadata(None, None)
        assert result == []

        result = self.extractor.extract_from_comfyui_metadata({}, {})
        assert result == []

    def test_extract_civitai_resources_convenience_function(self):
        """Test the convenience function."""
        prompt_json = {
            "1": {
                "inputs": {
                    "text": 'Civitai resources: [{"air":"urn:air:sd1:lora:civitai:123@456","modelName":"ConvenienceLoRA"}]'
                }
            }
        }

        result = extract_civitai_resources(prompt_json, None)

        assert len(result) == 1
        assert result[0]["model_name"] == "ConvenienceLoRA"

    def test_air_pattern_variations(self):
        """Test various AIR format variations."""
        test_cases = [
            ("urn:air:sd1:lora:civitai:123@456", 123, 456),
            ("urn:air:sdxl:checkpoint:civitai:999999@111111", 999999, 111111),
            ("urn:air:sd2:textual_inversion:civitai:777@888", 777, 888),
            ("prefix:civitai:555@666", 555, 666),
        ]

        for air, expected_model_id, expected_version_id in test_cases:
            item = {"air": air, "modelName": "TestModel"}
            result = self.extractor._parse_civitai_resource_item(item)
            assert result is not None, f"Failed to parse AIR: {air}"
            assert result["model_id"] == expected_model_id
            assert result["version_id"] == expected_version_id

    def test_malformed_air_rejected(self):
        """Test that malformed AIR strings are rejected."""
        invalid_airs = [
            "not an air",
            "urn:air:sd1:lora:civitai:123",  # Missing version
            "urn:air:sd1:lora:civitai:@456",  # Missing model ID
            "civitai:abc@def",  # Non-numeric IDs
            "",
        ]

        for air in invalid_airs:
            item = {"air": air, "modelName": "ShouldFail"}
            result = self.extractor._parse_civitai_resource_item(item)
            assert result is None, f"Should reject invalid AIR: {air}"

    def test_real_world_comfyui_structure(self):
        """Test extraction from a realistic ComfyUI metadata structure."""
        prompt_json = {
            "3": {
                "class_type": "CLIPTextEncode",
                "inputs": {
                    "text": "beautiful landscape, masterpiece\nCivitai resources: [{\"air\":\"urn:air:sd1:lora:civitai:12345@67890\",\"modelName\":\"DetailEnhancer\",\"versionName\":\"v2.0\",\"weight\":0.7}]",
                    "clip": ["4", 1]
                }
            },
            "4": {
                "class_type": "LoraLoader",
                "inputs": {
                    "lora_name": "detail_enhancer.safetensors",
                    "strength_model": 0.7,
                    "model": ["5", 0]
                }
            }
        }

        workflow_json = {
            "nodes": [
                {
                    "id": 3,
                    "type": "CLIPTextEncode",
                    "widgets_values": [
                        "beautiful landscape\nCivitai resources: [{\"air\":\"urn:air:sd1:lora:civitai:12345@67890\",\"modelName\":\"DetailEnhancer\",\"versionName\":\"v2.0\"}]"
                    ]
                }
            ]
        }

        result = self.extractor.extract_from_comfyui_metadata(prompt_json, workflow_json)

        # Should find the resource and deduplicate (same AIR in both prompt and workflow)
        assert len(result) == 1
        assert result[0]["model_name"] == "DetailEnhancer"
        assert result[0]["version_name"] == "v2.0"
        assert result[0]["weight"] == 0.7
        assert result[0]["model_id"] == 12345
        assert result[0]["version_id"] == 67890
        assert "civitai.red/models/12345" in result[0]["civitai_url"]
