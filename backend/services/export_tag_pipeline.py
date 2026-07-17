"""Tag processing pipeline: blacklist -> replace -> max N -> append.

Split verbatim (2026-07) out of ``services/export_template_engine.py`` (see
that facade's docstring for the decomposition map). Owns TagProcessingConfig,
process_tags, the kaomoji vocabulary + underscore formatting
(``is_kaomoji_tag`` / ``normalize_lora_tag``), and the blacklist /
template-value filter helpers. Pure functions only.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


# ====================================================================
# Tag processing pipeline
# ====================================================================

@dataclass
class TagProcessingConfig:
    """Configuration for the tag processing pipeline."""
    blacklist: List[str] = field(default_factory=list)
    replace_rules: Dict[str, str] = field(default_factory=dict)  # find -> replace
    max_tags: int = 0  # 0 = unlimited
    append: List[str] = field(default_factory=list)
    underscore_to_space: bool = False
    preserve_underscore_prefixes: List[str] = field(default_factory=list)


def process_tags(
    tags: List[Dict[str, Any]],
    config: TagProcessingConfig,
) -> List[str]:
    """Apply the tag processing pipeline: blacklist -> replace -> max N -> append."""
    blacklist_lower = _blacklist_tokens(config)
    if not tags:
        return [
            tag
            for tag in list(config.append)
            if _normalize_blacklist_item(tag, config) not in blacklist_lower
        ] if config.append else []

    # Step 1: filter blacklist + extract tag strings (sorted by confidence desc)
    sorted_tags = sorted(
        tags,
        key=lambda t: -float(t.get("confidence") or 1.0),
    )
    processed: List[str] = []
    for tag_data in sorted_tags:
        tag_str = str(tag_data.get("tag") or "").strip()
        if not tag_str or _normalize_blacklist_item(tag_str, config) in blacklist_lower:
            continue
        processed.append(tag_str)

    # Step 2: replace
    if config.replace_rules:
        # Normalize replacement keys consistently with blacklist
        replace_normalized = {}
        for find_key, replace_value in config.replace_rules.items():
            norm_key = _normalize_blacklist_item(find_key, config)
            if norm_key:
                replace_normalized[norm_key] = replace_value

        new_processed: List[str] = []
        for tag in processed:
            norm_tag = _normalize_blacklist_item(tag, config)
            replaced = replace_normalized.get(norm_tag)
            new_processed.append(replaced if replaced is not None else tag)
        processed = new_processed

        # Re-apply blacklist after replacement (Bug 1 fix)
        processed = [
            tag for tag in processed
            if _normalize_blacklist_item(tag, config) not in blacklist_lower
        ]

    # Step 3: max N
    if config.max_tags and config.max_tags > 0:
        processed = processed[:config.max_tags]

    # Step 4: format (underscore handling) + append
    if config.underscore_to_space:
        processed = [_format_tag_underscore(t, config.preserve_underscore_prefixes) for t in processed]

    if config.append:
        appended = list(config.append)
        if config.underscore_to_space:
            appended = [_format_tag_underscore(t, config.preserve_underscore_prefixes) for t in appended]
        # Dedupe append against existing
        existing_lower = {_normalize_blacklist_item(t, config) for t in processed}
        for ap in appended:
            normalized_append = _normalize_blacklist_item(ap, config)
            if normalized_append and normalized_append not in blacklist_lower and normalized_append not in existing_lower:
                processed.append(ap)
                existing_lower.add(normalized_append)

    return processed


# Danbooru emoticon ("kaomoji") vocabulary. These are REAL general tags that
# WD-family taggers emit (they live in the SmilingWolf v3 selected_tags.csv),
# so they must survive underscore→space formatting — ``^_^`` would corrupt to
# ``^ ^`` — and must never be stripped as "symbolic noise". Curated from the
# WD14 v3 vocab plus common danbooru emoticon aliases that arrive via
# prompt-imported tags.
KAOMOJI_TAGS: frozenset = frozenset({
    "0_0", "(o)_(o)", "+_+", "+_-", "._.", "3_3", "6_9", "<o>_<o>",
    "<|>_<|>", "=_=", ">_<", ">_o", "@_@", "^_^", "^o^", "|_|", "||_||",
    "o_o", "u_u", "x_x", "n_n", "t_t", ";_;", "<_<", ">_>", "-_-",
    ":3", ":d", ":i", ":o", ":p", ":q", ":t", ":x", ":|", ":>", ":<",
    ":c", ":/", ";3", ";d", ";o", ";p", ";q", ";)", ";(", ">:(", ">:)",
    "!", "!!", "!?", "?", "??", "+++", "...", "^^^", "\\m/", "\\o/",
    "\\||/", "o3o", "0w0", "uwu", ">o<", "d:",
})


def is_kaomoji_tag(tag: str) -> bool:
    """True when ``tag`` is a danbooru emoticon that must keep its exact glyphs.

    Curated-set membership first, then a shape heuristic: an underscore tag
    whose every ``_``-separated segment is at most one character (``o_o``,
    ``=_=``, ``0_0``, ``v_v``) is an emoticon face, never words joined by
    underscores, so spacing its underscores would corrupt it.
    """
    lowered = (tag or "").strip().lower()
    if not lowered:
        return False
    if lowered in KAOMOJI_TAGS:
        return True
    if "_" in lowered:
        segments = lowered.split("_")
        if all(len(seg) <= 1 for seg in segments) and any(segments):
            return True
    return False


def _format_tag_underscore(tag: str, preserve_prefixes: List[str]) -> str:
    """Convert underscores to spaces unless tag starts with a preserved prefix."""
    if is_kaomoji_tag(tag):
        return tag
    for prefix in preserve_prefixes:
        if tag.startswith(prefix):
            return tag
    return tag.replace("_", " ")


# Public re-export so other modules (notably ``tag_export_service.build_sidecar_content``)
# can reuse the exact same LoRA-trainer underscore convention.
def normalize_lora_tag(tag: str, preserve_prefixes: Optional[List[str]] = None) -> str:
    """Convert tag underscores to spaces while preserving the LoRA-quality
    prefixes (``score_*`` by default) that Pony / NoobAI base models depend on.

    Used by the same-name ``.txt`` export pipeline so danbooru-tag content
    modes (``tags``, ``caption_tags``, ``caption_merged``, ``tags_nl``) emit
    LoRA-friendly captions like ``multiple girls`` instead of
    ``multiple_girls`` while still keeping ``score_5`` / ``score_9_up``.

    Pass ``preserve_prefixes=[]`` to convert every underscore (rarely needed
    in real LoRA workflows). Pass extra prefixes (e.g. ``["score_", "rating_"]``)
    to keep additional Booru-style metadata tokens intact.
    """
    if not tag:
        return tag
    return _format_tag_underscore(str(tag), list(preserve_prefixes) if preserve_prefixes is not None else DEFAULT_LORA_PRESERVE_PREFIXES)


# Default underscore-preservation prefixes used by every LoRA preset that
# enables ``underscore_to_space``. Keeping it as a module constant makes the
# convention discoverable and lets the same-name ``.txt`` exporter reuse it
# without re-declaring the list.
DEFAULT_LORA_PRESERVE_PREFIXES: List[str] = ["score_"]


def _normalize_blacklist_item(value: str, config: TagProcessingConfig) -> str:
    normalized = str(value or "").strip()
    if config.underscore_to_space:
        normalized = _format_tag_underscore(normalized, config.preserve_underscore_prefixes)
    return " ".join(normalized.split()).lower()


def _blacklist_tokens(config: TagProcessingConfig) -> set[str]:
    return {
        token
        for token in (_normalize_blacklist_item(item, config) for item in config.blacklist)
        if token
    }


def _split_template_value(value: str, separator: str) -> List[str]:
    text = str(value or "").strip()
    if not text:
        return []
    sep = separator.strip()
    if sep:
        parts = [part.strip() for part in text.split(sep)]
    else:
        parts = [text]
    return [part for part in parts if part]


def _filter_template_value(value: str, config: TagProcessingConfig, separator: str) -> str:
    blocked = _blacklist_tokens(config)
    if not blocked:
        return str(value or "").strip()
    kept = [
        part
        for part in _split_template_value(value, separator)
        if _normalize_blacklist_item(part, config) not in blocked
    ]
    return separator.join(kept)
