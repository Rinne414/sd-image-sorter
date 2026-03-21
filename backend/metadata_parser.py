"""
Metadata parser for Stable Diffusion generated images.
Detects generator type and extracts prompt information.

Supports:
- ComfyUI (JSON workflow in PNG prompt/workflow chunks, complex node graphs)
- NovelAI (Comment JSON, EXIF UserComment for V4+, WebP EXIF)
- WebUI/A1111 (parameters text chunk)
- Forge (WebUI variant with Forge identifier)
- JPEG EXIF/UserComment
- WebP EXIF + XMP
"""
import json
import re
from typing import Optional, Dict, Any, Tuple, List, Set
from PIL import Image
from PIL.PngImagePlugin import PngInfo
import os


class MetadataParser:
    """Parse metadata from SD-generated images to detect source and extract prompts."""

    GENERATORS = {
        "comfyui": "ComfyUI",
        "nai": "NovelAI",
        "webui": "WebUI",
        "forge": "Forge",
        "unknown": "Unknown"
    }

    # Node class_types that contain text prompts in ComfyUI
    COMFYUI_TEXT_NODE_TYPES = {
        # Standard CLIP text encoders
        "CLIPTextEncode",
        "CLIPTextEncodeSDXL",
        "CLIPTextEncodeSD3",
        "CLIPTextEncodeFlux",
        "CLIPTextEncodeHunyuanDiT",
        # Custom/community text encoders
        "NewBieCLIPTextEncode",
        "NewBieCLIPTextEncodeBasic",
        "BNK_CLIPTextEncodeAdvanced",
        "CLIPTextEncodeA1111",
        # Conditioning nodes
        "ConditioningCombine",
        "ConditioningConcat",
        "ConditioningSetArea",
    }

    # Node types that hold string constants (prompt fragments)
    COMFYUI_STRING_NODE_TYPES = {
        "StringConstantMultiline",
        "StringConstant",
        "String",
        "Text",
        "TextMultiline",
        "TextBox",
        "ShowText",
        "Note",
        "PrimitiveNode",
    }

    # Node types that load checkpoints
    COMFYUI_CHECKPOINT_NODE_TYPES = {
        "CheckpointLoaderSimple",
        "CheckPointLoaderSimple",
        "CheckpointLoader",
        "CheckpointLoaderNF4",
        "UNETLoader",
        "DiffusionModelLoader",
        "DiffusionModelLoaderKJ",
    }

    # Node types that load LoRAs
    COMFYUI_LORA_NODE_TYPES = {
        "LoraLoader",
        "LoraLoaderModelOnly",
        "LoRALoader",
        "LoraLoaderBlockWeight",
    }

    # Node types that are KSamplers (have positive/negative inputs)
    COMFYUI_SAMPLER_NODE_TYPES = {
        "KSampler",
        "KSamplerAdvanced",
        "KSamplerSelect",
        "SamplerCustom",
        "SamplerCustomAdvanced",
    }

    def parse(self, image_path: str) -> Dict[str, Any]:
        """
        Parse image metadata and return structured data.

        Returns:
            {
                "generator": str,  # comfyui, nai, webui, forge, unknown
                "prompt": str or None,
                "negative_prompt": str or None,
                "checkpoint": str or None,
                "loras": list of str,
                "metadata": dict,  # Full raw metadata
                "width": int,
                "height": int,
                "file_size": int
            }
        """
        result = {
            "generator": "unknown",
            "prompt": None,
            "negative_prompt": None,
            "checkpoint": None,
            "loras": [],
            "metadata": {},
            "width": 0,
            "height": 0,
            "file_size": 0
        }

        try:
            result["file_size"] = os.path.getsize(image_path)

            with Image.open(image_path) as img:
                result["width"] = img.width
                result["height"] = img.height

                # Get all metadata
                metadata = {}
                if hasattr(img, 'info'):
                    metadata = dict(img.info)

                # Extract EXIF for all formats (not just WebP)
                exif_data = self._extract_exif(img)
                metadata.update(exif_data)

                # Extract EXIF IFD (UserComment etc.) for all formats
                exif_ifd_data = self._extract_exif_ifd(img)
                metadata.update(exif_ifd_data)

                # Check for WebP XMP
                if img.format == 'WEBP':
                    xmp_data = self._extract_webp_xmp(image_path)
                    metadata.update(xmp_data)

                # Check for JPEG EXIF UserComment that might contain SD params
                if img.format in ('JPEG', 'JPG'):
                    jpeg_data = self._extract_jpeg_sd_metadata(img)
                    metadata.update(jpeg_data)

                result["metadata"] = self._serialize_metadata(metadata)

                # Detect generator and extract prompts, checkpoint, loras
                generator, prompt, neg_prompt, checkpoint, loras = self._detect_and_parse(metadata)
                result["generator"] = generator
                result["prompt"] = prompt
                result["negative_prompt"] = neg_prompt
                result["checkpoint"] = checkpoint
                result["loras"] = loras

        except Exception as e:
            print(f"Error parsing {image_path}: {e}")

        return result

    def _serialize_metadata(self, metadata: dict) -> dict:
        """Serialize metadata to JSON-safe format."""
        result = {}
        for key, value in metadata.items():
            try:
                # Try to serialize, skip if not possible
                json.dumps({key: value})
                result[key] = value
            except (TypeError, ValueError):
                # Convert bytes to string
                if isinstance(value, bytes):
                    try:
                        result[key] = value.decode('utf-8', errors='replace')
                    except Exception:
                        result[key] = str(value)
                else:
                    result[key] = str(value)
        return result

    def _detect_and_parse(self, metadata: dict) -> Tuple[str, Optional[str], Optional[str], Optional[str], List[str]]:
        """
        Detect generator type and extract prompts, checkpoint, and loras.
        Returns: (generator, prompt, negative_prompt, checkpoint, loras)

        Priority order:
        1. WebUI/Forge 'parameters' text (most reliable format when present)
        2. NovelAI EXIF UserComment (V4+ WebP/JPEG)
        3. NovelAI 'Comment' PNG chunk
        4. ComfyUI 'prompt' JSON workflow
        5. ComfyUI 'workflow' key (fallback)
        6. Other EXIF fields
        7. Software tag detection
        """
        # === Check for WebUI/Forge 'parameters' text chunk first ===
        # This is the most reliable format. Even ComfyUI images sometimes have
        # 'parameters' text alongside 'workflow' JSON - prefer the text format.
        if "parameters" in metadata:
            params = metadata["parameters"]
            if isinstance(params, str) and ("Steps:" in params and "Sampler:" in params):
                prompt, neg, cp, lr = self._parse_webui_parameters(params)
                generator = "webui"
                if "forge" in params.lower() or "Forge" in params:
                    generator = "forge"
                return (generator, prompt, neg, cp, lr)

        # === Check for NovelAI EXIF UserComment (V4+ format) ===
        # NAI V4+ stores metadata in EXIF UserComment as JSON with
        # Description (prompt) and Comment (JSON with prompt/uc/settings)
        if "UserComment" in metadata:
            nai_result = self._parse_nai_usercomment(metadata["UserComment"], metadata)
            if nai_result:
                return nai_result

        # === Check for NovelAI 'Comment' PNG text chunk ===
        if "Comment" in metadata:
            try:
                comment = metadata["Comment"]
                if isinstance(comment, str):
                    comment_data = json.loads(comment)
                    if isinstance(comment_data, dict) and ("prompt" in comment_data or "uc" in comment_data):
                        prompt = comment_data.get("prompt", "")
                        neg = comment_data.get("uc", "")
                        return ("nai", prompt, neg, None, [])
            except (json.JSONDecodeError, TypeError, ValueError):
                pass

        # === Check for NovelAI Description field ===
        if "Description" in metadata:
            desc = metadata["Description"]
            software = str(metadata.get("Software", "")).lower()
            if "novelai" in software:
                # NAI image with Description as prompt
                neg = None
                # Try to get negative from Comment
                if "Comment" in metadata:
                    try:
                        comment_data = json.loads(metadata["Comment"])
                        if isinstance(comment_data, dict):
                            neg = comment_data.get("uc", None)
                    except (json.JSONDecodeError, TypeError, ValueError):
                        pass
                return ("nai", str(desc), neg, None, [])

        # === Check for ComfyUI 'prompt' key with JSON workflow ===
        if "prompt" in metadata:
            try:
                prompt_data = metadata["prompt"]
                if isinstance(prompt_data, str):
                    prompt_data = json.loads(prompt_data)
                if isinstance(prompt_data, dict):
                    # Verify this looks like ComfyUI prompt data (has node dicts with class_type)
                    has_nodes = any(
                        isinstance(v, dict) and "class_type" in v
                        for v in prompt_data.values()
                    )
                    if has_nodes:
                        pos, neg, cp, lr = self._extract_comfyui_data(prompt_data)
                        return ("comfyui", pos, neg, cp, lr)
            except (json.JSONDecodeError, TypeError, ValueError):
                pass

        # === Check for ComfyUI workflow key without prompt data ===
        if "workflow" in metadata:
            try:
                workflow = metadata["workflow"]
                if isinstance(workflow, str):
                    workflow = json.loads(workflow)
                # Try to extract from prompt data if available
                prompt_raw = metadata.get("prompt", {})
                if isinstance(prompt_raw, str):
                    try:
                        prompt_raw = json.loads(prompt_raw)
                    except (json.JSONDecodeError, TypeError, ValueError):
                        prompt_raw = {}
                pos, neg, cp, lr = self._extract_comfyui_data(prompt_raw)
                # If prompt data extraction failed, try extracting from workflow nodes
                if not pos and isinstance(workflow, dict):
                    pos, neg = self._extract_from_workflow(workflow)
                return ("comfyui", pos, neg, cp, lr)
            except Exception:
                return ("comfyui", None, None, None, [])

        # === Check for A1111 format in other EXIF fields ===
        for key in ["Parameters", "UserComment", "ImageDescription"]:
            if key in metadata:
                params = str(metadata[key])
                # Remove common EXIF prefix for UserComment if present
                if params.startswith("UNICODE") or params.startswith("ASCII"):
                    params = params[7:].strip("\0 ")

                if "Steps:" in params and "Sampler:" in params:
                    prompt, neg, cp, lr = self._parse_webui_parameters(params)
                    generator = "forge" if "forge" in params.lower() else "webui"
                    return (generator, prompt, neg, cp, lr)

        # === Check Software tag for generator identification ===
        if "Software" in metadata:
            software = str(metadata["Software"]).lower()
            if "novelai" in software:
                # Try to extract prompt from any available field
                prompt = metadata.get("Description", metadata.get("ImageDescription", None))
                if prompt:
                    prompt = str(prompt)
                return ("nai", prompt, None, None, [])
            if "comfyui" in software:
                return ("comfyui", None, None, None, [])

        return ("unknown", None, None, None, [])

    def _parse_nai_usercomment(self, usercomment: Any, metadata: dict) -> Optional[Tuple[str, Optional[str], Optional[str], Optional[str], List[str]]]:
        """
        Parse NovelAI V4+ EXIF UserComment.

        NAI V4+ stores metadata in EXIF UserComment as:
        "ASCII\0\0\0{JSON}" where JSON has:
        - Description: the prompt text
        - Comment: JSON string with {prompt, uc, steps, ...}
        - Software: "NovelAI"
        """
        try:
            text = None
            if isinstance(usercomment, bytes):
                # Remove EXIF UserComment encoding prefix
                if usercomment.startswith(b'ASCII\x00\x00\x00'):
                    text = usercomment[8:].decode('utf-8', errors='replace')
                elif usercomment.startswith(b'UNICODE\x00'):
                    text = usercomment[8:].decode('utf-16', errors='replace')
                else:
                    text = usercomment.decode('utf-8', errors='replace')
            elif isinstance(usercomment, str):
                text = usercomment
                # Remove prefix if present
                if text.startswith("ASCII") or text.startswith("UNICODE"):
                    text = text[7:].strip("\0 ")

            if not text:
                return None

            # Find JSON start
            json_start = text.find('{')
            if json_start < 0:
                return None

            data = json.loads(text[json_start:])
            if not isinstance(data, dict):
                return None

            # Check if this looks like NAI data
            software = data.get("Software", str(metadata.get("Software", "")))
            is_nai = "novelai" in str(software).lower()
            has_nai_keys = "Description" in data or "Source" in data or "Generation time" in data

            if not is_nai and not has_nai_keys:
                # Not NAI format, might be WebUI in UserComment
                return None

            prompt = data.get("Description", None)
            neg_prompt = None

            # Parse Comment field which contains detailed generation settings
            comment = data.get("Comment", "")
            if isinstance(comment, str) and comment:
                try:
                    comment_data = json.loads(comment)
                    if isinstance(comment_data, dict):
                        # V4+ Comment has prompt/uc keys
                        if "prompt" in comment_data and not prompt:
                            prompt = comment_data["prompt"]
                        neg_prompt = comment_data.get("uc", None)
                        # V4 also has v4_prompt and v4_negative_prompt
                        if not prompt and "v4_prompt" in comment_data:
                            v4_prompt = comment_data["v4_prompt"]
                            if isinstance(v4_prompt, dict):
                                prompt = v4_prompt.get("prompt", None)
                            elif isinstance(v4_prompt, str):
                                prompt = v4_prompt
                        if not neg_prompt and "v4_negative_prompt" in comment_data:
                            v4_neg = comment_data["v4_negative_prompt"]
                            if isinstance(v4_neg, dict):
                                neg_prompt = v4_neg.get("prompt", None)
                            elif isinstance(v4_neg, str):
                                neg_prompt = v4_neg
                except (json.JSONDecodeError, TypeError, ValueError):
                    pass

            if prompt or neg_prompt:
                return ("nai", prompt, neg_prompt, None, [])

        except Exception:
            pass

        return None

    def _extract_comfyui_data(self, prompt_data: Any) -> Tuple[Optional[str], Optional[str], Optional[str], List[str]]:
        """
        Extract positive/negative prompts, checkpoint, and loras from ComfyUI workflow.

        Uses graph traversal to follow KSampler positive/negative connections
        back to their source text nodes, rather than guessing based on order.
        """
        if not isinstance(prompt_data, dict):
            try:
                prompt_data = json.loads(prompt_data) if isinstance(prompt_data, str) else {}
            except Exception:
                return (None, None, None, [])

        if not prompt_data:
            return (None, None, None, [])

        checkpoint = None
        loras = []

        # Build a lookup of node_id -> node data
        nodes = {}
        for node_id, node in prompt_data.items():
            if isinstance(node, dict):
                nodes[str(node_id)] = node

        # Extract checkpoint names
        for node_id, node in nodes.items():
            class_type = node.get("class_type", "")
            inputs = node.get("inputs", {})

            # Check all checkpoint loader variants
            if any(ct in class_type for ct in ["CheckpointLoader", "CheckPointLoader", "UNETLoader", "DiffusionModelLoader"]):
                cp = inputs.get("ckpt_name", inputs.get("unet_name", inputs.get("model_name", "")))
                if cp and isinstance(cp, str):
                    checkpoint = cp

            # Extract LoRAs
            if any(ct in class_type for ct in ["LoraLoader", "LoRALoader"]):
                lr = inputs.get("lora_name", "")
                if lr and isinstance(lr, str):
                    loras.append(lr)

        # Try to find positive/negative prompts via KSampler graph traversal
        positive_text, negative_text = self._trace_sampler_prompts(nodes)

        # Fallback: if graph traversal didn't find text, collect all text nodes
        if not positive_text:
            positive_text, negative_text = self._collect_text_from_nodes(nodes)

        return (positive_text, negative_text, checkpoint, loras)

    def _trace_sampler_prompts(self, nodes: Dict[str, dict]) -> Tuple[Optional[str], Optional[str]]:
        """
        Trace KSampler positive/negative inputs back through the node graph
        to find the actual text content.
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
            return (None, None)

        # For each sampler, trace its positive and negative inputs
        for sampler_id, sampler_node in sampler_nodes:
            inputs = sampler_node.get("inputs", {})

            # Trace positive conditioning
            pos_ref = inputs.get("positive")
            if pos_ref:
                texts = self._trace_to_text(pos_ref, nodes, set())
                positive_texts.extend(texts)

            # Trace negative conditioning
            neg_ref = inputs.get("negative")
            if neg_ref:
                texts = self._trace_to_text(neg_ref, nodes, set())
                negative_texts.extend(texts)

        pos_result = "\n".join(positive_texts) if positive_texts else None
        neg_result = "\n".join(negative_texts) if negative_texts else None

        return (pos_result, neg_result)

    def _trace_to_text(self, ref: Any, nodes: Dict[str, dict], visited: Set[str], depth: int = 0) -> List[str]:
        """
        Recursively trace a node reference back to find text content.
        Handles node connections (lists like [node_id, output_index])
        and direct string values.
        """
        if depth > 20:  # Prevent infinite recursion
            return []

        # Direct string value
        if isinstance(ref, str):
            # Could be a text value or a node reference
            if ref in nodes:
                return self._extract_text_from_node(ref, nodes, visited, depth)
            return [ref] if ref.strip() else []

        # Node connection reference: [node_id, output_index]
        if isinstance(ref, list) and len(ref) >= 2:
            target_id = str(ref[0])
            return self._extract_text_from_node(target_id, nodes, visited, depth)

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
            for key in ["string_a", "string_b", "string1", "string2", "text1", "text2",
                         "text_a", "text_b", "prompt1", "prompt2", "prompt3",
                         "string_1", "string_2"]:
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

        # ShowText nodes (pysssss etc.) - text_0 has the cached output text
        elif "ShowText" in class_type:
            for key in ["text_0", "text", "string"]:
                val = inputs.get(key)
                if val is None:
                    continue
                if isinstance(val, str) and val.strip():
                    texts.append(val)
                    break  # text_0 has the actual text, don't follow text connection
                elif isinstance(val, (list, tuple)):
                    sub_texts = self._trace_to_text(val, nodes, visited, depth + 1)
                    texts.extend(sub_texts)

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
            text_val = inputs.get("string", inputs.get("text", inputs.get("value", "")))
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

        return texts

    def _collect_text_from_nodes(self, nodes: Dict[str, dict]) -> Tuple[Optional[str], Optional[str]]:
        """
        Fallback: collect text from all text-bearing nodes.
        Uses heuristics to separate positive from negative prompts.
        """
        positive_candidates = []
        negative_candidates = []

        for node_id, node in nodes.items():
            class_type = node.get("class_type", "")
            inputs = node.get("inputs", {})

            # Get text from text encoder nodes
            if any(ct in class_type for ct in ["CLIPTextEncode", "NewBieCLIPTextEncode"]):
                text = inputs.get("text", inputs.get("user_prompt", ""))
                if isinstance(text, str) and text.strip() and len(text.strip()) > 3:
                    if self._looks_like_negative_prompt(text):
                        negative_candidates.append(text)
                    else:
                        positive_candidates.append(text)

        # If we found text encoders, use those
        if positive_candidates or negative_candidates:
            pos = "\n".join(positive_candidates) if positive_candidates else None
            neg = "\n".join(negative_candidates) if negative_candidates else None
            return (pos, neg)

        # Second fallback: scan ALL nodes for any string value that looks like a prompt
        # This catches StringFunction|pysssss result fields, easy pipe nodes, etc.
        all_text_candidates = []
        for node_id, node in nodes.items():
            class_type = node.get("class_type", "")
            inputs = node.get("inputs", {})

            # Check all input keys for long string values
            for key in ["text", "string", "prompt", "user_prompt", "positive",
                         "result", "text_0", "value", "user_text"]:
                val = inputs.get(key)
                if isinstance(val, str) and val.strip() and len(val.strip()) > 20:
                    all_text_candidates.append((class_type, key, val))

        if all_text_candidates:
            # Sort by length descending
            all_text_candidates.sort(key=lambda x: len(x[2]), reverse=True)
            pos_strs = []
            neg_strs = []
            for ct, key, text in all_text_candidates:
                if self._looks_like_negative_prompt(text):
                    neg_strs.append(text)
                else:
                    pos_strs.append(text)
            pos = pos_strs[0] if pos_strs else None
            neg = neg_strs[0] if neg_strs else None
            return (pos, neg)

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

    def _parse_webui_parameters(self, params: str) -> Tuple[Optional[str], Optional[str], Optional[str], List[str]]:
        """Parse WebUI/Forge parameters format including checkpoint and loras."""
        if not params:
            return (None, None, None, [])

        prompt = None
        negative = None
        checkpoint = None
        loras = []

        # Extract Lora from prompt: <lora:name:weight>
        lora_matches = re.findall(r"<lora:([^:]+):[^>]+>", params)
        if lora_matches:
            loras = list(set(lora_matches))

        # Extract Checkpoint from parameters (usually "Model: [name]")
        model_match = re.search(r"Model:\s*([^,]+)", params)
        if model_match:
            checkpoint = model_match.group(1).strip()

        # WebUI format: prompt\nNegative prompt: neg\nSteps: X, ...
        lines = params.split("\n")

        # Find where negative prompt starts
        neg_start = -1
        for i, line in enumerate(lines):
            if line.startswith("Negative prompt:"):
                neg_start = i
                break

        # Find where parameters start
        param_start = -1
        for i, line in enumerate(lines):
            if re.match(r"^Steps:\s*\d+", line):
                param_start = i
                break

        # Extract positive prompt
        if neg_start > 0:
            prompt = "\n".join(lines[:neg_start]).strip()
        elif param_start > 0:
            prompt = "\n".join(lines[:param_start]).strip()
        else:
            prompt = params  # Just use everything

        # Extract negative prompt
        if neg_start >= 0:
            neg_end = param_start if param_start > neg_start else len(lines)
            neg_lines = lines[neg_start:neg_end]
            if neg_lines:
                neg_lines[0] = neg_lines[0].replace("Negative prompt:", "").strip()
                negative = "\n".join(neg_lines).strip()

        return (prompt, negative, checkpoint, loras)

    def _extract_exif(self, img: Image.Image) -> dict:
        """Extract top-level EXIF data from image."""
        metadata = {}
        try:
            exif = img.getexif()
            if exif:
                from PIL import ExifTags
                for tag_id, value in exif.items():
                    tag_name = ExifTags.TAGS.get(tag_id, tag_id)
                    if isinstance(value, bytes):
                        try:
                            metadata[tag_name] = value.decode('utf-8', errors='replace')
                        except Exception:
                            metadata[tag_name] = str(value)
                    else:
                        metadata[tag_name] = value
        except Exception as e:
            print(f"Error extracting exif: {e}")
        return metadata

    def _extract_exif_ifd(self, img: Image.Image) -> dict:
        """
        Extract EXIF IFD (sub-directory) data, specifically UserComment.
        NovelAI V4+ stores prompt data here for WebP images.
        """
        metadata = {}
        try:
            exif = img.getexif()
            if not exif:
                return metadata

            # Get the Exif IFD (tag 0x8769)
            ifd = exif.get_ifd(0x8769)
            if ifd:
                from PIL import ExifTags
                for tag_id, value in ifd.items():
                    tag_name = ExifTags.TAGS.get(tag_id, str(tag_id))

                    # Special handling for UserComment (tag 37510 / 0x9286)
                    if tag_id == 37510:
                        metadata["UserComment"] = value  # Keep raw bytes for parsing
                    elif isinstance(value, bytes):
                        try:
                            metadata[tag_name] = value.decode('utf-8', errors='replace')
                        except Exception:
                            metadata[tag_name] = str(value)
                    else:
                        metadata[tag_name] = value
        except Exception as e:
            # Non-critical, some images don't have EXIF IFD
            pass
        return metadata

    def _extract_jpeg_sd_metadata(self, img: Image.Image) -> dict:
        """Extract SD metadata from JPEG EXIF fields."""
        metadata = {}
        try:
            exif = img.getexif()
            if not exif:
                return metadata

            # Check ImageDescription (tag 0x010E)
            img_desc = exif.get(0x010E)
            if img_desc and isinstance(img_desc, str):
                if "ImageDescription" not in metadata:
                    metadata["ImageDescription"] = img_desc

            # Check for parameters in ImageDescription
            if img_desc and "Steps:" in str(img_desc) and "Sampler:" in str(img_desc):
                metadata["parameters"] = str(img_desc)
        except Exception:
            pass
        return metadata

    def _extract_webp_xmp(self, image_path: str) -> dict:
        """
        Extract XMP metadata from a WebP file manually by parsing chunks.
        WebP is a RIFF container, so we look for the 'XMP ' chunk.
        """
        metadata = {}
        try:
            with open(image_path, 'rb') as f:
                data = f.read()

                # Search for XMP chunk
                xmp_pos = data.find(b'XMP ')
                if xmp_pos != -1:
                    # Size is 4 bytes after ID
                    size = int.from_bytes(data[xmp_pos+4:xmp_pos+8], 'little')
                    xmp_content = data[xmp_pos+8:xmp_pos+8+size]

                    try:
                        decoded_xmp = xmp_content.decode('utf-8', errors='replace')
                        metadata["xmp"] = decoded_xmp

                        # Extract WebUI parameters from XMP
                        if "parameters" not in metadata and "parameters" in decoded_xmp:
                            match = re.search(r'parameters>(.*?)</', decoded_xmp, re.DOTALL)
                            if match:
                                metadata["parameters"] = match.group(1).strip()
                            elif "Steps:" in decoded_xmp:
                                metadata["parameters"] = decoded_xmp

                        # Extract ComfyUI prompt from XMP
                        if "prompt" not in metadata and "prompt" in decoded_xmp:
                            json_start = decoded_xmp.find('{')
                            if json_start != -1:
                                json_end = decoded_xmp.rfind('}')
                                if json_end > json_start:
                                    potential_json = decoded_xmp[json_start:json_end+1]
                                    try:
                                        json.loads(potential_json)
                                        metadata["prompt"] = potential_json
                                    except json.JSONDecodeError:
                                        pass

                    except Exception:
                        pass

        except Exception as e:
            print(f"Error extracting webp xmp: {e}")

        return metadata


# Singleton instance
_parser = None

def get_parser() -> MetadataParser:
    """Get the singleton parser instance."""
    global _parser
    if _parser is None:
        _parser = MetadataParser()
    return _parser


def parse_image(image_path: str) -> Dict[str, Any]:
    """Convenience function to parse a single image."""
    return get_parser().parse(image_path)
