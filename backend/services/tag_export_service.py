"""
Shared export helpers for prompt/tag/caption sidecar files.
"""
from __future__ import annotations

import json
import os
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, Iterator, List, Optional

from fastapi import HTTPException

import database as db
from services.export_validation import ExportValidator
from utils.path_validation import normalize_user_path, sanitize_filename, validate_folder_path


PARAMETER_EXPORT_ORDER = [
    ("steps", "Steps"),
    ("sampler", "Sampler"),
    ("schedule_type", "Schedule type"),
    ("cfg_scale", "CFG scale"),
    ("seed", "Seed"),
    ("size", "Size"),
    ("model", "Model"),
    ("model_hash", "Model hash"),
    ("clip_skip", "Clip skip"),
    ("denoising_strength", "Denoising strength"),
    ("loras", "LoRAs"),
]

VALID_CONTENT_MODES = {
    "tags",
    "prompt",
    "negative",
    "prompt_negative",
    "a1111",
    "caption_tags",
    "caption_merged",
    "json",
    # v3.2.1 additions
    "nl_caption",      # Pure natural language caption (ai_caption only)
    "tags_nl",         # Tags + natural language caption, without original prompt
    "prompt_nl",       # Original prompt + NL caption
    "template",        # Uses export_template_engine with preset/template options
}
VALID_OVERWRITE_POLICIES = {"unique", "overwrite", "skip"}
# ``folder``       — write all sidecars into the user-supplied ``output_folder``
#                    (legacy default; flat output regardless of source layout).
# ``beside_image`` — write each sidecar to the directory of its source image,
#                    so a library spread across many subfolders keeps its
#                    structure intact and per-image training tools that look
#                    for ``foo.png`` + ``foo.txt`` in the same directory keep
#                    working without extra plumbing.
VALID_OUTPUT_MODES = {"folder", "beside_image"}
EXPORT_DB_CHUNK_SIZE = 500
PROMPT_MATCH_MODE_EXACT = "exact"
PROMPT_MATCH_MODE_CONTAINS = "contains"
COMBINED_EXPORT_RECENT_ERROR_LIMIT = 20


def _normalize_export_image_ids(image_ids: Iterable[Any]) -> List[int]:
    normalized_ids: List[int] = []
    seen_ids: set[int] = set()
    for raw_image_id in image_ids or []:
        try:
            image_id = int(raw_image_id)
        except (TypeError, ValueError):
            continue
        if image_id <= 0 or image_id in seen_ids:
            continue
        seen_ids.add(image_id)
        normalized_ids.append(image_id)
    return normalized_ids


def _iter_id_list_chunks(image_ids: Iterable[Any], chunk_size: int = EXPORT_DB_CHUNK_SIZE) -> Iterator[List[int]]:
    normalized_chunk_size = max(1, int(chunk_size or EXPORT_DB_CHUNK_SIZE))
    chunk: List[int] = []
    seen_ids: set[int] = set()
    for raw_image_id in image_ids or []:
        try:
            image_id = int(raw_image_id)
        except (TypeError, ValueError):
            continue
        if image_id <= 0 or image_id in seen_ids:
            continue
        seen_ids.add(image_id)
        chunk.append(image_id)
        if len(chunk) >= normalized_chunk_size:
            yield chunk
            chunk = []
    if chunk:
        yield chunk


def _decode_selection_token(selection_token: str) -> Dict[str, Any]:
    # Reuse ImageService's validating decoder (lazy import: image_service
    # imports this module at top level). Beyond the version/dict checks it
    # type-checks list fields and coerces numeric filters, so a malformed
    # token ({"minUserRating": "abc"}) fails here with HTTP 400 instead of a
    # ValueError-driven 500 deep inside the SQL builders.
    from services.image_service import ImageService

    filters = ImageService()._decode_selection_token(selection_token)
    if (filters.get("sortBy") or "newest") == "random":
        raise HTTPException(status_code=400, detail="random sort cannot use selection-token export")
    return filters


def iter_selection_token_id_chunks(
    selection_token: str,
    chunk_size: int = EXPORT_DB_CHUNK_SIZE,
    *,
    snapshot: bool = False,
) -> Iterator[List[int]]:
    """Yield the token's matching image IDs in chunks.

    ``snapshot=True`` materializes all matching IDs to a temp file BEFORE the
    first chunk is yielded. Callers that mutate tags/captions the token's
    filters can reference (bulk tag ops, smart-tag, VLM caption batches) MUST
    pass it, otherwise the underlying offset pagination skips images as the
    matching set shrinks between committed chunks. Read-only consumers
    (exports) can keep the default streaming behavior.
    """
    filters = _decode_selection_token(selection_token)
    id_chunks = _iter_decoded_filter_id_chunks(filters, chunk_size)
    if snapshot:
        yield from db.iter_id_snapshot_chunks(id_chunks, chunk_size=chunk_size)
    else:
        yield from id_chunks


def _iter_decoded_filter_id_chunks(filters: Dict[str, Any], chunk_size: int) -> Iterator[List[int]]:
    yield from db.iter_filtered_image_id_chunks(
        chunk_size=chunk_size,
        generators=filters.get("generators") or None,
        tags=filters.get("tags") or None,
        tag_mode=filters.get("tagMode") or filters.get("tag_mode") or "and",
        ratings=filters.get("ratings") or None,
        checkpoints=filters.get("checkpoints") or None,
        loras=filters.get("loras") or None,
        search_query=filters.get("search") or None,
        sort_by=filters.get("sortBy") or "newest",
        min_width=filters.get("minWidth"),
        max_width=filters.get("maxWidth"),
        min_height=filters.get("minHeight"),
        max_height=filters.get("maxHeight"),
        prompt_terms=filters.get("prompts") or None,
        prompt_match_mode=filters.get("promptMatchMode") or filters.get("prompt_match_mode") or PROMPT_MATCH_MODE_EXACT,
        aspect_ratio=filters.get("aspectRatio"),
        artist=filters.get("artist"),
        min_aesthetic=filters.get("minAesthetic"),
        max_aesthetic=filters.get("maxAesthetic"),
        min_user_rating=filters.get("minUserRating") or filters.get("min_user_rating"),
        excluded_image_ids=filters.get("excludedImageIds") or None,
        brightness_min=filters.get("brightnessMin"),
        brightness_max=filters.get("brightnessMax"),
        color_temperature=filters.get("colorTemperature"),
        brightness_distribution=filters.get("brightnessDistribution"),
        exclude_tags=filters.get("excludeTags") or None,
        exclude_generators=filters.get("excludeGenerators") or None,
        exclude_ratings=filters.get("excludeRatings") or None,
        exclude_checkpoints=filters.get("excludeCheckpoints") or None,
        exclude_loras=filters.get("excludeLoras") or None,
        exclude_prompts=filters.get("excludePrompts") or None,
        exclude_colors=filters.get("excludeColors") or None,
        color_hues=filters.get("colorHues") or None,
        exclude_color_hues=filters.get("excludeColorHues") or None,
        collection_id=filters.get("collectionId") or filters.get("collection_id"),
        folder=filters.get("folder"),
        has_metadata=filters.get("hasMetadata"),
    )


def count_selection_token_ids(selection_token: str) -> int:
    filters = _decode_selection_token(selection_token)
    return db.get_filtered_image_count(
        generators=filters.get("generators") or None,
        tags=filters.get("tags") or None,
        tag_mode=filters.get("tagMode") or filters.get("tag_mode") or "and",
        ratings=filters.get("ratings") or None,
        checkpoints=filters.get("checkpoints") or None,
        loras=filters.get("loras") or None,
        search_query=filters.get("search") or None,
        min_width=filters.get("minWidth"),
        max_width=filters.get("maxWidth"),
        min_height=filters.get("minHeight"),
        max_height=filters.get("maxHeight"),
        prompt_terms=filters.get("prompts") or None,
        prompt_match_mode=filters.get("promptMatchMode") or filters.get("prompt_match_mode") or PROMPT_MATCH_MODE_EXACT,
        aspect_ratio=filters.get("aspectRatio"),
        artist=filters.get("artist"),
        min_aesthetic=filters.get("minAesthetic"),
        max_aesthetic=filters.get("maxAesthetic"),
        min_user_rating=filters.get("minUserRating") or filters.get("min_user_rating"),
        excluded_image_ids=filters.get("excludedImageIds") or None,
        brightness_min=filters.get("brightnessMin"),
        brightness_max=filters.get("brightnessMax"),
        color_temperature=filters.get("colorTemperature"),
        brightness_distribution=filters.get("brightnessDistribution"),
        exclude_tags=filters.get("excludeTags") or None,
        exclude_generators=filters.get("excludeGenerators") or None,
        exclude_ratings=filters.get("excludeRatings") or None,
        exclude_checkpoints=filters.get("excludeCheckpoints") or None,
        exclude_loras=filters.get("excludeLoras") or None,
        exclude_prompts=filters.get("excludePrompts") or None,
        exclude_colors=filters.get("excludeColors") or None,
        color_hues=filters.get("colorHues") or None,
        exclude_color_hues=filters.get("excludeColorHues") or None,
        collection_id=filters.get("collectionId") or filters.get("collection_id"),
        folder=filters.get("folder"),
        has_metadata=filters.get("hasMetadata"),
    )


def extract_generation_params(image: Dict[str, Any]) -> Dict[str, Any]:
    """Extract normalized generation parameters from a stored image row."""
    metadata = image.get("metadata") if isinstance(image.get("metadata"), dict) else None
    if metadata is None:
        raw_metadata = image.get("metadata_json")
        if isinstance(raw_metadata, str) and raw_metadata.strip():
            try:
                metadata = json.loads(raw_metadata)
            except (TypeError, ValueError, json.JSONDecodeError):
                metadata = {}
        else:
            metadata = {}

    parsed = metadata.get("_parsed") if isinstance(metadata, dict) else {}
    params = parsed.get("generation_params") if isinstance(parsed, dict) else {}
    normalized = dict(params) if isinstance(params, dict) else {}

    if not normalized.get("model") and image.get("checkpoint"):
        normalized["model"] = image.get("checkpoint")
    if not normalized.get("model_hash") and image.get("model_hash"):
        normalized["model_hash"] = image.get("model_hash")
    if not normalized.get("size") and image.get("width") and image.get("height"):
        normalized["size"] = f"{image.get('width')}x{image.get('height')}"
    if not normalized.get("loras") and image.get("loras"):
        loras = image.get("loras")
        if isinstance(loras, str):
            try:
                loaded = json.loads(loras)
                if isinstance(loaded, list):
                    loras = loaded
            except (TypeError, ValueError, json.JSONDecodeError):
                loras = [part.strip() for part in loras.split(",") if part.strip()]
        if isinstance(loras, list) and loras:
            normalized["loras"] = ", ".join(str(item) for item in loras if str(item).strip())

    return normalized


def build_a1111_parameters_text(image: Dict[str, Any]) -> str:
    """Build a Stable Diffusion WebUI/A1111-style prompt block."""
    prompt = str(image.get("prompt") or "").strip()
    negative_prompt = str(image.get("negative_prompt") or "").strip()
    generation_params = extract_generation_params(image)

    lines: List[str] = []
    if prompt:
        lines.append(prompt)
    if negative_prompt:
        lines.append(f"Negative prompt: {negative_prompt}")

    emitted = set()
    parts: List[str] = []
    for key, label in PARAMETER_EXPORT_ORDER:
        value = generation_params.get(key)
        if value is None or value == "":
            continue
        emitted.add(key)
        parts.append(f"{label}: {value}")

    for key in sorted(k for k in generation_params.keys() if k not in emitted):
        value = generation_params.get(key)
        if value is None or value == "":
            continue
        label = " ".join(part.capitalize() for part in str(key).split("_"))
        parts.append(f"{label}: {value}")

    if parts:
        lines.append(", ".join(parts))

    return "\n".join(lines).strip()


def _filter_tags(tags: List[Dict[str, Any]], blacklist: set[str]) -> List[str]:
    return [
        str(tag.get("tag") or "").strip()
        for tag in tags
        if str(tag.get("tag") or "").strip()
        and str(tag.get("tag") or "").strip().lower() not in blacklist
    ]


# Default underscore-preservation prefixes for the LoRA-friendly export path.
# Re-exported from ``export_template_engine`` so the same convention applies
# whether you run the basic ``tags`` mode or the template engine.
LORA_PRESERVE_UNDERSCORE_PREFIXES = ["score_"]


# Content modes that emit danbooru-style tag tokens. Underscore-to-space
# normalization defaults to ON for these so LoRA trainers receive
# ``multiple girls`` (with ``score_5`` preserved) instead of
# ``multiple_girls``. Modes producing free-form text (prompt, NL caption,
# A1111 parameter blocks) are left untouched because users may have written
# deliberate underscores into their original prompts.
DANBOORU_TAG_CONTENT_MODES = {
    "tags",
    "caption_tags",
    "caption_merged",
    "tags_nl",
}


def _maybe_normalize_underscores(
    tags: List[str],
    *,
    normalize: bool,
    preserve_prefixes: Optional[List[str]] = None,
) -> List[str]:
    """Apply LoRA-friendly underscore-to-space conversion to a list of tags."""
    if not normalize:
        return tags
    from services.export_template_engine import normalize_lora_tag
    prefixes = list(preserve_prefixes) if preserve_prefixes is not None else LORA_PRESERVE_UNDERSCORE_PREFIXES
    return [normalize_lora_tag(t, prefixes) for t in tags]


def _resolve_underscore_normalization(
    content_mode: str,
    normalize_tag_underscores: Optional[bool],
) -> bool:
    """Pick the effective underscore normalization flag for ``content_mode``.

    ``normalize_tag_underscores`` is the request override (``True``, ``False``
    or ``None`` for default). When ``None`` we apply normalization for every
    danbooru-tag content mode (the LoRA-trainer expectation) and skip it for
    NL / prompt / a1111 / json modes. ``template`` mode is also skipped here
    because the template engine performs its own per-preset normalization
    using the same underlying utility.
    """
    if normalize_tag_underscores is True:
        return True
    if normalize_tag_underscores is False:
        return False
    return str(content_mode or "").strip().lower() in DANBOORU_TAG_CONTENT_MODES


def _join_caption_parts(parts: List[str]) -> str:
    seen = set()
    output: List[str] = []
    for part in parts:
        normalized = " ".join(str(part or "").split()).strip(",")
        if not normalized:
            continue
        key = normalized.lower()
        if key in seen:
            continue
        seen.add(key)
        output.append(normalized)
    return ", ".join(output)


def _split_caption_transform_tokens(value: str) -> List[str]:
    return [
        " ".join(part.split()).strip(" ,")
        for part in str(value or "").replace("\n", ",").split(",")
        if " ".join(part.split()).strip(" ,")
    ]


def _normalize_caption_transform_token(value: str) -> str:
    return " ".join(str(value or "").replace("_", " ").split()).strip().lower()


def _coerce_transform_token_list(value: Any) -> List[str]:
    if value is None:
        return []
    if isinstance(value, (str, bytes)):
        values = [value]
    else:
        try:
            values = list(value)
        except TypeError:
            values = [value]
    out: List[str] = []
    seen: set[str] = set()
    for raw in values:
        token = " ".join(str(raw or "").split()).strip(" ,")
        if not token:
            continue
        key = _normalize_caption_transform_token(token)
        if key in seen:
            continue
        seen.add(key)
        out.append(token)
    return out


def apply_caption_transforms(content: str, transforms: Optional[Dict[str, Any]]) -> str:
    """Apply token-level caption transforms without loading captions in the UI.

    The v321 caption editor can now say "add/remove from all selected images"
    as a compact rule. Export code applies that rule per image while streaming
    chunks from either explicit IDs or a selection token.
    """
    if not isinstance(transforms, dict) or not transforms:
        return str(content or "")

    prepend = _coerce_transform_token_list(transforms.get("prepend") or transforms.get("add_prepend"))
    append = _coerce_transform_token_list(transforms.get("append") or transforms.get("add_append"))
    remove = _coerce_transform_token_list(transforms.get("remove") or transforms.get("remove_tokens"))
    remove_categories = {
        str(category or "").strip().lower()
        for category in _coerce_transform_token_list(
            transforms.get("remove_categories") or transforms.get("removeCategories")
        )
        if str(category or "").strip()
    }
    dedupe = bool(transforms.get("dedupe") or prepend or append or remove or remove_categories)

    if not prepend and not append and not remove and not remove_categories and not dedupe:
        return str(content or "")

    tokens = _split_caption_transform_tokens(str(content or ""))
    remove_keys = {_normalize_caption_transform_token(token) for token in remove}
    if remove_keys:
        tokens = [token for token in tokens if _normalize_caption_transform_token(token) not in remove_keys]
    if remove_categories:
        try:
            from tag_rules import categorize_tag
            tokens = [
                token
                for token in tokens
                if str(categorize_tag(token) or "").strip().lower() not in remove_categories
            ]
        except Exception:
            # Category cleanup is a convenience layer. Exact add/remove
            # transforms must continue to work even if the categorizer is
            # unavailable in a packaged build.
            pass

    merged = [*prepend, *tokens, *append]
    if dedupe:
        output: List[str] = []
        seen: set[str] = set()
        for token in merged:
            key = _normalize_caption_transform_token(token)
            if not key or key in seen:
                continue
            seen.add(key)
            output.append(token)
        merged = output

    return ", ".join(merged)


# Content modes whose rendered caption is booru-tags / template only — the
# per-image NL compose (caption editor's Booru/NL/Both control) layers the
# natural-language sentence on top of these. NL-aware modes (tags_nl,
# nl_caption, prompt_nl, caption_*) already emit the sentence globally, so
# compose is skipped for them to avoid doubling it. Shared with
# dataset_export_service — both export engines must gate identically.
NL_COMPOSE_MODES = {"template", "tags"}


def compose_caption_with_nl(rendered: str, caption_type: str, nl_text: str) -> str:
    """Join rule for the per-image Booru/NL/Both caption type.

    Single source of truth for both export engines; the frontend
    ``CaptionCore.compose`` mirrors this exactly — change them together.
    Returns ``rendered`` verbatim for any type other than "nl"/"both".

    The NL sentence is whitespace-flattened (P1-7): stored ai_caption text can
    span multiple lines, and kohya-style trainers read caption line 1 only, so
    a multi-line sentence would silently truncate the training caption.
    """
    ctype = str(caption_type or "").strip().lower()
    if ctype not in ("nl", "both"):
        return rendered
    booru = str(rendered or "").strip()
    text = " ".join(str(nl_text or "").split())
    if ctype == "nl":
        return text or booru
    # 'both' — tags first, then the sentence (matches the tags_nl mode order).
    if booru and text:
        return f"{booru}, {text}"
    return booru or text


def _coerce_int_str_map(raw: Optional[Dict[Any, Any]]) -> Dict[int, str]:
    """Normalise a JSON object keyed by image id into ``{int: str}``."""
    result: Dict[int, str] = {}
    if isinstance(raw, dict):
        for key, value in raw.items():
            try:
                result[int(key)] = str(value or "")
            except (TypeError, ValueError):
                continue
    return result


def _image_nl_source_text(image: Dict[str, Any], image_id: int, nl_overrides: Dict[int, str]) -> str:
    """Resolve one image's natural-language caption text.

    Editor override first (an explicit empty string intentionally suppresses
    the stored sentence), then the stored pure NL, then the fused ai_caption
    for rows tagged before the nl_caption split existed.
    """
    if image_id in nl_overrides:
        return str(nl_overrides[image_id] or "")
    return str(image.get("nl_caption") or image.get("ai_caption") or "")


def _compose_nl_for_image(
    rendered: str,
    image: Dict[str, Any],
    image_id: int,
    *,
    content_mode: str,
    image_types: Dict[int, str],
    nl_overrides: Dict[int, str],
) -> str:
    """Apply the per-image caption type to an already-rendered caption.

    An explicit empty-string entry in ``nl_overrides`` intentionally
    suppresses the stored sentence (mirrors dataset_export_service).
    """
    caption_type = str(image_types.get(image_id, "") or "").strip().lower()
    if caption_type not in ("nl", "both"):
        return rendered
    if str(content_mode or "").strip().lower() not in NL_COMPOSE_MODES:
        return rendered
    nl_text = _image_nl_source_text(image, image_id, nl_overrides)
    return compose_caption_with_nl(rendered, caption_type, nl_text)


def _build_nl_sidecar_content(nl_text: str, trigger: str) -> str:
    """Build the split-export NL twin's content: single line, trigger first.

    kohya-style trainers read caption line 1 only, so the sentence is
    whitespace-flattened. The trigger is prepended unless already present
    (case-insensitive), because each sidecar must stand alone as a caption.
    """
    flattened = " ".join(str(nl_text or "").split())
    trigger_clean = str(trigger or "").strip().strip(",")
    if not trigger_clean:
        return flattened
    if trigger_clean.lower() in flattened.lower():
        return flattened
    return f"{trigger_clean}, {flattened}" if flattened else trigger_clean


def _filter_text_caption_tokens(value: str, blacklist: set[str]) -> List[str]:
    blocked = {" ".join(str(tag or "").split()).strip().lower() for tag in blacklist if str(tag or "").strip()}
    if not blocked:
        normalized = " ".join(str(value or "").split()).strip(",")
        return [normalized] if normalized else []

    output: List[str] = []
    for token in str(value or "").replace("\n", " ").split(","):
        normalized = " ".join(token.split()).strip(",")
        if not normalized:
            continue
        if normalized.lower() in blocked:
            continue
        output.append(normalized)
    return output


def _merge_template_blacklist_options(template_options: Optional[Dict[str, Any]], blacklist: set[str]) -> Dict[str, Any]:
    """Keep the export-modal blacklist authoritative for template sidecars too."""
    opts = dict(template_options or {})
    merged: List[str] = []
    seen: set[str] = set()
    sources = [opts.get("blacklist") or [], blacklist or set()]
    for source in sources:
        if isinstance(source, (str, bytes)):
            items = [source]
        else:
            items = source
        for raw_item in items:
            item = str(raw_item or "").strip()
            if not item:
                continue
            key = " ".join(item.split()).lower()
            if key in seen:
                continue
            seen.add(key)
            merged.append(item)
    opts["blacklist"] = merged
    return opts


def build_sidecar_content(
    image: Dict[str, Any],
    tags: List[Dict[str, Any]],
    *,
    content_mode: str = "tags",
    blacklist: Optional[set[str]] = None,
    prefix: str = "",
    template_options: Optional[Dict[str, Any]] = None,
    normalize_tag_underscores: Optional[bool] = None,
    training_purpose: str = "",
    dedupe_implications: bool = False,
) -> str:
    """Build export content for one image according to a Pro SD workflow mode.

    For content_mode='template', template_options is required and may contain:
      preset_id, template_override, trigger, blacklist, replace_rules, max_tags,
      append, quality_override, safety_override, rating_override.

    ``normalize_tag_underscores`` controls whether danbooru-tag content modes
    (``tags``, ``caption_tags``, ``caption_merged``, ``tags_nl``) emit
    LoRA-friendly captions with underscores converted to spaces (``score_*``
    is always preserved). The default (``None``) follows the per-mode policy:
    tag modes normalize, free-form text modes (prompt, NL, a1111, json) do
    not. Pass ``False`` explicitly to keep underscores in tag modes; pass
    ``True`` to force normalization in modes that do not normalize by default
    (rarely useful — most callers should leave this at ``None``).
    """
    mode = str(content_mode or "tags").strip().lower()
    if mode not in VALID_CONTENT_MODES:
        raise HTTPException(status_code=400, detail=f"Invalid content_mode: {content_mode}")

    # P2-19 / P2-18 (2026-07-07): purpose filtering + implication dedup happen
    # on the tag ROWS before any mode dispatch, so every content mode —
    # including 'template', which receives the raw rows below — inherits them
    # and the export preview stays WYSIWYG with the written sidecars.
    if str(training_purpose or "").strip() or dedupe_implications:
        from services.tag_training_filters import apply_training_filters
        trigger_word = str((template_options or {}).get("trigger") or prefix or "")
        tags = apply_training_filters(
            tags,
            training_purpose=training_purpose,
            trigger_word=trigger_word,
            dedupe_implications=dedupe_implications,
        )

    blacklist = blacklist or set()
    filtered_tags = _filter_tags(tags, blacklist)
    prompt = str(image.get("prompt") or "").strip()
    negative_prompt = str(image.get("negative_prompt") or "").strip()
    caption = str(image.get("ai_caption") or "").strip()
    # Pure natural-language caption (point 1): prefer the dedicated nl_caption
    # column; fall back to the composed ai_caption for images tagged before the
    # split existed. The NL-oriented modes use this so booru tags don't leak in.
    nl_caption_text = str(image.get("nl_caption") or "").strip() or caption
    prefix = str(prefix or "").strip()

    # LoRA-friendly underscore normalization for danbooru-tag content modes.
    # Applied AFTER blacklist filtering (so the blacklist still works against
    # raw tag identifiers like ``multiple_girls``) but BEFORE the join, so
    # downstream consumers see ``multiple girls`` while ``score_5`` /
    # ``score_9_up`` survive intact.
    underscore_apply = _resolve_underscore_normalization(mode, normalize_tag_underscores)
    filtered_tags = _maybe_normalize_underscores(filtered_tags, normalize=underscore_apply)

    if mode == "tags":
        return _join_caption_parts(filtered_tags)
    if mode == "prompt":
        return prompt
    if mode == "negative":
        return negative_prompt
    if mode == "prompt_negative":
        return "\n".join(part for part in [prompt, f"Negative prompt: {negative_prompt}" if negative_prompt else ""] if part)
    if mode == "a1111":
        return build_a1111_parameters_text(image)
    if mode == "caption_tags":
        return _join_caption_parts([prefix, *_filter_text_caption_tokens(caption, blacklist), *filtered_tags])
    if mode == "caption_merged":
        return _join_caption_parts([
            prefix,
            *_filter_text_caption_tokens(caption, blacklist),
            *_filter_text_caption_tokens(prompt, blacklist),
            *filtered_tags,
        ])
    if mode == "nl_caption":
        # Pure natural language caption only
        return _join_caption_parts([prefix, *_filter_text_caption_tokens(nl_caption_text, blacklist)])
    if mode == "tags_nl":
        # Training-caption mode: local tags first, then natural-language caption; original prompt is excluded.
        return _join_caption_parts([prefix, *filtered_tags, *_filter_text_caption_tokens(nl_caption_text, blacklist)])
    if mode == "prompt_nl":
        # Original prompt + NL caption (separated by newline for clarity)
        parts = []
        if prefix:
            parts.append(prefix)
        parts.extend(_filter_text_caption_tokens(prompt, blacklist))
        parts.extend(_filter_text_caption_tokens(nl_caption_text, blacklist))
        return "\n".join(parts) if len(parts) > 1 else (parts[0] if parts else "")
    if mode == "template":
        # Use the export template engine
        from services.export_template_engine import build_export_caption
        opts = _merge_template_blacklist_options(template_options, blacklist)
        # Forward the underscore checkbox override so sidecar export matches preview
        if normalize_tag_underscores is False and "underscore_to_space_override" not in opts:
            opts["underscore_to_space_override"] = False
            opts.setdefault("preserve_underscore_prefixes_override", ["score_"])
        elif normalize_tag_underscores is True and "underscore_to_space_override" not in opts:
            opts["underscore_to_space_override"] = True
            opts.setdefault("preserve_underscore_prefixes_override", ["score_"])
        return build_export_caption(image, tags, **opts)
    if mode == "json":
        payload = {
            "id": image.get("id"),
            "filename": image.get("filename") or "",
            "generator": image.get("generator"),
            "prompt": prompt,
            "negative_prompt": negative_prompt,
            "ai_caption": caption,
            "tags": filtered_tags,
            "checkpoint": image.get("checkpoint"),
            "width": image.get("width"),
            "height": image.get("height"),
            "generation_params": extract_generation_params(image),
        }
        return json.dumps(payload, ensure_ascii=False, sort_keys=True)

    return ", ".join(filtered_tags)


def _sidecar_extension(content_mode: str) -> str:
    return ".json" if str(content_mode or "").lower() == "json" else ".txt"


def _sanitized_fallback_stem(image: Dict[str, Any]) -> str:
    """Last-resort sidecar stem when the image has no on-disk path.

    Used only for orphaned DB rows (missing-file records, broken paths).
    The normal export path uses the actual on-disk filename so the
    sidecar can pair with the image by exact basename match.
    """
    raw = str(image.get("filename") or f"image_{image.get('id') or 'unknown'}")
    sanitized = sanitize_filename(raw)
    return os.path.splitext(sanitized)[0] or "unnamed"


@dataclass(frozen=True)
class _SidecarAllocation:
    """Outcome of resolving one image's caption sidecar destination.

    ``outcome`` is one of:
      - ``"write"``  — write the caption to ``path``.
      - ``"skip"``   — write nothing; count toward ``skipped`` (an existing
                       sidecar is intentionally left in place).
      - ``"error"``  — write nothing; count toward ``error_count`` and surface
                       ``message`` (a name clash that renaming would only paper
                       over by breaking image/caption pairing).
    """

    outcome: str
    path: Optional[str] = None      # set iff outcome == "write"
    message: Optional[str] = None   # set iff outcome == "error"


def _unique_collision_message(sidecar_name: str, taken_by: str) -> str:
    """Per-image error text for a ``unique``-policy sidecar name clash."""
    return (
        f"Sidecar name '{sidecar_name}' already taken (by {taken_by}); "
        "rename the image, or use overwrite/skip."
    )


def _allocate_output_path(
    output_folder: str,
    image: Dict[str, Any],
    content_mode: str,
    overwrite_policy: str,
    used_output_paths: Dict[str, str],
    output_mode: str = "folder",
) -> _SidecarAllocation:
    """Resolve where (or whether) one image's caption sidecar is written.

    The sidecar stem is pinned to the image's on-disk stem so the caption pairs
    with the image by exact basename — the invariant LoRA trainers rely on.
    Returns a :class:`_SidecarAllocation`:

    - ``write`` + ``path``: write the caption there.
    - ``skip``: write nothing, keeping an existing sidecar — ``skip`` policy
      with the name already present, or ``unique`` policy in ``beside_image``
      mode where a caption already sits next to the image ("already exported").
    - ``error`` + ``message``: a ``unique``-policy name clash that must not be
      worked around. Renaming to ``{stem}_1{ext}`` would produce a caption that
      pairs with no image, so the clash is reported instead. Raised when the
      name is already claimed by an earlier image in this run (folder mode: two
      sources share a stem), or by a pre-existing file in ``folder`` mode.

    ``overwrite`` and ``skip`` policies keep their prior behavior; only
    ``unique`` collisions changed (they used to rename to ``{stem}_N``).
    ``used_output_paths`` maps each already-allocated sidecar path to the source
    image path that claimed it, so an in-run clash can name the first owner.
    """
    extension = _sidecar_extension(content_mode)
    # v3.2.2: derive the sidecar stem from the actual on-disk image
    # filename rather than ``sanitize_filename(image["filename"])``.
    #
    # The DB-stored ``filename`` field gets routed through
    # ``sanitize_filename`` here, which replaces apostrophes, parentheses,
    # commas, brackets, and other "non-word" characters with underscores
    # ("my (test).png" -> "my _test_.png"). For LoRA training that pairs
    # captions with images by exact basename match, this is fatal: the
    # caption file ends up named ``my _test_.txt`` while the image keeps
    # its original "my (test).png", and the trainer skips both.
    #
    # The image already exists on disk, so its filename is by definition
    # OS-legal; we don't need to sanitize. The ``beside_image`` branch
    # already does this via ``_sidecar_stem_override``; this aligns the
    # ``folder`` branch with that pattern. ``sanitize_filename`` remains
    # the fallback when the DB has no on-disk path (orphaned records,
    # missing-file rows, etc).
    stem_override = image.pop("_sidecar_stem_override", None)
    if stem_override:
        basename = stem_override
    else:
        on_disk_path = str(image.get("path") or "").strip()
        if on_disk_path:
            on_disk_basename = os.path.basename(on_disk_path)
            on_disk_stem = os.path.splitext(on_disk_basename)[0]
            basename = on_disk_stem if on_disk_stem else _sanitized_fallback_stem(image)
        else:
            basename = _sanitized_fallback_stem(image)
    if not basename:
        basename = f"image_{image.get('id') or 'unknown'}"

    sidecar_name = f"{basename}{extension}"
    primary_path = os.path.join(output_folder, sidecar_name)

    if overwrite_policy == "overwrite":
        # Overwrite replaces any pre-existing sidecar on disk. The one clash we
        # still resolve is two images in the SAME run mapping onto one name —
        # the second write would clobber the first image's caption, so both get
        # kept via a numeric suffix. (This path never fires in the default
        # ``unique`` policy below.)
        if primary_path not in used_output_paths:
            return _SidecarAllocation("write", path=primary_path)
        counter = 1
        while counter <= 10000:
            candidate = os.path.join(output_folder, f"{basename}_{counter}{extension}")
            if candidate not in used_output_paths and not os.path.exists(candidate):
                return _SidecarAllocation("write", path=candidate)
            counter += 1
        return _SidecarAllocation("skip")

    if overwrite_policy == "skip":
        # Leave any existing sidecar untouched — one on disk before the run, or
        # one written earlier in it. Only a free name is written.
        if os.path.exists(primary_path) or primary_path in used_output_paths:
            return _SidecarAllocation("skip")
        return _SidecarAllocation("write", path=primary_path)

    # overwrite_policy == "unique": the sidecar stem is pinned to the image
    # stem so image/caption pairing always holds. We therefore never rename a
    # collision to ``{stem}_1{ext}`` — a renamed caption pairs with no image
    # (LoRA trainers match by exact basename), i.e. a silently broken training
    # sample. A taken name is reported so the user can rename the offending
    # image or switch to overwrite/skip.
    if primary_path in used_output_paths:
        # An earlier image THIS run already claimed the name. In folder mode
        # that means two sources share a stem; in beside_image it can only mean
        # two DB rows point at one file. Either way two images want one caption
        # name — a real data-loss risk → error.
        taken_by = used_output_paths[primary_path] or "an earlier image in this export"
        return _SidecarAllocation("error", message=_unique_collision_message(sidecar_name, taken_by))
    if os.path.exists(primary_path):
        # The name is taken by a file already on disk. In beside_image mode a
        # caption already sitting next to the image is the "already exported"
        # case → a benign skip. In folder mode it is a genuine clash to surface.
        if output_mode == "beside_image":
            return _SidecarAllocation("skip")
        return _SidecarAllocation(
            "error", message=_unique_collision_message(sidecar_name, "an existing file on disk")
        )
    return _SidecarAllocation("write", path=primary_path)


def export_tags_batch_request(
    request: Any,
    *,
    id_chunks: Optional[Iterable[List[int]]] = None,
    total: Optional[int] = None,
    progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None,
    cancel_check: Optional[Callable[[], bool]] = None,
) -> Dict[str, Any]:
    """Export selected image metadata to sidecar files.

    ``cancel_check`` (Debt-22 background job support): when supplied, it is
    polled at each chunk boundary. Returning ``True`` stops the export
    cooperatively and returns the partial result gathered so far. The single
    ``used_output_paths`` de-dup set is preserved because this stays one call.
    """
    output_mode = str(getattr(request, "output_mode", "folder") or "folder").strip().lower()
    if output_mode not in VALID_OUTPUT_MODES:
        raise HTTPException(status_code=400, detail=f"Invalid output_mode: {output_mode}")

    # ``output_folder`` is only required for the legacy ``folder`` mode. In
    # ``beside_image`` mode we write each sidecar next to its source image, so
    # the field is ignored. Validating it would force the user to type a fake
    # path just to satisfy the schema.
    if output_mode == "folder":
        output_folder = normalize_user_path(str(request.output_folder or ""))
        is_valid, error = validate_folder_path(output_folder, allow_create=True)
        if not is_valid:
            raise HTTPException(status_code=400, detail=error or "Invalid output folder")
        output_folder_ready = os.path.isdir(output_folder)
    else:
        output_folder = ""
        output_folder_ready = True  # nothing to create up front in beside_image mode

    blacklist = {str(tag or "").strip().lower() for tag in (request.blacklist or []) if str(tag or "").strip()}
    prefix = str(request.prefix or "")
    content_mode = str(getattr(request, "content_mode", "tags") or "tags").strip().lower()
    if content_mode not in VALID_CONTENT_MODES:
        raise HTTPException(status_code=400, detail=f"Invalid content_mode: {content_mode}")
    overwrite_policy = str(getattr(request, "overwrite_policy", "unique") or "unique").strip().lower()
    if overwrite_policy not in VALID_OVERWRITE_POLICIES:
        raise HTTPException(status_code=400, detail=f"Invalid overwrite_policy: {overwrite_policy}")

    # v3.2.1: template_options for content_mode='template'
    template_options = getattr(request, "template_options", None)
    if template_options is not None and not isinstance(template_options, dict):
        # pydantic may pass a model — convert to dict
        if hasattr(template_options, "model_dump"):
            template_options = template_options.model_dump()
        else:
            template_options = None

    # P0-3: diffusion-pipe style split export — write each image's NL caption
    # to a ``{stem}{suffix}.txt`` twin beside the tag sidecar.
    nl_sidecar_enabled = bool(getattr(request, "nl_sidecar", False))
    nl_sidecar_suffix = str(getattr(request, "nl_sidecar_suffix", "_nl") or "_nl")
    if nl_sidecar_enabled and content_mode not in NL_COMPOSE_MODES:
        raise HTTPException(
            status_code=400,
            detail=(
                "nl_sidecar requires a tag-only content mode ('tags' or 'template'); "
                f"'{content_mode}' already carries the NL caption in the main file."
            ),
        )
    nl_sidecar_trigger = ""
    if nl_sidecar_enabled:
        if isinstance(template_options, dict):
            nl_sidecar_trigger = str(template_options.get("trigger") or "").strip()
        if not nl_sidecar_trigger:
            nl_sidecar_trigger = str(getattr(request, "prefix", "") or "").strip()

    # v3.2.1: image_overrides — per-image manually-edited caption that bypasses the engine
    image_overrides_raw = getattr(request, "image_overrides", None) or {}
    image_overrides: Dict[int, str] = {}
    if isinstance(image_overrides_raw, dict):
        for k, v in image_overrides_raw.items():
            try:
                image_overrides[int(k)] = str(v or "")
            except (TypeError, ValueError):
                continue

    # Aurora #25c: per-image caption type + edited NL sentence (caption editor).
    image_types_map = _coerce_int_str_map(getattr(request, "image_types", None))
    nl_overrides_map = _coerce_int_str_map(getattr(request, "image_nl_overrides", None))

    # v3.2.1 follow-up: LoRA-trainer underscore convention. None == follow
    # per-content-mode default. Explicit True / False is the user's
    # checkbox override from the export modal.
    normalize_tag_underscores_request = getattr(request, "normalize_tag_underscores", None)
    caption_transforms = getattr(request, "caption_transforms", None) or {}
    # P2-19 / P2-18 export-engine filters (both default off).
    training_purpose_request = str(getattr(request, "training_purpose", "") or "")
    dedupe_implications_request = bool(getattr(request, "dedupe_implications", False))

    exported = 0
    skipped = 0
    error_count = 0
    nl_sidecars_written = 0
    error_messages: List[str] = []
    # Maps each allocated sidecar path -> the source image path that claimed it,
    # so a unique-policy in-run name clash can point at the first owner.
    used_output_paths: Dict[str, str] = {}
    validator = ExportValidator(
        content_mode=content_mode, template_options=template_options
    )

    if id_chunks is None:
        id_chunks = _iter_id_list_chunks(getattr(request, "image_ids", []) or [], EXPORT_DB_CHUNK_SIZE)
    total_count = int(total if total is not None else len(_normalize_export_image_ids(getattr(request, "image_ids", []) or [])))
    processed = 0

    for image_id_list in id_chunks:
        if cancel_check is not None and cancel_check():
            break
        images_map = db.get_images_by_ids(image_id_list)
        tags_map = db.get_image_tags_map(image_id_list)

        for image_id in image_id_list:
            processed += 1
            if progress_callback:
                progress_callback({"processed": processed, "total": total_count, "current_id": image_id})
            try:
                image = images_map.get(image_id)
                if not image:
                    error_count += 1
                    error_messages.append(f"Image {image_id} not found")
                    continue

                tags = tags_map.get(image_id, [])
                # v3.2.1: if user provided a manual override for this image, use it verbatim
                if image_id in image_overrides:
                    file_content = image_overrides[image_id]
                else:
                    file_content = build_sidecar_content(
                        image,
                        tags,
                        content_mode=content_mode,
                        blacklist=blacklist,
                        prefix=prefix,
                        template_options=template_options,
                        normalize_tag_underscores=normalize_tag_underscores_request,
                        training_purpose=training_purpose_request,
                        dedupe_implications=dedupe_implications_request,
                    )
                # Aurora #25c: fold in the per-image NL sentence BEFORE the
                # transforms, matching dataset_export_service's order
                # (override/render -> compose -> transforms).
                file_content = _compose_nl_for_image(
                    file_content,
                    image,
                    image_id,
                    content_mode=content_mode,
                    image_types=image_types_map,
                    nl_overrides=nl_overrides_map,
                )
                file_content = apply_caption_transforms(file_content, caption_transforms)
                # In ``beside_image`` mode each image lands in its own
                # source directory. We do NOT auto-create directories on
                # this path: if the source folder no longer exists (file
                # was moved/deleted out from under us), fail this row
                # with a clear error rather than silently materialising
                # an empty folder somewhere unexpected.
                if output_mode == "beside_image":
                    image_path = str(image.get("path") or "").strip()
                    if not image_path:
                        error_count += 1
                        error_messages.append(
                            f"Image {image_id} has no source path on record; "
                            "cannot write sidecar beside the image."
                        )
                        continue
                    image_dir = os.path.dirname(image_path)
                    if not image_dir or not os.path.isdir(image_dir):
                        error_count += 1
                        error_messages.append(
                            f"Source folder for image {image_id} not found "
                            f"({image_dir!r}); skipping sidecar."
                        )
                        continue
                    target_folder = image_dir
                    # Use the actual file's stem for the sidecar name so it
                    # always matches the image (critical for LoRA training).
                    actual_stem = os.path.splitext(os.path.basename(image_path))[0]
                    if actual_stem:
                        image["_sidecar_stem_override"] = actual_stem
                else:
                    target_folder = output_folder

                allocation = _allocate_output_path(
                    target_folder, image, content_mode, overwrite_policy,
                    used_output_paths, output_mode=output_mode,
                )
                if allocation.outcome == "skip":
                    skipped += 1
                    continue
                if allocation.outcome == "error":
                    error_count += 1
                    if len(error_messages) < 20:
                        error_messages.append(f"Image {image_id}: {allocation.message}")
                    elif len(error_messages) == 20:
                        error_messages.append("... and more errors (total: showing first 20)")
                    continue
                output_path = str(allocation.path)

                # P0-3: resolve the NL twin BEFORE writing the tag sidecar so a
                # unique-policy clash on the twin fails the row atomically —
                # never a tag file without its NL half.
                nl_twin_path: Optional[str] = None
                nl_twin_content = ""
                if nl_sidecar_enabled:
                    nl_twin_content = _build_nl_sidecar_content(
                        _image_nl_source_text(image, image_id, nl_overrides_map),
                        nl_sidecar_trigger,
                    )
                    if nl_twin_content:
                        stem_no_ext, sidecar_ext = os.path.splitext(output_path)
                        candidate = f"{stem_no_ext}{nl_sidecar_suffix}{sidecar_ext}"
                        twin_taken = candidate in used_output_paths or os.path.exists(candidate)
                        if overwrite_policy == "unique" and twin_taken:
                            error_count += 1
                            if len(error_messages) < 20:
                                error_messages.append(
                                    f"Image {image_id}: NL sidecar name "
                                    f"'{os.path.basename(candidate)}' already taken; "
                                    "rename the image, or use overwrite/skip."
                                )
                            elif len(error_messages) == 20:
                                error_messages.append("... and more errors (total: showing first 20)")
                            continue
                        if overwrite_policy == "skip" and twin_taken:
                            nl_twin_path = None  # leave the existing twin in place
                        else:
                            nl_twin_path = candidate

                if output_mode == "folder" and not output_folder_ready:
                    try:
                        os.makedirs(output_folder, exist_ok=True)
                    except OSError as exc:
                        raise HTTPException(status_code=400, detail=f"Cannot create output folder: {exc}") from exc
                    output_folder_ready = True

                # newline="\n" (P3-14): keep sidecars LF on Windows too —
                # some trainer stacks treat a CRLF caption line as content.
                with open(output_path, "w", encoding="utf-8", newline="\n") as handle:
                    handle.write(file_content)

                used_output_paths[output_path] = str(image.get("path") or image.get("filename") or "")
                exported += 1
                validator.add(
                    output_path=output_path,
                    content=file_content,
                    image_path=str(image.get("path") or ""),
                )

                if nl_twin_path:
                    with open(nl_twin_path, "w", encoding="utf-8", newline="\n") as handle:
                        handle.write(nl_twin_content)
                    used_output_paths[nl_twin_path] = str(image.get("path") or image.get("filename") or "")
                    nl_sidecars_written += 1
                    validator.add(
                        output_path=nl_twin_path,
                        content=nl_twin_content,
                        image_path=str(image.get("path") or ""),
                        pair_suffix=nl_sidecar_suffix,
                    )
            except HTTPException:
                raise
            except Exception as exc:
                error_count += 1
                if len(error_messages) < 20:
                    error_messages.append(f"Error exporting sidecar for image {image_id}: {exc}")
                elif len(error_messages) == 20:
                    error_messages.append("... and more errors (total: showing first 20)")

    return {
        "exported": exported,
        "skipped": skipped,
        "error_count": error_count,
        "error_messages": error_messages,
        "total": total_count,
        "content_mode": content_mode,
        "overwrite_policy": overwrite_policy,
        "output_mode": output_mode,
        # P0-3 split export: how many {stem}_nl.txt twins were written (0 when
        # the option is off or no image had NL text).
        "nl_sidecars_written": nl_sidecars_written,
        # Trainer-consumability report over every written sidecar (P0 batch):
        # pairing, single-line, trigger presence, rating consistency, emptiness.
        "validation": validator.summary(),
    }


def _get_combined_export_dir() -> Path:
    target = Path(__file__).resolve().parent.parent / "data" / "combined-exports"
    target.mkdir(parents=True, exist_ok=True)
    return target


def combined_export_path(token: str) -> Path:
    raw = str(token or "")
    if len(raw) != 32 or any(ch not in "0123456789abcdef" for ch in raw):
        raise HTTPException(status_code=404, detail="Combined export not found")
    path = _get_combined_export_dir() / f"{raw}.txt"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Combined export not found")
    return path


def export_tags_combined_request(
    request: Any,
    *,
    id_chunks: Optional[Iterable[List[int]]] = None,
    total: Optional[int] = None,
) -> Dict[str, Any]:
    """Render selected captions to one server-side file.

    This avoids the old v321 path where the browser expanded a selection token
    into a giant ID list, rendered every caption via preview calls, then built a
    huge JS string/Blob. The browser now receives a download URL.
    """
    blacklist = {str(tag or "").strip().lower() for tag in (getattr(request, "blacklist", None) or []) if str(tag or "").strip()}
    prefix = str(getattr(request, "prefix", "") or "")
    content_mode = str(getattr(request, "content_mode", "tags") or "tags").strip().lower()
    if content_mode not in VALID_CONTENT_MODES:
        raise HTTPException(status_code=400, detail=f"Invalid content_mode: {content_mode}")

    template_options = getattr(request, "template_options", None)
    if template_options is not None and not isinstance(template_options, dict):
        if hasattr(template_options, "model_dump"):
            template_options = template_options.model_dump()
        else:
            template_options = None

    image_overrides_raw = getattr(request, "image_overrides", None) or {}
    image_overrides: Dict[int, str] = {}
    if isinstance(image_overrides_raw, dict):
        for key, value in image_overrides_raw.items():
            try:
                image_overrides[int(key)] = str(value or "")
            except (TypeError, ValueError):
                continue

    # Aurora #25c: per-image caption type + edited NL sentence (caption editor).
    image_types_map = _coerce_int_str_map(getattr(request, "image_types", None))
    nl_overrides_map = _coerce_int_str_map(getattr(request, "image_nl_overrides", None))

    normalize_tag_underscores_request = getattr(request, "normalize_tag_underscores", None)
    caption_transforms = getattr(request, "caption_transforms", None) or {}
    # P2-19 / P2-18 export-engine filters (both default off).
    training_purpose_request = str(getattr(request, "training_purpose", "") or "")
    dedupe_implications_request = bool(getattr(request, "dedupe_implications", False))

    if id_chunks is None:
        id_chunks = _iter_id_list_chunks(getattr(request, "image_ids", []) or [], EXPORT_DB_CHUNK_SIZE)
    total_count = int(total if total is not None else len(_normalize_export_image_ids(getattr(request, "image_ids", []) or [])))

    token = uuid.uuid4().hex
    export_dir = _get_combined_export_dir()
    path = export_dir / f"{token}.txt"
    tmp_path = export_dir / f"{token}.tmp"
    filename = f"sd-image-sorter-combined-{time.strftime('%Y%m%d-%H%M%S')}.{_sidecar_extension(content_mode).lstrip('.')}"

    exported = 0
    error_count = 0
    error_messages: List[str] = []
    first_line = True

    try:
        with tmp_path.open("w", encoding="utf-8", newline="\n") as handle:
            for image_id_list in id_chunks:
                images_map = db.get_images_by_ids(image_id_list)
                tags_map = db.get_image_tags_map(image_id_list)
                for image_id in image_id_list:
                    try:
                        image = images_map.get(image_id)
                        if not image:
                            error_count += 1
                            if len(error_messages) < COMBINED_EXPORT_RECENT_ERROR_LIMIT:
                                error_messages.append(f"Image {image_id} not found")
                            continue
                        if image_id in image_overrides:
                            rendered = image_overrides[image_id]
                        else:
                            rendered = build_sidecar_content(
                                image,
                                tags_map.get(image_id, []) or [],
                                content_mode=content_mode,
                                blacklist=blacklist,
                                prefix=prefix,
                                template_options=template_options,
                                normalize_tag_underscores=normalize_tag_underscores_request,
                                training_purpose=training_purpose_request,
                                dedupe_implications=dedupe_implications_request,
                            )
                        rendered = _compose_nl_for_image(
                            rendered,
                            image,
                            image_id,
                            content_mode=content_mode,
                            image_types=image_types_map,
                            nl_overrides=nl_overrides_map,
                        )
                        rendered = apply_caption_transforms(rendered, caption_transforms)
                        if not rendered:
                            continue
                        if not first_line:
                            handle.write("\n")
                        handle.write(rendered)
                        first_line = False
                        exported += 1
                    except HTTPException:
                        raise
                    except Exception as exc:
                        error_count += 1
                        if len(error_messages) < COMBINED_EXPORT_RECENT_ERROR_LIMIT:
                            error_messages.append(f"Image {image_id}: {exc}")
        tmp_path.replace(path)
    except Exception:
        tmp_path.unlink(missing_ok=True)
        raise

    return {
        "status": "ok" if error_count == 0 else ("partial" if exported else "error"),
        "token": token,
        "download_url": f"/api/tags/export-combined/download/{token}",
        "filename": filename,
        "exported": exported,
        "total": total_count,
        "error_count": error_count,
        "error_messages": error_messages,
        "content_mode": content_mode,
    }


def render_export_preview(request: Any) -> Dict[str, Any]:
    """Render template-engine previews for a small image set without writing sidecars."""
    image_ids = _normalize_export_image_ids(getattr(request, "image_ids", []) or [])
    if len(image_ids) > 500:
        raise HTTPException(status_code=400, detail="Preview limited to 500 images at a time")

    from services.export_template_engine import build_export_caption

    # P1-7 preview unification: any real content mode previews through
    # build_sidecar_content — the exact engine the export writes with — so the
    # preview can never drift from the sidecar. Only the template designer
    # (content_mode absent or "template") goes through build_export_caption.
    content_mode = str(getattr(request, "content_mode", None) or "").strip().lower() or None
    use_native_mode = content_mode is not None and content_mode != "template"
    if use_native_mode and content_mode not in VALID_CONTENT_MODES:
        raise HTTPException(status_code=400, detail=f"Invalid content_mode: {content_mode}")
    caption_transforms = getattr(request, "caption_transforms", None) or {}

    images_map = db.get_images_by_ids(image_ids)
    tags_map = db.get_image_tags_map(image_ids)
    results: List[Dict[str, Any]] = []

    # P2-19 / P2-18: apply the training filters to the rows BEFORE either
    # preview branch so the template path (which calls build_export_caption
    # directly) matches the export engine's output. Row filtering is
    # idempotent, so the native branch below stays in sync too.
    preview_training_purpose = str(getattr(request, "training_purpose", "") or "")
    preview_dedupe = bool(getattr(request, "dedupe_implications", False))
    preview_trigger = str(getattr(request, "trigger", "") or getattr(request, "prefix", "") or "")

    for image_id in image_ids:
        image = images_map.get(image_id)
        if not image:
            results.append({"image_id": image_id, "error": "not_found", "rendered": ""})
            continue

        preview_rows = tags_map.get(image_id, []) or []
        if preview_training_purpose or preview_dedupe:
            from services.tag_training_filters import apply_training_filters
            preview_rows = apply_training_filters(
                preview_rows,
                training_purpose=preview_training_purpose,
                trigger_word=preview_trigger,
                dedupe_implications=preview_dedupe,
            )

        try:
            if use_native_mode:
                rendered = build_sidecar_content(
                    image,
                    preview_rows,
                    content_mode=str(content_mode),
                    blacklist=set(getattr(request, "blacklist", []) or []),
                    prefix=str(getattr(request, "prefix", "") or ""),
                    normalize_tag_underscores=getattr(request, "normalize_tag_underscores", None),
                )
            else:
                rendered = build_export_caption(
                image,
                preview_rows,
                preset_id=getattr(request, "preset_id", "custom"),
                template_override=getattr(request, "template_override", None),
                trigger=getattr(request, "trigger", ""),
                blacklist=getattr(request, "blacklist", []) or [],
                replace_rules=getattr(request, "replace_rules", {}) or {},
                max_tags=int(getattr(request, "max_tags", 0) or 0),
                append=getattr(request, "append", []) or [],
                quality_override=getattr(request, "quality_override", None),
                safety_override=getattr(request, "safety_override", None),
                rating_override=getattr(request, "rating_override", None),
                underscore_to_space_override=getattr(request, "underscore_to_space_override", None),
                preserve_underscore_prefixes_override=getattr(request, "preserve_underscore_prefixes_override", None),
            )
        except Exception as exc:
            results.append({"image_id": image_id, "error": str(exc), "rendered": ""})
            continue

        rendered = apply_caption_transforms(rendered, caption_transforms)

        # SEP-2: any blacklisted term still present in the FINAL rendered
        # text leaked back in through prose (NL caption / template append) —
        # exactly the failure that undoes trait absorption. Surfaced per
        # image so the preview UI can flag it before export.
        from services.tag_training_filters import scan_text_for_blacklisted_terms
        blacklist_leaks = scan_text_for_blacklisted_terms(
            rendered, getattr(request, "blacklist", []) or []
        )

        results.append({
            "image_id": image_id,
            "filename": image.get("filename") or "",
            "thumbnail_path": image.get("path") or "",
            "rendered": rendered,
            # Surface the raw natural-language caption (VLM / Smart Tag output)
            # alongside the template-rendered string. The Dataset Maker editor
            # renders a booru-tags template that omits {nl_caption}, so without
            # this the VLM caption was visible in the gallery (which reads
            # ai_caption directly) but invisible in the caption editor. The
            # frontend uses this to seed the editor after a Smart Tag run.
            "ai_caption": str(image.get("ai_caption") or ""),
            # Pure natural-language caption (point 1/2): lets the editor's NL
            # box show / edit the sentence separately from the booru-tags box.
            "nl_caption": str(image.get("nl_caption") or ""),
            "blacklist_leaks": blacklist_leaks,
            "error": None,
        })

    return {"results": results}
