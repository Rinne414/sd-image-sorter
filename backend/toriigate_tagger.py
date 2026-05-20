"""
ToriiGate 0.5 image tagger backend.

This wraps the multimodal caption model into the same public result shape used
by the WD14 tagger so the existing tagging pipeline and UI can reuse it.
"""

from __future__ import annotations

import gc
import json
import logging
import os
import re
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional

from PIL import Image

from config import TAGGER_MODELS, get_toriigate_model_dir, read_float_env
from ai_runtime_guard import exclusive_ai_runtime
from model_download_sources import endpoint_label, get_hf_endpoint_order

logger = logging.getLogger(__name__)

# SECURITY: Pin HuggingFace model revision to prevent supply-chain attacks.
# snapshot_download() fetches from a remote repo; without a pinned commit, a
# compromised or hijacked repo could serve malicious model files.
TORIIGATE_COMMIT_HASH = "667e771497abcfa38637e1d308cb495beb68d803"

torch = None
hf_hub = None
AutoProcessor = None
Qwen3_5ForConditionalGeneration = None

RATING_TAGS = {"general", "sensitive", "questionable", "explicit"}
EXPLICIT_HINT_TAGS = {
    "pussy",
    "penis",
    "dick",
    "anus",
    "cum",
    "sex",
    "nude",
    "nipples",
}

TORIIGATE_SYSTEM_PROMPT = (
    "You are image captioning expert. Describe user's picture according to "
    "requested format and instructions."
)
TORIIGATE_SHORT_QUERY = (
    "# Captioning format:\n"
    "The caption for image should be quite short without long purple prose and slop. "
    "Cover main objects and details.\n\n"
    "# Characters on picture:\n"
    "Avoid to guess names for characters.\n"
)
TORIIGATE_MAX_IMAGE_PIXELS = 1024 * 1024
TORIIGATE_CUDA_MEMORY_FRACTION = max(
    0.30,
    min(0.95, read_float_env("SD_TORIIGATE_CUDA_MEMORY_FRACTION", 0.80)),
)
CAPTION_COUNT_PATTERNS = (
    (re.compile(r"\b(?:a|an|one|single)\s+(?:young\s+)?(?:girl|woman)\b"), "1girl"),
    (re.compile(r"\b(?:a|an|one|single)\s+(?:young\s+)?boy\b"), "1boy"),
    (re.compile(r"\b(?:girl|woman)\s+with\b"), "1girl"),
    (re.compile(r"\bboy\s+with\b"), "1boy"),
    (re.compile(r"\b(?:two|2)\s+girls\b"), "2girls"),
    (re.compile(r"\b(?:two|2)\s+boys\b"), "2boys"),
)
CAPTION_ATTRIBUTE_PATTERNS = (
    (
        re.compile(
            r"\b(black|blue|brown|green|grey|gray|orange|pink|purple|red|silver|white|yellow|blond|blonde)\s+hair\b"
        ),
        "{}_hair",
    ),
    (
        re.compile(
            r"\b(black|blue|brown|green|grey|gray|orange|pink|purple|red|silver|white|yellow|gold|golden)\s+eyes\b"
        ),
        "{}_eyes",
    ),
    (
        re.compile(
            r"\b(black|blue|brown|green|grey|gray|orange|pink|purple|red|silver|white|yellow)\s+blazer\b"
        ),
        "{}_blazer",
    ),
    (
        re.compile(
            r"\b(black|blue|brown|green|grey|gray|orange|pink|purple|red|silver|white|yellow)\s+shirt\b"
        ),
        "{}_shirt",
    ),
    (
        re.compile(
            r"\b(black|blue|brown|green|grey|gray|orange|pink|purple|red|silver|white|yellow)\s+bow\s+tie\b"
        ),
        "{}_bowtie",
    ),
)
CAPTION_PHRASE_TAGS = (
    ("school uniform", ("school_uniform",)),
    ("blazer", ("blazer",)),
    ("white shirt", ("white_shirt", "shirt")),
    ("shirt", ("shirt",)),
    ("red bow tie", ("red_bowtie", "bowtie")),
    ("bow tie", ("bowtie",)),
    ("monitor", ("monitor",)),
    ("screen", ("screen",)),
    ("viewfinder", ("viewfinder",)),
    ("recording", ("recording",)),
    ("rec indicator", ("recording",)),
    ("security camera", ("security_camera",)),
    ("tear-streaked", ("tears",)),
    ("tears", ("tears",)),
    ("crying", ("crying",)),
    ("distressed", ("distressed",)),
    ("fear", ("fear",)),
    ("restrained", ("restrained",)),
    ("cuffed", ("handcuffs", "restrained")),
    ("bound", ("bound",)),
    ("nude", ("nude",)),
    ("breasts", ("breasts",)),
    ("breast", ("breasts",)),
    ("nipples", ("nipples",)),
    ("nipple", ("nipples",)),
    ("buttocks", ("buttocks",)),
    ("anus", ("anus",)),
    ("vulva", ("pussy",)),
    ("labia", ("pussy",)),
    ("vaginal", ("pussy",)),
    ("genitalia", ("pussy",)),
    ("spread wide", ("spread_legs",)),
    ("legs spread", ("spread_legs",)),
    ("against the wall", ("against_wall",)),
    ("through the wall", ("against_wall",)),
)


def _ensure_imports() -> None:
    """Lazy import heavy ToriiGate dependencies."""
    global torch, hf_hub, AutoProcessor, Qwen3_5ForConditionalGeneration
    if torch is None:
        import torch as torch_module  # type: ignore

        torch = torch_module
    if hf_hub is None:
        import huggingface_hub as hf_module

        hf_hub = hf_module
    if AutoProcessor is None or Qwen3_5ForConditionalGeneration is None:
        from transformers import AutoProcessor as processor_cls  # type: ignore
        from transformers import Qwen3_5ForConditionalGeneration as model_cls  # type: ignore

        AutoProcessor = processor_cls
        Qwen3_5ForConditionalGeneration = model_cls


class ToriiGateTagger:
    """Caption-to-tags adapter for ToriiGate 0.5."""

    def __init__(
        self,
        model_name: str = "toriigate-0.5",
        model_dir: Optional[str] = None,
        use_gpu: bool = True,
        max_new_tokens: int = 160,
    ) -> None:
        _ensure_imports()
        self.model_name = model_name
        self.model_dir = model_dir or get_toriigate_model_dir()
        self.use_gpu = use_gpu
        self.max_new_tokens = max_new_tokens
        self.model = None
        self.processor = None
        self.device = "cuda" if self.use_gpu else "cpu"
        self._loaded = False
        self._resolved_model_dir: Optional[str] = None
        self._session_refresh_interval = 0

    def _download_model(self) -> str:
        config = TAGGER_MODELS[self.model_name]
        local_dir = os.path.join(self.model_dir, self.model_name)
        os.makedirs(local_dir, exist_ok=True)

        if not os.path.exists(os.path.join(local_dir, "config.json")):
            logger.info("Downloading ToriiGate model %s ...", self.model_name)
            assert hf_hub is not None
            last_error: Optional[Exception] = None
            for endpoint in get_hf_endpoint_order(model_name="ToriiGate 0.5"):
                try:
                    logger.info("Downloading ToriiGate from %s via %s", config["repo_id"], endpoint_label(endpoint))
                    hf_hub.snapshot_download(
                        repo_id=config["repo_id"],
                        revision=TORIIGATE_COMMIT_HASH,
                        local_dir=local_dir,
                        local_dir_use_symlinks=False,
                        allow_patterns=[
                            "*.json",
                            "*.safetensors",
                            "*.txt",
                            "*.jinja",
                        ],
                        endpoint=endpoint,
                    )
                    break
                except Exception as exc:
                    last_error = exc
                    logger.warning("ToriiGate download failed via %s: %s", endpoint_label(endpoint), exc)
            else:
                assert last_error is not None
                raise last_error
        return local_dir

    def _pick_torch_dtype(self):
        assert torch is not None
        if self.use_gpu and torch.cuda.is_available():
            if getattr(torch.cuda, "is_bf16_supported", None) and torch.cuda.is_bf16_supported():
                return torch.bfloat16
            return torch.float16
        return torch.float32

    def _apply_cuda_memory_guard(self) -> None:
        assert torch is not None
        if not (self.use_gpu and torch.cuda.is_available()):
            return

        setter = getattr(torch.cuda, "set_per_process_memory_fraction", None)
        if not callable(setter):
            return

        try:
            setter(TORIIGATE_CUDA_MEMORY_FRACTION, 0)
            logger.info(
                "ToriiGate CUDA memory guard set to %.0f%% of VRAM",
                TORIIGATE_CUDA_MEMORY_FRACTION * 100.0,
            )
        except Exception as exc:
            logger.debug("ToriiGate CUDA memory guard was unavailable: %s", exc)

    def _make_prompt(self) -> str:
        return TORIIGATE_SHORT_QUERY

    def load(self) -> None:
        if self._loaded:
            return

        assert AutoProcessor is not None
        assert Qwen3_5ForConditionalGeneration is not None
        assert torch is not None

        local_dir = self._download_model()
        self._resolved_model_dir = local_dir

        try:
            dtype = self._pick_torch_dtype()
            self._apply_cuda_memory_guard()
            # SECURITY: trust_remote_code=True allows the model repo to execute
            # arbitrary Python.  This is required by the Qwen architecture but
            # means a compromised repo could run code on load.  Mitigate by
            # pinning TORIIGATE_COMMIT_HASH and only downloading safetensors.
            with exclusive_ai_runtime("toriigate-load"):
                self.processor = AutoProcessor.from_pretrained(
                    local_dir,
                    trust_remote_code=True,
                    padding_side="right",
                    use_safetensors=True,
                )
                self.model = Qwen3_5ForConditionalGeneration.from_pretrained(
                    local_dir,
                    torch_dtype=dtype,
                    low_cpu_mem_usage=True,
                    trust_remote_code=True,
                    use_safetensors=True,
                )
                if self.use_gpu and torch.cuda.is_available():
                    self.model.to("cuda")
                    self.device = "cuda"
                else:
                    self.model.to("cpu")
                    self.device = "cpu"
                    self.use_gpu = False

            self.model.eval()
            self._loaded = True
            logger.info("ToriiGate loaded on %s", self.device)
        except Exception as exc:
            if self.use_gpu:
                logger.warning("Failed to load ToriiGate on GPU, retrying on CPU: %s", exc)
                self.use_gpu = False
                self.device = "cpu"
                self._teardown_model()
                with exclusive_ai_runtime("toriigate-load-cpu-retry"):
                    self.processor = AutoProcessor.from_pretrained(
                        local_dir,
                        trust_remote_code=True,  # required by Qwen architecture
                        padding_side="right",
                        use_safetensors=True,
                    )
                    self.model = Qwen3_5ForConditionalGeneration.from_pretrained(
                        local_dir,
                        torch_dtype=torch.float32,
                        low_cpu_mem_usage=True,
                        trust_remote_code=True,  # required by Qwen architecture
                        use_safetensors=True,
                    )
                    self.model.to("cpu")
                self.model.eval()
                self._loaded = True
            else:
                raise

    def _teardown_model(self) -> None:
        if self.model is not None:
            del self.model
            self.model = None
        if self.processor is not None:
            del self.processor
            self.processor = None
        gc.collect()
        if torch is not None and getattr(torch, "cuda", None) is not None and torch.cuda.is_available():
            torch.cuda.empty_cache()

    def _recreate_session(self) -> None:
        self._loaded = False
        self._teardown_model()
        self.load()

    def set_session_refresh_interval(self, interval: int) -> None:
        self._session_refresh_interval = max(0, interval)

    @staticmethod
    def _strip_reasoning(text: str) -> str:
        text = re.sub(r"<think>.*?</think>", "", text, flags=re.IGNORECASE | re.DOTALL)
        if "</think>" in text:
            text = text.split("</think>", 1)[-1]
        return text.strip()

    @staticmethod
    def _normalize_color_token(value: str) -> str:
        token = str(value or "").strip().lower()
        if token == "gray":
            return "grey"
        if token == "blond":
            return "blonde"
        if token == "golden":
            return "gold"
        return token

    @classmethod
    def _normalize_tag_token(cls, value: str) -> str:
        token = str(value or "").strip().lower()
        token = token.replace("`", "").replace("*", "").replace("•", "")
        token = re.sub(r"^\s*(?:[-•*]+|\d+\)|\d+\.)\s*", "", token)
        token = token.replace(" ", "_")
        token = token.replace("-", "_")
        token = re.sub(r"_+", "_", token)
        token = re.sub(r"[^a-z0-9_(),]+", "", token)
        token = token.strip("_, ")
        return token

    @classmethod
    def _extract_tag_list_tokens(cls, cleaned: str) -> List[str]:
        lowered = cleaned.lower()
        if "tags:" in lowered:
            cleaned = cleaned[lowered.index("tags:") + len("tags:") :]
        cleaned = cleaned.replace("\r", "\n").replace(";", ",")
        parts = re.split(r"[\n,]+", cleaned)
        tags: List[str] = []
        seen = set()
        for part in parts:
            token = cls._normalize_tag_token(part)
            if not token or token in seen:
                continue
            seen.add(token)
            tags.append(token)
        return tags

    @staticmethod
    def _looks_like_structured_caption(cleaned: str) -> bool:
        stripped = cleaned.strip()
        if stripped.startswith("{") or stripped.startswith("["):
            return True
        if re.search(r'"[^"]+"\s*:\s*"', stripped):
            return True
        if re.search(r"[.!?]", stripped) and re.search(
            r"\b(the|a|an|with|and|is|are|this|that|there)\b",
            stripped.lower(),
        ):
            return True
        return False

    @staticmethod
    def _tag_list_seems_valid(tags: List[str]) -> bool:
        if not tags:
            return False
        if sum(1 for tag in tags if len(tag) > 40) >= 2:
            return False
        if any("character_" in tag for tag in tags):
            return False
        return True

    @classmethod
    def _extract_json_string_values(cls, cleaned: str) -> List[str]:
        try:
            parsed = json.loads(cleaned)
        except Exception:
            parsed = None

        def collect(node: Any) -> List[str]:
            values: List[str] = []
            if isinstance(node, str):
                values.append(node)
            elif isinstance(node, dict):
                for value in node.values():
                    values.extend(collect(value))
            elif isinstance(node, list):
                for value in node:
                    values.extend(collect(value))
            return values

        if parsed is not None:
            return collect(parsed)

        return re.findall(r'"[^"]+"\s*:\s*"([^"]+)"', cleaned)

    @classmethod
    def _extract_tags_from_caption(cls, cleaned: str) -> List[str]:
        caption_chunks = cls._extract_json_string_values(cleaned)
        caption_text = " ".join(caption_chunks) if caption_chunks else cleaned
        lowered = caption_text.lower()

        tags: List[str] = []
        seen = set()

        def append_tag(value: str) -> None:
            token = cls._normalize_tag_token(value)
            if not token or token in seen:
                return
            seen.add(token)
            tags.append(token)

        for pattern, tag in CAPTION_COUNT_PATTERNS:
            if pattern.search(lowered):
                append_tag(tag)

        for pattern, template in CAPTION_ATTRIBUTE_PATTERNS:
            for match in pattern.findall(lowered):
                append_tag(template.format(cls._normalize_color_token(match)))

        for phrase, mapped_tags in CAPTION_PHRASE_TAGS:
            if phrase in lowered:
                for mapped in mapped_tags:
                    append_tag(mapped)

        if "mouth open" in lowered or "open mouth" in lowered:
            append_tag("open_mouth")
        if "lower body" in lowered:
            append_tag("lower_body")

        return tags

    @classmethod
    def _extract_tags(cls, text: str) -> List[str]:
        cleaned = cls._strip_reasoning(text)

        if cls._looks_like_structured_caption(cleaned):
            caption_tags = cls._extract_tags_from_caption(cleaned)
            if caption_tags:
                return caption_tags

        tag_list_tags = cls._extract_tag_list_tokens(cleaned)
        if cls._tag_list_seems_valid(tag_list_tags):
            return tag_list_tags

        caption_tags = cls._extract_tags_from_caption(cleaned)
        if caption_tags:
            return caption_tags
        return tag_list_tags

    @classmethod
    def _derive_rating(cls, tags: List[str]) -> str:
        for rating in ("explicit", "questionable", "sensitive", "general"):
            if rating in tags:
                return rating
        if any(tag in EXPLICIT_HINT_TAGS for tag in tags):
            return "explicit"
        return "general"

    @classmethod
    def _build_result(cls, text: str) -> Dict[str, Any]:
        tags = cls._extract_tags(text)
        rating = cls._derive_rating(tags)
        normalized_tags = [tag for tag in tags if tag not in RATING_TAGS]
        general_tags = []
        character_tags = []

        for tag in normalized_tags:
            target = character_tags if re.search(r"_\([^)]*\)$", tag) else general_tags
            target.append({"tag": tag, "confidence": 1.0})

        all_tags = [{"tag": rating, "confidence": 1.0}]
        all_tags.extend(general_tags)
        all_tags.extend(character_tags)

        return {
            "general_tags": general_tags,
            "character_tags": character_tags,
            "rating": rating,
            "rating_confidences": {rating: 1.0},
            "all_tags": all_tags,
            "raw_text": text,
        }

    @staticmethod
    def _resize_for_inference(image: Image.Image) -> Image.Image:
        width, height = image.size
        pixels = width * height
        if pixels <= TORIIGATE_MAX_IMAGE_PIXELS:
            return image

        scale = (TORIIGATE_MAX_IMAGE_PIXELS / float(pixels)) ** 0.5
        resized_width = max(512, int(width * scale))
        resized_height = max(512, int(height * scale))
        resampling = getattr(Image, "Resampling", Image).LANCZOS
        return image.resize((resized_width, resized_height), resampling)

    def _generate_text(self, image_path: str) -> str:
        if not self._loaded:
            self.load()

        assert self.model is not None
        assert self.processor is not None
        assert torch is not None

        with Image.open(image_path) as image:
            image = self._resize_for_inference(image.convert("RGB"))
            messages = [
                {
                    "role": "system",
                    "content": [{"type": "text", "text": TORIIGATE_SYSTEM_PROMPT}],
                },
                {
                    "role": "user",
                    "content": [
                        {"type": "image"},
                        {"type": "text", "text": self._make_prompt()},
                    ],
                },
            ]
            prompt_text = self.processor.apply_chat_template(
                messages,
                tokenize=False,
                add_generation_prompt=True,
            )
            inputs = self.processor(
                text=[prompt_text],
                images=[image],
                return_tensors="pt",
            )

        model_device = next(self.model.parameters()).device
        inputs = {
            key: value.to(model_device) if hasattr(value, "to") else value
            for key, value in inputs.items()
        }

        with torch.inference_mode(), exclusive_ai_runtime("toriigate-inference"):
            generated = self.model.generate(
                **inputs,
                do_sample=False,
                max_new_tokens=self.max_new_tokens,
                use_cache=False,
            )

        prompt_tokens = inputs["input_ids"].shape[1]
        new_tokens = generated[:, prompt_tokens:]
        text = self.processor.batch_decode(new_tokens, skip_special_tokens=True)[0]
        return text.strip()

    def tag(self, image_path: str) -> Dict[str, Any]:
        try:
            return self._build_result(self._generate_text(image_path))
        except Exception as exc:
            logger.error("ToriiGate failed on %s: %s", image_path, exc)
            if self.use_gpu:
                logger.warning("ToriiGate switching to CPU after GPU failure.")
                self.use_gpu = False
                self.device = "cpu"
                self._recreate_session()
                try:
                    return self._build_result(self._generate_text(image_path))
                except Exception as retry_exc:
                    logger.error("ToriiGate CPU retry failed on %s: %s", image_path, retry_exc)
                    return {
                        "general_tags": [],
                        "character_tags": [],
                        "rating": "unknown",
                        "rating_confidences": {},
                        "all_tags": [],
                        "error": str(retry_exc),
                    }
            return {
                "general_tags": [],
                "character_tags": [],
                "rating": "unknown",
                "rating_confidences": {},
                "all_tags": [],
                "error": str(exc),
            }

    def tag_batch(
        self,
        image_paths: List[str],
        *,
        preferred_batch_size: Optional[int] = None,
        min_batch_size: int = 1,
        return_runtime_info: bool = False,
    ) -> Any:
        del preferred_batch_size, min_batch_size

        results = [self.tag(path) for path in image_paths]
        runtime_info = {
            "initial_chunk_size": 1,
            "final_chunk_size": 1,
            "backoff_steps": [],
            "used_cpu_fallback": not self.use_gpu,
            "attempted_gpu_backoff": False,
        }
        if return_runtime_info:
            return results, runtime_info
        return results


_toriigate_tagger = None
_current_settings: Dict[str, Any] = {}
_toriigate_lock = threading.Lock()


def get_toriigate_tagger(
    model_name: str = "toriigate-0.5",
    use_gpu: bool = True,
    force_reload: bool = False,
    **_: Any,
) -> ToriiGateTagger:
    """Get or create the ToriiGate singleton."""
    global _toriigate_tagger, _current_settings

    with _toriigate_lock:
        new_settings = {
            "model_name": model_name,
            "use_gpu": use_gpu,
        }
        if force_reload or _toriigate_tagger is None or new_settings != _current_settings:
            _toriigate_tagger = ToriiGateTagger(
                model_name=model_name,
                use_gpu=use_gpu,
            )
            _current_settings = new_settings
        return _toriigate_tagger
