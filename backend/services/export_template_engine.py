"""Export template engine for LoRA training caption files.

Supports a flexible {variable} template syntax with tag processing pipeline:
  blacklist -> replace -> max N -> append

Built-in presets target popular base models (Anima, Illustrious/Pony, NoobAI, FLUX, Kohya).
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


# ====================================================================
# Preset definitions
# ====================================================================

# Each preset specifies:
#   - template: the format string (uses {variable} placeholders)
#   - separator: tag separator (", " for danbooru, " " for Anima)
#   - underscore_to_space: convert tag underscores to spaces (Anima style)
#   - preserve_underscore_prefixes: tags starting with these keep underscores (e.g., "score_")
#   - default_append: tags to append by default (can be overridden)
#   - description: human-readable description for UI

PRESETS: Dict[str, Dict[str, Any]] = {
    "anima": {
        "name": "Anima (Tags + NL)",
        "description": "Anima base model: quality/safety prefix, danbooru tags (spaces not underscores), then NL caption separated by period. Official tag order: quality → safety → count → trigger → general tags → NL.",
        "template": "{quality}, {safety}, {count}, {trigger}, {tags:filtered}. {nl_caption}",
        "separator": ", ",
        "underscore_to_space": True,
        "preserve_underscore_prefixes": ["score_"],
        "default_quality": "masterpiece, best quality, score_5",
        "default_safety": "safe",
        "default_append": "",
    },
    "anima_tags_only": {
        "name": "Anima (Tags only)",
        "description": "Anima format without NL caption — pure danbooru tags with quality/safety prefix.",
        "template": "{quality}, {safety}, {count}, {trigger}, {tags:filtered}",
        "separator": ", ",
        "underscore_to_space": True,
        "preserve_underscore_prefixes": ["score_"],
        "default_quality": "newest, highres, normal quality, score_5",
        "default_safety": "safe",
        "default_append": "",
    },
    "illustrious_pony": {
        "name": "Illustrious / Pony",
        "description": "Standard danbooru tag format for Illustrious, Pony XL, NoobAI XL etc.",
        "template": "{trigger}, {tags:filtered}, {append}",
        "separator": ", ",
        "underscore_to_space": False,
        "preserve_underscore_prefixes": [],
        "default_quality": "",
        "default_safety": "",
        "default_append": "masterpiece, best_quality",
    },
    "noobai": {
        "name": "NoobAI",
        "description": "NoobAI requires rating tag at front, otherwise standard danbooru format.",
        "template": "{trigger}, {rating}, {tags:filtered}, {append}",
        "separator": ", ",
        "underscore_to_space": False,
        "preserve_underscore_prefixes": [],
        "default_quality": "",
        "default_safety": "",
        "default_append": "masterpiece, best_quality",
    },
    "flux": {
        "name": "FLUX (NL only)",
        "description": "FLUX uses T5 encoder — pure natural language description with trigger word as period-separated prefix.",
        "template": "{trigger}. {nl_caption}",
        "separator": ", ",
        "underscore_to_space": False,
        "preserve_underscore_prefixes": [],
        "default_quality": "",
        "default_safety": "",
        "default_append": "",
    },
    "kohya_sd15": {
        "name": "Kohya SD 1.5",
        "description": "Classic Kohya format for SD 1.5 LoRAs — no quality tags, just trigger + tags.",
        "template": "{trigger}, {tags:filtered}",
        "separator": ", ",
        "underscore_to_space": False,
        "preserve_underscore_prefixes": [],
        "default_quality": "",
        "default_safety": "",
        "default_append": "",
    },
    "custom": {
        "name": "Custom Template",
        "description": "Build your own template with full control.",
        "template": "{tags:filtered}",
        "separator": ", ",
        "underscore_to_space": False,
        "preserve_underscore_prefixes": [],
        "default_quality": "",
        "default_safety": "",
        "default_append": "",
    },
}

# Variable reference for documentation
TEMPLATE_VARIABLES: List[Dict[str, str]] = [
    {"name": "{trigger}", "description": "Trigger word(s) for the LoRA"},
    {"name": "{tags}", "description": "All tags from the local tagger, comma-separated"},
    {"name": "{tags:filtered}", "description": "Tags after blacklist + replace + max-N processing"},
    {"name": "{tags:N}", "description": "Top N tags by confidence (e.g., {tags:20})"},
    {"name": "{nl_caption}", "description": "VLM-generated natural language caption (ai_caption field)"},
    {"name": "{prompt}", "description": "Original generation prompt"},
    {"name": "{negative}", "description": "Original negative prompt"},
    {"name": "{rating}", "description": "Rating tag (general/sensitive/questionable/explicit) or 'safe'"},
    {"name": "{characters}", "description": "Character tags only (heuristic detection)"},
    {"name": "{general}", "description": "Non-character tags only"},
    {"name": "{quality}", "description": "Quality tag string (preset default or user override)"},
    {"name": "{safety}", "description": "Safety tag string (preset default or user override)"},
    {"name": "{count}", "description": "Subject-count tag (1girl/1boy/2girls/etc.) extracted from tags"},
    {"name": "{append}", "description": "User-supplied or preset-default append text"},
]


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
        replace_lower = {k.lower(): v for k, v in config.replace_rules.items()}
        new_processed: List[str] = []
        for tag in processed:
            replaced = replace_lower.get(tag.lower())
            new_processed.append(replaced if replaced is not None else tag)
        processed = new_processed

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


def _format_tag_underscore(tag: str, preserve_prefixes: List[str]) -> str:
    """Convert underscores to spaces unless tag starts with a preserved prefix."""
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


# ====================================================================
# Variable resolution
# ====================================================================

# Heuristic character tag patterns (anime character names usually contain underscores
# or are multi-word names with parentheses indicating series)
_CHARACTER_TAG_HINTS = re.compile(r"\([^)]+\)$")  # tags ending in (series_name)
_COUNT_TAG_PATTERN = re.compile(r"^\d+(girl|boy|girls|boys|other|others|female|male)s?$", re.IGNORECASE)


def _is_character_tag(tag: str) -> bool:
    """Heuristic: tag has parenthesized suffix or comes from a known list of character tags."""
    return bool(_CHARACTER_TAG_HINTS.search(tag))


def _extract_count_tag(tags: List[str]) -> str:
    """Find subject-count tag (1girl, 2boys, etc.) in the tag list."""
    for tag in tags:
        if _COUNT_TAG_PATTERN.match(tag):
            return tag
    return ""


def _split_tags_by_type(filtered_tags: List[str]) -> Dict[str, List[str]]:
    """Split tags into character vs general."""
    characters = [t for t in filtered_tags if _is_character_tag(t)]
    general = [t for t in filtered_tags if not _is_character_tag(t)]
    return {"characters": characters, "general": general}


@dataclass
class TemplateContext:
    """All variables available to a template."""
    trigger: str = ""
    tags_all: List[str] = field(default_factory=list)
    tags_filtered: List[str] = field(default_factory=list)
    tags_top_n: Dict[int, List[str]] = field(default_factory=dict)
    nl_caption: str = ""
    prompt: str = ""
    negative: str = ""
    rating: str = ""
    quality: str = ""
    safety: str = ""
    append: str = ""
    separator: str = ", "

    def resolve(self) -> Dict[str, str]:
        """Build dict of variable name -> resolved string."""
        split = _split_tags_by_type(self.tags_filtered)
        count = _extract_count_tag(self.tags_filtered)
        sep = self.separator

        return {
            "trigger": self.trigger,
            "tags": sep.join(self.tags_all),
            "tags:filtered": sep.join(self.tags_filtered),
            "nl_caption": self.nl_caption,
            "prompt": self.prompt,
            "negative": self.negative,
            "rating": self.rating,
            "characters": sep.join(split["characters"]),
            "general": sep.join(split["general"]),
            "quality": self.quality,
            "safety": self.safety,
            "count": count,
            "append": self.append,
        }


# ====================================================================
# Template rendering
# ====================================================================

# Match {variable} or {tags:N} where N is digit
_TEMPLATE_VAR_PATTERN = re.compile(r"\{([a-zA-Z_]+(?::\w+)?)\}")


def render_template(template: str, context: TemplateContext) -> str:
    """Render a template by substituting variables.

    Empty variables are replaced with empty strings; consecutive separators
    and trailing/leading separators are cleaned up.
    """
    resolved = context.resolve()

    def substitute(match: re.Match) -> str:
        var = match.group(1)
        # Handle {tags:N}
        if var.startswith("tags:"):
            suffix = var.split(":", 1)[1]
            if suffix == "filtered":
                return resolved["tags:filtered"]
            try:
                n = int(suffix)
                top_n = context.tags_top_n.get(n) or context.tags_filtered[:n]
                return context.separator.join(top_n)
            except ValueError:
                return ""
        return resolved.get(var, "")

    # Render line by line so literal prose and author-written line breaks
    # survive (v3.4.3: custom templates may freely mix free text, blank
    # lines and {variables}). Blank lines written in the template are
    # preserved; lines that only became empty because every variable on
    # them resolved empty are dropped. Separator cleanup and token dedup
    # stay per-line, so single-line templates behave exactly as before.
    out_lines: List[str] = []
    for line in str(template or "").split("\n"):
        if not line.strip():
            out_lines.append("")
            continue
        rendered = _TEMPLATE_VAR_PATTERN.sub(substitute, line)
        cleaned = _cleanup_separators(rendered, context.separator)
        deduped = _dedup_tokens(cleaned, context.separator)
        if deduped:
            out_lines.append(deduped)
    while out_lines and not out_lines[0]:
        out_lines.pop(0)
    while out_lines and not out_lines[-1]:
        out_lines.pop()
    return "\n".join(out_lines)


def _dedup_tokens(text: str, separator: str) -> str:
    """Drop duplicate tokens while preserving first-occurrence order.

    Two tokens are duplicates when their normalised forms match — case
    is ignored, leading/trailing whitespace is stripped, and
    underscores are folded with spaces. This is the same equivalence
    the rest of the engine uses (``_normalize_blacklist_item``).

    Concretely it fixes the LoRA-training regression where ``{trigger}``
    and an item in ``{append}`` could both produce the trigger word
    once with an underscore (``my_oc``) and once after underscore
    normalisation (``my oc``); a real trainer would treat those as
    two distinct BPE tokens.
    """
    if not text:
        return ""
    sep = separator if separator else ", "
    parts = [p.strip() for p in text.split(sep)]
    seen: set = set()
    kept: list = []
    for p in parts:
        if not p:
            continue
        # Treat ``_`` and `` `` as equivalent so ``my_oc`` and ``my oc``
        # collapse to one entry. Case-insensitive.
        norm = " ".join(p.replace("_", " ").lower().split())
        if norm in seen:
            continue
        seen.add(norm)
        kept.append(p)
    return sep.join(kept)


def _cleanup_separators(text: str, separator: str) -> str:
    """Remove duplicate separators and leading/trailing separator artifacts.

    Examples (sep=', '):
      ', , tag1, tag2, ' -> 'tag1, tag2'
      'tag1, , , tag2'   -> 'tag1, tag2'
    """
    if not text:
        return ""
    # Split on separator, strip, drop empties
    sep_stripped = separator.strip()
    if not sep_stripped:
        return text.strip()
    parts = [p.strip() for p in text.split(sep_stripped)]
    parts = [p for p in parts if p]
    result = separator.join(parts).strip()
    # Remove trailing ". " or "." left when template variables after a period
    # separator (e.g., "{tags}. {nl_caption}") resolve to empty.
    while result.endswith('.') or result.endswith('. '):
        candidate = result.rstrip('. ').rstrip('.')
        if candidate == result:
            break
        # Only strip if what remains looks like it ended with a comma-separated
        # tag (not a proper NL sentence that naturally ends with a period).
        # Heuristic: if the last character before the period is a letter and
        # the segment after the last comma has spaces, it's a sentence — keep it.
        last_comma = candidate.rfind(sep_stripped)
        tail = candidate[last_comma + len(sep_stripped):].strip() if last_comma >= 0 else candidate
        if ' ' in tail and len(tail) > 20:
            # Looks like a sentence — don't strip
            break
        result = candidate
    return result


# ====================================================================
# High-level render function for the export pipeline
# ====================================================================

def build_export_caption(
    image: Dict[str, Any],
    tags: List[Dict[str, Any]],
    *,
    preset_id: str = "custom",
    template_override: Optional[str] = None,
    trigger: str = "",
    blacklist: Optional[List[str]] = None,
    replace_rules: Optional[Dict[str, str]] = None,
    max_tags: int = 0,
    append: Optional[List[str]] = None,
    quality_override: Optional[str] = None,
    safety_override: Optional[str] = None,
    rating_override: Optional[str] = None,
    underscore_to_space_override: Optional[bool] = None,
    preserve_underscore_prefixes_override: Optional[List[str]] = None,
) -> str:
    """Build the final caption string for a single image using a preset + overrides.

    ``underscore_to_space_override`` and ``preserve_underscore_prefixes_override``
    let the caller force the LoRA underscore convention (``True`` to convert,
    ``False`` to keep). Used by the live-preview path so the preview
    matches the actual same-name ``.txt`` export when the user toggles the
    "Convert tag underscores to spaces (preserve `score_*`)" checkbox.

    Returns the rendered caption string ready for writing to a sidecar file.
    """
    preset = PRESETS.get(preset_id) or PRESETS["custom"]
    template = template_override if template_override else preset["template"]
    separator = preset.get("separator", ", ")

    effective_underscore = (
        bool(underscore_to_space_override)
        if underscore_to_space_override is not None
        else bool(preset.get("underscore_to_space", False))
    )
    effective_preserve = list(
        preserve_underscore_prefixes_override
        if preserve_underscore_prefixes_override is not None
        else preset.get("preserve_underscore_prefixes", [])
    )

    # Build tag processing config
    proc_config = TagProcessingConfig(
        blacklist=list(blacklist or []),
        replace_rules=dict(replace_rules or {}),
        max_tags=int(max_tags or 0),
        append=list(append or []),
        underscore_to_space=effective_underscore,
        preserve_underscore_prefixes=effective_preserve,
    )

    # Process tags
    all_tag_strings = [
        str(t.get("tag") or "").strip()
        for t in tags
        if t.get("tag")
    ]
    if proc_config.underscore_to_space:
        all_tag_strings = [
            _format_tag_underscore(t, proc_config.preserve_underscore_prefixes)
            for t in all_tag_strings
        ]

    filtered_tags = process_tags(tags, proc_config)
    blocked = _blacklist_tokens(proc_config)
    if blocked:
        all_tag_strings = [
            tag for tag in all_tag_strings
            if _normalize_blacklist_item(tag, proc_config) not in blocked
        ]

    # Determine rating
    rating = rating_override if rating_override is not None else _extract_rating(image)
    rating = _filter_template_value(rating, proc_config, separator)
    trigger_text = _filter_template_value(trigger.strip(), proc_config, separator)
    nl_caption = _filter_template_value(str(image.get("nl_caption") or image.get("ai_caption") or "").strip(), proc_config, separator)
    prompt = _filter_template_value(str(image.get("prompt") or "").strip(), proc_config, separator)
    negative = _filter_template_value(str(image.get("negative_prompt") or "").strip(), proc_config, separator)
    quality = _filter_template_value(
        quality_override if quality_override is not None else preset.get("default_quality", ""),
        proc_config,
        separator,
    )
    safety = _filter_template_value(
        safety_override if safety_override is not None else preset.get("default_safety", ""),
        proc_config,
        separator,
    )
    append_text = "" if append else _filter_template_value(preset.get("default_append", ""), proc_config, separator)

    # Build context
    context = TemplateContext(
        trigger=trigger_text,
        tags_all=all_tag_strings,
        tags_filtered=filtered_tags,
        nl_caption=nl_caption,
        prompt=prompt,
        negative=negative,
        rating=rating,
        quality=quality,
        safety=safety,
        append=append_text,
        separator=separator,
    )

    return render_template(template, context)


def _extract_rating(image: Dict[str, Any]) -> str:
    """Get rating from image record. Falls back to 'safe' if not set."""
    rating = str(image.get("rating") or "").strip().lower()
    rating_map = {
        "general": "safe",
        "g": "safe",
        "safe": "safe",
        "sensitive": "sensitive",
        "s": "sensitive",
        "questionable": "questionable",
        "q": "questionable",
        "explicit": "explicit",
        "e": "explicit",
    }
    return rating_map.get(rating, "safe" if not rating else rating)


def list_presets() -> List[Dict[str, Any]]:
    """Return preset metadata for UI."""
    return [
        {"id": pid, **{k: v for k, v in p.items() if k != "template"}, "template": p["template"]}
        for pid, p in PRESETS.items()
    ]
