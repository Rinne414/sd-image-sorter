"""Generic prompt-likeness scoring for metadata extraction (v3.5.0 L2).

The precise ComfyUI graph tracer (L1) understands node semantics; this module
deliberately does NOT. It answers one question for any string found anywhere
in a workflow: "does this text read like a prompt?" — so brand-new custom
node packs are caught without teaching the parser their shapes.

Two independent signals, the better one wins:

- Vocabulary: the share of comma tokens that are known danbooru tags
  (reusing the 140k vocabulary bundled for tag autocomplete). A string whose
  tokens are half booru tags IS a prompt, whatever node held it.
- Structure: natural-language prompts ("a watercolor of a fox, soft light")
  hit few booru tags, so comma-separated multi-word shape scores on its own.

Everything fails open: with no vocabulary available, structure alone decides.
"""
from __future__ import annotations

import logging
import re
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

logger = logging.getLogger(__name__)

# Candidates below the floor are never accepted as prompts.
PROMPT_SCORE_FLOOR = 0.35
# Strings shorter than this cannot carry enough signal to judge.
MIN_CANDIDATE_LENGTH = 12
# Bonus when the string came out of a text-encoder-ish node.
TEXT_NODE_BONUS = 0.15

_WEIGHT_SYNTAX_RE = re.compile(r"[()\[\]{}]|:\d+(?:\.\d+)?")
_LORA_TAG_RE = re.compile(r"<[^<>]*>")
_FILE_EXT_RE = re.compile(
    r"\.(safetensors|ckpt|pt|pth|bin|onnx|png|jpe?g|webp|gif|mp4|json|ya?ml|txt|csv)$",
    re.IGNORECASE,
)
_URL_RE = re.compile(r"^[a-z][a-z0-9+.-]*://", re.IGNORECASE)

# Input keys whose values are configuration, not prose — skipped at harvest.
NON_PROMPT_KEYS = frozenset({
    "separator", "delimiter", "sampler_name", "scheduler", "ckpt_name",
    "unet_name", "vae_name", "lora_name", "model_name", "control_net_name",
    "filename_prefix", "filename", "font", "font_name", "preset",
    "upscale_method", "method", "mode", "device", "output_format",
    "extension", "path", "directory", "folder", "custom_layer_filter",
})

_NEGATIVE_INDICATORS = (
    "worst quality", "low quality", "bad quality", "lowres",
    "bad anatomy", "worst hands", "bad hands", "deformed", "blurry",
    "low_resolution", "medium_resolution", "low_score",
    "pixelated", "compression artifacts", "jpeg artifacts",
    "bad_anatomy", "worst_hands", "extra fingers", "fewer fingers",
    "extra digits", "missing fingers", "watermark", "signature",
    "easynegative", "negativexl", "badhandv4", "bad-hands",
    "worst_quality", "low_quality",
)


def _vocab_index() -> Optional[Dict[str, int]]:
    try:
        from services.tag_suggest_service import get_vocab_tag_index

        return get_vocab_tag_index()
    except Exception as exc:  # pragma: no cover - defensive import guard
        logger.debug("prompt scorer running without vocabulary: %s", exc)
        return None


def tokenize_prompt_text(text: str) -> List[str]:
    """Split a candidate into normalized comma tokens (weight syntax removed)."""
    cleaned = _LORA_TAG_RE.sub(" ", str(text or ""))
    cleaned = _WEIGHT_SYNTAX_RE.sub(" ", cleaned)
    tokens: List[str] = []
    for part in cleaned.split(","):
        token = re.sub(r"\s+", " ", part).strip().lower()
        if token:
            tokens.append(token)
    return tokens


def _vocab_hit_ratio(tokens: Sequence[str], vocab: Optional[Dict[str, int]]) -> float:
    if not tokens or not vocab:
        return 0.0
    hits = 0
    for token in tokens:
        underscored = token.replace(" ", "_")
        if underscored in vocab or token in vocab:
            hits += 1
    return hits / len(tokens)


def _structure_score(text: str, tokens: Sequence[str]) -> float:
    """Shape-only score, capped below the vocab path's ceiling."""
    if not tokens:
        return 0.0
    token_count = len(tokens)
    words = str(text).split()
    if token_count >= 5:
        base = 0.5
    elif token_count >= 3:
        base = 0.42
    elif len(words) >= 8:
        # A single long natural-language sentence is still prompt-shaped.
        base = 0.4
    else:
        return 0.1
    lengths = [len(t) for t in tokens]
    average = sum(lengths) / len(lengths)
    if not 2 <= average <= 60:
        return 0.15
    return min(0.55, base + min(0.05, token_count * 0.005))


def looks_like_non_prompt_value(text: str) -> bool:
    """Values that are clearly configuration: paths, URLs, model files, JSON."""
    stripped = str(text or "").strip()
    if len(stripped) < MIN_CANDIDATE_LENGTH:
        return True
    if _URL_RE.match(stripped):
        return True
    if _FILE_EXT_RE.search(stripped.split(",")[-1].strip()) or _FILE_EXT_RE.search(stripped):
        return True
    if ("\\" in stripped or "/" in stripped) and "," not in stripped:
        return True
    first = stripped.lstrip()[:1]
    if first in ("{", "["):
        return True
    if re.fullmatch(r"[\d\s.,:x×-]+", stripped):
        return True
    return False


def score_prompt_likeness(text: str, vocab: Optional[Dict[str, int]] = None) -> Dict[str, Any]:
    """Score how much a string reads like an SD prompt (0..1)."""
    tokens = tokenize_prompt_text(text)
    if vocab is None:
        vocab = _vocab_index()
    hit_ratio = _vocab_hit_ratio(tokens, vocab)
    vocab_score = 0.6 + 0.4 * hit_ratio if hit_ratio >= 0.4 else hit_ratio
    structure = _structure_score(text, tokens)
    return {
        "score": max(vocab_score, structure),
        "vocab_hit_ratio": hit_ratio,
        "token_count": len(tokens),
        "vocab_available": vocab is not None,
    }


def is_negative_prompt_text(text: str) -> bool:
    """3+ classic negative-quality indicators → negative prompt."""
    lower = str(text or "").lower()
    matches = sum(1 for indicator in _NEGATIVE_INDICATORS if indicator in lower)
    return matches >= 3


def harvest_prompt_candidates(nodes: Dict[str, dict],
                              text_node_types: Iterable[str]) -> List[Dict[str, Any]]:
    """Collect every plausible prompt string from every node's inputs.

    No node-type knowledge required — that is the point. `text_node_types`
    only adds a small prior bonus for encoder-ish nodes.
    """
    type_markers = tuple(text_node_types or ())
    vocab = _vocab_index()
    candidates: List[Dict[str, Any]] = []
    for node_id, node in nodes.items():
        if not isinstance(node, dict):
            continue
        class_type = str(node.get("class_type", ""))
        inputs = node.get("inputs", {})
        if not isinstance(inputs, dict):
            continue
        is_text_node = any(marker in class_type for marker in type_markers)
        for key, value in inputs.items():
            if not isinstance(value, str):
                continue
            if str(key).lower() in NON_PROMPT_KEYS:
                continue
            if looks_like_non_prompt_value(value):
                continue
            result = score_prompt_likeness(value, vocab)
            score = result["score"] + (TEXT_NODE_BONUS if is_text_node else 0.0)
            candidates.append({
                "text": value.strip(),
                "score": round(min(1.0, score), 4),
                "node_id": str(node_id),
                "class_type": class_type,
                "key": str(key),
                "vocab_hit_ratio": result["vocab_hit_ratio"],
            })
    return candidates


def _dedupe_substrings(ordered: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Drop candidates fully contained in an already-kept longer one."""
    kept: List[Dict[str, Any]] = []
    for candidate in sorted(ordered, key=lambda c: len(c["text"]), reverse=True):
        normalized = re.sub(r"\s+", " ", candidate["text"].lower())
        if any(normalized in re.sub(r"\s+", " ", other["text"].lower()) for other in kept):
            continue
        kept.append(candidate)
    return kept


def pick_positive_negative(candidates: List[Dict[str, Any]],
                           floor: float = PROMPT_SCORE_FLOOR,
                           ) -> Tuple[Optional[str], Optional[str]]:
    """Choose the best positive and negative from harvested candidates."""
    eligible = [c for c in candidates if c["score"] >= floor]
    if not eligible:
        return (None, None)
    unique = _dedupe_substrings(eligible)
    negatives = [c for c in unique if is_negative_prompt_text(c["text"])]
    positives = [c for c in unique if not is_negative_prompt_text(c["text"])]

    def best(pool: List[Dict[str, Any]]) -> Optional[str]:
        if not pool:
            return None
        pool.sort(key=lambda c: (c["score"], len(c["text"])), reverse=True)
        return pool[0]["text"]

    return (best(positives), best(negatives))
