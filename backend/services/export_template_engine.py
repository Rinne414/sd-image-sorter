"""Export template engine for LoRA training caption files.

Supports a flexible {variable} template syntax with tag processing pipeline:
  blacklist -> replace -> max N -> append

Built-in presets target popular base models (Anima, Illustrious/Pony, NoobAI, FLUX, Kohya).

Split (2026-07) into four sibling modules, re-exported here BY REFERENCE so
every historical ``services.export_template_engine.<name>`` keeps resolving --
the lazy origin-module seams (routers/tags.py, tag_export/captions.py,
tag_export/preview.py, dataset_export/captions.py) and the eager
``is_kaomoji_tag`` identity imports (smart_tag/consensus.py,
smart_tag/results.py) are locked by tests/test_export_template_pins.py:

* ``export_template_presets`` -- PRESETS, TEMPLATE_VARIABLES, list_presets
* ``export_tag_pipeline``     -- TagProcessingConfig, process_tags, the
  kaomoji vocabulary + underscore formatting (is_kaomoji_tag /
  normalize_lora_tag), and the blacklist / template-value helpers
* ``export_rating_quality``   -- rating canon/vocab, resolve_canonical_rating,
  the aesthetic-score quality buckets, flatten_single_line
* ``export_template_render``  -- TemplateContext, the category-bucket split,
  render_template, separator cleanup + token dedup

Only ``build_export_caption`` (the high-level orchestrator) stays defined
in this file.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

from services.export_template_presets import (
    PRESETS,
    TEMPLATE_VARIABLES,
    list_presets,
)
from services.export_tag_pipeline import (
    TagProcessingConfig,
    process_tags,
    KAOMOJI_TAGS,
    is_kaomoji_tag,
    _format_tag_underscore,
    normalize_lora_tag,
    DEFAULT_LORA_PRESERVE_PREFIXES,
    _normalize_blacklist_item,
    _blacklist_tokens,
    _split_template_value,
    _filter_template_value,
)
from services.export_rating_quality import (
    RATING_TAG_CANON,
    DEFAULT_RATING_VOCAB,
    _RATING_SLOT_PATTERN,
    canonical_rating_word,
    resolve_canonical_rating,
    _QUALITY_BUCKETS,
    quality_from_aesthetic_score,
    flatten_single_line,
)
from services.export_template_render import (
    _CHARACTER_TAG_HINTS,
    _COUNT_TAG_PATTERN,
    _TAG_CATEGORY_BUCKETS,
    _is_character_tag,
    _extract_count_tag,
    _category_norm,
    _split_tags_by_type,
    TemplateContext,
    _TEMPLATE_VAR_PATTERN,
    render_template,
    _dedup_tokens,
    _cleanup_separators,
)


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

    # Resolve the image's actual rating once (canonical danbooru word or "").
    canonical_rating = resolve_canonical_rating(image, tags, rating_override)

    # When the template carries a dedicated {rating}/{safety} slot, keep the
    # raw rating-marker tags out of every tag variable so one caption can
    # never state two contradictory ratings (F1: "safe, …, explicit").
    if _RATING_SLOT_PATTERN.search(template):
        tags = [
            t for t in tags
            if canonical_rating_word(str(t.get("tag") or "")) is None
        ]

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

    # P3-11: record each tag's stored category BEFORE the processing pipeline
    # reshapes the strings — the lookup key folds underscores/case, so
    # underscore formatting keeps matching; replace-rule renames simply fall
    # back to the heuristic.
    category_by_norm: Dict[str, str] = {}
    for t in tags:
        name = str(t.get("tag") or "").strip()
        cat = str(t.get("category") or "").strip().lower()
        if name and cat:
            category_by_norm[_category_norm(name)] = cat

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

    # {rating}: explicit override wins verbatim; otherwise render the
    # per-image canonical rating through the generic vocabulary. Unrated
    # images render nothing — never a guessed "safe" (F1).
    if rating_override is not None and str(rating_override).strip():
        rating = str(rating_override).strip()
    else:
        rating = DEFAULT_RATING_VOCAB.get(canonical_rating, "")
    rating = _filter_template_value(rating, proc_config, separator)

    # {safety}: same resolution, but through the preset's model-card
    # vocabulary (Anima: questionable→nsfw). ``default_safety`` only fills
    # in when the image was never rated.
    if safety_override is not None:
        safety = safety_override
    elif canonical_rating:
        safety_vocab = preset.get("safety_vocab") or DEFAULT_RATING_VOCAB
        safety = safety_vocab.get(canonical_rating, canonical_rating)
    else:
        safety = preset.get("default_safety", "")
    safety = _filter_template_value(safety, proc_config, separator)

    # {quality}: user override > aesthetic-score bucket > preset default.
    # A scored image in the normal band deliberately renders "" — a uniform
    # quality token on every caption carries no training signal.
    if quality_override is not None:
        quality = quality_override
    else:
        derived_quality = quality_from_aesthetic_score(image.get("aesthetic_score"))
        quality = (
            derived_quality
            if derived_quality is not None
            else preset.get("default_quality", "")
        )
    quality = _filter_template_value(quality, proc_config, separator)

    trigger_text = _filter_template_value(trigger.strip(), proc_config, separator)
    nl_caption = _filter_template_value(str(image.get("nl_caption") or image.get("ai_caption") or "").strip(), proc_config, separator)
    prompt = _filter_template_value(str(image.get("prompt") or "").strip(), proc_config, separator)
    negative = _filter_template_value(str(image.get("negative_prompt") or "").strip(), proc_config, separator)
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
        category_by_norm=category_by_norm,
    )

    rendered = render_template(template, context)

    # Single-line guarantee (F2): kohya-family trainers read only the first
    # line of a caption file, so built-in presets flatten variable-injected
    # newlines (multi-paragraph NL captions, prompts with line breaks).
    # Author-written multi-line templates (custom preset, or an override
    # that itself contains "\n") are left untouched.
    if preset.get("single_line") and "\n" not in template:
        rendered = flatten_single_line(rendered)

    return rendered
