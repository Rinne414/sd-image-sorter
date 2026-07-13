# =============================================================================
# metadata_parser.comfyui.graph - metadata_parser decomposition stages 1+2 (2026-07-13).
# Extracted VERBATIM from backend/metadata_parser.py @ c06d374 (4,912 lines).
# Source line ranges (original file): 3168-3186, 3472-3485, 3486-3494, 3495-3550.
# Mixin: ComfyUI graph walk: activity roots, upstream distances, input-ref/key-path helpers.
# self.* calls and class-constant lookups resolve via MRO exactly as before.
# Patched seams (Image / open / _MAX_* / _sidecar_directory_cache): the readers
# live in metadata_parser/_runtime.py behind the package get/set proxy in
# __init__.py (stage 3); see tests/test_metadata_parser_pins.py.
import re
from typing import Dict, Any, Tuple, List

class ComfyUIGraphMixin:
    """ComfyUI graph walk: activity roots, upstream distances, input-ref/key-path helpers."""

    def _iter_workflow_widget_strings(self, value: Any, path: str = "") -> List[Tuple[str, str]]:
        """Collect string widget values from workflow nodes with stable paths."""
        results: List[Tuple[str, str]] = []
        if isinstance(value, str):
            text = value.strip()
            if text:
                results.append((path or "0", text))
            return results
        if isinstance(value, list):
            for index, item in enumerate(value):
                next_path = f"{path}.{index}" if path else str(index)
                results.extend(self._iter_workflow_widget_strings(item, next_path))
            return results
        if isinstance(value, dict):
            for key, item in value.items():
                next_path = f"{path}.{key}" if path else str(key)
                results.extend(self._iter_workflow_widget_strings(item, next_path))
        return results

    def _is_explicit_comfyui_lora_key(self, key_path: str) -> bool:
        """Return True only for genuinely lora-shaped keys, not UI flags/noise."""
        leaf_key = key_path.split(".")[-1].lower()
        if re.match(r"^lora(_\d+)?$", leaf_key):
            return True
        if leaf_key in {"lora_name", "lora_path", "lora_file", "lora_str", "temp_lora_str"}:
            return True
        return (
            leaf_key.endswith("_lora")
            or leaf_key.endswith("_lora_name")
            or leaf_key.endswith("_lora_str")
            or leaf_key.endswith("_lora_stack")
        )

    @staticmethod
    def _join_comfyui_key_path(base: str, suffix: str) -> str:
        """Join serialized key suffixes onto an existing input key path."""
        if not suffix:
            return base
        if suffix.startswith("["):
            return f"{base}{suffix}"
        return f"{base}.{suffix}"

    def _find_comfyui_activity_roots(self, nodes: Dict[str, dict]) -> List[str]:
        """Find likely sampler/output roots for the active ComfyUI branch."""
        roots: List[str] = []
        for node_id, node in nodes.items():
            class_type = str(node.get("class_type", ""))
            class_type_lower = class_type.lower()
            inputs = node.get("inputs", {})

            if any(token.lower() in class_type_lower for token in self.COMFYUI_SAMPLER_NODE_TYPES):
                roots.append(node_id)
                continue

            if "ksampler" in class_type_lower or (
                "model" in inputs and ("positive" in inputs or "negative" in inputs)
            ):
                roots.append(node_id)

        return roots or list(nodes.keys())

    def _collect_comfyui_upstream_distances(self, nodes: Dict[str, dict], root_ids: List[str]) -> Dict[str, int]:
        """Breadth-first walk from active roots to upstream nodes."""
        distances: Dict[str, int] = {}
        queue: List[Tuple[str, int]] = [(root_id, 0) for root_id in root_ids if root_id in nodes]

        while queue:
            node_id, distance = queue.pop(0)
            previous = distances.get(node_id)
            if previous is not None and previous <= distance:
                continue
            distances[node_id] = distance

            node = nodes.get(node_id, {})
            for ref_id in self._iter_comfyui_input_refs(node.get("inputs", {})):
                if ref_id in nodes:
                    queue.append((ref_id, distance + 1))

        return distances

    def _iter_comfyui_input_refs(self, value: Any) -> List[str]:
        """Collect node references from nested ComfyUI input values."""
        refs: List[str] = []

        if isinstance(value, (list, tuple)):
            if len(value) >= 2 and isinstance(value[0], (str, int)):
                refs.append(str(value[0]))
                return refs
            for item in value:
                refs.extend(self._iter_comfyui_input_refs(item))
            return refs

        if isinstance(value, dict):
            for nested in value.values():
                refs.extend(self._iter_comfyui_input_refs(nested))

        return refs

