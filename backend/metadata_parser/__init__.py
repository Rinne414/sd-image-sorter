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
# =============================================================================
# metadata_parser (package top module) - decomposition stages 1+2+3 (2026-07-13).
# Stages 1+2: extracted VERBATIM from backend/metadata_parser.py @ c06d374
# (4,912 lines) into constants + pure-format mixins + the comfyui sub-package.
# Stage 3: the loader/sidecar/C2PA/EXIF-bytes/verify method mass moved VERBATIM
# to metadata_parser/_runtime.py (ParserRuntimeMixin + verify_image_readable);
# this module keeps parse()/dispatch, the pure text/serialize helpers, the
# singleton and every historical re-export. MRO resolves self.* as before.
# Patched seams (Image / open / _MAX_* / _sidecar_directory_cache): the
# bare-name READERS live in _runtime.py (parse() below also reads Image); the
# _MetadataParserPackage proxy at the bottom of this file forwards
# package-level get/set/del so monkeypatching `metadata_parser.<seam>` still
# lands where the readers resolve it. See tests/test_metadata_parser_pins.py.
import json
import logging
import os
import sys
from types import ModuleType
from typing import Optional, Dict, Any
from PIL import Image
from .constants import PARSED_METADATA_VERSION

from . import _runtime
from ._runtime import ParserRuntimeMixin, verify_image_readable
from .alt_generators import AltGeneratorsMixin
from .comfyui import (
    ComfyUIAssetsMixin,
    ComfyUIExtractMixin,
    ComfyUIGraphMixin,
    ComfyUITextTraceMixin,
)
from .constants import ParserVocabularyMixin
from .exif_xmp import ExifXmpMixin
from .model_assets import ModelAssetsMixin
from .novelai import NovelAIMixin
from .webui import WebUIMixin

logger = logging.getLogger(__name__)


class MetadataParser(
    ParserRuntimeMixin,
    ParserVocabularyMixin,
    ExifXmpMixin,
    ModelAssetsMixin,
    WebUIMixin,
    AltGeneratorsMixin,
    NovelAIMixin,
    ComfyUIExtractMixin,
    ComfyUIAssetsMixin,
    ComfyUIGraphMixin,
    ComfyUITextTraceMixin,
):
    """Parse metadata from SD-generated images to detect source and extract prompts."""

    def parse(self, image_path: str, validate_image_data: bool = False) -> Dict[str, Any]:
        """
        Parse image metadata and return structured data.

        Returns:
            {
                "generator": str,  # comfyui, nai, webui, forge, others, unknown
                "prompt": str or None,
                "negative_prompt": str or None,
                "checkpoint": str or None,
                "loras": list of str,
                "metadata": dict,  # Full raw metadata (includes _parsed key)
                "width": int,
                "height": int,
                "file_size": int,
                "parse_error": str or None,  # Fatal image/container failure
                "metadata_error": str or None  # Non-fatal embedded metadata failure
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
            "metadata_error": None,
        }

        try:
            result["file_size"] = os.path.getsize(image_path)
            metadata = self._load_image_metadata(image_path)
            result["width"] = metadata["width"]
            result["height"] = metadata["height"]
            result["metadata_error"] = metadata.get("metadata_error")

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
            parsed = self._detect_and_parse(metadata["metadata"], image_path=image_path, file_size=result["file_size"])
            if parsed["generator"] == "unknown" and not any((parsed.get("prompt"), parsed.get("negative_prompt"), parsed.get("checkpoint"), parsed.get("loras"))):
                sidecar_metadata = self._load_sidecar_metadata(image_path)
                if sidecar_metadata:
                    combined_metadata = {**metadata["metadata"], **sidecar_metadata}
                    sidecar_parsed = self._detect_and_parse(combined_metadata, image_path=image_path, file_size=result["file_size"])
                    if sidecar_parsed["generator"] != "unknown" or any((
                        sidecar_parsed.get("prompt"),
                        sidecar_parsed.get("negative_prompt"),
                        sidecar_parsed.get("checkpoint"),
                        sidecar_parsed.get("loras"),
                    )):
                        metadata["metadata"] = combined_metadata
                        result["metadata"] = self._serialize_metadata(combined_metadata)
                        parsed = sidecar_parsed
            result["generator"] = parsed["generator"]
            result["prompt"] = parsed["prompt"]
            result["negative_prompt"] = parsed["negative_prompt"]
            result["checkpoint"] = parsed["checkpoint"]
            result["loras"] = parsed["loras"]

            # Add civitai_resources to top-level result if present
            if "civitai_resources" in parsed:
                result["civitai_resources"] = parsed["civitai_resources"]

            # Store structured parsed data in metadata for frontend access
            result["metadata"]["_parsed"] = {
                "version": PARSED_METADATA_VERSION,
                "generation_params": parsed.get("generation_params"),
                "is_img2img": parsed.get("is_img2img", False),
                "img2img_info": parsed.get("img2img_info"),
                "character_prompts": parsed.get("character_prompts"),
                "prompt_nodes": parsed.get("prompt_nodes"),
                "model_assets": parsed.get("model_assets"),
                "civitai_resources": parsed.get("civitai_resources"),
            }

            # Metadata L3: parsing produced no positive prompt but the file
            # DOES carry metadata chunks — keep the originals so "Re-parse
            # failed images" can replay them through a future, better parser
            # even if the file is later moved or deleted. metadata_json is not
            # enough for that: it truncates large chunks during compaction.
            if not (result["prompt"] and str(result["prompt"]).strip()):
                raw_text = self._capture_raw_metadata_text(metadata["metadata"])
                if raw_text:
                    result["raw_metadata_text"] = raw_text

        except Exception as e:
            result["parse_error"] = str(e)
            logger.debug("Failed to parse metadata for %s: %s", image_path, e, exc_info=True)

        return result

    def _capture_raw_metadata_text(self, metadata: Dict[str, Any]) -> Optional[str]:
        """Serialize the original string metadata chunks for L3 retention.

        Returns a JSON envelope of every string chunk (``{"prompt": "...",
        "workflow": "...", ...}``) — the same shape ``_detect_and_parse``
        consumes, so the re-parse job can replay it directly. Returns None
        when there is nothing worth keeping or the caps are exceeded.
        """
        try:
            envelope: Dict[str, str] = {}
            total = 0
            for key, value in metadata.items():
                if not isinstance(key, str) or not isinstance(value, str):
                    continue
                if not value.strip():
                    continue
                if len(value) > self.RAW_METADATA_CHUNK_CAP:
                    continue
                envelope[key] = value
                total += len(value)
                if total > self.RAW_METADATA_TOTAL_CAP:
                    return None
            if not envelope:
                return None
            return json.dumps(envelope, ensure_ascii=False)
        except Exception as exc:
            logger.debug("raw metadata capture failed: %s", exc)
            return None

    def _serialize_metadata(self, metadata: dict) -> dict:
        """Serialize metadata to JSON-safe format."""
        result = {}
        for key, value in metadata.items():
            try:
                # Try to serialize, skip if not possible
                json.dumps({key: value})
                result[key] = value
            except (TypeError, ValueError):
                # Convert bytes to string - serialization failed
                if isinstance(value, bytes):
                    try:
                        result[key] = value.decode('utf-8', errors='replace')
                    except Exception:
                        result[key] = str(value)
                else:
                    result[key] = str(value)
        return result

    def _decode_exif_user_comment(self, value: Any) -> Optional[str]:
        """Decode EXIF UserComment bytes written by SD tools for JPEG/WebP."""
        if value is None:
            return None
        if isinstance(value, str):
            text = value
            if text.startswith("ASCII") or text.startswith("UNICODE"):
                text = text[7:].strip("\0 ")
            return text.strip() or None
        if not isinstance(value, bytes):
            text = str(value).strip()
            return text or None

        if value.startswith(b"ASCII\x00\x00\x00"):
            text = value[8:].decode("utf-8", errors="replace")
        elif value.startswith(b"UNICODE\x00"):
            payload = value[8:]
            text = self._decode_exif_unicode_payload(payload)
        elif value.startswith(b"\x00" * 8):
            text = value[8:].decode("utf-8", errors="replace")
        else:
            text = self._decode_exif_text_bytes(value)

        text = text.strip("\0 ")
        return text or None

    def _decode_exif_unicode_payload(self, payload: bytes) -> str:
        """Decode the non-standard-but-common UNICODE UserComment payload."""
        if payload.startswith(b"\xff\xfe") or payload.startswith(b"\xfe\xff"):
            return payload.decode("utf-16", errors="replace")
        if len(payload) >= 2 and payload[1:2] == b"\x00":
            return payload.decode("utf-16-le", errors="replace")
        return payload.decode("utf-16-be", errors="replace")

    def _decode_exif_text_bytes(self, value: bytes) -> str:
        """Decode generic EXIF text bytes, including Windows XP* UTF-16LE tags."""
        if value.startswith(b"\xff\xfe") or value.startswith(b"\xfe\xff"):
            return value.decode("utf-16", errors="replace")
        if len(value) >= 4 and value[1::2].count(0) >= max(1, len(value) // 4):
            return value.decode("utf-16-le", errors="replace")
        return value.decode("utf-8", errors="replace")

    def _looks_like_comfyui_prompt_dict(self, payload: Any) -> bool:
        """Return True for ComfyUI API prompt dictionaries."""
        return isinstance(payload, dict) and any(
            isinstance(value, dict) and "class_type" in value
            for value in payload.values()
        )

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

    def _detect_and_parse(self, metadata: dict, image_path: Optional[str] = None, file_size: int = 0) -> Dict[str, Any]:
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
                    # ---- Fooocus disambiguation ---------------------
                    # Fooocus uses lowercase `prompt`/`negative_prompt`
                    # in the same `Comment` chunk, which would otherwise
                    # be classified as NovelAI here. Detect Fooocus by
                    # its distinctive sibling keys (`base_model`,
                    # `performance`, `metadata_scheme`, `version`
                    # containing "Fooocus") OR the presence of
                    # `negative_prompt` instead of NovelAI's `uc`.
                    if isinstance(comment_data, dict):
                        looks_like_fooocus = (
                            metadata.get("fooocus_scheme") is not None
                            or comment_data.get("metadata_scheme") in {"fooocus", "a1111"}
                            or "base_model" in comment_data
                            or "performance" in comment_data
                            or "Performance" in comment_data
                            or "Base Model" in comment_data
                            or "negative_prompt" in comment_data and "uc" not in comment_data
                            or (
                                isinstance(comment_data.get("version"), str)
                                and "fooocus" in comment_data["version"].lower()
                            )
                        )
                        if looks_like_fooocus:
                            fooocus_result = self._maybe_parse_fooocus(metadata)
                            if fooocus_result:
                                base.update({k: v for k, v in fooocus_result.items() if v is not None or k in ("prompt", "negative_prompt", "checkpoint")})
                                base.setdefault("loras", fooocus_result.get("loras") or [])
                                if not base.get("model_assets"):
                                    base["model_assets"] = fooocus_result.get("model_assets")
                                return base

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
                        pos, neg, cp, lr, gen_params, prompt_nodes, img2img, model_assets, civitai_resources = self._extract_comfyui_data_extended(prompt_data, workflow_data)
                        base.update({
                            "generator": "comfyui", "prompt": pos, "negative_prompt": neg,
                            "checkpoint": cp, "loras": lr, "generation_params": gen_params,
                            "prompt_nodes": prompt_nodes,
                            "model_assets": model_assets,
                        })
                        if civitai_resources:
                            base["civitai_resources"] = civitai_resources
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
                pos, neg, cp, lr, gen_params, prompt_nodes, img2img, model_assets, civitai_resources = self._extract_comfyui_data_extended(prompt_raw, workflow)
                if not pos and isinstance(workflow, dict):
                    pos, neg = self._extract_from_workflow(workflow)
                base.update({
                    "generator": "comfyui", "prompt": pos, "negative_prompt": neg,
                    "checkpoint": cp, "loras": lr, "generation_params": gen_params,
                    "prompt_nodes": prompt_nodes,
                    "model_assets": model_assets,
                })
                if civitai_resources:
                    base["civitai_resources"] = civitai_resources
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

        # === Alternate generators (Fooocus / Easy Diffusion / InvokeAI /
        # === SwarmUI / Draw Things). These run before the generic
        # === `_parse_explicit_saved_metadata` fallback so they can claim
        # === metadata that the generic path would otherwise label as
        # === "others".
        for detector in (
            self._maybe_parse_fooocus,
            self._maybe_parse_swarmui,
            self._maybe_parse_invokeai,
            self._maybe_parse_drawthings,
            self._maybe_parse_easy_diffusion,
        ):
            try:
                alt = detector(metadata)
            except Exception as exc:  # pragma: no cover — defensive
                logger.debug("alt-generator detector %s failed: %s", detector.__name__, exc)
                continue
            if alt:
                base.update({k: v for k, v in alt.items() if v is not None or k in ("prompt", "negative_prompt", "checkpoint")})
                base.setdefault("loras", alt.get("loras") or [])
                if not base.get("model_assets"):
                    base["model_assets"] = alt.get("model_assets")
                return base

        explicit_saved = self._parse_explicit_saved_metadata(metadata)
        if explicit_saved:
            base.update(explicit_saved)
            base["model_assets"] = self._build_explicit_model_assets(
                source="explicit_metadata",
                checkpoint=base["checkpoint"],
                loras=base["loras"],
            )
            if base["generator"] == "unknown":
                base["generator"] = "others"
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

        # === Closed-source AI providers (Gemini / gpt-image / DALL-E).
        ai_provider = self._maybe_detect_ai_provider(metadata, image_path=image_path, file_size=file_size)
        if ai_provider:
            base.update({k: v for k, v in ai_provider.items() if v is not None or k in ("prompt", "negative_prompt", "checkpoint")})
            base.setdefault("loras", ai_provider.get("loras") or [])
            return base

        # Has metadata but unrecognized generator → "others"
        if base["generator"] == "unknown" and any((base.get("prompt"), base.get("negative_prompt"), base.get("checkpoint"), base.get("loras"))):
            base["generator"] = "others"

        return base


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


# ---------------------------------------------------------------------------
# Stage-3 seam proxy (smart_tag_service dynamic-facade precedent, 980b309).
#
# The loader/sidecar/verify bodies moved to _runtime.py, but the historical
# monkeypatch surface is THIS package module:
#
#     monkeypatch.setattr(metadata_parser_module, "open", fake, raising=False)
#     monkeypatch.setattr(metadata_parser_module, "_MAX_DECOMPRESSED_BYTES", 64)
#     monkeypatch.setattr(metadata_parser_module, "_MAX_SIDECAR_DIRECTORY_CACHE_FILENAMES", 1)
#     monkeypatch.setattr(metadata_parser_module.Image, "open", fake)
#
# Bare-name reads inside _runtime resolve from _runtime's own globals, so a
# patch must physically land there. PEP 562 module __getattr__ covers GET
# only; rebinding (SET) and monkeypatch teardown (DEL) need a ModuleType
# subclass. Semantics preserved per seam:
#
#   * open  -- builtin shadow: absent from BOTH namespaces until a test sets
#     it (getattr raises AttributeError, so monkeypatch raising=False records
#     'absent' and tears down via delattr); while set, the moved readers
#     resolve the patched callable; after delattr they fall back to the
#     real builtin.
#   * _MAX_DECOMPRESSED_BYTES / _MAX_SIDECAR_DIRECTORY_CACHE_FILENAMES --
#     no longer bound in this namespace; get/set/del forward to _runtime,
#     whose bindings the moved readers use.
#   * Image -- read at call time BOTH by parse() (this module) and by the
#     moved loaders/verify (_runtime), so a rebind fans out to both
#     namespaces. (.Image.open patches mutate the shared PIL.Image module
#     in place and need no forwarding.)
#
# Every other attribute missing here falls through to _runtime on GET
# (PNG_SIGNATURE, _sidecar_directory_cache, struct, ... -- names that moved
# with the mass), and a SET of a name _runtime owns rebinds it there so the
# patch stays effective for its readers; names owned here (logger, _parser,
# parse_image, ...) keep native module behavior.
# ---------------------------------------------------------------------------
_RUNTIME_SEAM_NAMES = frozenset(
    {"open", "_MAX_DECOMPRESSED_BYTES", "_MAX_SIDECAR_DIRECTORY_CACHE_FILENAMES"}
)


class _MetadataParserPackage(ModuleType):
    """Package module subclass forwarding seam get/set/del to ``_runtime``."""

    def __getattr__(self, name: str):
        try:
            return getattr(_runtime, name)
        except AttributeError:
            raise AttributeError(
                f"module {self.__name__!r} has no attribute {name!r}"
            ) from None

    def __setattr__(self, name: str, value) -> None:
        if name == "Image":
            super().__setattr__(name, value)
            setattr(_runtime, name, value)
            return
        if name in _RUNTIME_SEAM_NAMES or (
            name not in self.__dict__ and hasattr(_runtime, name)
        ):
            setattr(_runtime, name, value)
            return
        super().__setattr__(name, value)

    def __delattr__(self, name: str) -> None:
        if name == "Image":
            super().__delattr__(name)
            delattr(_runtime, name)
            return
        if name in _RUNTIME_SEAM_NAMES or (
            name not in self.__dict__ and hasattr(_runtime, name)
        ):
            delattr(_runtime, name)
            return
        super().__delattr__(name)

    def __dir__(self):
        return sorted(set(super().__dir__()) | set(vars(_runtime)))


sys.modules[__name__].__class__ = _MetadataParserPackage
