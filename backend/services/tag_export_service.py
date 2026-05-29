"""
Shared export helpers for prompt/tag/caption sidecar files.
"""
from __future__ import annotations

import json
import os
import base64
import binascii
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, Iterator, List, Optional

from fastapi import HTTPException

import database as db
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
SELECTION_TOKEN_VERSION = 2
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
    try:
        padded = selection_token + "=" * (-len(selection_token) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8"))
    except (binascii.Error, json.JSONDecodeError, UnicodeDecodeError, ValueError):
        raise HTTPException(status_code=400, detail="Invalid selection token")

    if not isinstance(payload, dict) or payload.get("v") != SELECTION_TOKEN_VERSION:
        raise HTTPException(status_code=400, detail="Invalid selection token")
    filters = payload.get("filters")
    if not isinstance(filters, dict):
        raise HTTPException(status_code=400, detail="Invalid selection token")
    if (filters.get("sortBy") or "newest") == "random":
        raise HTTPException(status_code=400, detail="random sort cannot use selection-token export")
    return filters


def iter_selection_token_id_chunks(selection_token: str, chunk_size: int = EXPORT_DB_CHUNK_SIZE) -> Iterator[List[int]]:
    filters = _decode_selection_token(selection_token)
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

    blacklist = blacklist or set()
    filtered_tags = _filter_tags(tags, blacklist)
    prompt = str(image.get("prompt") or "").strip()
    negative_prompt = str(image.get("negative_prompt") or "").strip()
    caption = str(image.get("ai_caption") or "").strip()
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
        return _join_caption_parts([prefix, *_filter_text_caption_tokens(caption, blacklist)])
    if mode == "tags_nl":
        # Training-caption mode: local tags first, then natural-language caption; original prompt is excluded.
        return _join_caption_parts([prefix, *filtered_tags, *_filter_text_caption_tokens(caption, blacklist)])
    if mode == "prompt_nl":
        # Original prompt + NL caption (separated by newline for clarity)
        parts = []
        if prefix:
            parts.append(prefix)
        parts.extend(_filter_text_caption_tokens(prompt, blacklist))
        parts.extend(_filter_text_caption_tokens(caption, blacklist))
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


def _allocate_output_path(
    output_folder: str,
    image: Dict[str, Any],
    content_mode: str,
    overwrite_policy: str,
    used_output_paths: set[str],
) -> Optional[str]:
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
    # The sidecar filename is always `{basename}{extension}` (e.g. `image_001.txt`).
    # We deliberately do NOT fall back to `{filename}{extension}`
    # (e.g. `image_001.json.txt`) when the basename is taken — that pattern
    # produces the dual-extension `<orig_ext>.<sidecar_ext>` filenames
    # (`123.json.txt`, `123.gif.txt`) that LoRA training pipelines do not
    # recognize as caption sidecars. Instead we use a numeric suffix
    # (`image_001_1.txt`, `image_001_2.txt`, ...) which every trainer
    # accepts as the same image's caption when paired by basename match.
    primary_path = os.path.join(output_folder, f"{basename}{extension}")
    if overwrite_policy == "overwrite":
        if primary_path not in used_output_paths:
            return primary_path
    elif overwrite_policy == "skip":
        if os.path.exists(primary_path):
            return None
        if primary_path not in used_output_paths:
            return primary_path
    elif primary_path not in used_output_paths and not os.path.exists(primary_path):
        return primary_path

    if overwrite_policy == "skip":
        return None

    counter = 1
    while counter <= 10000:
        candidate_path = os.path.join(output_folder, f"{basename}_{counter}{extension}")
        if candidate_path not in used_output_paths and not os.path.exists(candidate_path):
            return candidate_path
        counter += 1

    return None


def export_tags_batch_request(
    request: Any,
    *,
    id_chunks: Optional[Iterable[List[int]]] = None,
    total: Optional[int] = None,
    progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None,
) -> Dict[str, Any]:
    """Export selected image metadata to sidecar files."""
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

    # v3.2.1: image_overrides — per-image manually-edited caption that bypasses the engine
    image_overrides_raw = getattr(request, "image_overrides", None) or {}
    image_overrides: Dict[int, str] = {}
    if isinstance(image_overrides_raw, dict):
        for k, v in image_overrides_raw.items():
            try:
                image_overrides[int(k)] = str(v or "")
            except (TypeError, ValueError):
                continue

    # v3.2.1 follow-up: LoRA-trainer underscore convention. None == follow
    # per-content-mode default. Explicit True / False is the user's
    # checkbox override from the export modal.
    normalize_tag_underscores_request = getattr(request, "normalize_tag_underscores", None)
    caption_transforms = getattr(request, "caption_transforms", None) or {}

    exported = 0
    skipped = 0
    error_count = 0
    error_messages: List[str] = []
    used_output_paths = set()

    if id_chunks is None:
        id_chunks = _iter_id_list_chunks(getattr(request, "image_ids", []) or [], EXPORT_DB_CHUNK_SIZE)
    total_count = int(total if total is not None else len(_normalize_export_image_ids(getattr(request, "image_ids", []) or [])))
    processed = 0

    for image_id_list in id_chunks:
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

                output_path = _allocate_output_path(target_folder, image, content_mode, overwrite_policy, used_output_paths)
                if output_path is None:
                    skipped += 1
                    continue

                if output_mode == "folder" and not output_folder_ready:
                    try:
                        os.makedirs(output_folder, exist_ok=True)
                    except OSError as exc:
                        raise HTTPException(status_code=400, detail=f"Cannot create output folder: {exc}") from exc
                    output_folder_ready = True

                with open(output_path, "w", encoding="utf-8") as handle:
                    handle.write(file_content)

                used_output_paths.add(output_path)
                exported += 1
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

    normalize_tag_underscores_request = getattr(request, "normalize_tag_underscores", None)
    caption_transforms = getattr(request, "caption_transforms", None) or {}

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

    # Modes that cannot be represented as templates — use build_sidecar_content directly
    content_mode = getattr(request, "content_mode", None)
    use_native_mode = content_mode in ("json", "a1111", "prompt_negative")
    caption_transforms = getattr(request, "caption_transforms", None) or {}

    images_map = db.get_images_by_ids(image_ids)
    tags_map = db.get_image_tags_map(image_ids)
    results: List[Dict[str, Any]] = []

    for image_id in image_ids:
        image = images_map.get(image_id)
        if not image:
            results.append({"image_id": image_id, "error": "not_found", "rendered": ""})
            continue

        try:
            if use_native_mode:
                rendered = build_sidecar_content(
                    image,
                    tags_map.get(image_id, []) or [],
                    content_mode=content_mode,
                    blacklist=set(getattr(request, "blacklist", []) or []),
                )
            else:
                rendered = build_export_caption(
                image,
                tags_map.get(image_id, []) or [],
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

        results.append({
            "image_id": image_id,
            "filename": image.get("filename") or "",
            "thumbnail_path": image.get("path") or "",
            "rendered": rendered,
            "error": None,
        })

    return {"results": results}
