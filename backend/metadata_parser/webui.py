# =============================================================================
# metadata_parser.webui - metadata_parser decomposition stages 1+2 (2026-07-13).
# Extracted VERBATIM from backend/metadata_parser.py @ c06d374 (4,912 lines).
# Source line ranges (original file): 1269-1397, 4375-4550.
# Mixin: WebUI / A1111 / Forge / reForge parameter parsing.
# self.* calls and class-constant lookups resolve via MRO exactly as before.
# Patched seams (Image / open / _MAX_* / _sidecar_directory_cache): the readers
# live in metadata_parser/_runtime.py behind the package get/set proxy in
# __init__.py (stage 3); see tests/test_metadata_parser_pins.py.
import json
import logging
import re
from typing import Optional, Dict, Any, Tuple, List

logger = logging.getLogger(__name__)

class WebUIMixin:
    """WebUI / A1111 / Forge / reForge parameter parsing."""

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
        """Distinguish Forge / reForge / vanilla A1111/WebUI before returning parsed parameters."""
        def has_reforge_signature(value: Any) -> bool:
            text = str(value or "").strip().lower()
            if not text:
                return False
            # Panchovix/sd-webui-reForge advertises itself as "reForge" in
            # `Software`, `Source`, `Version` etc. Match the name with
            # tolerant separators so we still catch hyphen / underscore /
            # camelcase variations from forks.
            if re.search(r"\bre[-_\s]?forge\b", text):
                return True
            if re.search(r"\bsd[-_\s]?webui[-_\s]?re[-_\s]?forge\b", text):
                return True
            if re.search(r"\bstable[-_\s]?diffusion[-_\s]?(?:webui[-_\s]?)?re[-_\s]?forge\b", text):
                return True
            return False

        def has_forge_signature(value: Any) -> bool:
            text = str(value or "").strip().lower()
            if not text:
                return False
            if has_reforge_signature(text):
                # reForge will be picked up by the dedicated check below; keep
                # this signature strict to vanilla Forge.
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
            if has_reforge_signature(metadata.get(key)):
                return "reforge"
        for key in ("Software", "software", "Source", "source", "Generator", "generator"):
            if has_forge_signature(metadata.get(key)):
                return "forge"

        if gen_params:
            for key, value in gen_params.items():
                key_normalized = str(key or "").strip().lower().replace(" ", "_")
                if key_normalized in {"reforge_version", "sd_webui_reforge_version"}:
                    return "reforge"
                if key_normalized in {"forge_version", "sd_webui_forge_version"}:
                    return "forge"
                if key_normalized in {"version", "software", "source", "generator"}:
                    if has_reforge_signature(value):
                        return "reforge"
                    if has_forge_signature(value):
                        return "forge"

        # Fallback: scan the raw `params` text for either signature in case
        # the saver embedded the identifier inline (e.g. "Version: ..., reForge").
        if has_reforge_signature(params):
            return "reforge"
        if has_forge_signature(params):
            return "forge"

        return "webui"

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

