# =============================================================================
# metadata_parser.comfyui.text_trace - metadata_parser decomposition stages 1+2 (2026-07-13).
# Extracted VERBATIM from backend/metadata_parser.py @ c06d374 (4,912 lines).
# Source line ranges (original file): 3819-4374.
# Mixin: ComfyUI text tracing: sampler prompts, node text extraction, workflow text.
# self.* calls and class-constant lookups resolve via MRO exactly as before.
# Patched seams (Image / open / _MAX_* / _sidecar_directory_cache) live ONLY
# in metadata_parser/__init__.py; see tests/test_metadata_parser_pins.py.
import json
import logging
from typing import Optional, Dict, Any, Tuple, List, Set

logger = logging.getLogger(__name__)

class ComfyUITextTraceMixin:
    """ComfyUI text tracing: sampler prompts, node text extraction, workflow text."""

    def _trace_sampler_prompts(self, nodes: Dict[str, dict]) -> Tuple[Optional[str], Optional[str]]:
        """
        Trace KSampler positive/negative inputs back through the node graph
        to find the actual text content.

        Fallback strategy when no sampler is found:
        1. If exactly 2 CLIPTextEncode nodes → first=positive, second=negative
        2. If 1 CLIPTextEncode node → positive only
        3. If 3+ CLIPTextEncode nodes → all as positive
        """
        positive_texts = []
        negative_texts = []

        # Find KSampler nodes
        sampler_nodes = []
        for node_id, node in nodes.items():
            class_type = node.get("class_type", "")
            if any(st in class_type for st in ["KSampler", "SamplerCustom"]):
                sampler_nodes.append((node_id, node))

        if not sampler_nodes:
            # Fallback: no sampler found, try to find CLIPTextEncode nodes directly
            clip_nodes = []
            for node_id, node in nodes.items():
                class_type = node.get("class_type", "")
                if any(clip_type in class_type for clip_type in self.COMFYUI_TEXT_NODE_TYPES):
                    clip_nodes.append((node_id, node))

            if len(clip_nodes) == 2:
                # Two CLIP nodes: assume first=positive, second=negative
                texts = self._trace_to_text(clip_nodes[0][0], nodes, set())
                positive_texts.extend(texts)
                texts = self._trace_to_text(clip_nodes[1][0], nodes, set())
                negative_texts.extend(texts)
            elif len(clip_nodes) == 1:
                # Single CLIP node: positive only
                texts = self._trace_to_text(clip_nodes[0][0], nodes, set())
                positive_texts.extend(texts)
            elif len(clip_nodes) > 2:
                # Multiple CLIP nodes: all as positive (common in multi-prompt workflows)
                for node_id, _ in clip_nodes:
                    texts = self._trace_to_text(node_id, nodes, set())
                    positive_texts.extend(texts)

            pos_result = "\n".join(positive_texts) if positive_texts else None
            neg_result = "\n".join(negative_texts) if negative_texts else None
            return (pos_result, neg_result)

        # For each sampler, trace its positive and negative inputs
        for sampler_id, sampler_node in sampler_nodes:
            inputs = sampler_node.get("inputs", {})

            pos_ref = inputs.get("positive")
            neg_ref = inputs.get("negative")

            # SamplerCustomAdvanced uses a guider node instead of direct
            # positive/negative.  Follow the guider reference to find them.
            if pos_ref is None and neg_ref is None:
                guider_ref = inputs.get("guider")
                if isinstance(guider_ref, (list, tuple)) and len(guider_ref) >= 2:
                    guider_node = nodes.get(str(guider_ref[0]), {})
                    guider_inputs = guider_node.get("inputs", {})
                    pos_ref = guider_inputs.get("positive")
                    neg_ref = guider_inputs.get("negative")
                    if pos_ref is None:
                        pos_ref = guider_inputs.get("cond")

            # Trace positive conditioning
            if pos_ref:
                texts = self._trace_to_text(pos_ref, nodes, set(), side="positive")
                positive_texts.extend(texts)

            # Trace negative conditioning
            if neg_ref:
                texts = self._trace_to_text(neg_ref, nodes, set(), side="negative")
                negative_texts.extend(texts)

        pos_result = "\n".join(positive_texts) if positive_texts else None
        neg_result = "\n".join(negative_texts) if negative_texts else None

        return (pos_result, neg_result)

    @staticmethod
    def _extract_danbooru_gallery_text(inputs: dict) -> Optional[str]:
        """Parse DanbooruGallery ``selection_data`` into a prompt string.

        ``selection_data`` is serialized at QUEUE time, so it reflects the
        CURRENT run: ``{"selections": [{"post_id": ..., "prompt": ...}]}``.
        Multiple selections are joined with ", ". Malformed payloads yield
        ``None`` (never raise).
        """
        raw = inputs.get("selection_data")
        if not isinstance(raw, str) or not raw.strip():
            return None
        try:
            data = json.loads(raw)
        except (ValueError, TypeError):
            return None
        if not isinstance(data, dict):
            return None
        selections = data.get("selections")
        if not isinstance(selections, list):
            return None
        prompts = []
        for item in selections:
            if not isinstance(item, dict):
                continue
            prompt = item.get("prompt")
            if isinstance(prompt, str) and prompt.strip():
                prompts.append(prompt.strip())
        return ", ".join(prompts) if prompts else None

    def _trace_to_text(self, ref: Any, nodes: Dict[str, dict], visited: Set[str], depth: int = 0,
                       side: Optional[str] = None) -> List[str]:
        """
        Recursively trace a node reference back to find text content.
        Handles node connections (lists like [node_id, output_index])
        and direct string values. ``side`` ("positive"/"negative") keeps a
        trace from resolving through the OTHER side's input on
        dual-conditioning nodes (ControlNet, guiders).
        """
        traced = self._trace_to_text_with_source(ref, nodes, visited, depth, side=side)
        return [item["text"] for item in traced if item.get("text")]

    def _trace_to_text_with_source(self, ref: Any, nodes: Dict[str, dict], visited: Set[str], depth: int = 0,
                                   side: Optional[str] = None) -> List[Dict[str, Any]]:
        """Trace text and keep source node metadata."""
        if depth > 20:
            return []

        if isinstance(ref, str):
            if ref in nodes:
                return self._extract_text_from_node_with_source(ref, nodes, visited, depth, side=side)
            return [{
                "text": ref,
                "source_node_id": None,
                "source_class_type": "literal",
                "source_key": "literal",
            }] if ref.strip() else []

        if isinstance(ref, list) and len(ref) >= 2:
            target_id = str(ref[0])
            return self._extract_text_from_node_with_source(target_id, nodes, visited, depth, side=side)

        return []

    def _extract_text_from_node(self, node_id: str, nodes: Dict[str, dict], visited: Set[str], depth: int = 0) -> List[str]:
        """Extract text from a specific node, following connections as needed."""
        if node_id in visited:
            return []
        visited.add(node_id)

        node = nodes.get(node_id)
        if not node:
            return []

        class_type = node.get("class_type", "")
        inputs = node.get("inputs", {})
        texts = []

        # Text encoder nodes - get the text input
        if any(ct in class_type for ct in ["CLIPTextEncode", "NewBieCLIPTextEncode", "TextEncodeQwen"]):
            text_val = inputs.get("text", inputs.get("prompt", inputs.get("user_prompt", "")))
            if isinstance(text_val, str) and text_val.strip():
                texts.append(text_val)
            elif isinstance(text_val, (list, tuple)):
                # Follow the connection
                sub_texts = self._trace_to_text(text_val, nodes, visited, depth + 1)
                texts.extend(sub_texts)

            # Also check system_prompt for some custom nodes
            sys_prompt = inputs.get("system_prompt", "")
            if isinstance(sys_prompt, (list, tuple)):
                # Follow connection but don't include system prompts in output
                pass

        # String/text concatenation/join nodes (CR Text Concatenate, StringConcatenate, JoinStrings, easy promptConcat, etc.)
        # MUST be before StringConstant/Text check since "CR Text Concatenate" contains "Text"
        elif any(kw in class_type for kw in ["Concatenate", "Concat", "JoinString", "Join"]):
            # Prioritize known text input keys first (preserves order)
            priority_keys = ["string_a", "string_b", "string1", "string2", "text1", "text2",
                             "text_a", "text_b", "prompt1", "prompt2", "prompt3",
                             "string_1", "string_2"]
            # Then dynamically match numbered keys (string_3, string_4, ..., string_N)
            numbered_keys = [key for key in inputs.keys() if self._is_numbered_text_key(key) and key not in priority_keys]
            # Combine: fixed keys first, then numbered keys sorted naturally
            all_keys = priority_keys + sorted(numbered_keys, key=lambda k: (k.rsplit("_", 1)[0], int(k.rsplit("_", 1)[1])))

            for key in all_keys:
                val = inputs.get(key)
                if val is None:
                    continue
                if isinstance(val, str) and val.strip():
                    texts.append(val)
                elif isinstance(val, (list, tuple)):
                    sub_texts = self._trace_to_text(val, nodes, visited, depth + 1)
                    texts.extend(sub_texts)
            # Also follow delimiter/separator connections (they might chain to text)
            for key in ["delimiter", "separator"]:
                val = inputs.get(key)
                if val and isinstance(val, (list, tuple)):
                    sub_texts = self._trace_to_text(val, nodes, visited, depth + 1)
                    texts.extend(sub_texts)

        # Conditioning combine/concat - follow both conditioning inputs
        # MUST be before generic "Prompt" check since ConditioningConcat contains no text
        elif "ConditioningCombine" in class_type or "ConditioningConcat" in class_type:
            for key in ["conditioning_1", "conditioning_2", "cond1", "cond2"]:
                val = inputs.get(key)
                if val:
                    sub_texts = self._trace_to_text(val, nodes, visited, depth + 1)
                    texts.extend(sub_texts)

        # ControlNet nodes - follow the positive/negative conditioning through
        elif "ControlNet" in class_type:
            for key in ["positive", "negative", "conditioning"]:
                val = inputs.get(key)
                if val and isinstance(val, (list, tuple)):
                    sub_texts = self._trace_to_text(val, nodes, visited, depth + 1)
                    texts.extend(sub_texts)

        # ShowText nodes (pysssss etc.) - text_0 is a display cache serialized
        # at QUEUE time, so it can hold STALE output from a PREVIOUS run when
        # the text is generated at runtime (e.g. by a VLM). When the live
        # text input is a link, trace upstream FIRST; fall back to the cached
        # literal only when upstream derivation yields nothing.
        elif "ShowText" in class_type:
            upstream_texts: List[str] = []
            for key in ["text", "string"]:
                val = inputs.get(key)
                if isinstance(val, (list, tuple)):
                    upstream_texts.extend(self._trace_to_text(val, nodes, visited, depth + 1))
            if upstream_texts:
                texts.extend(upstream_texts)
            else:
                for key in ["text_0", "text", "string"]:
                    val = inputs.get(key)
                    if isinstance(val, str) and val.strip():
                        texts.append(val)
                        break

        # DanbooruGallery nodes - selection_data is a QUEUE-TIME literal, so
        # it reflects the CURRENT run's selected post(s) (unlike ShowText
        # display caches).
        elif "DanbooruGallery" in class_type:
            danbooru_text = self._extract_danbooru_gallery_text(inputs)
            if danbooru_text:
                texts.append(danbooru_text)

        # StringFunction nodes (pysssss) - have text_a/text_b/text_c inputs
        # and a 'result' cached output. Prefer result if available, else trace inputs.
        elif "StringFunction" in class_type:
            result_val = inputs.get("result", "")
            if isinstance(result_val, str) and result_val.strip():
                texts.append(result_val)
            else:
                # Follow text_a, text_b, text_c inputs
                for key in ["text_a", "text_b", "text_c"]:
                    val = inputs.get(key)
                    if val is None:
                        continue
                    if isinstance(val, str) and val.strip():
                        texts.append(val)
                    elif isinstance(val, (list, tuple)):
                        sub_texts = self._trace_to_text(val, nodes, visited, depth + 1)
                        texts.extend(sub_texts)

        # LLM/AI prompt formatter nodes - extract user_text as the prompt
        elif any(kw in class_type for kw in ["LLM", "Formatter", "ChatGPT"]):
            for key in ["user_text", "text", "prompt", "user_prompt", "input_text"]:
                val = inputs.get(key)
                if val is None:
                    continue
                if isinstance(val, str) and val.strip():
                    texts.append(val)
                elif isinstance(val, (list, tuple)):
                    sub_texts = self._trace_to_text(val, nodes, visited, depth + 1)
                    texts.extend(sub_texts)

        # Prompt text nodes (CR Prompt Text, WeiLin prompt nodes, etc.)
        elif any(kw in class_type for kw in ["Prompt", "prompt"]):
            for key in ["prompt", "positive", "negative", "text", "string",
                         "user_text", "user_prompt"]:
                val = inputs.get(key)
                if val is None:
                    continue
                if isinstance(val, str) and val.strip():
                    texts.append(val)
                elif isinstance(val, (list, tuple)):
                    sub_texts = self._trace_to_text(val, nodes, visited, depth + 1)
                    texts.extend(sub_texts)

        # String constant nodes - return the string value
        # This is intentionally AFTER Concatenate/Prompt checks since those class_types
        # can contain substrings like "Text" or "String" (e.g. "CR Text Concatenate")
        elif any(ct in class_type for ct in ["StringConstant", "String", "Text", "Note", "PrimitiveNode"]):
            text_val = inputs.get("string", inputs.get("String", inputs.get("text", inputs.get("value", ""))))
            if isinstance(text_val, str) and text_val.strip():
                texts.append(text_val)
            elif isinstance(text_val, (list, tuple)):
                sub_texts = self._trace_to_text(text_val, nodes, visited, depth + 1)
                texts.extend(sub_texts)

        # Generic fallback: check for any text-like input or cached result
        # Also handles FluxKontextMultiReferenceLatentMethod (follow conditioning ref)
        else:
            for key in ["text", "text_0", "string", "prompt", "user_prompt",
                         "positive", "negative", "conditioning", "text1", "text2",
                         "string_a", "string_b", "user_text", "value", "result"]:
                val = inputs.get(key)
                if val is None:
                    continue
                if isinstance(val, str) and val.strip():
                    texts.append(val)
                elif isinstance(val, (list, tuple)):
                    sub_texts = self._trace_to_text(val, nodes, visited, depth + 1)
                    texts.extend(sub_texts)

        # VLM/image-inference dead-end bridging: nodes whose text output is
        # generated at RUNTIME (e.g. QwenTE_ImageInfer) carry no recoverable
        # text in the serialized graph. Follow their image input upstream —
        # it can reach a node whose queue-time literal IS recoverable (e.g.
        # DanbooruGallery). Only image-typed links are followed here; VLM
        # instruction ("提示词") and system ("系统提示词"/"system") inputs are
        # never extracted on this bridging path.
        if not texts:
            for key in self.COMFYUI_IMAGE_BRIDGE_KEYS:
                val = inputs.get(key)
                if isinstance(val, (list, tuple)) and len(val) >= 2:
                    sub_texts = self._trace_to_text(val, nodes, visited, depth + 1)
                    if sub_texts:
                        texts.extend(sub_texts)
                        break

        return texts

    def _extract_text_from_node_with_source(self, node_id: str, nodes: Dict[str, dict], visited: Set[str], depth: int = 0,
                                             side: Optional[str] = None) -> List[Dict[str, Any]]:
        """Extract text plus source metadata from a node.

        ``side`` ("positive"/"negative"/None) marks which sampler input the
        trace started from, so dual-conditioning nodes (ControlNetApply,
        guiders) resolve through THEIR side's link and never the other one.
        """
        if node_id in visited:
            return []

        node = nodes.get(node_id)
        if not node:
            return []

        class_type = node.get("class_type", "")
        inputs = node.get("inputs", {})

        # DanbooruGallery nodes - selection_data is a QUEUE-TIME literal that
        # reflects the CURRENT run's selected post(s).
        if "DanbooruGallery" in class_type:
            danbooru_text = self._extract_danbooru_gallery_text(inputs)
            if danbooru_text:
                return [{
                    "text": danbooru_text,
                    "source_node_id": node_id,
                    "source_class_type": class_type,
                    "source_key": "selection_data",
                }]

        # ShowText display caches (text_0) are serialized at QUEUE time and
        # can be STALE; prefer the live upstream link, cache as fallback only.
        if "ShowText" in class_type:
            nested_visited = set(visited)
            nested_visited.add(node_id)
            for key in ["text", "string"]:
                val = inputs.get(key)
                if isinstance(val, (list, tuple)):
                    traced = self._trace_to_text_with_source(val, nodes, nested_visited, depth + 1, side=side)
                    if traced:
                        return traced
            for key in ["text_0", "text", "string"]:
                val = inputs.get(key)
                if isinstance(val, str) and val.strip():
                    return [{
                        "text": val,
                        "source_node_id": node_id,
                        "source_class_type": class_type,
                        "source_key": key,
                    }]
            return []

        # Join/Concat nodes use numbered keys (string_1, string_2, …)
        if any(kw in class_type for kw in ["Concatenate", "Concat", "JoinString", "Join"]):
            nested_visited = set(visited)
            nested_visited.add(node_id)
            results: List[Dict[str, Any]] = []
            # Prioritize known text input keys first (preserves order)
            priority_keys = ["string_a", "string_b", "string1", "string2",
                             "text1", "text2", "text_a", "text_b",
                             "prompt1", "prompt2", "prompt3",
                             "string_1", "string_2", "string_3", "string_4"]
            # Then dynamically match numbered keys (string_5, string_6, ..., string_N)
            numbered_keys = [key for key in inputs.keys() if self._is_numbered_text_key(key) and key not in priority_keys]
            # Combine: fixed keys first, then numbered keys sorted naturally
            all_keys = priority_keys + sorted(numbered_keys, key=lambda k: (k.rsplit("_", 1)[0], int(k.rsplit("_", 1)[1])))

            for key in all_keys:
                val = inputs.get(key)
                if val is None:
                    continue
                if isinstance(val, str) and val.strip():
                    results.append({
                        "text": val,
                        "source_node_id": node_id,
                        "source_class_type": class_type,
                        "source_key": key,
                    })
                elif isinstance(val, (list, tuple)):
                    traced = self._trace_to_text_with_source(val, nodes, nested_visited, depth + 1, side=side)
                    results.extend(traced)
            if results:
                return results

        # "base_prompt" (AnimaArtistPack) and the SAME-side conditioning
        # channel (ControlNet/guider-style processors) carry the prompt
        # through custom conditioning nodes. The OTHER side's channel is
        # excluded: tracing KSampler.negative through ControlNetApply must
        # ride its "negative" input, never resolve via "positive" (corpus
        # case controlnet-apply-chain caught exactly that).
        side_channel = "negative" if side == "negative" else "positive"
        for key in ["text_0", "text", "prompt", "base_prompt", "user_prompt",
                    side_channel, "string", "String", "value", "result",
                    "conditioning"]:
            value = inputs.get(key)
            if isinstance(value, str) and value.strip():
                return [{
                    "text": value,
                    "source_node_id": node_id,
                    "source_class_type": class_type,
                    "source_key": key,
                }]
            if isinstance(value, (list, tuple)):
                nested_visited = set(visited)
                nested_visited.add(node_id)
                traced = self._trace_to_text_with_source(value, nodes, nested_visited, depth + 1, side=side)
                if traced:
                    return traced

        # VLM/image-inference dead-end bridging: follow image-typed links only
        # (see _extract_text_from_node for rationale); instruction/system
        # inputs are never followed here.
        bridge_visited = set(visited)
        bridge_visited.add(node_id)
        for key in self.COMFYUI_IMAGE_BRIDGE_KEYS:
            val = inputs.get(key)
            if isinstance(val, (list, tuple)) and len(val) >= 2:
                traced = self._trace_to_text_with_source(val, nodes, bridge_visited, depth + 1, side=side)
                if traced:
                    return traced

        # Conditioning bridge (v3.5.0): custom conditioning processors hide
        # the prompt behind node-specific link keys (e.g. AnimaArtistCrossAttn
        # → artist_pack → AnimaArtistPack → base_prompt). After every known
        # text key missed, follow the remaining links except known non-text
        # plumbing — the first chain that yields text wins. Only reached when
        # the node would otherwise dead-end, so already-parsing workflows are
        # unaffected. The opposite side's channel stays off-limits here too.
        opposite_channel = "positive" if side == "negative" else "negative"
        for key, val in inputs.items():
            if not isinstance(val, (list, tuple)) or len(val) < 2:
                continue
            lowered = str(key).lower()
            if lowered in self.COMFYUI_COND_BRIDGE_EXCLUDE_KEYS:
                continue
            if lowered in self.COMFYUI_IMAGE_BRIDGE_KEYS:
                continue
            if lowered == opposite_channel:
                continue
            traced = self._trace_to_text_with_source(val, nodes, bridge_visited, depth + 1, side=side)
            if traced:
                return traced

        return []

    def _collect_text_from_nodes(self, nodes: Dict[str, dict]) -> Tuple[Optional[str], Optional[str]]:
        """Generic last-resort harvest: score EVERY string in the graph.

        v3.5.0 L2 rewrite. The old version had two stages where a partial
        hit in stage 1 (e.g. only the negative CLIPTextEncode is a literal,
        the positive rides custom links) returned early and PERMANENTLY
        shadowed the whole-graph scan — one of the two reasons an owner
        folder of 657 images parsed with empty positives. Now every node's
        every string value is scored for prompt-likeness (danbooru-vocab
        hit ratio OR comma structure — see prompt_text_scorer) in a single
        pass; encoder-ish nodes only add a prior bonus, never a monopoly.
        """
        try:
            from prompt_text_scorer import harvest_prompt_candidates, pick_positive_negative

            candidates = harvest_prompt_candidates(nodes, self.COMFYUI_TEXT_NODE_TYPES)
            return pick_positive_negative(candidates)
        except Exception as exc:  # scorer must never take the parser down
            logger.debug("prompt text harvest failed: %s", exc)
            return (None, None)

    def _looks_like_negative_prompt(self, text: str) -> bool:
        """Heuristic to detect if a text is a negative prompt."""
        lower = text.lower().strip()
        negative_indicators = [
            "worst quality", "low quality", "bad quality", "lowres",
            "bad anatomy", "worst hands", "deformed", "blurry",
            "low_resolution", "medium_resolution", "low_score",
            "pixelated", "compression artifacts", "jpeg artifacts",
            "bad_anatomy", "worst_hands",
        ]
        # Count how many negative indicators are present
        matches = sum(1 for indicator in negative_indicators if indicator in lower)
        # If 3+ negative quality indicators, likely a negative prompt
        return matches >= 3

    def _collect_text_from_nodes_as_nodes(self, nodes: Dict[str, dict]) -> Optional[List[Dict[str, Any]]]:
        """Collect text-bearing nodes in a frontend-friendly structure."""
        prompt_nodes = self._collect_prompt_nodes(nodes)
        return prompt_nodes if prompt_nodes else None

    def _extract_from_workflow(self, workflow: dict) -> Tuple[Optional[str], Optional[str]]:
        """
        Extract prompts from ComfyUI workflow format (nodes with widgets_values).
        This is a fallback when prompt data is missing or empty.
        """
        positive_candidates = []
        negative_candidates = []

        nodes = workflow.get("nodes", [])
        if not isinstance(nodes, list):
            return (None, None)

        for node in nodes:
            if not isinstance(node, dict):
                continue
            ntype = node.get("type", "")
            widgets = node.get("widgets_values", [])

            if not isinstance(widgets, list):
                continue

            # Look for CLIPTextEncode nodes with text in widgets
            if "CLIPTextEncode" in ntype or "TextEncode" in ntype:
                for w in widgets:
                    if isinstance(w, str) and len(w.strip()) > 3:
                        if self._looks_like_negative_prompt(w):
                            negative_candidates.append(w)
                        else:
                            positive_candidates.append(w)

        pos = "\n".join(positive_candidates) if positive_candidates else None
        neg = "\n".join(negative_candidates) if negative_candidates else None
        return (pos, neg)

