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
        "description": "Anima base model: space-separated tags, optional NL caption, score_N keeps underscore.",
        "template": "{quality}, {safety}, {count}, {trigger}, {nl_caption}, {tags:filtered}",
        "separator": ", ",
        "underscore_to_space": True,
        "preserve_underscore_prefixes": ["score_"],
        "default_quality": "newest, highres, normal quality, score_5",
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
    if not tags:
        return list(config.append) if config.append else []

    blacklist_lower = {t.lower().strip() for t in config.blacklist if t and t.strip()}

    # Step 1: filter blacklist + extract tag strings (sorted by confidence desc)
    sorted_tags = sorted(
        tags,
        key=lambda t: -float(t.get("confidence") or 1.0),
    )
    processed: List[str] = []
    for tag_data in sorted_tags:
        tag_str = str(tag_data.get("tag") or "").strip()
        if not tag_str or tag_str.lower() in blacklist_lower:
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
        existing_lower = {t.lower() for t in processed}
        for ap in appended:
            if ap.lower() not in existing_lower:
                processed.append(ap)
                existing_lower.add(ap.lower())

    return processed


def _format_tag_underscore(tag: str, preserve_prefixes: List[str]) -> str:
    """Convert underscores to spaces unless tag starts with a preserved prefix."""
    for prefix in preserve_prefixes:
        if tag.startswith(prefix):
            return tag
    return tag.replace("_", " ")


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
        count = _extract_count_tag(self.tags_filtered + self.tags_all)
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

    rendered = _TEMPLATE_VAR_PATTERN.sub(substitute, template)
    return _cleanup_separators(rendered, context.separator)


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
    return separator.join(parts)


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
) -> str:
    """Build the final caption string for a single image using a preset + overrides.

    Returns the rendered caption string ready for writing to a sidecar file.
    """
    preset = PRESETS.get(preset_id) or PRESETS["custom"]
    template = template_override if template_override else preset["template"]
    separator = preset.get("separator", ", ")

    # Build tag processing config
    proc_config = TagProcessingConfig(
        blacklist=list(blacklist or []),
        replace_rules=dict(replace_rules or {}),
        max_tags=int(max_tags or 0),
        append=list(append or []),
        underscore_to_space=preset.get("underscore_to_space", False),
        preserve_underscore_prefixes=list(preset.get("preserve_underscore_prefixes", [])),
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

    # Determine rating
    rating = rating_override if rating_override is not None else _extract_rating(image)

    # Build context
    context = TemplateContext(
        trigger=trigger.strip(),
        tags_all=all_tag_strings,
        tags_filtered=filtered_tags,
        nl_caption=str(image.get("ai_caption") or "").strip(),
        prompt=str(image.get("prompt") or "").strip(),
        negative=str(image.get("negative_prompt") or "").strip(),
        rating=rating,
        quality=quality_override if quality_override is not None else preset.get("default_quality", ""),
        safety=safety_override if safety_override is not None else preset.get("default_safety", ""),
        append=", ".join(append) if append else preset.get("default_append", ""),
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
