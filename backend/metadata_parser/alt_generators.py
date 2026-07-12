# =============================================================================
# metadata_parser.alt_generators - metadata_parser decomposition stages 1+2 (2026-07-13).
# Extracted VERBATIM from backend/metadata_parser.py @ c06d374 (4,912 lines).
# Source line ranges (original file): 1398-1428, 1429-1916, 1970-2044.
# Mixin: Alternate generator detectors (Fooocus/EasyDiffusion/InvokeAI/SwarmUI/DrawThings/AI-provider).
# self.* calls and class-constant lookups resolve via MRO exactly as before.
# Patched seams (Image / open / _MAX_* / _sidecar_directory_cache) live ONLY
# in metadata_parser/__init__.py; see tests/test_metadata_parser_pins.py.
import json
import re
from typing import Optional, Dict, Any, List

class AltGeneratorsMixin:
    """Alternate generator detectors (Fooocus/EasyDiffusion/InvokeAI/SwarmUI/DrawThings/AI-provider)."""

    # ============================================================
    # Alternate generator detectors (Fooocus, Easy Diffusion,
    # InvokeAI, SwarmUI, Draw Things, Gemini, gpt-image, ...).
    # These run AFTER the well-known WebUI/NovelAI/ComfyUI paths
    # so they only fire on metadata that didn't match a primary
    # generator. Each returns a parsed-result dict (compatible
    # with `_detect_and_parse` base) or None when it doesn't
    # recognize the metadata.
    # ============================================================

    # Generator IDs that should NOT be returned to the caller (so
    # gallery / filter UI can keep its small primary tab list and
    # surface rare ones via the modal instead). Reused by callers
    # that need the canonical "uncommon" bundle.
    _ALT_GENERATOR_FOOOCUS_KEYS = (
        "Prompt",
        "Negative Prompt",
        "negative_prompt",
        "Sampler",
        "Performance",
        "Resolution",
        "ADM Guidance",
        "Base Model",
        "Refiner Model",
        "Refiner Switch",
        "Sharpness",
        "Guidance Scale",
        "Metadata Scheme",
        "Style Selections",
    )

    def _maybe_parse_fooocus(self, metadata: dict) -> Optional[Dict[str, Any]]:
        """Detect Fooocus images.

        Fooocus stores the prompt JSON either in PNG `Comment` or in JPEG /
        WEBP `comment` (lower-case). It also writes a `fooocus_scheme` PNG
        text chunk. The JSON dict uses Title-Case keys (`Prompt`,
        `Negative Prompt`, `Performance`, `Sampler`, ...) which are
        distinct from NovelAI's lower-case `prompt`/`uc` shape, so this
        detector is safe to run after NAI detection.
        """
        # `fooocus_scheme` is unique to Fooocus and confirms the source
        # even when the Comment JSON is missing fields we don't know.
        fooocus_scheme = metadata.get("fooocus_scheme") or metadata.get("Fooocus_Scheme")
        candidate_blocks: List[Any] = []

        for key in ("Comment", "comment"):
            if key in metadata:
                candidate_blocks.append(metadata[key])

        # Fooocus a1111 scheme writes regular `parameters` text (already
        # caught by the WebUI path). Skip parameters here.
        if not candidate_blocks and not fooocus_scheme:
            return None

        software = str(metadata.get("Software", metadata.get("software", "")) or "").lower()
        software_is_fooocus = "fooocus" in software

        for block in candidate_blocks:
            data = self._coerce_json_block(block)
            if not isinstance(data, dict):
                continue

            # Skip NovelAI-only Comment shapes. NAI uses `uc` for
            # negative; if a `negative_prompt` key is present we treat
            # the block as Fooocus-shaped and let detection continue
            # below. We still bail on V4-specific NAI shapes.
            if (
                "uc" in data
                or "v4_prompt" in data
                or "v4_negative_prompt" in data
            ) and "negative_prompt" not in data:
                continue

            data_software = str(data.get("Software", data.get("software", "")) or "").lower()
            looks_like_fooocus = (
                fooocus_scheme is not None
                or software_is_fooocus
                or "fooocus" in data_software
                or any(key in data for key in self._ALT_GENERATOR_FOOOCUS_KEYS)
                # Real Fooocus output shape from lllyasviel/Fooocus:
                # lowercase `prompt`+`negative_prompt` keys plus at
                # least one of these distinctive sibling keys.
                or (
                    "prompt" in data
                    and "negative_prompt" in data
                    and any(k in data for k in (
                        "base_model", "performance", "sampler", "steps", "seed",
                        "metadata_scheme", "sharpness", "guidance_scale",
                    ))
                )
            )
            if not looks_like_fooocus:
                continue

            prompt = self._flatten_text_value(
                data.get("Prompt") or data.get("prompt") or data.get("Positive Prompt")
            )
            negative = self._flatten_text_value(
                data.get("Negative Prompt") or data.get("negative_prompt") or data.get("Negative")
            )
            checkpoint = self._flatten_text_value(
                data.get("Base Model") or data.get("base_model") or data.get("Model")
            )
            loras: List[str] = []
            for lora_key in (
                "LoRAs", "loras", "LoRA", "lora",
                "Lora", "Loras",
                "lora_combined_1", "lora_combined_2", "lora_combined_3",
                "lora_combined_4", "lora_combined_5",
            ):
                value = data.get(lora_key)
                if value is None:
                    continue
                if isinstance(value, (list, tuple, set)):
                    loras.extend(str(v).strip() for v in value if str(v).strip())
                else:
                    loras.append(str(value).strip())

            gen_params: Dict[str, Any] = {}
            param_keys = (
                "Steps", "Sampler", "Scheduler", "CFG Scale", "Guidance Scale",
                "Seed", "Resolution", "Sharpness", "Performance", "ADM Guidance",
                "Refiner Model", "Refiner Switch", "Style Selections",
                "Metadata Scheme", "Version",
            )
            for k in param_keys:
                if k in data and data[k] not in (None, ""):
                    gen_params[k.lower().replace(" ", "_")] = data[k]
            if checkpoint and "model" not in gen_params:
                gen_params["model"] = checkpoint

            return {
                "generator": "fooocus",
                "prompt": prompt or None,
                "negative_prompt": negative or None,
                "checkpoint": checkpoint or None,
                "loras": self._normalize_lora_names(loras),
                "generation_params": gen_params or None,
                "model_assets": self._build_explicit_model_assets(
                    source="fooocus_comment",
                    checkpoint=checkpoint or None,
                    loras=loras,
                ),
            }

        if fooocus_scheme is not None or software_is_fooocus:
            # Fooocus PNG with only the parameters text chunk (a1111
            # scheme) is already parsed as WebUI; this branch is reached
            # for unusual files where neither Comment JSON nor parameters
            # exist. We still tag the generator so the user sees Fooocus
            # in the gallery instead of a useless "unknown".
            return {
                "generator": "fooocus",
                "prompt": None,
                "negative_prompt": None,
                "checkpoint": self._extract_metadata_model_identifier(metadata),
                "loras": [],
                "generation_params": None,
                "model_assets": None,
            }
        return None

    @staticmethod
    def _coerce_json_block(block: Any) -> Any:
        """Best-effort JSON-loads for opaque metadata strings."""
        if isinstance(block, dict):
            return block
        if isinstance(block, bytes):
            try:
                block = block.decode("utf-8", errors="replace")
            except Exception:
                return None
        if not isinstance(block, str):
            return None
        text = block.strip()
        if text.startswith("UNICODE") or text.startswith("ASCII"):
            text = text[7:].strip("\0 ")
        json_start = text.find("{")
        if json_start < 0:
            return None
        try:
            return json.loads(text[json_start:])
        except (json.JSONDecodeError, ValueError, TypeError):
            return None

    # Easy Diffusion-specific PNG keys / settings keys. We require at
    # least one of these before claiming an image as Easy Diffusion to
    # avoid stealing generic "{prompt,negative_prompt}" JSON sidecars
    # (which the explicit-saved-metadata path correctly labels as
    # "others").
    _EASY_DIFFUSION_KEYS = (
        "use_stable_diffusion_model",
        "use_vae_model",
        "use_lora_model",
        "use_hypernetwork_model",
        "use_face_correction",
        "use_upscale",
        "sampler_name",
        "num_inference_steps",
        "guidance_scale",
        "negative_prompt_scale",
    )

    def _maybe_parse_easy_diffusion(self, metadata: dict) -> Optional[Dict[str, Any]]:
        """Detect Easy Diffusion (cmdr2/stable-diffusion-ui) PNG/JPEG metadata.

        PNGs use direct text chunks `prompt` + `negative_prompt` (or
        `Negative Prompt`) plus Easy-Diffusion-specific fields like
        `use_stable_diffusion_model`. We *require* at least one of those
        specific markers so we don't claim arbitrary JSON sidecars that
        happen to have generic `prompt`/`negative_prompt` keys (those
        legitimately fall through to the "others" path).
        """
        # Avoid stealing ComfyUI's `prompt` JSON. ComfyUI's `prompt` is
        # always a JSON dict of nodes, never a raw user string.
        prompt = metadata.get("prompt")
        negative = metadata.get("negative_prompt") or metadata.get("Negative Prompt")
        if not negative:
            return None
        if isinstance(prompt, str) and prompt.strip().startswith("{"):
            try:
                if isinstance(json.loads(prompt), dict):
                    return None
            except (json.JSONDecodeError, ValueError, TypeError):
                pass

        if not any(key in metadata for key in self._EASY_DIFFUSION_KEYS):
            return None

        prompt_text = self._flatten_text_value(prompt)
        negative_text = self._flatten_text_value(negative)
        if not prompt_text and not negative_text:
            return None

        gen_params: Dict[str, Any] = {}
        for k in (
            "use_stable_diffusion_model", "use_vae_model", "use_lora_model",
            "use_hypernetwork_model", "sampler_name", "num_inference_steps",
            "guidance_scale", "seed", "width", "height", "use_face_correction",
            "use_upscale",
        ):
            if k in metadata and metadata[k] not in (None, ""):
                gen_params[k] = metadata[k]

        checkpoint = self._flatten_text_value(
            metadata.get("use_stable_diffusion_model")
            or metadata.get("Model")
            or metadata.get("model")
        )
        loras: List[str] = []
        lora_value = metadata.get("use_lora_model") or metadata.get("LoRA")
        if isinstance(lora_value, (list, tuple, set)):
            loras = [str(v).strip() for v in lora_value if str(v).strip()]
        elif lora_value:
            loras = [s.strip() for s in re.split(r"[,\n]", str(lora_value)) if s.strip()]

        return {
            "generator": "easy-diffusion",
            "prompt": prompt_text or None,
            "negative_prompt": negative_text or None,
            "checkpoint": checkpoint or None,
            "loras": self._normalize_lora_names(loras),
            "generation_params": gen_params or None,
            "model_assets": self._build_explicit_model_assets(
                source="easy_diffusion_text",
                checkpoint=checkpoint or None,
                loras=loras,
            ),
        }

    def _maybe_parse_invokeai(self, metadata: dict) -> Optional[Dict[str, Any]]:
        """Detect InvokeAI PNG metadata.

        Supported shapes:
          - v3 `invokeai_metadata` JSON (positive_prompt/negative_prompt/...)
          - v3 graph workflow `invokeai_graph` with embedded `core_metadata` node
          - v2 `sd-metadata`
          - legacy `Dream` string
        """
        # InvokeAI v3+: `invokeai_metadata` is a JSON dict with `positive_prompt`,
        # `negative_prompt`, `model` (dict), `steps`, `cfg_scale`, etc.
        v3_block = metadata.get("invokeai_metadata")
        v3_graph = metadata.get("invokeai_graph")
        v2_block = metadata.get("sd-metadata")
        legacy = metadata.get("Dream")
        if not v3_block and not v3_graph and not v2_block and not legacy:
            return None

        prompt = None
        negative = None
        checkpoint = None
        loras: List[str] = []
        gen_params: Dict[str, Any] = {}

        if v3_block:
            data = self._coerce_json_block(v3_block)
            if isinstance(data, dict):
                prompt = self._flatten_text_value(data.get("positive_prompt"))
                negative = self._flatten_text_value(data.get("negative_prompt"))
                model = data.get("model")
                if isinstance(model, dict):
                    checkpoint = self._flatten_text_value(model.get("model_name") or model.get("name"))
                elif isinstance(model, str):
                    checkpoint = model
                for k in ("steps", "cfg_scale", "scheduler", "seed", "width", "height", "rand_device", "controlnets"):
                    if k in data and data[k] not in (None, ""):
                        gen_params[k] = data[k]
                lora_value = data.get("loras") or data.get("lora")
                if isinstance(lora_value, list):
                    for entry in lora_value:
                        if isinstance(entry, dict):
                            name = entry.get("model_name") or entry.get("lora", {}).get("model_name") or entry.get("name")
                            if name:
                                loras.append(str(name))
                        elif entry:
                            loras.append(str(entry))

        if not prompt and v3_graph:
            # `invokeai_graph` JSON contains a `nodes` dict; the
            # `core_metadata` node carries the same fields as the v3
            # `invokeai_metadata` block. Mirror IIB's parser behaviour
            # by looking up the first node whose key starts with
            # `core_metadata`.
            graph = self._coerce_json_block(v3_graph)
            if isinstance(graph, dict):
                nodes = graph.get("nodes") or {}
                core_meta = None
                if isinstance(nodes, dict):
                    for key, node in nodes.items():
                        if isinstance(key, str) and key.startswith("core_metadata") and isinstance(node, dict):
                            core_meta = node
                            break
                if isinstance(core_meta, dict):
                    prompt = self._flatten_text_value(core_meta.get("positive_prompt"))
                    negative = self._flatten_text_value(core_meta.get("negative_prompt"))
                    model = core_meta.get("model")
                    if isinstance(model, dict):
                        checkpoint = self._flatten_text_value(model.get("model_name") or model.get("name"))
                    elif isinstance(model, str):
                        checkpoint = model
                    for k in ("steps", "cfg_scale", "scheduler", "seed", "width", "height"):
                        if k in core_meta and core_meta[k] not in (None, ""):
                            gen_params[k] = core_meta[k]

        if not prompt and v2_block:
            data = self._coerce_json_block(v2_block)
            if isinstance(data, dict):
                image = data.get("image", {}) if isinstance(data.get("image"), dict) else {}
                prompt_field = image.get("prompt") or data.get("prompt")
                if isinstance(prompt_field, list) and prompt_field:
                    first = prompt_field[0]
                    if isinstance(first, dict):
                        prompt = self._flatten_text_value(first.get("prompt") or first.get("text"))
                else:
                    prompt = self._flatten_text_value(prompt_field)
                checkpoint = checkpoint or self._flatten_text_value(data.get("model_weights"))

        if not prompt and legacy:
            # Legacy Dream string: "<prompt> -s 50 -S 12345 -W 512 -H 512 -C 7.0"
            text = str(legacy)
            match = re.match(r'^"?([^"]*?)"?\s+(?:-[A-Za-z]\s+\S+(?:\s+|$))*$', text.strip())
            if match:
                prompt = match.group(1).strip() or None
            else:
                prompt = text.strip().split(" -", 1)[0].strip() or None

        if not prompt and not negative and not checkpoint and not gen_params:
            return None

        return {
            "generator": "invokeai",
            "prompt": prompt,
            "negative_prompt": negative,
            "checkpoint": checkpoint or None,
            "loras": self._normalize_lora_names(loras),
            "generation_params": gen_params or None,
            "model_assets": self._build_explicit_model_assets(
                source="invokeai_metadata",
                checkpoint=checkpoint or None,
                loras=loras,
            ),
        }

    def _maybe_parse_swarmui(self, metadata: dict) -> Optional[Dict[str, Any]]:
        """Detect SwarmUI / StableSwarmUI parameters (`sui_image_params`)."""
        candidates: List[Any] = []
        for key in ("parameters", "Parameters", "UserComment"):
            if key in metadata:
                candidates.append(metadata[key])
        # SwarmUI also stores the JSON in EXIF tag 0x0110 (Make).
        for key in ("Make", "make", "0x0110"):
            if key in metadata:
                candidates.append(metadata[key])

        for block in candidates:
            text = block
            if isinstance(text, bytes):
                text = text.decode("utf-8", errors="replace")
            if not isinstance(text, str):
                if isinstance(text, dict):
                    data = text
                else:
                    continue
            else:
                if "sui_image_params" not in text:
                    continue
                data = self._coerce_json_block(text)
                if not isinstance(data, dict):
                    continue

            params = data.get("sui_image_params") or data
            if not isinstance(params, dict):
                continue

            prompt = self._flatten_text_value(params.get("prompt"))
            negative = self._flatten_text_value(params.get("negativeprompt") or params.get("negative_prompt"))
            checkpoint = self._flatten_text_value(params.get("model"))
            gen_params = {
                k: v for k, v in params.items()
                if k not in ("prompt", "negativeprompt", "negative_prompt") and v not in (None, "")
            }
            loras = []
            lora_value = params.get("loras") or params.get("lora")
            if isinstance(lora_value, list):
                loras = [str(v).strip() for v in lora_value if str(v).strip()]
            elif lora_value:
                loras = [s.strip() for s in re.split(r"[,\n]", str(lora_value)) if s.strip()]

            return {
                "generator": "swarmui",
                "prompt": prompt or None,
                "negative_prompt": negative or None,
                "checkpoint": checkpoint or None,
                "loras": self._normalize_lora_names(loras),
                "generation_params": gen_params or None,
                "model_assets": self._build_explicit_model_assets(
                    source="swarmui_parameters",
                    checkpoint=checkpoint or None,
                    loras=loras,
                ),
            }
        return None

    def _maybe_parse_drawthings(self, metadata: dict) -> Optional[Dict[str, Any]]:
        """Detect Draw Things (iOS/macOS) XMP-embedded JSON metadata."""
        xmp = metadata.get("XML:com.adobe.xmp") or metadata.get("xmp")
        if not xmp:
            return None
        try:
            from xml.dom import minidom
            doc = minidom.parseString(xmp if isinstance(xmp, str) else xmp.decode("utf-8", errors="replace"))
            user_comment_nodes = doc.getElementsByTagName("exif:UserComment")
            if not user_comment_nodes:
                return None
            # XPath-equivalent: rdf:Alt > rdf:li text
            li_nodes = user_comment_nodes[0].getElementsByTagName("rdf:li")
            if not li_nodes or not li_nodes[0].firstChild:
                return None
            data = json.loads(li_nodes[0].firstChild.nodeValue)
        except Exception:
            return None

        if not isinstance(data, dict):
            return None
        if not any(k in data for k in ("c", "uc", "model", "sampler", "steps", "seed")):
            # Real Draw Things blob has at least one of these keys; bail
            # otherwise to avoid hijacking unrelated XMP UserComment.
            return None

        prompt = self._flatten_text_value(data.get("c") or data.get("prompt"))
        negative = self._flatten_text_value(data.get("uc") or data.get("negative_prompt"))
        checkpoint = self._flatten_text_value(data.get("model"))
        gen_params = {
            k: v for k, v in data.items()
            if k not in ("c", "uc", "prompt", "negative_prompt") and v not in (None, "")
        }
        return {
            "generator": "drawthings",
            "prompt": prompt or None,
            "negative_prompt": negative or None,
            "checkpoint": checkpoint or None,
            "loras": [],
            "generation_params": gen_params or None,
            "model_assets": self._build_explicit_model_assets(
                source="drawthings_xmp",
                checkpoint=checkpoint or None,
            ),
        }

    # ============================================================
    # Closed-source AI provider detection (Gemini, gpt-image, ...).
    # These don't expose A1111-style parameters, but we still want
    # to surface "this came from Gemini" so the user can find them
    # in the gallery instead of a flat 'unknown' bucket. Detection
    # is intentionally lightweight: we look for known software
    # tags / C2PA claim_generator strings inside metadata fields
    # we already extracted, never doing extra disk IO.
    # ============================================================

    _AI_PROVIDER_PATTERNS = (
        ("gemini", re.compile(
            r"\b(?:gemini|imagen(?:[-_\s]?\d+)?|google(?:\s*ai|\s*deepmind)?|nano[-_\s]?banana|made\s*with\s*google\s*ai)\b",
            re.IGNORECASE,
        )),
        ("gpt-image", re.compile(
            r"\b(?:gpt[-_\s]?image(?:[-_\s]?\d+)?|chatgpt(?:[-_\s]?image)?|openai(?:\s*image)?|dall[-_\s]?e(?:[-_\s]?\d+)?)\b",
            re.IGNORECASE,
        )),
    )

    _AI_PROVIDER_FIELDS = (
        "Software", "software", "Source", "source", "Generator", "generator",
        "Make", "make", "Model", "model", "Author", "author", "Creator", "creator",
        "Description", "ImageDescription", "Title", "title",
        "claim_generator", "claimGenerator",
        "XML:com.adobe.xmp",
    )

    def _maybe_detect_ai_provider(self, metadata: dict, image_path: Optional[str] = None, file_size: int = 0) -> Optional[Dict[str, Any]]:
        """Detect closed-source AI image generators via Software/EXIF tags.

        Returns a minimal result so the user can at least see the
        provider in the gallery. Prompts often aren't embedded in
        these files, so we surface what's available (Description,
        title, etc.) and mark generation_params accordingly.

        TODO(pixel-watermark): we currently identify Gemini / gpt-image
        only through METADATA — EXIF tags + the C2PA Content
        Credentials byte scan below. We do NOT verify Google's SynthID
        invisible pixel watermark, and we do NOT verify OpenAI's
        in-pixel signal. The frontend image-detail modal shows a
        notice (`modal.aiProviderNote.gemini` / `.gptImage`) so users
        are aware. To upgrade detection, see TECHNICAL_DEBT_NOTES.md
        → "Pixel-watermark detection for Gemini / gpt-image" — the
        candidate library is `aloshdenny/reverse-SynthID` (FFT spectral
        analysis, ~90% accuracy on Gemini outputs at supported
        resolutions) but it's research-only-licensed, ~220 MB
        codebook, and ~100-300 ms per image, so we kept it as a
        deferred opt-in feature for now. There is no public
        open-source detector for OpenAI's pixel watermark as of the
        ADR date (2026-05-16).
        """
        haystacks: List[str] = []
        for field in self._AI_PROVIDER_FIELDS:
            value = metadata.get(field)
            if value is None:
                continue
            if isinstance(value, bytes):
                try:
                    value = value.decode("utf-8", errors="replace")
                except Exception:
                    continue
            haystacks.append(str(value))

        joined = "\n".join(haystacks)
        matched_generator: Optional[str] = None

        if joined:
            for generator_id, pattern in self._AI_PROVIDER_PATTERNS:
                if pattern.search(joined):
                    matched_generator = generator_id
                    break

        if matched_generator is None and image_path:
            # Fallback: scan the front of the file for C2PA / "Content
            # Credentials" manifest signatures. Many providers strip the
            # plaintext Software tag but keep the cryptographic C2PA
            # manifest, so this catches images the metadata-only check
            # missed. Bounded to ~512 KiB of IO per image and only runs
            # when the metadata fields didn't already identify a
            # provider.
            matched_generator = self._scan_c2pa_byte_signatures(image_path, file_size)

        if matched_generator is None:
            return None

        # Best-effort prompt extraction from human-readable fields.
        prompt = self._flatten_text_value(
            metadata.get("Description")
            or metadata.get("ImageDescription")
            or metadata.get("Title")
            or metadata.get("UserComment")
        )
        return {
            "generator": matched_generator,
            "prompt": prompt or None,
            "negative_prompt": None,
            "checkpoint": self._flatten_text_value(metadata.get("Model") or metadata.get("model")) or None,
            "loras": [],
            "generation_params": None,
            "model_assets": None,
        }

