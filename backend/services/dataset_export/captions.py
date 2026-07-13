"""Caption assembly for the dataset export service.

Functions moved verbatim from services/dataset_export_service.py
(decomposition 2026-07, claude-dsexport-pins-REPORT.md §6). The shared
caption-engine names (NL_COMPOSE_MODES / build_sidecar_content /
compose_caption_with_nl / apply_caption_transforms) are origin-imported from
services.tag_export_service — the same objects the facade re-binds — so both
export engines keep gating NL-composition identically (_NL_COMPOSE_MODES
below stays the SAME set object; a pin asserts that identity). The lazy
in-function import of services.export_template_engine is an origin-module
seam and stays verbatim.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from services.dataset_export._constants import (
    DATASET_LEGACY_TEMPLATE,
    TRAINING_TAG_CONTENT_MODES,
)
from services.tag_export_service import (
    NL_COMPOSE_MODES,
    apply_caption_transforms,
    build_sidecar_content,
    compose_caption_with_nl,
)
from utils.path_validation import normalize_user_path


def _split_keyed_str_map(raw: Optional[Dict[str, Any]]) -> Tuple[Dict[int, str], Dict[str, str]]:
    """Split a ``{str(image_id)|abs_path: value}`` map into (int-keyed, path-keyed).

    Shared by ``image_overrides``, ``image_types`` and ``image_nl_overrides`` —
    all three use the same dual key convention (DB id for gallery items, a
    resolved absolute path for local Dataset Maker items).
    """
    int_map: Dict[int, str] = {}
    path_map: Dict[str, str] = {}
    for k, v in (raw or {}).items():
        text = str(v if v is not None else "")
        try:
            int_map[int(k)] = text
        except (TypeError, ValueError):
            try:
                normalized = str(Path(normalize_user_path(str(k))).resolve())
            except (OSError, ValueError):
                continue
            path_map[normalized] = text
    return int_map, path_map


def _split_image_overrides(request: Any) -> Tuple[Dict[int, str], Dict[str, str]]:
    """Normalise DB-id and local-path caption overrides.

    Keys are either ``str(image_id)`` for gallery-backed records or absolute
    paths for local Dataset Maker records. Empty strings are valid overrides:
    a user can intentionally export a blank sidecar from the review table.
    """
    return _split_keyed_str_map(getattr(request, "image_overrides", None))


# Content modes whose rendered caption is booru-tags / template only — the
# per-image NL compose (point 3) layers the natural-language sentence on top of
# these. NL-aware modes (tags_nl, nl_caption, prompt_nl, caption_*) already emit
# the sentence globally, so compose is skipped for them to avoid doubling it.
# Shared with tag_export_service so both export engines gate identically.
_NL_COMPOSE_MODES = NL_COMPOSE_MODES


def _compose_nl_caption(
    rendered: str,
    record: Dict[str, Any],
    image_id: int,
    src_image_path: str,
    *,
    content_mode: str,
    types_int: Dict[int, str],
    types_path: Dict[str, str],
    nl_overrides_int: Dict[int, str],
    nl_overrides_path: Dict[str, str],
) -> str:
    """Fold the natural-language sentence into a booru caption per the image's
    caption type (point 3: two-box editor / per-image Booru-NL-Both control).

    ``rendered`` is the already-computed booru caption (a verbatim override or a
    fresh template render). Returns it unchanged when the image has no type
    entry (the default 'booru', also the full back-compat path for callers that
    never send ``image_types``) or when the global content mode already
    incorporates the caption. ``image_nl_overrides`` (the user's edited NL box)
    wins over the stored ``nl_caption`` so a freshly-rendered booru caption can
    be paired with an edited sentence without freezing the whole caption.
    """
    caption_type = None
    if image_id and image_id in types_int:
        caption_type = types_int[image_id]
    elif src_image_path and src_image_path in types_path:
        caption_type = types_path[src_image_path]
    caption_type = str(caption_type or "").strip().lower()
    if caption_type not in ("nl", "both"):
        return rendered
    if str(content_mode or "").strip().lower() not in _NL_COMPOSE_MODES:
        return rendered

    nl_text: Optional[str] = None
    if image_id and image_id in nl_overrides_int:
        nl_text = nl_overrides_int[image_id]
    elif src_image_path and src_image_path in nl_overrides_path:
        nl_text = nl_overrides_path[src_image_path]
    if nl_text is None:
        # Fall back to the stored pure NL, then the fused ai_caption for rows
        # tagged before the nl_caption split existed.
        nl_text = str(record.get("nl_caption") or record.get("ai_caption") or "")
    # Join via the shared rule so the two export engines can never drift.
    return compose_caption_with_nl(rendered, caption_type, nl_text)



def _normalise_common_tag(tag: str, *, normalize_tag_underscores: bool) -> str:
    value = str(tag or "").strip()
    if not value or not normalize_tag_underscores:
        return value
    try:
        from services.export_template_engine import normalize_lora_tag

        return normalize_lora_tag(value, ["score_"])
    except Exception:
        return value.replace("_", " ")


def _append_common_tags_for_mode(content: str, request: Any, content_mode: str) -> str:
    mode = str(content_mode or "").strip().lower()
    if mode not in TRAINING_TAG_CONTENT_MODES:
        return content
    common_tags = [
        _normalise_common_tag(tag, normalize_tag_underscores=bool(getattr(request, "normalize_tag_underscores", True)))
        for tag in (getattr(request, "common_tags", None) or [])
        if str(tag or "").strip()
    ]
    if not common_tags:
        return content
    parts = [part.strip() for part in str(content or "").split(",") if part.strip()]
    seen = {" ".join(part.split()).lower() for part in parts}
    for tag in common_tags:
        key = " ".join(tag.split()).lower()
        if key and key not in seen:
            seen.add(key)
            parts.append(tag)
    return ", ".join(parts)


def _build_dataset_template_options(request: Any, blacklist_set: set[str]) -> Dict[str, Any]:
    raw_options = getattr(request, "template_options", None)
    if isinstance(raw_options, dict):
        options = dict(raw_options)
    else:
        options = {
            "preset_id": "custom",
            "template_override": DATASET_LEGACY_TEMPLATE,
            "trigger": str(getattr(request, "trigger", "") or ""),
            "blacklist": list(blacklist_set),
            "replace_rules": {},
            "max_tags": 0,
            "append": [],
        }

    existing_append = options.get("append") or []
    if isinstance(existing_append, str):
        append_values = [part.strip() for part in existing_append.split(",") if part.strip()]
    elif isinstance(existing_append, list):
        append_values = [str(part).strip() for part in existing_append if str(part).strip()]
    else:
        append_values = []
    seen_append = {value.lower() for value in append_values}
    for tag in getattr(request, "common_tags", None) or []:
        value = str(tag or "").strip()
        if value and value.lower() not in seen_append:
            seen_append.add(value.lower())
            append_values.append(value)
    options["append"] = append_values
    options.setdefault("trigger", str(getattr(request, "trigger", "") or ""))
    options.setdefault("blacklist", list(blacklist_set))

    normalize = bool(getattr(request, "normalize_tag_underscores", True))
    options.setdefault("underscore_to_space_override", normalize)
    options.setdefault("preserve_underscore_prefixes_override", ["score_"])
    return options


def _render_dataset_sidecar(
    record: Dict[str, Any],
    tags: Optional[List[Any]],
    request: Any,
    *,
    blacklist_set: set[str],
    image_overrides_int: Dict[int, str],
    image_overrides_path: Dict[str, str],
    image_types_int: Optional[Dict[int, str]] = None,
    image_types_path: Optional[Dict[str, str]] = None,
    nl_overrides_int: Optional[Dict[int, str]] = None,
    nl_overrides_path: Optional[Dict[str, str]] = None,
) -> str:
    image_id = int(record.get("id") or 0)
    src_image_path = str(record.get("path") or "")
    content_mode = str(getattr(request, "content_mode", "template") or "template").strip().lower()
    if image_id and image_id in image_overrides_int:
        rendered = image_overrides_int[image_id]
    elif src_image_path and src_image_path in image_overrides_path:
        rendered = image_overrides_path[src_image_path]
    else:
        template_options = (
            _build_dataset_template_options(request, blacklist_set)
            if content_mode == "template"
            else getattr(request, "template_options", None)
        )
        rendered = build_sidecar_content(
            record,
            tags or [],
            content_mode=content_mode,
            blacklist=blacklist_set,
            prefix=str(getattr(request, "prefix", "") or ""),
            template_options=template_options,
            normalize_tag_underscores=bool(getattr(request, "normalize_tag_underscores", True)),
        )
        rendered = _append_common_tags_for_mode(rendered, request, content_mode)
    # Point 3: fold in the per-image natural-language sentence (no-op unless the
    # image carries an 'nl'/'both' type entry — full back-compat otherwise).
    rendered = _compose_nl_caption(
        rendered,
        record,
        image_id,
        src_image_path,
        content_mode=content_mode,
        types_int=image_types_int or {},
        types_path=image_types_path or {},
        nl_overrides_int=nl_overrides_int or {},
        nl_overrides_path=nl_overrides_path or {},
    )
    return apply_caption_transforms(rendered, getattr(request, "caption_transforms", None) or {})
