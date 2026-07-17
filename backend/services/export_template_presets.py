"""LoRA-caption preset registry + template-variable documentation surface.

Split verbatim (2026-07) out of ``services/export_template_engine.py`` (see
that facade's docstring for the decomposition map). Owns the seven built-in
base-model presets, the ``{variable}`` documentation catalog, and the
``list_presets`` UI helper. Pure constants + one pure function.
"""
from __future__ import annotations

from typing import Any, Dict, List


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
        "description": "Anima base model: quality/safety prefix, danbooru tags (spaces not underscores), then NL caption separated by period. Official model-card order: quality → safety → count → trigger → characters → copyright → @artists → general tags → NL.",
        # P3-11: official Anima caption order with dedicated category sections
        # (characters / copyright / @-prefixed artists ahead of general tags).
        "template": "{quality}, {safety}, {count}, {trigger}, {characters}, {copyright}, {artists:@}, {general}. {nl_caption}",
        "separator": ", ",
        "underscore_to_space": True,
        "preserve_underscore_prefixes": ["score_"],
        "default_quality": "masterpiece, best quality",
        "default_safety": "",
        "default_append": "",
        "single_line": True,
        # Anima model-card safety vocabulary: safe / sensitive / nsfw / explicit.
        "safety_vocab": {
            "general": "safe",
            "sensitive": "sensitive",
            "questionable": "nsfw",
            "explicit": "explicit",
        },
    },
    "anima_tags_only": {
        "name": "Anima (Tags only)",
        "description": "Anima format without NL caption — pure danbooru tags with quality/safety prefix.",
        "template": "{quality}, {safety}, {count}, {trigger}, {characters}, {copyright}, {artists:@}, {general}",
        "separator": ", ",
        "underscore_to_space": True,
        "preserve_underscore_prefixes": ["score_"],
        # P3-14: match the tags+NL preset — "newest, highres, normal quality"
        # was a time/meta mix, not a quality default any trainer documents.
        "default_quality": "masterpiece, best quality",
        "default_safety": "",
        "default_append": "",
        "single_line": True,
        "safety_vocab": {
            "general": "safe",
            "sensitive": "sensitive",
            "questionable": "nsfw",
            "explicit": "explicit",
        },
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
        "single_line": True,
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
        "single_line": True,
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
        "single_line": True,
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
        "single_line": True,
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
        # Custom templates may deliberately span multiple lines (v3.4.3);
        # never flatten them behind the author's back.
        "single_line": False,
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
    {"name": "{rating}", "description": "Per-image rating resolved from the tagger's rating tag (safe/sensitive/questionable/explicit); empty when the image was never rated"},
    {"name": "{characters}", "description": "Character tags only (tagger-recorded category, heuristic fallback)"},
    {"name": "{copyright}", "description": "Copyright/series tags only (tagger-recorded category)"},
    {"name": "{artists}", "description": "Artist tags only (tagger-recorded category)"},
    {"name": "{artists:@}", "description": "Artist tags with the Anima-style @ prefix (@artist_name)"},
    {"name": "{general}", "description": "Tags not in the character/copyright/artist buckets"},
    {"name": "{quality}", "description": "Quality tags: user override > aesthetic-score bucket > preset default"},
    {"name": "{safety}", "description": "Per-image rating in the preset's model-card vocabulary (Anima: questionable→nsfw); preset default only when unrated"},
    {"name": "{count}", "description": "Subject-count tag (1girl/1boy/2girls/etc.) extracted from tags"},
    {"name": "{append}", "description": "User-supplied or preset-default append text"},
]


def list_presets() -> List[Dict[str, Any]]:
    """Return preset metadata for UI."""
    return [
        {"id": pid, **{k: v for k, v in p.items() if k != "template"}, "template": p["template"]}
        for pid, p in PRESETS.items()
    ]
