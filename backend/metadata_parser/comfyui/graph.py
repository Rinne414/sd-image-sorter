# =============================================================================
# metadata_parser.comfyui.graph - metadata_parser decomposition stages 1+2 (2026-07-13).
# Extracted VERBATIM from backend/metadata_parser.py @ c06d374 (4,912 lines).
# Source line ranges (original file): 3168-3186, 3472-3485, 3486-3494, 3495-3550.
# Mixin: ComfyUI graph walk: activity roots, upstream distances, input-ref/key-path helpers.
# self.* calls and class-constant lookups resolve via MRO exactly as before.
# Patched seams (Image / open / _MAX_* / _sidecar_directory_cache): the readers
# live in metadata_parser/_runtime.py behind the package get/set proxy in
# __init__.py (stage 3); see tests/test_metadata_parser_pins.py.
import json
import re
import threading
from typing import Dict, Any, Tuple, List, Optional, Set

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

    _TEXT_WIDGET_INPUT_NAMES = {
        "text",
        "prompt",
        "positive",
        "negative",
        "string",
        "STRING",
        "text_0",
        "t5xxl",
        "text_g",
        "text_l",
        "clip_l",
        "clip_g",
        "user_prompt",
        "user_text",
        "value",
        "result",
        "prompt1",
        "prompt2",
        "prompt3",
        "text1",
        "text2",
        "part1",
        "part2",
        "part3",
        "part4",
    }

    # Nodes that show the value of their upstream input and keep it as a
    # widget when the workflow is saved.
    _DISPLAY_NODE_MARKERS = ("showtext", "previewany", "showanything", "displayany")

    @classmethod
    def _is_comfyui_display_node(cls, class_type: Any) -> bool:
        lowered = str(class_type or "").lower()
        return any(marker in lowered for marker in cls._DISPLAY_NODE_MARKERS)

    @staticmethod
    def _unwrap_comfyui_widget_text(value: Any) -> Optional[str]:
        """Flatten ShowText-style list widgets and skip empty/non-text values."""
        if isinstance(value, str):
            text = value.strip()
            return text or None
        if isinstance(value, (list, tuple)) and value:
            return ComfyUIGraphMixin._unwrap_comfyui_widget_text(value[0])
        return None

    def _comfyui_bus_name(self, node: Dict[str, Any]) -> Optional[str]:
        """kjnodes SetNode/GetNode bus name from widgets, stamped field, or title."""
        if not isinstance(node, dict):
            return None
        stamped = node.get("_bus_name")
        if isinstance(stamped, str) and stamped.strip():
            return stamped.strip()
        widgets = node.get("widgets_values")
        if isinstance(widgets, list) and widgets:
            name = self._unwrap_comfyui_widget_text(widgets[0])
            if name:
                return name
        title = str(node.get("title") or "").strip()
        for prefix in ("Set_", "Get_"):
            if title.startswith(prefix) and title[len(prefix):]:
                return title[len(prefix):]
        return None

    def _find_comfyui_set_node(self, nodes: Dict[str, dict], bus_name: Optional[str]) -> Optional[str]:
        """Return the SetNode id that publishes ``bus_name``."""
        if not bus_name:
            return None
        for node_id, node in nodes.items():
            if not isinstance(node, dict):
                continue
            class_type = str(node.get("class_type") or node.get("type") or "")
            if class_type not in ("SetNode", "Set"):
                continue
            if self._comfyui_bus_name(node) == bus_name:
                return str(node_id)
        return None

    def _is_comfyui_sampler_node(self, class_type: str, inputs: Optional[Dict[str, Any]] = None) -> bool:
        """True for KSampler-family nodes and custom samplers with pos/neg inputs."""
        ct = str(class_type or "")
        if any(token in ct for token in self.COMFYUI_SAMPLER_NODE_TYPES):
            return True
        if "Sampler" not in ct:
            return False
        if inputs is None:
            return True
        return "positive" in inputs or "negative" in inputs

    def _workflow_ui_to_prompt_data(self, workflow_data: Any) -> Optional[Dict[str, dict]]:
        """Convert a ComfyUI frontend workflow (nodes+links) into API prompt_data.

        Saved PNGs often omit the API ``prompt`` chunk and only embed the UI
        ``workflow``. CLIPTextEncode widgets are empty; text rides GetNode/SetNode
        buses and ShowText caches. The existing tracer speaks API-format
        ``{node_id: {class_type, inputs}}``, so this adapter is the bridge.
        """
        if isinstance(workflow_data, str):
            try:
                workflow_data = json.loads(workflow_data)
            except (json.JSONDecodeError, TypeError, ValueError):
                return None
        if not isinstance(workflow_data, dict):
            return None

        nodes_list = workflow_data.get("nodes")
        if not isinstance(nodes_list, list) or not nodes_list:
            # Already API-shaped? Leave it to the caller.
            return None

        raw_links = workflow_data.get("links") or []
        link_by_id: Dict[Any, Any] = {}
        for item in raw_links:
            if isinstance(item, (list, tuple)) and item:
                link_by_id[item[0]] = item
            elif isinstance(item, dict) and "id" in item:
                link_by_id[item["id"]] = item

        node_by_id: Dict[Any, dict] = {}
        for node in nodes_list:
            if isinstance(node, dict) and node.get("id") is not None:
                node_by_id[node["id"]] = node

        set_by_name: Dict[str, Any] = {}
        for node in nodes_list:
            if not isinstance(node, dict):
                continue
            if str(node.get("type") or "") not in ("SetNode", "Set"):
                continue
            bus = self._comfyui_bus_name(node)
            if bus and bus not in set_by_name:
                set_by_name[bus] = node.get("id")

        prompt_data: Dict[str, dict] = {}
        for node in nodes_list:
            if not isinstance(node, dict) or node.get("id") is None:
                continue
            node_id = str(node["id"])
            class_type = str(node.get("type") or node.get("class_type") or "")
            inputs: Dict[str, Any] = {}

            for inp in node.get("inputs") or []:
                if not isinstance(inp, dict):
                    continue
                name = inp.get("name")
                link_id = inp.get("link")
                if link_id is None:
                    continue
                if not name:
                    name = f"_{link_id}"
                link = link_by_id.get(link_id)
                if link is None:
                    continue
                if isinstance(link, dict):
                    src_id = link.get("origin_id", link.get("src"))
                    src_slot = link.get("origin_slot", link.get("src_slot", 0))
                else:
                    src_id = link[1] if len(link) > 1 else None
                    src_slot = link[2] if len(link) > 2 else 0
                if src_id is None:
                    continue
                src_id, src_slot = self._resolve_ui_link_source(
                    src_id, src_slot, node_by_id, link_by_id, set_by_name, set()
                )
                inputs[name] = [str(src_id), src_slot]

            widgets = node.get("widgets_values")
            widget_inputs = [
                inp
                for inp in (node.get("inputs") or [])
                if isinstance(inp, dict) and inp.get("widget") and inp.get("name")
            ]
            text_widget_inputs = [
                inp
                for inp in widget_inputs
                if str(inp.get("name")) in self._TEXT_WIDGET_INPUT_NAMES
                and inp.get("name") not in inputs
            ]
            string_widgets: List[str] = []
            if isinstance(widgets, list):
                for item in widgets:
                    text = self._unwrap_comfyui_widget_text(item)
                    if text:
                        string_widgets.append(text)
            title = str(node.get("title") or "")
            looks_negative = (
                "负面" in title
                or "negative" in title.lower()
                or "negative" in class_type.lower()
                or class_type == "easy negative"
            )
            if text_widget_inputs and string_widgets:
                if len(text_widget_inputs) == len(widgets):
                    for inp, raw in zip(text_widget_inputs, widgets):
                        text = self._unwrap_comfyui_widget_text(raw)
                        if text:
                            inputs[inp["name"]] = text
                else:
                    inputs[text_widget_inputs[0]["name"]] = string_widgets[0]

            # Only a display node stores the value that reached it. A linked
            # input on any other node keeps whatever was typed before it was
            # wired (the upstream result is never written back), so that
            # widget is not read.
            if self._is_comfyui_display_node(class_type):
                cache = self._unwrap_comfyui_widget_text(widgets)
                if cache:
                    inputs.setdefault("text_0", cache)

            has_linked_text_input = any(
                str(inp.get("name")) in self._TEXT_WIDGET_INPUT_NAMES
                and inp.get("name") in inputs
                for inp in widget_inputs
            )
            if not has_linked_text_input and not any(
                isinstance(value, str) and value.strip() for value in inputs.values()
            ):
                prompt_widget = self._first_prompt_like_widget(string_widgets)
                if prompt_widget:
                    inputs.setdefault("text", prompt_widget)
                    inputs.setdefault("negative" if looks_negative else "positive", prompt_widget)

            if looks_negative and "positive" in inputs and "negative" not in inputs:
                inputs["negative"] = inputs["positive"]

            ui_inputs = [inp for inp in (node.get("inputs") or []) if isinstance(inp, dict)]
            ui_outputs = node.get("outputs")
            prompt_data[node_id] = {
                "class_type": class_type,
                "inputs": inputs,
                "widgets_values": widgets,
                "_bus_name": self._comfyui_bus_name(node),
                # Structure the API shape has no room for: execution mode
                # (2 muted / 4 bypassed), every declared input name (an
                # unlinked system_prompt widget still marks an instruct
                # node), slot types, and "declared with no outputs" (notes).
                "_ui_mode": node.get("mode"),
                "_ui_input_names": [str(inp.get("name")) for inp in ui_inputs if inp.get("name")],
                "_ui_io": {
                    "inputs": [str(inp.get("type")) for inp in ui_inputs],
                    "outputs": [
                        str(out.get("type"))
                        for out in (ui_outputs if isinstance(ui_outputs, list) else [])
                        if isinstance(out, dict)
                    ],
                },
                "_ui_no_outputs": isinstance(ui_outputs, list) and not ui_outputs,
                # A linked text input keeps a stale hand-typed widget value:
                # the text harvest must not score this node's widgets.
                "_ui_linked_text_widget": has_linked_text_input,
            }

        return prompt_data or None

    # Input names under which a consumer takes TEXT. A system-prompt node
    # whose output lands on one of these is a text generator (LLM / VLM);
    # one whose output goes to a sampler as conditioning is an encoder that
    # merely carries a system prompt (NewBie, LLM-adapter encoders).
    # ``positive``/``negative`` are a sampler's conditioning slots, not text.
    _TEXT_SINK_INPUT_NAMES = (_TEXT_WIDGET_INPUT_NAMES - {"positive", "negative"}) | {
        "custom_prompt", "user_text", "input_text", "text_a", "text_b", "text_c",
        "string_a", "string_b", "string1", "string2", "populated_text",
    }

    def _has_comfyui_system_prompt_input(self, node: Dict[str, Any]) -> bool:
        if not isinstance(node, dict):
            return False
        inputs = node.get("inputs") if isinstance(node.get("inputs"), dict) else {}
        names = {str(key).lower() for key in inputs}
        names.update(str(name).lower() for name in (node.get("_ui_input_names") or []))
        return any(key in names for key in self.COMFYUI_INSTRUCT_INPUT_KEYS)

    # The consumer map of the graph a thread parsed last. Holding the graph
    # itself (compared by identity) keeps its id from being reused. This
    # assumes a graph dict is only mutated while it is built (extract.py and
    # the UI conversion here); an in-place edit that keeps its length would
    # get the old map back.
    _consumer_map_cache = threading.local()

    def _comfyui_consumer_map(self, nodes: Dict[str, dict]) -> Dict[str, List[Tuple[str, str]]]:
        """For each node id, the (consumer id, input key) pairs that read its output."""
        cached = getattr(self._consumer_map_cache, "entry", None)
        if cached is not None and cached[0] is nodes and cached[1] == len(nodes):
            return cached[2]
        consumers: Dict[str, List[Tuple[str, str]]] = {}
        for consumer_id, consumer in nodes.items():
            inputs = consumer.get("inputs") if isinstance(consumer, dict) and isinstance(consumer.get("inputs"), dict) else {}
            for key, value in inputs.items():
                for ref in self._iter_comfyui_input_refs(value):
                    consumers.setdefault(ref, []).append((consumer_id, str(key).lower()))
        self._consumer_map_cache.entry = (nodes, len(nodes), consumers)
        return consumers

    def _comfyui_output_reaches_text_input(self, nodes: Dict[str, dict], node_id: str) -> bool:
        """Walk consumers downstream: does this node's output land on a text input?

        Stops at generation roots; passes through anything else (PreviewAny,
        switches), so an LLM -> preview -> primitive.value chain is text.
        """
        consumers = self._comfyui_consumer_map(nodes)
        seen: Set[str] = {node_id}
        queue = [node_id]
        while queue:
            current = queue.pop()
            for consumer_id, key in consumers.get(current, []):
                if key in self._TEXT_SINK_INPUT_NAMES or self._is_numbered_text_key(key):
                    return True
                if consumer_id in seen:
                    continue
                seen.add(consumer_id)
                consumer = nodes.get(consumer_id)
                if isinstance(consumer, dict) and self._is_comfyui_generation_root(consumer):
                    continue
                queue.append(consumer_id)
        return False

    def _is_comfyui_instruct_node(
        self,
        node: Dict[str, Any],
        nodes: Optional[Dict[str, dict]] = None,
        node_id: Optional[str] = None,
    ) -> bool:
        """True for an LLM/VLM that WRITES text: a system-prompt node whose output is text.

        Decided by structure: the UI graph's declared output types when
        present (STRING out = generator), else by where the output lands in
        the API graph (a text input = generator; a sampler's conditioning =
        encoder). Without any graph context a system-prompt node counts as a
        generator.
        """
        if not self._has_comfyui_system_prompt_input(node):
            return False
        io = node.get("_ui_io") if isinstance(node.get("_ui_io"), dict) else {}
        outputs = [str(item).upper() for item in (io.get("outputs") or [])]
        if outputs:
            return "STRING" in outputs
        if nodes is None or node_id is None:
            return True
        return self._comfyui_output_reaches_text_input(nodes, str(node_id))

    def _is_comfyui_generation_root(self, node: Dict[str, Any]) -> bool:
        """True for a node that turns conditioning into pixels.

        KSampler-family and custom ``*Sampler`` classes, a node with a model
        and positive/negative inputs, a node carrying both a seed and a step
        count (all-in-one generators), or a UI node that takes MODEL and
        emits IMAGE/LATENT.
        """
        if not isinstance(node, dict):
            return False
        class_type = str(node.get("class_type") or "")
        inputs = node.get("inputs") if isinstance(node.get("inputs"), dict) else {}
        if self._is_comfyui_sampler_node(class_type, inputs):
            return True
        if "model" in inputs and ("positive" in inputs or "negative" in inputs):
            return True
        names = {str(key).lower() for key in inputs}
        if names & set(self.COMFYUI_SEED_INPUT_KEYS) and names & set(self.COMFYUI_STEPS_INPUT_KEYS):
            return True
        io = node.get("_ui_io") or {}
        return "MODEL" in (io.get("inputs") or []) and bool(
            {"IMAGE", "LATENT"} & set(io.get("outputs") or [])
        )

    def _is_comfyui_prompt_to_image_node(self, node: Dict[str, Any], consumed_as_image: bool) -> bool:
        """A node that takes a ``prompt`` and emits an image: a generation step
        without a sampler of its own (cloud / API image nodes)."""
        if not isinstance(node, dict):
            return False
        inputs = node.get("inputs") if isinstance(node.get("inputs"), dict) else {}
        names = {str(key).lower() for key in inputs}
        names.update(str(name).lower() for name in (node.get("_ui_input_names") or []))
        if "prompt" not in names:
            return False
        io = node.get("_ui_io") if isinstance(node.get("_ui_io"), dict) else {}
        return consumed_as_image or "IMAGE" in [str(item).upper() for item in (io.get("outputs") or [])]

    # Link inputs that never carry prompt text. What sits behind them (a
    # LoRA manager's string, a note feeding the model) is not a prompt.
    _NON_TEXT_LINK_KEYS = frozenset({
        "model", "clip", "vae", "latent_image", "latent", "samples", "sigmas",
        "noise", "sampler", "upscale_model", "control_net", "lora_stack",
    })

    # A model link normally leads to loaders and LoRA stacks; these class-name
    # markers keep them a barrier.
    _MODEL_SOURCE_MARKERS = ("lora", "load", "checkpoint")
    _PATCH_TEXT_KEY_PREFIXES = ("text", "prompt", "string", "artist", "cond")

    def _is_text_bearing_model_patch(self, node: Any, nodes: Dict[str, dict]) -> bool:
        """A node met on a model link that conditions on text of its own.

        AttentionCouple (``cond_1``/``cond_2``) and artist cross-attention
        (``artist_N``) patch the model yet carry prompt text the sampler's
        positive input never reaches. Loaders and LoRA stacks do not count,
        and neither does a patch that only rewrites model settings.
        """
        if not isinstance(node, dict) or not isinstance(node.get("inputs"), dict):
            return False
        class_type = str(node.get("class_type") or "").lower()
        if any(marker in class_type for marker in self._MODEL_SOURCE_MARKERS):
            return False
        for key, value in node["inputs"].items():
            lowered = str(key).lower()
            if lowered in self._NON_TEXT_LINK_KEYS:
                continue
            if any(ref in nodes for ref in self._iter_comfyui_input_refs(value)):
                return True
            if isinstance(value, str) and value.strip() and lowered.startswith(self._PATCH_TEXT_KEY_PREFIXES):
                return True
        return False

    def _comfyui_prompt_eligible_nodes(self, nodes: Dict[str, dict]) -> Tuple[Set[str], Set[str]]:
        """Which nodes may hold the prompt, and which must never contribute text.

        The sampler trace is exact; the scored harvest behind it is not, so
        the harvest only sees text that can have reached a generation step:

        1. With a generation root (see ``_is_comfyui_generation_root``):
           every node upstream of a root through a link that can carry text
           (not model/clip/vae/latent links, see ``_NON_TEXT_LINK_KEYS``; a model link is
           followed into a patch node that holds text of its own, see
           ``_is_text_bearing_model_patch``), plus nodes consuming an upstream
           value (ShowText displays of the executed prompt). An instruct node
           is a barrier: kept as an anchor for its displays, it contributes
           no text and nothing behind its instruction inputs is reached.
        2. Without a root, text encoders play that role.
        3. Without either, this graph has no generation step: only standalone
           text holders (no links in or out) are kept, because such a graph
           is a prompt container, not a pipeline. Text wired into a pipeline
           that generates nothing (overlays, filters, device names) is a
           setting of that pipeline.

        Bypassed/muted UI nodes and note nodes (declared without outputs)
        never contribute.
        """
        link_refs: Dict[str, List[str]] = {}
        walk_refs: Dict[str, List[str]] = {}
        consumed: Set[str] = set()
        for node_id, node in nodes.items():
            inputs = node.get("inputs") if isinstance(node, dict) and isinstance(node.get("inputs"), dict) else {}
            refs = [ref for ref in self._iter_comfyui_input_refs(inputs) if ref in nodes and ref != node_id]
            link_refs[node_id] = refs
            walk_refs[node_id] = [
                ref
                for key, value in inputs.items()
                if str(key).lower() not in self._NON_TEXT_LINK_KEYS or str(key).lower() == "model"
                for ref in self._iter_comfyui_input_refs(value)
                if ref in nodes and ref != node_id
                and (str(key).lower() != "model" or self._is_text_bearing_model_patch(nodes[ref], nodes))
            ]
            consumed.update(refs)
        instruct = {
            node_id for node_id, node in nodes.items()
            if self._is_comfyui_instruct_node(node, nodes, node_id)
        }
        image_consumed: Set[str] = set()
        for node in nodes.values():
            inputs = node.get("inputs") if isinstance(node, dict) and isinstance(node.get("inputs"), dict) else {}
            for key, value in inputs.items():
                lowered = str(key).lower()
                if lowered in self.COMFYUI_IMAGE_BRIDGE_KEYS or lowered.startswith("image"):
                    image_consumed.update(ref for ref in self._iter_comfyui_input_refs(value) if ref in nodes)
        roots = [node_id for node_id, node in nodes.items() if self._is_comfyui_generation_root(node)]
        roots.extend(
            node_id for node_id, node in nodes.items()
            if node_id not in roots
            and self._is_comfyui_prompt_to_image_node(node, node_id in image_consumed)
        )
        if not roots:
            roots = [
                node_id for node_id, node in nodes.items()
                if isinstance(node, dict)
                and any(marker in str(node.get("class_type") or "") for marker in self.COMFYUI_TEXT_NODE_TYPES)
            ]
        eligible: Set[str] = set()
        if roots:
            queue = list(roots)
            while queue:
                node_id = queue.pop()
                if node_id in eligible:
                    continue
                eligible.add(node_id)
                if node_id in instruct:
                    continue
                queue.extend(walk_refs.get(node_id, []))
            for node_id, refs in walk_refs.items():
                if node_id in eligible or node_id in instruct:
                    continue
                if any(ref in eligible for ref in refs):
                    eligible.add(node_id)
        else:
            eligible = {
                node_id for node_id, refs in link_refs.items()
                if not refs and node_id not in consumed and node_id not in instruct
            }
        for node_id in list(eligible):
            node = nodes.get(node_id)
            if not isinstance(node, dict):
                continue
            if node.get("_ui_mode") in (2, 4) or node.get("_ui_no_outputs"):
                eligible.discard(node_id)
        return eligible, instruct

    def _first_prompt_like_widget(self, string_widgets: List[str]) -> Optional[str]:
        """Pick the first widget string that reads as a prompt, any node class."""
        if not string_widgets:
            return None
        try:
            from prompt_text_scorer import (
                PROMPT_SCORE_FLOOR,
                looks_like_formula,
                looks_like_non_prompt_value,
                score_prompt_likeness,
            )
        except Exception:
            return None
        for text in string_widgets:
            if looks_like_non_prompt_value(text) or looks_like_formula(text):
                continue
            if score_prompt_likeness(text)["score"] >= PROMPT_SCORE_FLOOR:
                return text
        return None

    def _resolve_ui_link_source(
        self,
        src_id: Any,
        src_slot: Any,
        node_by_id: Dict[Any, dict],
        link_by_id: Dict[Any, Any],
        set_by_name: Dict[str, Any],
        seen: set,
    ) -> Tuple[Any, Any]:
        """Walk Get/Set buses and Reroute nodes to the real upstream source."""
        if src_id in seen:
            return src_id, src_slot
        seen.add(src_id)
        src_node = node_by_id.get(src_id)
        if not isinstance(src_node, dict):
            return src_id, src_slot
        ntype = str(src_node.get("type") or src_node.get("class_type") or "")
        if ntype in ("GetNode", "Get"):
            bus = self._comfyui_bus_name(src_node)
            set_id = set_by_name.get(bus) if bus else None
            if set_id is not None:
                return self._resolve_ui_link_source(
                    set_id, 0, node_by_id, link_by_id, set_by_name, seen
                )
            return src_id, src_slot
        if ntype in ("Reroute", "ReroutePrimitive"):
            for inp in src_node.get("inputs") or []:
                if not isinstance(inp, dict) or inp.get("link") is None:
                    continue
                link = link_by_id.get(inp.get("link"))
                if link is None:
                    continue
                if isinstance(link, dict):
                    next_id = link.get("origin_id", link.get("src"))
                    next_slot = link.get("origin_slot", link.get("src_slot", 0))
                else:
                    next_id = link[1] if len(link) > 1 else None
                    next_slot = link[2] if len(link) > 2 else 0
                if next_id is None:
                    continue
                return self._resolve_ui_link_source(
                    next_id, next_slot, node_by_id, link_by_id, set_by_name, seen
                )
        return src_id, src_slot

