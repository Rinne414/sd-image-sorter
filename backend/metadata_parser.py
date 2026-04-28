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
import logging
import re
import struct
from typing import Optional, Dict, Any, Tuple, List, Set
from PIL import Image
from PIL.PngImagePlugin import PngInfo
import os
import zlib


logger = logging.getLogger(__name__)


PARSED_METADATA_VERSION = 5
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


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

    # Multi-LoRA loader node types (rgthree-style: lora_1, lora_2, ...)
    COMFYUI_MULTI_LORA_NODE_TYPES = {
        "Power Lora Loader (rgthree)",
        "CR LoRA Stack",
        "Efficient Loader",
    }

    # Node types that are KSamplers (have positive/negative inputs)
    COMFYUI_SAMPLER_NODE_TYPES = {
        "KSampler",
        "KSamplerAdvanced",
        "KSamplerSelect",
        "SamplerCustom",
        "SamplerCustomAdvanced",
    }

    COMFYUI_MODEL_FILE_EXTENSIONS = (
        ".safetensors",
        ".ckpt",
        ".pt",
        ".pth",
        ".bin",
        ".onnx",
    )

    COMFYUI_MODEL_KEY_TYPES = {
        "ckpt_name": "checkpoint",
        "checkpoint_name": "checkpoint",
        "checkpoint": "checkpoint",
        "unet_name": "unet",
        "diffusion_model": "diffusion_model",
        "diffusion_model_name": "diffusion_model",
        "model_name": "model",
        "base_model": "model",
        "lora_name": "lora",
        "vae_name": "vae",
        "clip_name": "clip",
        "clip_name1": "clip",
        "clip_name2": "clip",
        "yolo_model": "yolo",
        "yolo_model_name": "yolo",
        "detector_model": "yolo",
        "detector_model_name": "yolo",
        "bbox_model_name": "yolo",
        "segm_model_name": "yolo",
        "ultralytics_model": "yolo",
        "ultralytics_model_name": "yolo",
    }

    def parse(self, image_path: str, validate_image_data: bool = False) -> Dict[str, Any]:
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
        result: Dict[str, Any] = {
            "generator": "unknown",
            "prompt": None,
            "negative_prompt": None,
            "checkpoint": None,
            "loras": [],
            "metadata": {},
            "width": 0,
            "height": 0,
            "file_size": 0,
            "parse_error": None,
        }

        try:
            result["file_size"] = os.path.getsize(image_path)
            metadata = self._load_image_metadata(image_path)
            result["width"] = metadata["width"]
            result["height"] = metadata["height"]

            if validate_image_data:
                # Full decode is much slower on large PNG/WebP files and is not
                # required for scan-time metadata ingestion. Re-open + verify()
                # still catches common corruption/truncation without paying the
                # full pixel decode cost. Workflows that need deep decode already
                # use verify_image_readable() separately.
                with Image.open(image_path) as verify_img:
                    verify_img.verify()

            result["metadata"] = self._serialize_metadata(metadata["metadata"])

            # Detect generator and extract prompts, checkpoint, loras + extras
            parsed = self._detect_and_parse(metadata["metadata"])
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
                "model_assets": parsed.get("model_assets"),
            }

        except Exception as e:
            result["parse_error"] = str(e)
            logger.error("Error parsing %s: %s", image_path, e, exc_info=True)

        return result

    def _load_image_metadata(self, image_path: str) -> Dict[str, Any]:
        """Load dimensions and raw metadata with format-specific fast paths."""
        if os.path.splitext(image_path)[1].lower() == ".png":
            try:
                return self._load_png_metadata_fast(image_path)
            except Exception as exc:
                logger.debug("PNG fast-path fell back to Pillow for %s: %s", image_path, exc)

        return self._load_image_metadata_via_pillow(image_path)

    def _load_image_metadata_via_pillow(self, image_path: str) -> Dict[str, Any]:
        """Load metadata through Pillow for formats without a custom fast path."""
        with Image.open(image_path) as img:
            metadata = {}
            if hasattr(img, 'info'):
                metadata = dict(img.info)

            metadata.update(self._extract_exif(img))
            metadata.update(self._extract_exif_ifd(img))

            if img.format == 'WEBP':
                metadata.update(self._extract_webp_xmp(image_path))

            if img.format in ('JPEG', 'JPG', 'WEBP'):
                metadata.update(self._extract_jpeg_sd_metadata(img))

            return {
                "width": img.width,
                "height": img.height,
                "metadata": metadata,
            }

    def _load_png_metadata_fast(self, image_path: str) -> Dict[str, Any]:
        """Read PNG dimensions + text metadata without a full Pillow open."""
        metadata: Dict[str, Any] = {}
        width = 0
        height = 0

        with open(image_path, "rb") as png_file:
            if png_file.read(len(PNG_SIGNATURE)) != PNG_SIGNATURE:
                raise ValueError("Invalid PNG signature")

            while True:
                chunk_length_raw = png_file.read(4)
                if not chunk_length_raw:
                    break
                if len(chunk_length_raw) != 4:
                    raise ValueError("Truncated PNG chunk length")

                chunk_length = struct.unpack(">I", chunk_length_raw)[0]
                chunk_type = png_file.read(4)
                if len(chunk_type) != 4:
                    raise ValueError("Truncated PNG chunk type")

                chunk_data = png_file.read(chunk_length)
                if len(chunk_data) != chunk_length:
                    raise ValueError("Truncated PNG chunk data")

                chunk_crc = png_file.read(4)
                if len(chunk_crc) != 4:
                    raise ValueError("Truncated PNG chunk CRC")

                if chunk_type == b"IHDR":
                    if chunk_length < 8:
                        raise ValueError("Invalid PNG IHDR chunk")
                    width, height = struct.unpack(">II", chunk_data[:8])
                elif chunk_type == b"tEXt":
                    text_item = self._decode_png_text_chunk(chunk_data)
                    if text_item:
                        metadata[text_item[0]] = text_item[1]
                elif chunk_type == b"zTXt":
                    text_item = self._decode_png_ztxt_chunk(chunk_data)
                    if text_item:
                        metadata[text_item[0]] = text_item[1]
                elif chunk_type == b"iTXt":
                    text_item = self._decode_png_itxt_chunk(chunk_data)
                    if text_item:
                        metadata[text_item[0]] = text_item[1]
                elif chunk_type == b"eXIf":
                    metadata.update(self._extract_exif_from_bytes(chunk_data))
                    metadata.update(self._extract_exif_ifd_from_bytes(chunk_data))
                    metadata.update(self._extract_sd_metadata_from_exif_bytes(chunk_data))
                elif chunk_type == b"IEND":
                    break

        if width <= 0 or height <= 0:
            raise ValueError("PNG dimensions missing")

        return {
            "width": width,
            "height": height,
            "metadata": metadata,
        }

    def _decode_png_text_chunk(self, chunk_data: bytes) -> Optional[Tuple[str, str]]:
        """Decode a PNG tEXt chunk into a key/value pair."""
        if b"\x00" not in chunk_data:
            return None
        keyword, text = chunk_data.split(b"\x00", 1)
        return (
            keyword.decode("latin-1", errors="replace"),
            text.decode("utf-8", errors="replace"),
        )

    def _decode_png_ztxt_chunk(self, chunk_data: bytes) -> Optional[Tuple[str, str]]:
        """Decode a PNG zTXt chunk into a key/value pair."""
        if b"\x00" not in chunk_data:
            return None
        keyword, remainder = chunk_data.split(b"\x00", 1)
        if len(remainder) < 2:
            return None
        compression_method = remainder[0]
        if compression_method != 0:
            return None
        text = zlib.decompress(remainder[1:])
        return (
            keyword.decode("latin-1", errors="replace"),
            text.decode("utf-8", errors="replace"),
        )

    def _decode_png_itxt_chunk(self, chunk_data: bytes) -> Optional[Tuple[str, str]]:
        """Decode a PNG iTXt chunk into a key/value pair."""
        if b"\x00" not in chunk_data:
            return None
        keyword, remainder = chunk_data.split(b"\x00", 1)
        if len(remainder) < 2:
            return None

        compression_flag = remainder[0]
        compression_method = remainder[1]
        remainder = remainder[2:]

        if b"\x00" not in remainder:
            return None
        _language_tag, remainder = remainder.split(b"\x00", 1)
        if b"\x00" not in remainder:
            return None
        _translated_keyword, text_bytes = remainder.split(b"\x00", 1)

        if compression_flag == 1:
            if compression_method != 0:
                return None
            text_bytes = zlib.decompress(text_bytes)

        return (
            keyword.decode("latin-1", errors="replace"),
            text_bytes.decode("utf-8", errors="replace"),
        )

    def _serialize_metadata(self, metadata: dict) -> dict:
        """Serialize metadata to JSON-safe format."""
        result = {}
        for key, value in metadata.items():
            try:
                # Try to serialize, skip if not possible
                json.dumps({key: value})
                result[key] = value
            except (TypeError, ValueError) as e:
                # Convert bytes to string - serialization failed
                if isinstance(value, bytes):
                    try:
                        result[key] = value.decode('utf-8', errors='replace')
                    except Exception as e:
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

    def _extract_metadata_model_identifier(self, metadata: dict) -> Optional[str]:
        """Extract the best available model identifier from raw metadata."""
        software = str(metadata.get("Software", "") or "").strip().lower()

        for key in ("Source", "source", "Model", "model"):
            value = metadata.get(key)
            if not isinstance(value, str):
                continue

            text = value.strip().strip("\0 ")
            if not text:
                continue

            lower = text.lower()
            if self._looks_like_model_filename(text):
                return text
            if any(token in lower for token in ("novelai diffusion", "stable diffusion")):
                return text
            if "novelai" in software and re.match(r"^(sdxl|nai|stable diffusion)\b", text, flags=re.IGNORECASE):
                return text

        return None

    def _parse_explicit_saved_metadata(self, metadata: dict) -> Optional[Dict[str, Any]]:
        """Parse simple text metadata fields written by the Reader metadata editor."""
        prompt = self._flatten_text_value(metadata.get("prompt"))
        negative_prompt = self._flatten_text_value(
            metadata.get("negative_prompt") if "negative_prompt" in metadata else metadata.get("negative prompt")
        )
        checkpoint = (
            self._flatten_text_value(metadata.get("model"))
            or self._flatten_text_value(metadata.get("checkpoint"))
            or self._extract_metadata_model_identifier(metadata)
        )

        loras: List[str] = []
        lora_value = metadata.get("loras") or metadata.get("LoRAs") or metadata.get("lora")
        if isinstance(lora_value, (list, tuple, set)):
            loras = [str(item).strip() for item in lora_value if str(item).strip()]
        elif lora_value is not None:
            loras = [
                part.strip() for part in re.split(r"[,\n]", str(lora_value))
                if str(part).strip()
            ]

        generation_params: Dict[str, Any] = {}
        if "seed" in metadata:
            try:
                generation_params["seed"] = int(str(metadata["seed"]).strip())
            except (TypeError, ValueError):
                generation_params["seed"] = metadata["seed"]
        if "steps" in metadata:
            try:
                generation_params["steps"] = int(str(metadata["steps"]).strip())
            except (TypeError, ValueError):
                generation_params["steps"] = metadata["steps"]
        if "sampler" in metadata:
            generation_params["sampler"] = metadata["sampler"]
        if "cfg_scale" in metadata or "cfg scale" in metadata:
            cfg_value = metadata.get("cfg_scale", metadata.get("cfg scale"))
            try:
                generation_params["cfg_scale"] = float(str(cfg_value).strip())
            except (TypeError, ValueError):
                generation_params["cfg_scale"] = cfg_value
        if "size" in metadata:
            generation_params["size"] = metadata["size"]
        if checkpoint:
            generation_params["model"] = checkpoint
        if loras:
            generation_params["loras"] = ", ".join(loras)

        if not any((prompt, negative_prompt, checkpoint, loras, generation_params)):
            return None

        return {
            "generator": "unknown",
            "prompt": prompt,
            "negative_prompt": negative_prompt,
            "checkpoint": checkpoint,
            "loras": self._normalize_lora_names(loras),
            "generation_params": generation_params or None,
        }

    @staticmethod
    def _dedupe_non_empty_strings(values: List[Any]) -> List[str]:
        """Deduplicate string values while preserving order."""
        result: List[str] = []
        seen: Set[str] = set()

        for value in values:
            text = str(value or "").strip()
            if not text or text.lower() in {"none", "null", "false"} or text in seen:
                continue
            seen.add(text)
            result.append(text)

        return result

    @staticmethod
    def _asset_alias_key(value: str) -> str:
        """Normalize a model path/tag into a comparison-friendly alias key."""
        text = re.sub(r"[\\/]+", "/", str(value or "").strip().strip('"').strip("'"))
        if not text:
            return ""

        leaf = text.split("/")[-1]
        stem = leaf.rsplit(".", 1)[0] if "." in leaf else leaf
        return stem.lower()

    def _normalize_lora_names(self, names: List[str]) -> List[str]:
        """Prefer explicit filenames over bare inline aliases when both exist."""
        unique_names = self._dedupe_non_empty_strings(names)
        file_backed = [name for name in unique_names if self._looks_like_model_filename(name)]
        alias_covered = {
            self._asset_alias_key(name)
            for name in file_backed
            if self._asset_alias_key(name)
        }

        result: List[str] = []
        seen: Set[str] = set()
        for name in [*file_backed, *[item for item in unique_names if item not in file_backed]]:
            if not self._looks_like_model_filename(name):
                alias_key = self._asset_alias_key(name)
                if alias_key and alias_key in alias_covered:
                    continue
            if name in seen:
                continue
            seen.add(name)
            result.append(name)

        return result

    @staticmethod
    def _model_candidate_identity(candidate: Dict[str, Any]) -> Tuple[str, str, str, str, str]:
        """Stable dedupe key for model candidate records."""
        return (
            str(candidate.get("name", "")).strip(),
            str(candidate.get("node_id", "")).strip(),
            str(candidate.get("class_type", "")).strip(),
            str(candidate.get("input_key", "")).strip(),
            str(candidate.get("key_path", "")).strip(),
        )

    def _merge_candidate_records(self, *candidate_lists: Optional[List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
        """Merge candidate records while preserving first-seen ordering."""
        merged: List[Dict[str, Any]] = []
        seen: Set[Tuple[str, str, str, str, str]] = set()

        for candidate_list in candidate_lists:
            if not isinstance(candidate_list, list):
                continue
            for candidate in candidate_list:
                if not isinstance(candidate, dict):
                    continue
                identity = self._model_candidate_identity(candidate)
                if identity[0] == "" or identity in seen:
                    continue
                seen.add(identity)
                merged.append(dict(candidate))

        return merged

    def _build_explicit_model_assets(
        self,
        source: str,
        checkpoint: Optional[str] = None,
        loras: Optional[List[str]] = None,
        unets: Optional[List[str]] = None,
        diffusion_models: Optional[List[str]] = None,
        yolo_models: Optional[List[str]] = None,
        model_names: Optional[List[str]] = None,
        confidence: str = "high",
    ) -> Optional[Dict[str, Any]]:
        """Build a normalized model_assets payload from explicit metadata fields."""
        checkpoint_names = self._dedupe_non_empty_strings([checkpoint] if checkpoint else [])
        unet_names = self._dedupe_non_empty_strings(unets or [])
        diffusion_names = self._dedupe_non_empty_strings(diffusion_models or [])
        generic_model_names = self._dedupe_non_empty_strings(model_names or [])
        lora_names = self._normalize_lora_names(loras or [])
        yolo_names = self._dedupe_non_empty_strings(yolo_models or [])

        if not any((checkpoint_names, unet_names, diffusion_names, generic_model_names, lora_names, yolo_names)):
            return None

        def make_candidates(asset_type: str, names: List[str]) -> List[Dict[str, Any]]:
            return [
                {
                    "name": name,
                    "asset_type": asset_type,
                    "source_mode": source,
                    "confidence": confidence,
                    "match_type": "explicit_metadata",
                }
                for name in names
            ]

        primary_model_type = None
        primary_model_name = None
        for asset_type, names in (
            ("checkpoint", checkpoint_names),
            ("unet", unet_names),
            ("diffusion_model", diffusion_names),
            ("model", generic_model_names),
        ):
            if names:
                primary_model_type = asset_type
                primary_model_name = names[0]
                break

        return {
            "source": source,
            "primary_model_type": primary_model_type,
            "primary_model_name": primary_model_name,
            "checkpoint_candidates": make_candidates("checkpoint", checkpoint_names),
            "unet_candidates": make_candidates("unet", unet_names),
            "diffusion_model_candidates": make_candidates("diffusion_model", diffusion_names),
            "model_candidates": make_candidates("model", generic_model_names),
            "lora_candidates": make_candidates("lora", lora_names),
            "yolo_candidates": make_candidates("yolo", yolo_names),
            "loras": lora_names,
            "yolo_models": yolo_names,
        }

    def _merge_model_assets(self, primary: Optional[Dict[str, Any]], secondary: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        """Merge two normalized model_assets payloads."""
        if not primary:
            return dict(secondary) if secondary else None
        if not secondary:
            return primary

        merged: Dict[str, Any] = dict(primary)

        if not merged.get("primary_model_name") and secondary.get("primary_model_name"):
            merged["primary_model_name"] = secondary.get("primary_model_name")
            merged["primary_model_type"] = secondary.get("primary_model_type")

        primary_source = str(primary.get("source", "")).strip()
        secondary_source = str(secondary.get("source", "")).strip()
        if primary_source and secondary_source and primary_source != secondary_source:
            merged["sources"] = self._dedupe_non_empty_strings([
                *(primary.get("sources") or [primary_source]),
                *(secondary.get("sources") or [secondary_source]),
            ])

        candidate_keys = {
            "checkpoint_candidates",
            "unet_candidates",
            "diffusion_model_candidates",
            "model_candidates",
            "lora_candidates",
            "yolo_candidates",
            "workflow_widget_lora_candidates",
            "global_lora_candidates",
            "global_yolo_candidates",
        }
        for key in candidate_keys:
            merged_list = self._merge_candidate_records(primary.get(key), secondary.get(key))
            if merged_list:
                merged[key] = merged_list

        merged["loras"] = self._normalize_lora_names([
            *(primary.get("loras") or []),
            *(secondary.get("loras") or []),
        ])
        merged["yolo_models"] = self._dedupe_non_empty_strings([
            *(primary.get("yolo_models") or []),
            *(secondary.get("yolo_models") or []),
        ])
        merged["activity_root_ids"] = self._dedupe_non_empty_strings([
            *(primary.get("activity_root_ids") or []),
            *(secondary.get("activity_root_ids") or []),
        ])

        primary_count = primary.get("activity_node_count")
        secondary_count = secondary.get("activity_node_count")
        if isinstance(primary_count, int) or isinstance(secondary_count, int):
            merged["activity_node_count"] = max(
                int(primary_count or 0),
                int(secondary_count or 0),
            )

        return merged

    def _looks_like_yolo_model_name(self, value: str, class_type: str = "", key_path: str = "") -> bool:
        """Detect Ultralytics/YOLO-style detector models without confusing them with checkpoints."""
        if not self._looks_like_model_filename(value):
            return False

        combined = " ".join([
            str(class_type or "").lower(),
            str(key_path or "").lower(),
            str(value or "").lower(),
        ])
        return any(token in combined for token in (
            "ultralytics",
            "yolo",
            "detector",
            "bbox/",
            "segm",
            "detailer",
            "adetailer",
        ))

    def _extract_webui_yolo_models(self, params: str, gen_params: Optional[Dict[str, Any]]) -> List[str]:
        """Extract detector/YOLO models from WebUI/Forge parameter blobs."""
        names: List[str] = []

        def push(value: Any) -> None:
            text = str(value or "").strip().strip('"')
            if not text or not self._looks_like_model_filename(text):
                return
            if not self._looks_like_yolo_model_name(text, key_path=text):
                return
            names.append(text)

        if gen_params:
            for key, value in gen_params.items():
                key_lower = str(key).lower()
                if not isinstance(value, str):
                    continue
                if any(token in key_lower for token in ("adetailer", "detector", "yolo", "bbox", "segm")):
                    push(value)

        for match in re.finditer(
            r"(?:ADetailer|Detector|YOLO)[^:\n]*:\s*([^,\n]+)",
            params or "",
            flags=re.IGNORECASE,
        ):
            push(match.group(1))

        return self._dedupe_non_empty_strings(names)

    def _extract_webui_checkpoint_identifier(self, gen_params: Optional[Dict[str, Any]], params: str) -> Optional[str]:
        """Recover the best available WebUI/Forge model identifier."""
        if gen_params:
            model_name = str(gen_params.get("model") or "").strip()
            if model_name:
                return model_name

            hashes_blob = gen_params.get("hashes")
            if isinstance(hashes_blob, str):
                try:
                    hashes_json = json.loads(hashes_blob)
                except Exception:
                    hashes_json = None
                if isinstance(hashes_json, dict):
                    hash_model = str(hashes_json.get("model") or "").strip()
                    if hash_model:
                        return f"Model hash {hash_model}"

            model_hash = str(gen_params.get("model_hash") or "").strip()
            if model_hash:
                return f"Model hash {model_hash}"

        raw_hash_match = re.search(r"(?:^|,\s*)Model hash:\s*([^,\n]+)", params or "", flags=re.IGNORECASE)
        if raw_hash_match:
            model_hash = raw_hash_match.group(1).strip()
            if model_hash:
                return f"Model hash {model_hash}"

        return None

    def _detect_webui_family_generator(
        self,
        params: str,
        metadata: dict,
        gen_params: Optional[Dict[str, Any]] = None,
    ) -> str:
        """Distinguish Forge from vanilla A1111/WebUI before returning parsed parameters."""
        def has_forge_signature(value: Any) -> bool:
            text = str(value or "").strip().lower()
            if not text:
                return False
            if re.search(r"\bsd[-_\s]?webui[-_\s]?forge\b", text):
                return True
            if re.search(r"\bstable[-_\s]?diffusion[-_\s]?(?:webui[-_\s]?)?forge\b", text):
                return True
            if re.search(r"\bwebui[-_\s]+forge\b|\bforge[-_\s]+webui\b", text):
                return True
            if re.search(r"\bf\d+(?:\.\d+)*v\d+(?:\.\d+)*(?:[-+][a-z0-9_.-]+)?\b", text, flags=re.IGNORECASE):
                return True
            return False

        for key in ("Software", "software", "Source", "source", "Generator", "generator"):
            if has_forge_signature(metadata.get(key)):
                return "forge"

        if gen_params:
            for key, value in gen_params.items():
                key_normalized = str(key or "").strip().lower().replace(" ", "_")
                if key_normalized in {"forge_version", "sd_webui_forge_version"}:
                    return "forge"
                if key_normalized in {"version", "software", "source", "generator"} and has_forge_signature(value):
                    return "forge"

        return "webui"

    def _detect_and_parse(self, metadata: dict) -> Dict[str, Any]:
        """
        Detect generator type and extract prompts, checkpoint, loras, and extended info.
        Returns a dict with keys: generator, prompt, negative_prompt, checkpoint, loras,
        generation_params, is_img2img, img2img_info, character_prompts, prompt_nodes.
        """
        base: Dict[str, Any] = {
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
            "model_assets": None,
        }

        # === Check for WebUI/Forge 'parameters' text chunk first ===
        if "parameters" in metadata:
            params = metadata["parameters"]
            if isinstance(params, str) and ("Steps:" in params and "Sampler:" in params):
                prompt, neg, cp, lr, gen_params = self._parse_webui_parameters(params)
                generator = self._detect_webui_family_generator(params, metadata, gen_params)
                base.update({
                    "generator": generator, "prompt": prompt, "negative_prompt": neg,
                    "checkpoint": cp, "loras": lr, "generation_params": gen_params,
                })
                if not base["checkpoint"]:
                    base["checkpoint"] = self._extract_metadata_model_identifier(metadata)
                base["model_assets"] = self._build_explicit_model_assets(
                    source=f"{generator}_parameters",
                    checkpoint=base["checkpoint"],
                    loras=base["loras"],
                    yolo_models=self._extract_webui_yolo_models(params, gen_params),
                )
                self._merge_workflow_widget_assets_into_result(base, metadata)
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
                if not nai_result.get("model_assets"):
                    nai_result["model_assets"] = self._build_explicit_model_assets(
                        source="nai_usercomment",
                        checkpoint=nai_result.get("checkpoint"),
                    )
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
                        base["checkpoint"] = self._extract_metadata_model_identifier(metadata)
                        base["model_assets"] = self._build_explicit_model_assets(
                            source="nai_comment",
                            checkpoint=base["checkpoint"],
                        )
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
            except (json.JSONDecodeError, TypeError, ValueError) as e:
                logger.debug("Failed to parse JSON: %s", e)

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
                    except (json.JSONDecodeError, TypeError, ValueError) as e:
                        logger.debug("Failed to parse Comment in Description path: %s", e)
                base.update({"generator": "nai", "prompt": str(desc), "negative_prompt": neg})
                base["checkpoint"] = self._extract_metadata_model_identifier(metadata)
                base["model_assets"] = self._build_explicit_model_assets(
                    source="nai_description",
                    checkpoint=base["checkpoint"],
                )
                return base

        # === Check for ComfyUI 'prompt' key with JSON workflow ===
        if "prompt" in metadata:
            try:
                prompt_data = metadata["prompt"]
                workflow_data = metadata.get("workflow")
                if isinstance(workflow_data, str):
                    try:
                        workflow_data = json.loads(workflow_data)
                    except (json.JSONDecodeError, TypeError, ValueError):
                        workflow_data = None
                if isinstance(prompt_data, str):
                    prompt_data = json.loads(prompt_data)
                if isinstance(prompt_data, dict):
                    has_nodes = any(
                        isinstance(v, dict) and "class_type" in v
                        for v in prompt_data.values()
                    )
                    if has_nodes:
                        pos, neg, cp, lr, gen_params, prompt_nodes, img2img, model_assets = self._extract_comfyui_data_extended(prompt_data, workflow_data)
                        base.update({
                            "generator": "comfyui", "prompt": pos, "negative_prompt": neg,
                            "checkpoint": cp, "loras": lr, "generation_params": gen_params,
                            "prompt_nodes": prompt_nodes,
                            "model_assets": model_assets,
                        })
                        if img2img:
                            base["is_img2img"] = True
                            base["img2img_info"] = img2img
                        return base
            except (json.JSONDecodeError, TypeError, ValueError) as e:
                logger.debug("Failed to parse JSON: %s", e)

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
                    except (json.JSONDecodeError, TypeError, ValueError) as e:
                        logger.debug('Failed to parse prompt in workflow path: %s', e)
                        prompt_raw = {}
                pos, neg, cp, lr, gen_params, prompt_nodes, img2img, model_assets = self._extract_comfyui_data_extended(prompt_raw, workflow)
                if not pos and isinstance(workflow, dict):
                    pos, neg = self._extract_from_workflow(workflow)
                base.update({
                    "generator": "comfyui", "prompt": pos, "negative_prompt": neg,
                    "checkpoint": cp, "loras": lr, "generation_params": gen_params,
                    "prompt_nodes": prompt_nodes,
                    "model_assets": model_assets,
                })
                if not base["checkpoint"]:
                    workflow_assets = self._extract_comfyui_model_assets_from_workflow_widgets(workflow)
                    if workflow_assets:
                        base["model_assets"] = self._merge_model_assets(base.get("model_assets"), workflow_assets)
                        base["checkpoint"] = workflow_assets.get("primary_model_name")
                        base["loras"] = self._normalize_lora_names([
                            *(base.get("loras") or []),
                            *(workflow_assets.get("loras") or []),
                        ])
                if img2img:
                    base["is_img2img"] = True
                    base["img2img_info"] = img2img
                return base
            except Exception as e:
                logger.debug("Failed to parse ComfyUI workflow: %s", e)
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
                    generator = self._detect_webui_family_generator(params, metadata, gen_params)
                    base.update({
                        "generator": generator, "prompt": prompt, "negative_prompt": neg,
                        "checkpoint": cp, "loras": lr, "generation_params": gen_params,
                    })
                    if not base["checkpoint"]:
                        base["checkpoint"] = self._extract_metadata_model_identifier(metadata)
                    base["model_assets"] = self._build_explicit_model_assets(
                        source=f"{generator}_parameters",
                        checkpoint=base["checkpoint"],
                        loras=base["loras"],
                        yolo_models=self._extract_webui_yolo_models(params, gen_params),
                    )
                    self._merge_workflow_widget_assets_into_result(base, metadata)
                    if gen_params and gen_params.get("denoising_strength") is not None:
                        base["is_img2img"] = True
                        base["img2img_info"] = {
                            "denoising_strength": gen_params["denoising_strength"],
                            "source": "img2img",
                        }
                    return base

        explicit_saved = self._parse_explicit_saved_metadata(metadata)
        if explicit_saved:
            base.update(explicit_saved)
            base["model_assets"] = self._build_explicit_model_assets(
                source="explicit_metadata",
                checkpoint=base["checkpoint"],
                loras=base["loras"],
            )
            return base

        # === Check Software tag for generator identification ===
        if "Software" in metadata:
            software = str(metadata["Software"]).lower()
            if "novelai" in software:
                prompt = metadata.get("Description", metadata.get("ImageDescription", None))
                if prompt:
                    prompt = str(prompt)
                base.update({
                    "generator": "nai",
                    "prompt": prompt,
                    "checkpoint": self._extract_metadata_model_identifier(metadata),
                })
                base["model_assets"] = self._build_explicit_model_assets(
                    source="nai_software_tag",
                    checkpoint=base["checkpoint"],
                )
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

            result: Dict[str, Any] = {
                "generator": "nai",
                "prompt": self._flatten_text_value(data.get("Description", None)),
                "negative_prompt": None,
                "checkpoint": self._extract_metadata_model_identifier(metadata) or self._extract_metadata_model_identifier(data),
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
                except (json.JSONDecodeError, TypeError, ValueError) as e:
                    logger.debug("Failed to parse NAI UserComment Comment JSON: %s", e)

            if result["prompt"] or result["negative_prompt"]:
                return result

        except Exception as e:
            logger.debug('Failed to parse NAI UserComment: %s', e)

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
        positive_text, negative_text, checkpoint, loras, _, _, _, _ = self._extract_comfyui_data_extended(prompt_data)
        return (positive_text, negative_text, checkpoint, loras)

    def _extract_comfyui_data_extended(self, prompt_data: Any, workflow_data: Any = None) -> Tuple[Optional[str], Optional[str], Optional[str], List[str], Optional[Dict], Optional[List], Optional[Dict], Optional[Dict[str, Any]]]:
        """
        Extended ComfyUI extraction: returns
        (pos, neg, checkpoint, loras, gen_params, prompt_nodes, img2img_info, model_assets).
        """
        if not isinstance(prompt_data, dict):
            try:
                prompt_data = json.loads(prompt_data) if isinstance(prompt_data, str) else {}
            except Exception as e:
                logger.debug('Failed to parse ComfyUI prompt_data (extended): %s', e)
                return (None, None, None, [], None, None, None, None)

        if not prompt_data:
            return (None, None, None, [], None, None, None, None)

        checkpoint = None
        loras = []
        gen_params: Dict[str, Any] = {}
        prompt_nodes = []
        img2img_info = None
        model_assets = None

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

            # LoRAs (standard single-lora nodes)
            if any(ct in class_type for ct in ["LoraLoader", "LoRALoader"]):
                lr = inputs.get("lora_name", "")
                if lr and isinstance(lr, str):
                    loras.append(lr)
                    strength_model = inputs.get("strength_model")
                    strength_clip = inputs.get("strength_clip")
                    lora_detail = {"name": lr}
                    if isinstance(strength_model, (int, float)):
                        lora_detail["strength_model"] = round(float(strength_model), 4)
                    if isinstance(strength_clip, (int, float)):
                        lora_detail["strength_clip"] = round(float(strength_clip), 4)
                    if "lora_details" not in gen_params:
                        gen_params["lora_details"] = []
                    gen_params["lora_details"].append(lora_detail)

            # LoRAs (multi-lora nodes like rgthree Power Lora Loader)
            if any(ct in class_type for ct in self.COMFYUI_MULTI_LORA_NODE_TYPES):
                loras.extend(self._extract_multi_lora_inputs(inputs))
                multi_details = self._extract_multi_lora_details(inputs)
                if multi_details:
                    if "lora_details" not in gen_params:
                        gen_params["lora_details"] = []
                    gen_params["lora_details"].extend(multi_details)

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
            fallback = self._collect_text_from_nodes_as_nodes(nodes)
            if fallback:
                prompt_nodes = fallback

        # Fallback
        if not positive_text:
            positive_text, negative_text = self._collect_text_from_nodes(nodes)

        workflow_assets = self._extract_comfyui_model_assets_from_workflow_widgets(workflow_data)

        if checkpoint is None or not loras:
            model_assets = self._extract_comfyui_model_assets_from_active_graph(nodes)
            if checkpoint is None:
                checkpoint = model_assets.get("primary_model_name")
            if not loras:
                loras = list(model_assets.get("loras", []))

            global_lora_candidates = self._extract_comfyui_global_lora_candidates(nodes)
            if global_lora_candidates:
                existing_loras = {
                    str(name).strip()
                    for name in model_assets.get("loras", [])
                    if str(name).strip()
                }
                existing_loras.update(
                    str(item.get("name", "")).strip()
                    for item in model_assets.get("lora_candidates", [])
                    if str(item.get("name", "")).strip()
                )
                filtered_global_candidates = [
                    item for item in global_lora_candidates
                    if item["name"] not in existing_loras
                ]
                if filtered_global_candidates:
                    model_assets["global_lora_candidates"] = filtered_global_candidates
        else:
            model_assets = self._build_explicit_model_assets(
                source="fast_path",
                checkpoint=checkpoint,
                loras=loras,
            )

        model_assets = self._merge_model_assets(model_assets, workflow_assets)
        model_assets = self._merge_model_assets(model_assets, self._extract_comfyui_yolo_assets_from_full_graph(nodes))

        # Collect disabled LoRA names from rgthree-style nodes so workflow
        # widget data (which lacks the on/off flag) doesn't re-introduce them.
        disabled_loras: Set[str] = set()
        for node in nodes.values():
            if not isinstance(node, dict):
                continue
            for key, val in node.get("inputs", {}).items():
                if isinstance(val, dict) and val.get("on") is False:
                    lr_name = val.get("lora", val.get("lora_name", ""))
                    if lr_name and isinstance(lr_name, str):
                        disabled_loras.add(lr_name)

        if checkpoint is None and model_assets:
            checkpoint = model_assets.get("primary_model_name")
        loras = self._normalize_lora_names([
            *loras,
            *((model_assets or {}).get("loras") or []),
        ])
        if disabled_loras:
            loras = [lr for lr in loras if lr not in disabled_loras]
        if model_assets is not None:
            model_assets["loras"] = list(loras)
            if disabled_loras:
                for key in ("lora_candidates", "global_lora_candidates"):
                    candidates = model_assets.get(key)
                    if candidates:
                        model_assets[key] = [c for c in candidates if c.get("name") not in disabled_loras]

        return (positive_text, negative_text, checkpoint, loras,
                gen_params if gen_params else None,
                prompt_nodes if prompt_nodes else None,
                img2img_info,
                model_assets)

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

    @staticmethod
    def _extract_multi_lora_inputs(inputs: dict) -> List[str]:
        """Extract LoRA names from multi-lora nodes (e.g. rgthree Power Lora Loader).

        These nodes have inputs like lora_1, lora_2, ... lora_N.
        Each can be:
        - A dict with {on: bool, lora: str, strength: float}
        - A string (lora name directly)
        """
        loras = []
        for key, value in inputs.items():
            key_lower = str(key).lower()
            if not key_lower.startswith("lora_"):
                continue
            if not (
                re.match(r"^lora_\d+$", key_lower)
                or key_lower.endswith("_name")
                or key_lower.endswith("_lora")
                or key_lower.endswith("_lora_name")
            ):
                continue
            if isinstance(value, dict):
                if value.get("on") is False:
                    continue
                lora_name = value.get("lora", value.get("lora_name", ""))
                if lora_name and isinstance(lora_name, str) and lora_name != "None":
                    loras.append(lora_name)
            elif isinstance(value, str) and value and value != "None":
                loras.append(value)
        return loras

    @staticmethod
    def _extract_multi_lora_details(inputs: dict) -> List[Dict[str, Any]]:
        """Like _extract_multi_lora_inputs but returns structured details with weights."""
        details = []
        for key, value in inputs.items():
            key_lower = str(key).lower()
            if not key_lower.startswith("lora_"):
                continue
            if not (
                re.match(r"^lora_\d+$", key_lower)
                or key_lower.endswith("_name")
                or key_lower.endswith("_lora")
                or key_lower.endswith("_lora_name")
            ):
                continue
            if isinstance(value, dict):
                if value.get("on") is False:
                    continue
                lora_name = value.get("lora", value.get("lora_name", ""))
                if lora_name and isinstance(lora_name, str) and lora_name != "None":
                    detail: Dict[str, Any] = {"name": lora_name}
                    strength = value.get("strength")
                    if isinstance(strength, (int, float)):
                        detail["strength_model"] = round(float(strength), 4)
                    details.append(detail)
        return details

    def _extract_comfyui_model_assets_from_active_graph(self, nodes: Dict[str, dict]) -> Dict[str, Any]:
        """Fallback asset extraction that follows the active sampler subgraph.

        This is slower than the old node-class whitelist, so callers should only
        use it when the fast path failed to find checkpoint / LoRA data.
        """
        root_ids = self._find_comfyui_activity_roots(nodes)
        distances = self._collect_comfyui_upstream_distances(nodes, root_ids)
        if not distances:
            distances = {node_id: 999 for node_id in nodes.keys()}

        candidate_map: Dict[str, List[Dict[str, Any]]] = {
            "checkpoint": [],
            "unet": [],
            "diffusion_model": [],
            "model": [],
            "lora": [],
            "vae": [],
            "clip": [],
            "yolo": [],
        }
        seen: Set[Tuple[str, str, str, str]] = set()

        for node_id, distance in distances.items():
            node = nodes.get(node_id, {})
            self._scan_comfyui_asset_candidates(
                value=node.get("inputs", {}),
                key_path="inputs",
                node_id=node_id,
                class_type=str(node.get("class_type", "")),
                node_distance=distance,
                candidate_map=candidate_map,
                seen=seen,
            )

        for asset_type, items in candidate_map.items():
            candidate_map[asset_type] = sorted(
                items,
                key=lambda item: (-item["score"], item["distance"], item["node_id"], item["name"].lower()),
            )

        primary_model_type = None
        primary_model_name = None
        for asset_type in ("checkpoint", "unet", "diffusion_model", "model"):
            if candidate_map[asset_type]:
                primary_model_type = asset_type
                primary_model_name = candidate_map[asset_type][0]["name"]
                break

        lora_names = self._normalize_lora_names([item["name"] for item in candidate_map["lora"]])
        yolo_names = self._dedupe_non_empty_strings([item["name"] for item in candidate_map["yolo"]])

        return {
            "source": "activity_subgraph_fallback",
            "activity_root_ids": root_ids,
            "activity_node_count": len(distances),
            "primary_model_type": primary_model_type,
            "primary_model_name": primary_model_name,
            "checkpoint_candidates": candidate_map["checkpoint"],
            "unet_candidates": candidate_map["unet"],
            "diffusion_model_candidates": candidate_map["diffusion_model"],
            "model_candidates": candidate_map["model"],
            "lora_candidates": candidate_map["lora"],
            "vae_candidates": candidate_map["vae"],
            "clip_candidates": candidate_map["clip"],
            "yolo_candidates": candidate_map["yolo"],
            "loras": lora_names,
            "yolo_models": yolo_names,
        }

    def _extract_comfyui_model_assets_from_workflow_widgets(self, workflow_data: Any) -> Optional[Dict[str, Any]]:
        """Recover explicit asset filenames stored only in workflow widget state."""
        if not isinstance(workflow_data, dict):
            try:
                workflow_data = json.loads(workflow_data) if isinstance(workflow_data, str) else {}
            except Exception:
                return None

        nodes = workflow_data.get("nodes")
        if not isinstance(nodes, list):
            return None

        candidate_map: Dict[str, List[Dict[str, Any]]] = {
            "checkpoint": [],
            "unet": [],
            "diffusion_model": [],
            "lora": [],
            "vae": [],
            "clip": [],
            "yolo": [],
        }
        seen: Set[Tuple[str, str, str, str]] = set()

        for node in nodes:
            if not isinstance(node, dict):
                continue
            node_type = str(node.get("type", ""))
            widgets = node.get("widgets_values")
            if widgets is None:
                continue

            for path, value in self._iter_workflow_widget_strings(widgets):
                widget_key_path = f"widgets_values[{path}]"
                asset_type = self._classify_comfyui_workflow_widget_asset(node_type, widget_key_path, value)
                if not asset_type:
                    continue
                identity = (asset_type, value, str(node.get("id", "")), widget_key_path)
                if identity in seen:
                    continue
                seen.add(identity)
                candidate_map[asset_type].append({
                    "name": value,
                    "node_id": str(node.get("id", "")),
                    "class_type": node_type,
                    "input_key": widget_key_path,
                    "key_path": widget_key_path,
                    "source_mode": "workflow_widget_fallback",
                    "confidence": "high",
                    "match_type": "workflow_widget_value",
                })

        if not any(candidate_map.values()):
            return None

        primary_model_type = None
        primary_model_name = None
        for asset_type in ("checkpoint", "unet", "diffusion_model"):
            if candidate_map[asset_type]:
                primary_model_type = asset_type
                primary_model_name = candidate_map[asset_type][0]["name"]
                break

        return {
            "source": "workflow_widget_fallback",
            "primary_model_type": primary_model_type,
            "primary_model_name": primary_model_name,
            "checkpoint_candidates": candidate_map["checkpoint"],
            "unet_candidates": candidate_map["unet"],
            "diffusion_model_candidates": candidate_map["diffusion_model"],
            "lora_candidates": candidate_map["lora"],
            "workflow_widget_lora_candidates": candidate_map["lora"],
            "yolo_candidates": candidate_map["yolo"],
            "loras": self._normalize_lora_names([item["name"] for item in candidate_map["lora"]]),
            "yolo_models": self._dedupe_non_empty_strings([item["name"] for item in candidate_map["yolo"]]),
        }

    def _merge_workflow_widget_assets_into_result(self, result: Dict[str, Any], metadata: Dict[str, Any]) -> None:
        """Merge explicit workflow widget assets into an already-detected result."""
        workflow_assets = self._extract_comfyui_model_assets_from_workflow_widgets(metadata.get("workflow"))
        if not workflow_assets:
            return

        if not result.get("checkpoint") and workflow_assets.get("primary_model_name"):
            result["checkpoint"] = workflow_assets.get("primary_model_name")

        result["loras"] = self._normalize_lora_names([
            *(result.get("loras") or []),
            *(workflow_assets.get("loras") or []),
        ])

        result["model_assets"] = self._merge_model_assets(result.get("model_assets"), workflow_assets)

    def _classify_comfyui_workflow_widget_asset(self, node_type: str, key_path: str, value: str) -> Optional[str]:
        """Classify widget-only values where the numeric path carries no semantic meaning."""
        node_type_lower = str(node_type or "").lower()
        text = str(value or "").strip()
        if not text or not self._looks_like_model_filename(text):
            return None

        if self._looks_like_yolo_model_name(text, node_type, key_path):
            return "yolo"
        if "lora" in node_type_lower:
            return "lora"
        if "unet" in node_type_lower:
            return "unet"
        if "diffusion" in node_type_lower:
            return "diffusion_model"
        if any(token in node_type_lower for token in ("checkpoint", "ckpt", "efficient loader", "comfyloader")):
            return "checkpoint"

        return None

    def _extract_comfyui_yolo_assets_from_full_graph(self, nodes: Dict[str, dict]) -> Optional[Dict[str, Any]]:
        """Collect YOLO/detector models from the full graph so optional detailers still surface."""
        candidates: List[Dict[str, Any]] = []
        seen: Set[Tuple[str, str, str, str]] = set()

        candidate_map = {"checkpoint": [], "unet": [], "diffusion_model": [], "model": [], "lora": [], "vae": [], "clip": [], "yolo": []}
        for node_id, node in nodes.items():
            if not isinstance(node, dict):
                continue
            self._scan_comfyui_asset_candidates(
                value=node.get("inputs", {}),
                key_path="inputs",
                node_id=node_id,
                class_type=str(node.get("class_type", "")),
                node_distance=50,
                candidate_map=candidate_map,
                seen=seen,
            )

        for item in sorted(
            candidate_map["yolo"],
            key=lambda candidate: (-candidate["score"], candidate["node_id"], candidate["name"].lower()),
        ):
            enriched = dict(item)
            enriched.setdefault("source_mode", "global_graph_fallback")
            candidates.append(enriched)

        if not candidates:
            return None

        return {
            "source": "global_graph_fallback",
            "global_yolo_candidates": candidates,
            "yolo_candidates": candidates,
            "yolo_models": self._dedupe_non_empty_strings([item["name"] for item in candidates]),
        }

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

    def _extract_comfyui_global_lora_candidates(self, nodes: Dict[str, dict]) -> List[Dict[str, Any]]:
        """Scan the full ComfyUI graph for secondary LoRA hints.

        These candidates are intentionally conservative and stay in model_assets
        only. They are not promoted into the main loras list from the global
        fallback because disconnected helper/UI nodes can easily be stale.
        """
        candidates: List[Dict[str, Any]] = []
        seen: Set[Tuple[str, str, str, str]] = set()

        for node_id, node in nodes.items():
            if not isinstance(node, dict):
                continue
            self._scan_comfyui_global_lora_candidates(
                value=node.get("inputs", {}),
                key_path="inputs",
                node_id=node_id,
                class_type=str(node.get("class_type", "")),
                candidates=candidates,
                seen=seen,
            )

        best_by_name: Dict[str, Dict[str, Any]] = {}
        for item in candidates:
            name = str(item.get("name", "")).strip()
            if not name:
                continue
            existing = best_by_name.get(name)
            if existing is None or self._is_better_global_lora_candidate(item, existing):
                best_by_name[name] = item

        return sorted(
            best_by_name.values(),
            key=lambda item: (
                self._global_lora_confidence_rank(item.get("confidence")),
                -int(item.get("score", 0)),
                str(item.get("node_id", "")),
                str(item.get("name", "")).lower(),
            ),
        )

    def _scan_comfyui_global_lora_candidates(
        self,
        value: Any,
        key_path: str,
        node_id: str,
        class_type: str,
        candidates: List[Dict[str, Any]],
        seen: Set[Tuple[str, str, str, str]],
    ) -> None:
        """Recursively scan the full graph for secondary LoRA evidence."""
        if isinstance(value, dict):
            if value.get("on") is False:
                return
            for key, nested_value in value.items():
                next_path = f"{key_path}.{key}" if key_path else str(key)
                self._scan_comfyui_global_lora_candidates(
                    nested_value,
                    next_path,
                    node_id,
                    class_type,
                    candidates,
                    seen,
                )
            return

        if isinstance(value, (list, tuple)):
            if len(value) >= 2 and isinstance(value[0], (str, int)):
                return
            for index, nested_value in enumerate(value):
                next_path = f"{key_path}[{index}]"
                self._scan_comfyui_global_lora_candidates(
                    nested_value,
                    next_path,
                    node_id,
                    class_type,
                    candidates,
                    seen,
                )
            return

        if not isinstance(value, str):
            return

        text = value.strip()
        if not text or text.lower() in {"none", "null", "false"}:
            return

        if self._is_explicit_comfyui_lora_key(key_path) and self._looks_like_model_filename(text):
            self._add_comfyui_global_lora_candidate(
                candidates=candidates,
                seen=seen,
                candidate_name=text,
                node_id=node_id,
                class_type=class_type,
                key_path=key_path,
                match_type="explicit_input",
                confidence="high",
            )

        if text[0] in "[{":
            for item in self._extract_comfyui_serialized_lora_candidates(text):
                full_key_path = self._join_comfyui_key_path(key_path, item["key_path_suffix"])
                self._add_comfyui_global_lora_candidate(
                    candidates=candidates,
                    seen=seen,
                    candidate_name=item["name"],
                    node_id=node_id,
                    class_type=class_type,
                    key_path=full_key_path,
                    match_type=item["match_type"],
                    confidence=item["confidence"],
                )
            return

        for lora_name in self._extract_inline_lora_tags(text):
            self._add_comfyui_global_lora_candidate(
                candidates=candidates,
                seen=seen,
                candidate_name=lora_name,
                node_id=node_id,
                class_type=class_type,
                key_path=key_path,
                match_type="inline_lora_tag",
                confidence="low",
            )

    def _extract_comfyui_serialized_lora_candidates(self, text: str) -> List[Dict[str, str]]:
        """Extract LoRA candidates from JSON-serialized strings.

        Only explicit lora/lora_name-style fields and inline <lora:...> tags are
        accepted here to avoid turning arbitrary UI tokens into fake LoRA names.
        """
        text = text.strip()
        if not text or text[0] not in "[{":
            return []

        try:
            payload = json.loads(text)
        except Exception:
            return []

        candidates: List[Dict[str, str]] = []

        def walk(value: Any, key_path: str = "") -> None:
            if isinstance(value, dict):
                for key, nested_value in value.items():
                    next_path = f"{key_path}.{key}" if key_path else str(key)
                    key_lower = str(key).lower()

                    if isinstance(nested_value, str):
                        nested_text = nested_value.strip()
                        if self._is_explicit_comfyui_lora_key(key_lower) and self._looks_like_model_filename(nested_text):
                            candidates.append({
                                "name": nested_text,
                                "key_path_suffix": next_path,
                                "match_type": "serialized_field",
                                "confidence": "high",
                            })

                        for lora_name in self._extract_inline_lora_tags(nested_text):
                            candidates.append({
                                "name": lora_name,
                                "key_path_suffix": next_path,
                                "match_type": "serialized_inline_lora_tag",
                                "confidence": "low",
                            })
                        continue

                    walk(nested_value, next_path)
                return

            if isinstance(value, list):
                for index, item in enumerate(value):
                    next_path = f"{key_path}[{index}]" if key_path else f"[{index}]"
                    walk(item, next_path)
                return

            if isinstance(value, str):
                nested_text = value.strip()
                for lora_name in self._extract_inline_lora_tags(nested_text):
                    candidates.append({
                        "name": lora_name,
                        "key_path_suffix": key_path or "value",
                        "match_type": "serialized_inline_lora_tag",
                        "confidence": "low",
                    })

        walk(payload)
        return candidates

    def _add_comfyui_global_lora_candidate(
        self,
        candidates: List[Dict[str, Any]],
        seen: Set[Tuple[str, str, str, str]],
        candidate_name: str,
        node_id: str,
        class_type: str,
        key_path: str,
        match_type: str,
        confidence: str,
    ) -> None:
        """Add a deduplicated global LoRA candidate with provenance metadata."""
        name = candidate_name.strip()
        if not name or name.lower() in {"none", "null", "false"}:
            return

        dedupe_key = (name, node_id, key_path, match_type)
        if dedupe_key in seen:
            return
        seen.add(dedupe_key)

        candidates.append({
            "name": name,
            "asset_type": "lora",
            "node_id": node_id,
            "class_type": class_type,
            "input_key": key_path.split(".")[-1],
            "key_path": key_path,
            "source_mode": "global_candidate_fallback",
            "match_type": match_type,
            "confidence": confidence,
            "score": self._score_comfyui_global_lora_candidate(
                class_type=class_type,
                key_path=key_path,
                candidate_name=name,
                match_type=match_type,
                confidence=confidence,
            ),
        })

    def _score_comfyui_global_lora_candidate(
        self,
        class_type: str,
        key_path: str,
        candidate_name: str,
        match_type: str,
        confidence: str,
    ) -> int:
        """Score full-graph LoRA candidates so the best provenance wins."""
        score = 300 if confidence == "high" else 200 if confidence == "medium" else 100
        class_type_lower = class_type.lower()
        key_path_lower = key_path.lower()

        if match_type == "explicit_input":
            score += 40
        elif match_type == "serialized_field":
            score += 35
        elif match_type == "inline_lora_tag":
            score += 20
        elif match_type == "serialized_inline_lora_tag":
            score += 15

        if "lora" in class_type_lower:
            score += 20
        if "lora" in key_path_lower:
            score += 15
        if self._looks_like_model_filename(candidate_name):
            score += 10

        return score

    def _is_better_global_lora_candidate(self, candidate: Dict[str, Any], existing: Dict[str, Any]) -> bool:
        """Pick the strongest provenance record when the same LoRA appears repeatedly."""
        candidate_rank = self._global_lora_confidence_rank(candidate.get("confidence"))
        existing_rank = self._global_lora_confidence_rank(existing.get("confidence"))
        if candidate_rank != existing_rank:
            return candidate_rank < existing_rank

        candidate_score = int(candidate.get("score", 0))
        existing_score = int(existing.get("score", 0))
        if candidate_score != existing_score:
            return candidate_score > existing_score

        return str(candidate.get("key_path", "")) < str(existing.get("key_path", ""))

    @staticmethod
    def _global_lora_confidence_rank(confidence: Optional[str]) -> int:
        """Stable sort order for candidate confidence labels."""
        return {
            "high": 0,
            "medium": 1,
            "low": 2,
        }.get(str(confidence or "").lower(), 3)

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

    def _scan_comfyui_asset_candidates(
        self,
        value: Any,
        key_path: str,
        node_id: str,
        class_type: str,
        node_distance: int,
        candidate_map: Dict[str, List[Dict[str, Any]]],
        seen: Set[Tuple[str, str, str, str]],
    ) -> None:
        """Recursively scan a node input tree for model / LoRA asset candidates."""
        if isinstance(value, dict):
            if value.get("on") is False:
                return
            for key, nested_value in value.items():
                next_path = f"{key_path}.{key}" if key_path else str(key)
                self._scan_comfyui_asset_candidates(
                    nested_value,
                    next_path,
                    node_id,
                    class_type,
                    node_distance,
                    candidate_map,
                    seen,
                )
            return

        if isinstance(value, (list, tuple)):
            if len(value) >= 2 and isinstance(value[0], (str, int)):
                return
            for index, nested_value in enumerate(value):
                next_path = f"{key_path}[{index}]"
                self._scan_comfyui_asset_candidates(
                    nested_value,
                    next_path,
                    node_id,
                    class_type,
                    node_distance,
                    candidate_map,
                    seen,
                )
            return

        if not isinstance(value, str):
            return

        asset_name = value.strip()
        if not asset_name or asset_name.lower() in {"none", "null", "false", "baked vae"}:
            return

        inline_loras = self._extract_inline_lora_tags(asset_name)
        if inline_loras:
            leaf_key = key_path.split(".")[-1]
            for inline_lora in inline_loras:
                dedupe_key = ("lora", inline_lora, node_id, leaf_key)
                if dedupe_key in seen:
                    continue
                seen.add(dedupe_key)
                score = self._score_comfyui_asset_candidate("lora", leaf_key, class_type, inline_lora, node_distance) + 30
                candidate_map["lora"].append({
                    "name": inline_lora,
                    "node_id": node_id,
                    "class_type": class_type,
                    "input_key": leaf_key,
                    "distance": node_distance,
                    "score": score,
                })

        asset_type = self._classify_comfyui_asset_candidate(key_path, class_type, asset_name)
        if not asset_type:
            return

        expanded_asset_names = self._expand_serialized_asset_value(asset_type, asset_name)
        if expanded_asset_names:
            asset_names = expanded_asset_names
        else:
            asset_names = [asset_name]

        leaf_key = key_path.split(".")[-1]
        for candidate_name in asset_names:
            candidate_name = candidate_name.strip()
            if not candidate_name or candidate_name.lower() in {"none", "null", "false"}:
                continue
            dedupe_key = (asset_type, candidate_name, node_id, leaf_key)
            if dedupe_key in seen:
                continue
            seen.add(dedupe_key)

            score = self._score_comfyui_asset_candidate(asset_type, leaf_key, class_type, candidate_name, node_distance)
            candidate_map[asset_type].append({
                "name": candidate_name,
                "node_id": node_id,
                "class_type": class_type,
                "input_key": leaf_key,
                "distance": node_distance,
                "score": score,
            })

    def _classify_comfyui_asset_candidate(self, key_path: str, class_type: str, asset_name: str) -> Optional[str]:
        """Guess asset type from input semantics instead of node-name whitelists."""
        leaf_key = key_path.split(".")[-1].lower()
        key_path_lower = key_path.lower()
        class_type_lower = class_type.lower()

        if leaf_key in self.COMFYUI_MODEL_KEY_TYPES:
            mapped_type = self.COMFYUI_MODEL_KEY_TYPES[leaf_key]
            if mapped_type == "model" and self._looks_like_yolo_model_name(asset_name, class_type, key_path):
                return "yolo"
            return mapped_type

        if re.match(r"^lora_\d+$", leaf_key):
            return "lora"
        if self._is_explicit_comfyui_lora_key(key_path):
            return "lora"
        if "ckpt" in leaf_key or "checkpoint" in leaf_key:
            return "checkpoint"
        if "unet" in leaf_key:
            return "unet"
        if "vae" in leaf_key:
            return "vae"
        if "clip" in leaf_key and "name" in leaf_key:
            return "clip"
        if "diffusion" in leaf_key and "model" in leaf_key:
            return "diffusion_model"
        if any(token in leaf_key for token in ("yolo", "detector", "bbox", "segm")):
            return "yolo"

        if not self._looks_like_model_filename(asset_name):
            if "lora" in class_type_lower and leaf_key in {"lora", "lora_name"}:
                return "lora"
            if "loramanager" in class_type_lower and leaf_key == "name":
                return "lora"
            return None

        if self._looks_like_yolo_model_name(asset_name, class_type, key_path):
            return "yolo"
        if "lora" in class_type_lower:
            return "lora"
        if "vae" in class_type_lower:
            return "vae"
        if "clip" in class_type_lower and "loader" in class_type_lower:
            return "clip"
        if "unet" in class_type_lower:
            return "unet"
        if "diffusion" in class_type_lower:
            return "diffusion_model"
        if any(token in class_type_lower for token in ("checkpoint", "ckpt", "loader", "model")):
            return "model"

        return None

    def _score_comfyui_asset_candidate(
        self,
        asset_type: str,
        input_key: str,
        class_type: str,
        asset_name: str,
        node_distance: int,
    ) -> int:
        """Score candidates so the closest, most semantically explicit one wins."""
        score = 0
        class_type_lower = class_type.lower()
        input_key_lower = input_key.lower()

        if asset_type == "checkpoint":
            score += 400
        elif asset_type == "unet":
            score += 320
        elif asset_type == "diffusion_model":
            score += 300
        elif asset_type == "vae":
            score += 280
        elif asset_type == "clip":
            score += 270
        elif asset_type == "model":
            score += 260
        elif asset_type == "lora":
            score += 350
        elif asset_type == "yolo":
            score += 240

        if input_key_lower in self.COMFYUI_MODEL_KEY_TYPES:
            score += 120
        elif re.match(r"^lora_\d+$", input_key_lower):
            score += 110

        if "efficient loader" in class_type_lower:
            score += 80
        if "loader" in class_type_lower:
            score += 40
        if asset_type == "yolo":
            if any(token in class_type_lower for token in ("ultralytics", "yolo", "detector", "detailer", "adetailer")):
                score += 100
            if any(token in input_key_lower for token in ("yolo", "detector", "bbox", "segm")):
                score += 90
        if self._looks_like_model_filename(asset_name):
            score += 20

        score -= node_distance * 5
        return score

    def _looks_like_model_filename(self, value: str) -> bool:
        """Return True when a string looks like a model / LoRA filename."""
        value_lower = value.lower().strip()
        return value_lower.endswith(self.COMFYUI_MODEL_FILE_EXTENSIONS)

    def _extract_inline_lora_tags(self, text: str) -> List[str]:
        """Extract <lora:name:weight> tags from prompt-like strings."""
        matches = re.findall(r"<lora:([^:>,\r\n]+)(?::[^>\r\n]*)?>", text, flags=re.IGNORECASE)
        names: List[str] = []
        seen = set()
        for match in matches:
            name = match.strip()
            if not name or name.lower() == "none" or name in seen:
                continue
            seen.add(name)
            names.append(name)
        return names

    def _expand_serialized_asset_value(self, asset_type: str, asset_name: str) -> List[str]:
        """Expand JSON-serialized UI stacks into actual asset filenames."""
        asset_name = asset_name.strip()
        if not asset_name or asset_name[0] not in "[{":
            return []

        try:
            payload = json.loads(asset_name)
        except Exception:
            return []

        names: List[str] = []
        allowed_keys = {
            "lora": {"lora", "lora_name", "lora_path", "lora_file"},
            "checkpoint": {"ckpt_name", "checkpoint", "checkpoint_name", "model_name", "name"},
            "unet": {"unet_name", "model_name", "name"},
            "diffusion_model": {"diffusion_model", "diffusion_model_name", "model_name", "name"},
            "model": {"model_name", "ckpt_name", "unet_name", "diffusion_model", "name"},
            "yolo": {"model_name", "yolo_model", "yolo_model_name", "detector_model", "detector_model_name", "bbox_model_name", "segm_model_name", "name"},
        }.get(asset_type, {"name"})

        def walk(value: Any) -> None:
            if isinstance(value, dict):
                for key, nested in value.items():
                    if isinstance(nested, str) and key.lower() in allowed_keys and self._looks_like_model_filename(nested):
                        names.append(nested)
                    walk(nested)
            elif isinstance(value, list):
                for item in value:
                    walk(item)

        walk(payload)
        return names

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
                texts = self._trace_to_text(pos_ref, nodes, set())
                positive_texts.extend(texts)

            # Trace negative conditioning
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

        # Join/Concat nodes use numbered keys (string_1, string_2, …)
        if any(kw in class_type for kw in ["Concatenate", "Concat", "JoinString", "Join"]):
            nested_visited = set(visited)
            nested_visited.add(node_id)
            results: List[Dict[str, Any]] = []
            for key in ["string_a", "string_b", "string1", "string2",
                         "text1", "text2", "text_a", "text_b",
                         "prompt1", "prompt2", "prompt3",
                         "string_1", "string_2", "string_3", "string_4"]:
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
                    traced = self._trace_to_text_with_source(val, nodes, nested_visited, depth + 1)
                    results.extend(traced)
            if results:
                return results

        for key in ["text_0", "text", "prompt", "user_prompt", "string", "String", "value", "result"]:
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
            for key in ["text", "string", "String", "prompt", "user_prompt", "positive",
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

        # Extract LoRAs from prompt text. Allow both weighted and weightless tags.
        loras = self._extract_inline_lora_tags(params)

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
            checkpoint = self._extract_webui_checkpoint_identifier(gen_params, params)

        extra_loras = self._extract_webui_loras_from_metadata(params, gen_params)
        if extra_loras:
            merged = []
            seen = set()
            for name in [*loras, *extra_loras]:
                normalized = str(name).strip()
                if not normalized or normalized.lower() == "none" or normalized in seen:
                    continue
                seen.add(normalized)
                merged.append(normalized)
            loras = merged

        return (prompt, negative, checkpoint, loras, gen_params if gen_params else None)

    def _extract_webui_loras_from_metadata(self, params: str, gen_params: Optional[Dict[str, Any]]) -> List[str]:
        """Recover LoRA names from WebUI/Forge metadata beyond inline <lora:...> tags."""
        names: List[str] = []
        seen = set()

        def push(value: Any) -> None:
            text = str(value or "").strip().strip('"')
            if not text or text.lower() == "none" or text in seen:
                return
            seen.add(text)
            names.append(text)

        if gen_params:
            lora_hashes = gen_params.get("lora_hashes") or gen_params.get("Lora hashes")
            if isinstance(lora_hashes, str):
                for part in lora_hashes.strip().strip('"').split(","):
                    pair = part.strip()
                    if not pair or ":" not in pair:
                        continue
                    push(pair.split(":", 1)[0].strip())

            for key, value in gen_params.items():
                key_lower = str(key).lower()
                if key_lower.startswith("addnet_model_") or key_lower.startswith("addnet module_"):
                    push(value)

            for key in ("loras", "lora", "lora_names"):
                value = gen_params.get(key)
                if isinstance(value, str):
                    for part in re.split(r"[,\n]", value):
                        push(part)

        # Some exports store AddNet names only in the raw parameters blob.
        for match in re.finditer(r"AddNet Model \d+:\s*([^,\n]+)", params, re.IGNORECASE):
            push(match.group(1))

        return names

    def _parse_gen_params_line(self, params_line: str) -> Dict[str, Any]:
        """Parse the 'Steps: 20, Sampler: Euler a, CFG scale: 7, ...' line into a dict."""
        result: Dict[str, Any] = {}
        pairs = []
        current = []
        in_quotes = False

        for idx, char in enumerate(params_line):
            if char == '"' and (idx == 0 or params_line[idx - 1] != '\\'):
                in_quotes = not in_quotes
                current.append(char)
                continue

            if char == ',' and not in_quotes:
                remainder = params_line[idx + 1:]
                if re.match(r'^\s*[A-Za-z][A-Za-z0-9 _/\-]*:', remainder):
                    pair = ''.join(current).strip()
                    if pair:
                        pairs.append(pair)
                    current = []
                    continue

            current.append(char)

        trailing = ''.join(current).strip()
        if trailing:
            pairs.append(trailing)

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
            except (ValueError, TypeError) as e:
                logger.debug('Failed to parse gen param %s=%s: %s', key, value, e)
                result[key_lower] = value

        return result

    def _extract_exif(self, img: Image.Image) -> dict:
        """Extract top-level EXIF data from image."""
        try:
            return self._extract_exif_mapping(img.getexif())
        except Exception as e:
            logger.debug("Error extracting EXIF: %s", e)
        return {}

    def _extract_exif_mapping(self, exif: Any) -> dict:
        """Extract top-level EXIF tags from an Exif mapping object."""
        metadata = {}
        try:
            if exif:
                from PIL import ExifTags
                for tag_id, value in exif.items():
                    tag_name = ExifTags.TAGS.get(tag_id, tag_id)
                    if isinstance(value, bytes):
                        try:
                            metadata[tag_name] = value.decode('utf-8', errors='replace')
                        except Exception as e:
                            logger.debug("Failed to decode EXIF tag %s: %s", tag_name, e)
                            metadata[tag_name] = str(value)
                    else:
                        metadata[tag_name] = value
        except Exception as e:
            logger.debug("Error extracting EXIF: %s", e)
        return metadata

    def _extract_exif_from_bytes(self, exif_bytes: bytes) -> dict:
        """Extract top-level EXIF tags from raw EXIF bytes."""
        try:
            exif = Image.Exif()
            exif.load(exif_bytes)
            return self._extract_exif_mapping(exif)
        except Exception as e:
            logger.debug("Error extracting EXIF bytes: %s", e)
            return {}

    def _extract_exif_ifd(self, img: Image.Image) -> dict:
        """
        Extract EXIF IFD (sub-directory) data, specifically UserComment.
        NovelAI V4+ stores prompt data here for WebP images.
        """
        try:
            return self._extract_exif_ifd_mapping(img.getexif())
        except Exception:
            return {}

    def _extract_exif_ifd_mapping(self, exif: Any) -> dict:
        """
        Extract EXIF IFD (sub-directory) data, specifically UserComment.
        NovelAI V4+ stores prompt data here for WebP images.
        """
        metadata: Dict[str, Any] = {}
        try:
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
                        except Exception as e:
                            logger.debug("Failed to decode EXIF IFD tag %s: %s", tag_name, e)
                            metadata[tag_name] = str(value)
                    else:
                        metadata[tag_name] = value
        except Exception as e:
            # Non-critical, some images don't have EXIF IFD
            pass
        return metadata

    def _extract_exif_ifd_from_bytes(self, exif_bytes: bytes) -> dict:
        """Extract EXIF IFD tags from raw EXIF bytes."""
        try:
            exif = Image.Exif()
            exif.load(exif_bytes)
            return self._extract_exif_ifd_mapping(exif)
        except Exception:
            return {}

    def _extract_jpeg_sd_metadata(self, img: Image.Image) -> dict:
        """Extract SD metadata from JPEG EXIF fields."""
        try:
            return self._extract_sd_metadata_from_exif(img.getexif())
        except Exception as e:
            logger.debug("Error extracting JPEG SD metadata: %s", e)
            return {}

    def _extract_sd_metadata_from_exif_bytes(self, exif_bytes: bytes) -> dict:
        """Extract SD-style metadata from raw EXIF bytes."""
        try:
            exif = Image.Exif()
            exif.load(exif_bytes)
            return self._extract_sd_metadata_from_exif(exif)
        except Exception as e:
            logger.debug("Error extracting SD metadata from EXIF bytes: %s", e)
            return {}

    def _extract_sd_metadata_from_exif(self, exif: Any) -> dict:
        """Extract SD metadata from an Exif mapping object."""
        metadata: Dict[str, Any] = {}
        try:
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

            # Check UserComment in Exif IFD for ComfyUI / WebUI params
            ifd = exif.get_ifd(0x8769)
            if ifd:
                uc = ifd.get(0x9286)  # UserComment
                if uc:
                    text = None
                    if isinstance(uc, bytes):
                        for prefix in (b'ASCII\x00\x00\x00', b'UNICODE\x00', b'\x00' * 8):
                            if uc.startswith(prefix):
                                text = uc[len(prefix):].decode('utf-8', errors='replace')
                                break
                        if text is None:
                            text = uc.decode('utf-8', errors='replace')
                    elif isinstance(uc, str):
                        text = uc

                    if text and text.strip():
                        text = text.strip()
                        if text.startswith('{'):
                            try:
                                obj = json.loads(text)
                                if isinstance(obj, dict) and any(
                                    isinstance(v, dict) and "class_type" in v
                                    for v in obj.values()
                                ):
                                    metadata["prompt"] = text
                            except (json.JSONDecodeError, ValueError):
                                pass
                        if "prompt" not in metadata and "Steps:" in text and "Sampler:" in text:
                            metadata["parameters"] = text
        except Exception as e:
            logger.debug("Error extracting JPEG SD metadata: %s", e)
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
                                    except json.JSONDecodeError as e:
                                        logger.debug('Failed to parse XMP prompt JSON: %s', e)

                    except Exception as e:
                        logger.debug("Failed to decode WebP XMP: %s", e)

        except Exception as e:
            logger.error("Error extracting WebP XMP from %s: %s", image_path, e)

        return metadata


# Singleton instance
_parser = None

def get_parser() -> MetadataParser:
    """Get the singleton parser instance."""
    global _parser
    if _parser is None:
        _parser = MetadataParser()
    return _parser


def parse_image(image_path: str, validate_image_data: bool = False) -> Dict[str, Any]:
    """Convenience function to parse a single image."""
    return get_parser().parse(image_path, validate_image_data=validate_image_data)


def verify_image_readable(image_path: str) -> Tuple[bool, Optional[str]]:
    """Confirm an image can be fully decoded, not just opened for metadata."""
    try:
        with Image.open(image_path) as img:
            img.verify()
        with Image.open(image_path) as img:
            img.load()
        return True, None
    except Exception as exc:
        return False, str(exc)
