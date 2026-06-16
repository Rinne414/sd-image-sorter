"""
Civitai Resources Extractor

Extracts Civitai AIR (Asset Identification Record) metadata from ComfyUI images.
AIR format: urn:air:sd1:lora:civitai:123456@7890
            urn:air:sdxl:checkpoint:civitai:999999@111111

References:
- https://github.com/n0va39/ComfyUI-EXIF-viewer/blob/main/comfy_metadata_reader.py
- https://github.com/civitai/civitai/wiki/AIR-%E2%80%90-Uniform-Resource-Names-for-AI
"""

import json
import re
from typing import Any, Dict, List, Optional, Set, Tuple


class CivitaiResourceExtractor:
    """
    Extract Civitai resource metadata from ComfyUI prompt/workflow JSON.

    Searches for "Civitai resources:" markers in various metadata fields
    and parses AIR (Asset Identification Record) strings.
    """

    # AIR pattern: urn:air:sd1:lora:civitai:123456@7890
    AIR_PATTERN = re.compile(r":civitai:(\d+)@(\d+)$")

    # Civitai resources marker in ComfyUI metadata
    CIVITAI_MARKER = "Civitai resources:"

    # Fields to scan for Civitai resources
    SCAN_FIELDS = [
        "prompt", "workflow", "parameters", "comment", "description",
        "usercomment", "imagedescription"
    ]

    def extract_from_comfyui_metadata(self, prompt_json: Optional[Dict[str, Any]],
                                      workflow_json: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        Extract Civitai resources from ComfyUI prompt and workflow JSON.

        Args:
            prompt_json: ComfyUI prompt JSON (from PNG 'prompt' text chunk)
            workflow_json: ComfyUI workflow JSON (from PNG 'workflow' text chunk)

        Returns:
            List of Civitai resource dicts with fields:
            - model_name: str
            - version_name: Optional[str]
            - weight: Optional[float]
            - air: str (original AIR string)
            - model_id: Optional[int]
            - version_id: Optional[int]
            - civitai_url: Optional[str]
        """
        resources: List[Dict[str, Any]] = []
        seen: Set[Tuple[str, str, str]] = set()

        # Scan prompt JSON
        if prompt_json:
            resources.extend(self._scan_json_recursive(prompt_json, seen))

        # Scan workflow JSON
        if workflow_json:
            resources.extend(self._scan_json_recursive(workflow_json, seen))

        return resources

    def _scan_json_recursive(self, data: Any, seen: Set[Tuple[str, str, str]]) -> List[Dict[str, Any]]:
        """
        Recursively scan JSON data for Civitai resources.

        Args:
            data: JSON data (dict, list, str, or primitive)
            seen: Set of (model_name, version_name, url) tuples to deduplicate

        Returns:
            List of unique Civitai resource dicts
        """
        resources: List[Dict[str, Any]] = []

        if isinstance(data, dict):
            # Check if this dict contains Civitai resources
            for key, value in data.items():
                if isinstance(value, str) and self.CIVITAI_MARKER in value:
                    # Found a field with Civitai marker
                    items = self._parse_civitai_resources_field(value)
                    for item in items:
                        resource = self._parse_civitai_resource_item(item)
                        if resource:
                            marker = (resource["model_name"],
                                    resource.get("version_name", ""),
                                    resource.get("civitai_url", ""))
                            if marker not in seen:
                                resources.append(resource)
                                seen.add(marker)

                # Recurse into nested structures
                resources.extend(self._scan_json_recursive(value, seen))

        elif isinstance(data, list):
            for item in data:
                resources.extend(self._scan_json_recursive(item, seen))

        elif isinstance(data, str):
            # Check if this string contains Civitai marker
            if self.CIVITAI_MARKER in data:
                items = self._parse_civitai_resources_field(data)
                for item in items:
                    resource = self._parse_civitai_resource_item(item)
                    if resource:
                        marker = (resource["model_name"],
                                resource.get("version_name", ""),
                                resource.get("civitai_url", ""))
                        if marker not in seen:
                            resources.append(resource)
                            seen.add(marker)

        return resources

    def _parse_civitai_resources_field(self, text: str) -> List[Dict[str, Any]]:
        """
        Parse "Civitai resources: [...]" field from a text string.

        Args:
            text: Text containing "Civitai resources:" marker

        Returns:
            List of resource item dicts (raw from JSON array)
        """
        marker_index = text.find(self.CIVITAI_MARKER)
        if marker_index < 0:
            return []

        # Find the opening bracket after the marker
        start = text.find("[", marker_index + len(self.CIVITAI_MARKER))
        if start < 0:
            return []

        # Try to parse the JSON array
        try:
            decoder = json.JSONDecoder()
            parsed, _end = decoder.raw_decode(text[start:])
        except json.JSONDecodeError:
            return []

        if not isinstance(parsed, list):
            return []

        return [item for item in parsed if isinstance(item, dict)]

    def _parse_civitai_resource_item(self, item: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """
        Parse a single Civitai resource item dict.

        Args:
            item: Raw resource dict from Civitai resources JSON array
                Example: {
                    "air": "urn:air:sd1:lora:civitai:123456@7890",
                    "modelName": "MyLoRA",
                    "versionName": "v1.0",
                    "weight": 0.8
                }

        Returns:
            Parsed resource dict or None if invalid
        """
        air = str(item.get("air", "")).strip()
        if not air:
            return None

        # Extract model_id and version_id from AIR
        match = self.AIR_PATTERN.search(air)
        if not match:
            return None

        model_id_str, version_id_str = match.groups()
        model_id = int(model_id_str)
        version_id = int(version_id_str)

        # Extract model name and version name
        model_name = str(item.get("modelName", "")).strip()
        if not model_name:
            model_name = f"Civitai model {model_id}"

        version_name = str(item.get("versionName", "")).strip() or None

        # Extract weight (for LoRAs)
        weight_value = item.get("weight")
        weight = None
        if weight_value is not None:
            try:
                weight = float(weight_value)
            except (ValueError, TypeError):
                pass

        # Build Civitai URL
        civitai_url = f"https://civitai.red/models/{model_id}?modelVersionId={version_id}"

        return {
            "model_name": model_name,
            "version_name": version_name,
            "weight": weight,
            "air": air,
            "model_id": model_id,
            "version_id": version_id,
            "civitai_url": civitai_url
        }


# Singleton instance
_extractor_instance: Optional[CivitaiResourceExtractor] = None


def get_civitai_extractor() -> CivitaiResourceExtractor:
    """Get or create the singleton Civitai resource extractor instance."""
    global _extractor_instance
    if _extractor_instance is None:
        _extractor_instance = CivitaiResourceExtractor()
    return _extractor_instance


def extract_civitai_resources(prompt_json: Optional[Dict[str, Any]],
                               workflow_json: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Convenience function to extract Civitai resources.

    Args:
        prompt_json: ComfyUI prompt JSON
        workflow_json: ComfyUI workflow JSON

    Returns:
        List of Civitai resource dicts
    """
    extractor = get_civitai_extractor()
    return extractor.extract_from_comfyui_metadata(prompt_json, workflow_json)
