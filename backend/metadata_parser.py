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


PARSED_METADATA_VERSION = 3


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
                "metadata": dict,  # Full raw metadata (includes _parsed key)
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

                # Detect generator and extract prompts, checkpoint, loras + extras
                parsed = self._detect_and_parse(metadata)
                result["generator"] = parsed["generator"]
                result["prompt"] = parsed["prompt"]
                result["negative_prompt"] = parsed["negative_prompt"]
                result["checkpoint"] = parsed["checkpoint"]
                result["loras"] = parsed["loras"]

                # Store structured parsed data in metadata for frontend access
                result["metadata"]["_parsed"] = {
                    "version": PARSED_METADATA_VERSION,
                    "generation_params": parsed.get("generation_params"),
                    "is_img2img": parsed.get("is_img2img", False),
                    "img2img_info": parsed.get("img2img_info"),
                    "character_prompts": parsed.get("character_prompts"),
                    "prompt_nodes": parsed.get("prompt_nodes"),
                }

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

    def _flatten_text_value(self, value: Any) -> Optional[str]:
        """Flatten nested metadata values to a readable text string."""
        if value is None:
            return None
        if isinstance(value, str):
            text = value.strip()
            return text or None
        if isinstance(value, (list, tuple)):
            parts = []
            for item in value:
                part = self._flatten_text_value(item)
                if part:
                    parts.append(part)
            if not parts:
                return None
            return "\n".join(parts)
        if isinstance(value, dict):
            for key in ("base_caption", "caption", "text", "prompt", "value", "content", "description"):
                nested = self._flatten_text_value(value.get(key))
                if nested:
                    return nested
            for nested in value.values():
                flattened = self._flatten_text_value(nested)
                if flattened:
                    return flattened
        return None

    def _detect_and_parse(self, metadata: dict) -> Dict[str, Any]:
        """
        Detect generator type and extract prompts, checkpoint, loras, and extended info.
        Returns a dict with keys: generator, prompt, negative_prompt, checkpoint, loras,
        generation_params, is_img2img, img2img_info, character_prompts, prompt_nodes.
        """
        base = {
            "generator": "unknown",
            "prompt": None,
            "negative_prompt": None,
            "checkpoint": None,
            "loras": [],
            "generation_params": None,
            "is_img2img": False,
            "img2img_info": None,
            "character_prompts": None,
            "prompt_nodes": None,
        }

        # === Check for WebUI/Forge 'parameters' text chunk first ===
        if "parameters" in metadata:
            params = metadata["parameters"]
            if isinstance(params, str) and ("Steps:" in params and "Sampler:" in params):
                prompt, neg, cp, lr, gen_params = self._parse_webui_parameters(params)
                generator = "webui"
                if "forge" in params.lower() or "Forge" in params:
                    generator = "forge"
                base.update({
                    "generator": generator, "prompt": prompt, "negative_prompt": neg,
                    "checkpoint": cp, "loras": lr, "generation_params": gen_params,
                })
                # img2img detection for WebUI/Forge
                if gen_params:
                    ds = gen_params.get("denoising_strength")
                    if ds is not None:
                        base["is_img2img"] = True
                        source = "img2img"
                        if gen_params.get("mask_hash"):
                            source = "inpaint"
                        elif gen_params.get("hires_upscaler"):
                            source = "hires fix"
                            base["is_img2img"] = False  # hires fix isn't true img2img
                        base["img2img_info"] = {"denoising_strength": ds, "source": source}
                return base

        # === Check for NovelAI EXIF UserComment (V4+ format) ===
        if "UserComment" in metadata:
            nai_result = self._parse_nai_usercomment_extended(metadata["UserComment"], metadata)
            if nai_result:
                base.update(nai_result)
                return base

        # === Check for NovelAI 'Comment' PNG text chunk ===
        if "Comment" in metadata:
            try:
                comment = metadata["Comment"]
                if isinstance(comment, str):
                    comment_data = json.loads(comment)
                    if isinstance(comment_data, dict) and (
                        "prompt" in comment_data
                        or "uc" in comment_data
                        or "v4_prompt" in comment_data
                        or "v4_negative_prompt" in comment_data
                    ):
                        prompt = self._flatten_text_value(comment_data.get("prompt"))
                        neg = self._flatten_text_value(comment_data.get("uc"))

                        v4_prompt = comment_data.get("v4_prompt")
                        if not prompt and isinstance(v4_prompt, dict):
                            prompt = self._flatten_text_value(
                                v4_prompt.get("prompt")
                                or v4_prompt.get("caption")
                                or v4_prompt
                            )

                        v4_negative = comment_data.get("v4_negative_prompt")
                        if not neg:
                            neg = self._flatten_text_value(
                                v4_negative.get("prompt") if isinstance(v4_negative, dict) else v4_negative
                            )
                            if not neg and isinstance(v4_negative, dict):
                                neg = self._flatten_text_value(v4_negative.get("caption") or v4_negative)

                        base.update({"generator": "nai", "prompt": prompt, "negative_prompt": neg})
                        # Extract NAI generation params
                        base["generation_params"] = self._extract_nai_gen_params(comment_data)
                        # Extract character prompts if present
                        char_prompts = self._extract_nai_character_prompts(comment_data)
                        if char_prompts:
                            base["character_prompts"] = char_prompts
                        # NAI img2img detection
                        if comment_data.get("strength") is not None and comment_data.get("strength", 1.0) < 1.0:
                            base["is_img2img"] = True
                            base["img2img_info"] = {
                                "denoising_strength": comment_data["strength"],
                                "source": "img2img",
                            }
                        return base
            except (json.JSONDecodeError, TypeError, ValueError):
                pass

        # === Check for NovelAI Description field ===
        if "Description" in metadata:
            desc = metadata["Description"]
            software = str(metadata.get("Software", "")).lower()
            if "novelai" in software:
                neg = None
                if "Comment" in metadata:
                    try:
                        comment_data = json.loads(metadata["Comment"])
                        if isinstance(comment_data, dict):
                            neg = comment_data.get("uc", None)
                            base["generation_params"] = self._extract_nai_gen_params(comment_data)
                            char_prompts = self._extract_nai_character_prompts(comment_data)
                            if char_prompts:
                                base["character_prompts"] = char_prompts
                    except (json.JSONDecodeError, TypeError, ValueError):
                        pass
                base.update({"generator": "nai", "prompt": str(desc), "negative_prompt": neg})
                return base

        # === Check for ComfyUI 'prompt' key with JSON workflow ===
        if "prompt" in metadata:
            try:
                prompt_data = metadata["prompt"]
                if isinstance(prompt_data, str):
                    prompt_data = json.loads(prompt_data)
                if isinstance(prompt_data, dict):
                    has_nodes = any(
                        isinstance(v, dict) and "class_type" in v
                        for v in prompt_data.values()
                    )
                    if has_nodes:
                        pos, neg, cp, lr, gen_params, prompt_nodes, img2img = self._extract_comfyui_data_extended(prompt_data)
                        base.update({
                            "generator": "comfyui", "prompt": pos, "negative_prompt": neg,
                            "checkpoint": cp, "loras": lr, "generation_params": gen_params,
                            "prompt_nodes": prompt_nodes,
                        })
                        if img2img:
                            base["is_img2img"] = True
                            base["img2img_info"] = img2img
                        return base
            except (json.JSONDecodeError, TypeError, ValueError):
                pass

        # === Check for ComfyUI workflow key without prompt data ===
        if "workflow" in metadata:
            try:
                workflow = metadata["workflow"]
                if isinstance(workflow, str):
                    workflow = json.loads(workflow)
                prompt_raw = metadata.get("prompt", {})
                if isinstance(prompt_raw, str):
                    try:
                        prompt_raw = json.loads(prompt_raw)
                    except (json.JSONDecodeError, TypeError, ValueError):
                        prompt_raw = {}
                pos, neg, cp, lr, gen_params, prompt_nodes, img2img = self._extract_comfyui_data_extended(prompt_raw)
                if not pos and isinstance(workflow, dict):
                    pos, neg = self._extract_from_workflow(workflow)
                base.update({
                    "generator": "comfyui", "prompt": pos, "negative_prompt": neg,
                    "checkpoint": cp, "loras": lr, "generation_params": gen_params,
                    "prompt_nodes": prompt_nodes,
                })
                if img2img:
                    base["is_img2img"] = True
                    base["img2img_info"] = img2img
                return base
            except Exception:
                base["generator"] = "comfyui"
                return base

        # === Check for A1111 format in other EXIF fields ===
        for key in ["Parameters", "UserComment", "ImageDescription"]:
            if key in metadata:
                params = str(metadata[key])
                if params.startswith("UNICODE") or params.startswith("ASCII"):
                    params = params[7:].strip("\0 ")

                if "Steps:" in params and "Sampler:" in params:
                    prompt, neg, cp, lr, gen_params = self._parse_webui_parameters(params)
                    generator = "forge" if "forge" in params.lower() else "webui"
                    base.update({
                        "generator": generator, "prompt": prompt, "negative_prompt": neg,
                        "checkpoint": cp, "loras": lr, "generation_params": gen_params,
                    })
                    if gen_params and gen_params.get("denoising_strength") is not None:
                        base["is_img2img"] = True
                        base["img2img_info"] = {
                            "denoising_strength": gen_params["denoising_strength"],
                            "source": "img2img",
                        }
                    return base

        # === Check Software tag for generator identification ===
        if "Software" in metadata:
            software = str(metadata["Software"]).lower()
            if "novelai" in software:
                prompt = metadata.get("Description", metadata.get("ImageDescription", None))
                if prompt:
                    prompt = str(prompt)
                base.update({"generator": "nai", "prompt": prompt})
                return base
            if "comfyui" in software:
                base["generator"] = "comfyui"
                return base

        return base

    def _parse_nai_usercomment(self, usercomment: Any, metadata: dict) -> Optional[Tuple[str, Optional[str], Optional[str], Optional[str], List[str]]]:
        """Legacy wrapper — delegates to extended version for backward compat."""
        result = self._parse_nai_usercomment_extended(usercomment, metadata)
        if result:
            return ("nai", result.get("prompt"), result.get("negative_prompt"), None, [])
        return None

    def _parse_nai_usercomment_extended(self, usercomment: Any, metadata: dict) -> Optional[Dict[str, Any]]:
        """
        Parse NovelAI V4+ EXIF UserComment and return extended dict.
        Extracts prompt, negative, generation params, character prompts, img2img info.
        """
        try:
            text = None
            if isinstance(usercomment, bytes):
                if usercomment.startswith(b'ASCII\x00\x00\x00'):
                    text = usercomment[8:].decode('utf-8', errors='replace')
                elif usercomment.startswith(b'UNICODE\x00'):
                    text = usercomment[8:].decode('utf-16', errors='replace')
                else:
                    text = usercomment.decode('utf-8', errors='replace')
            elif isinstance(usercomment, str):
                text = usercomment
                if text.startswith("ASCII") or text.startswith("UNICODE"):
                    text = text[7:].strip("\0 ")

            if not text:
                return None

            json_start = text.find('{')
            if json_start < 0:
                return None

            data = json.loads(text[json_start:])
            if not isinstance(data, dict):
                return None

            software = data.get("Software", str(metadata.get("Software", "")))
            is_nai = "novelai" in str(software).lower()
            has_nai_keys = "Description" in data or "Source" in data or "Generation time" in data

            if not is_nai and not has_nai_keys:
                return None

            result = {
                "generator": "nai",
                "prompt": self._flatten_text_value(data.get("Description", None)),
                "negative_prompt": None,
                "generation_params": None,
                "character_prompts": None,
                "is_img2img": False,
                "img2img_info": None,
            }

            comment = data.get("Comment", "")
            if isinstance(comment, str) and comment:
                try:
                    comment_data = json.loads(comment)
                    if isinstance(comment_data, dict):
                        if "prompt" in comment_data and not result["prompt"]:
                            result["prompt"] = self._flatten_text_value(comment_data["prompt"])
                        result["negative_prompt"] = self._flatten_text_value(comment_data.get("uc", None))

                        # V4 prompt structure
                        if "v4_prompt" in comment_data:
                            v4_prompt = comment_data["v4_prompt"]
                            if isinstance(v4_prompt, dict):
                                if not result["prompt"]:
                                    result["prompt"] = self._flatten_text_value(
                                        v4_prompt.get("prompt")
                                        or v4_prompt.get("caption")
                                        or v4_prompt
                                    )
                                # Extract character prompts
                                char_prompts = self._extract_nai_character_prompts(comment_data)
                                if char_prompts:
                                    result["character_prompts"] = char_prompts

                        if "v4_negative_prompt" in comment_data:
                            v4_neg = comment_data["v4_negative_prompt"]
                            if not result["negative_prompt"]:
                                result["negative_prompt"] = self._flatten_text_value(
                                    v4_neg.get("prompt") if isinstance(v4_neg, dict) else v4_neg
                                )
                                if not result["negative_prompt"] and isinstance(v4_neg, dict):
                                    result["negative_prompt"] = self._flatten_text_value(v4_neg.get("caption") or v4_neg)

                        # Generation params
                        result["generation_params"] = self._extract_nai_gen_params(comment_data)

                        # img2img detection
                        strength = comment_data.get("strength")
                        noise = comment_data.get("noise")
                        if strength is not None and float(strength) < 1.0:
                            result["is_img2img"] = True
                            result["img2img_info"] = {
                                "denoising_strength": float(strength),
                                "noise": float(noise) if noise is not None else None,
                                "source": "img2img",
                            }
                except (json.JSONDecodeError, TypeError, ValueError):
                    pass

            if result["prompt"] or result["negative_prompt"]:
                return result

        except Exception:
            pass

        return None

    def _extract_nai_gen_params(self, comment_data: dict) -> Optional[Dict[str, Any]]:
        """Extract structured generation parameters from NAI Comment JSON."""
        if not isinstance(comment_data, dict):
            return None

        params = {}
        key_map = {
            "steps": "steps",
            "sampler": "sampler",
            "seed": "seed",
            "strength": "strength",
            "noise": "noise",
            "scale": "cfg_scale",
            "cfg_rescale": "cfg_rescale",
            "sm": "sm",
            "sm_dyn": "sm_dyn",
            "dynamic_thresholding": "dynamic_thresholding",
            "noise_schedule": "noise_schedule",
            "legacy_v3_extend": "legacy_v3_extend",
            "uncond_scale": "uncond_scale",
            "skip_cfg_above_sigma": "skip_cfg_above_sigma",
            "ucPreset": "uc_preset",
            "qualityToggle": "quality_toggle",
            "params_version": "params_version",
            "use_coords": "use_coords",
            "use_order": "use_order",
        }

        for src_key, dst_key in key_map.items():
            if src_key in comment_data:
                val = comment_data[src_key]
                params[dst_key] = val

        # Extract resolution from request_type or width/height
        if "width" in comment_data and "height" in comment_data:
            params["size"] = f"{comment_data['width']}x{comment_data['height']}"

        # Keep legacy helpers available for callers that expect them
        if "qualityToggle" in comment_data and "quality_toggle" not in params:
            params["quality_toggle"] = comment_data["qualityToggle"]
        if "ucPreset" in comment_data and "uc_preset" not in params:
            params["uc_preset"] = comment_data["ucPreset"]
        if "params_version" in comment_data and "params_version" not in params:
            params["params_version"] = comment_data["params_version"]
        if "use_coords" in comment_data and "use_coords" not in params:
            params["use_coords"] = comment_data["use_coords"]
        if "use_order" in comment_data and "use_order" not in params:
            params["use_order"] = comment_data["use_order"]

        return params if params else None

    def _extract_nai_character_prompts(self, comment_data: dict) -> Optional[List[Dict[str, Any]]]:
        """Extract NAI V4 character prompts from Comment JSON."""
        if not isinstance(comment_data, dict):
            return None

        v4_prompt = comment_data.get("v4_prompt")
        if not isinstance(v4_prompt, dict):
            return None

        char_prompts_raw = v4_prompt.get("character_prompts")
        if not isinstance(char_prompts_raw, list) or len(char_prompts_raw) == 0:
            return None

        characters = []
        for i, char in enumerate(char_prompts_raw):
            if not isinstance(char, dict):
                continue
            prompt_val = char.get("prompt", "")
            negative_val = char.get("ucPrompt", char.get("uc", ""))
            if isinstance(prompt_val, dict):
                prompt_val = self._flatten_text_value(prompt_val) or ""
            if isinstance(negative_val, dict):
                negative_val = self._flatten_text_value(negative_val) or ""

            char_data = {
                "index": i,
                "prompt": prompt_val,
                "negative_prompt": negative_val,
            }
            # Position data if available
            center = char.get("center")
            if isinstance(center, dict):
                char_data["center"] = {"x": center.get("x", 0.5), "y": center.get("y", 0.5)}
            characters.append(char_data)

        return characters if characters else None

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

    def _extract_comfyui_data_extended(self, prompt_data: Any) -> Tuple[Optional[str], Optional[str], Optional[str], List[str], Optional[Dict], Optional[List], Optional[Dict]]:
        """
        Extended ComfyUI extraction: returns (pos, neg, checkpoint, loras, gen_params, prompt_nodes, img2img_info).
        """
        if not isinstance(prompt_data, dict):
            try:
                prompt_data = json.loads(prompt_data) if isinstance(prompt_data, str) else {}
            except Exception:
                return (None, None, None, [], None, None, None)

        if not prompt_data:
            return (None, None, None, [], None, None, None)

        checkpoint = None
        loras = []
        gen_params = {}
        prompt_nodes = []
        img2img_info = None

        # Build lookup
        nodes = {}
        for node_id, node in prompt_data.items():
            if isinstance(node, dict):
                nodes[str(node_id)] = node

        # Extract checkpoint, loras, and generation params from nodes
        has_load_image = False
        for node_id, node in nodes.items():
            class_type = node.get("class_type", "")
            inputs = node.get("inputs", {})

            # Checkpoint
            if any(ct in class_type for ct in ["CheckpointLoader", "CheckPointLoader", "UNETLoader", "DiffusionModelLoader"]):
                cp = inputs.get("ckpt_name", inputs.get("unet_name", inputs.get("model_name", "")))
                if cp and isinstance(cp, str):
                    checkpoint = cp

            # LoRAs
            if any(ct in class_type for ct in ["LoraLoader", "LoRALoader"]):
                lr = inputs.get("lora_name", "")
                if lr and isinstance(lr, str):
                    loras.append(lr)

            # KSampler params
            if any(st in class_type for st in ["KSampler", "SamplerCustom"]):
                if "seed" in inputs:
                    seed_val = inputs["seed"]
                    if isinstance(seed_val, (int, float)):
                        gen_params["seed"] = int(seed_val)
                if "steps" in inputs:
                    steps_val = inputs["steps"]
                    if isinstance(steps_val, (int, float)):
                        gen_params["steps"] = int(steps_val)
                if "cfg" in inputs:
                    cfg_val = inputs["cfg"]
                    if isinstance(cfg_val, (int, float)):
                        gen_params["cfg_scale"] = float(cfg_val)
                if "sampler_name" in inputs:
                    gen_params["sampler"] = inputs["sampler_name"]
                if "sampler" in inputs and "sampler" not in gen_params:
                    gen_params["sampler"] = inputs["sampler"]
                if "scheduler" in inputs:
                    gen_params["scheduler"] = inputs["scheduler"]
                if "denoise" in inputs:
                    denoise_val = inputs["denoise"]
                    if isinstance(denoise_val, (int, float)):
                        gen_params["denoising_strength"] = float(denoise_val)
                if "noise_seed" in inputs and isinstance(inputs["noise_seed"], (int, float)):
                    gen_params["noise_seed"] = int(inputs["noise_seed"])
                if "add_noise" in inputs:
                    gen_params["add_noise"] = inputs["add_noise"]
                if "start_at_step" in inputs and isinstance(inputs["start_at_step"], (int, float)):
                    gen_params["start_at_step"] = int(inputs["start_at_step"])
                if "end_at_step" in inputs and isinstance(inputs["end_at_step"], (int, float)):
                    gen_params["end_at_step"] = int(inputs["end_at_step"])
                if "return_with_leftover_noise" in inputs:
                    gen_params["return_with_leftover_noise"] = inputs["return_with_leftover_noise"]

            if class_type in ("EmptyLatentImage", "EmptySD3LatentImage", "EmptyHunyuanLatentVideo"):
                width = inputs.get("width")
                height = inputs.get("height")
                if isinstance(width, (int, float)) and isinstance(height, (int, float)):
                    gen_params["size"] = f"{int(width)}x{int(height)}"

            # img2img detection: LoadImage node presence
            if class_type in ("LoadImage", "LoadImageMask"):
                has_load_image = True

        # Determine img2img
        denoise = gen_params.get("denoising_strength")
        if has_load_image and denoise is not None and denoise < 1.0:
            img2img_info = {
                "denoising_strength": denoise,
                "source": "img2img",
            }
        elif denoise is not None and denoise < 1.0 and not has_load_image:
            # Likely hires fix or latent upscale — still record it
            img2img_info = {
                "denoising_strength": denoise,
                "source": "latent upscale",
            }

        # Trace prompts via KSampler graph
        positive_text, negative_text = self._trace_sampler_prompts(nodes)

        # Build prompt_nodes list (multi-node breakdown)
        prompt_nodes = self._collect_prompt_nodes(nodes)
        if not prompt_nodes:
            prompt_nodes = self._collect_text_from_nodes_as_nodes(nodes)

        # Fallback
        if not positive_text:
            positive_text, negative_text = self._collect_text_from_nodes(nodes)

        return (positive_text, negative_text, checkpoint, loras,
                gen_params if gen_params else None,
                prompt_nodes if prompt_nodes else None,
                img2img_info)

    def _collect_prompt_nodes(self, nodes: Dict[str, dict]) -> List[Dict[str, Any]]:
        """Collect all text-bearing nodes for multi-node prompt breakdown."""
        result = []
        seen_texts = set()

        for node_id, node in nodes.items():
            class_type = node.get("class_type", "")
            inputs = node.get("inputs", {})

            # Only collect from text encoder nodes
            if not any(ct in class_type for ct in ["CLIPTextEncode", "NewBieCLIPTextEncode", "TextEncode", "PromptBuilder", "PromptComposer"]):
                continue

            text = inputs.get("text", inputs.get("prompt", inputs.get("user_prompt", "")))
            source_node_id = node_id
            source_class_type = class_type
            source_key = "text" if "text" in inputs else ("prompt" if "prompt" in inputs else "user_prompt")

            if isinstance(text, (list, tuple)):
                traced_info = self._trace_to_text_with_source(text, nodes, set())
                traced_texts = [item["text"] for item in traced_info if item.get("text")]
                text = "\n".join(traced_texts) if traced_texts else None
                if traced_info:
                    source_node_id = traced_info[0]["source_node_id"]
                    source_class_type = traced_info[0]["source_class_type"]
                    source_key = traced_info[0]["source_key"]

            if isinstance(text, str) and text.strip() and len(text.strip()) > 3:
                # Deduplicate
                if text.strip() not in seen_texts:
                    seen_texts.add(text.strip())
                    role = "negative" if self._looks_like_negative_prompt(text) else "positive"
                    result.append({
                        "node_id": node_id,
                        "class_type": class_type,
                        "text": text.strip(),
                        "role": role,
                        "resolved_from": source_node_id,
                        "source_class_type": source_class_type,
                        "source_key": source_key,
                    })
                    extra_source_id = source_node_id if source_node_id in nodes else node_id
                    if role == "positive" and extra_source_id in nodes:
                        source_node = nodes[extra_source_id]
                        source_inputs = source_node.get("inputs", {})
                        for extra_key in ["text_b", "text_c", "prompt_b", "prompt_c", "string_b", "string_c"]:
                            extra_text = source_inputs.get(extra_key)
                            if isinstance(extra_text, str) and extra_text.strip() and extra_text.strip() not in seen_texts:
                                seen_texts.add(extra_text.strip())
                                result.append({
                                    "node_id": extra_source_id,
                                    "class_type": source_node.get("class_type", source_class_type),
                                    "text": extra_text.strip(),
                                    "role": role,
                                    "resolved_from": extra_source_id,
                                    "source_class_type": source_node.get("class_type", source_class_type),
                                    "source_key": extra_key,
                                })

        return result

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
        traced = self._trace_to_text_with_source(ref, nodes, visited, depth)
        return [item["text"] for item in traced if item.get("text")]

    def _trace_to_text_with_source(self, ref: Any, nodes: Dict[str, dict], visited: Set[str], depth: int = 0) -> List[Dict[str, Any]]:
        """Trace text and keep source node metadata."""
        if depth > 20:
            return []

        if isinstance(ref, str):
            if ref in nodes:
                return self._extract_text_from_node_with_source(ref, nodes, visited, depth)
            return [{
                "text": ref,
                "source_node_id": None,
                "source_class_type": "literal",
                "source_key": "literal",
            }] if ref.strip() else []

        if isinstance(ref, list) and len(ref) >= 2:
            target_id = str(ref[0])
            return self._extract_text_from_node_with_source(target_id, nodes, visited, depth)

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

    def _extract_text_from_node_with_source(self, node_id: str, nodes: Dict[str, dict], visited: Set[str], depth: int = 0) -> List[Dict[str, Any]]:
        """Extract text plus source metadata from a node."""
        if node_id in visited:
            return []

        node = nodes.get(node_id)
        if not node:
            return []

        class_type = node.get("class_type", "")
        inputs = node.get("inputs", {})

        for key in ["text_0", "text", "prompt", "user_prompt", "string", "value", "result"]:
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
                traced = self._trace_to_text_with_source(value, nodes, nested_visited, depth + 1)
                if traced:
                    return traced

        return []

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

    def _parse_webui_parameters(self, params: str) -> Tuple[Optional[str], Optional[str], Optional[str], List[str], Optional[Dict[str, Any]]]:
        """Parse WebUI/Forge parameters format including checkpoint, loras, and generation params."""
        if not params:
            return (None, None, None, [], None)

        prompt = None
        negative = None
        checkpoint = None
        loras = []
        gen_params = {}

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

        # Extract structured generation parameters from the "Steps: X, Sampler: Y, ..." line
        if param_start >= 0:
            params_line = "\n".join(lines[param_start:])
            gen_params = self._parse_gen_params_line(params_line)

        return (prompt, negative, checkpoint, loras, gen_params if gen_params else None)

    def _parse_gen_params_line(self, params_line: str) -> Dict[str, Any]:
        """Parse the 'Steps: 20, Sampler: Euler a, CFG scale: 7, ...' line into a dict."""
        result = {}
        # Split by comma, but handle values that might contain commas in quotes
        pairs = re.split(r',\s*(?=[A-Z][a-z]*[\s_]*[A-Za-z]*:)', params_line)

        for pair in pairs:
            match = re.match(r'^\s*([^:]+):\s*(.+)$', pair.strip())
            if not match:
                continue
            key = match.group(1).strip()
            value = match.group(2).strip()

            # Normalize key names
            key_lower = key.lower().replace(" ", "_")

            # Type cast known fields
            try:
                if key_lower in ("steps", "clip_skip", "ensd", "hires_steps", "mask_blur"):
                    result[key_lower] = int(value)
                elif key_lower in ("cfg_scale", "denoising_strength", "hires_upscale"):
                    result[key_lower] = float(value)
                elif key_lower == "seed":
                    result["seed"] = int(value)
                elif key_lower == "size":
                    result["size"] = value
                elif key_lower == "model":
                    result["model"] = value
                elif key_lower == "model_hash":
                    result["model_hash"] = value
                elif key_lower == "sampler":
                    result["sampler"] = value
                elif key_lower == "schedule_type":
                    result["schedule_type"] = value
                elif key_lower in ("hires_upscaler",):
                    result["hires_upscaler"] = value
                elif key_lower == "mask_hash":
                    result["mask_hash"] = value
                elif key_lower == "init_image_hash":
                    result["init_image_hash"] = value
                else:
                    # Store other params as-is
                    result[key_lower] = value
            except (ValueError, TypeError):
                result[key_lower] = value

        return result

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
