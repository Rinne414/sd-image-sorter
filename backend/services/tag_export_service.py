"""
Shared export helpers for prompt/tag/caption sidecar files.
"""
from __future__ import annotations

import json
import os
from typing import Any, Dict, List, Optional

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
}
VALID_OVERWRITE_POLICIES = {"unique", "overwrite", "skip"}


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


def build_sidecar_content(
    image: Dict[str, Any],
    tags: List[Dict[str, Any]],
    *,
    content_mode: str = "tags",
    blacklist: Optional[set[str]] = None,
    prefix: str = "",
) -> str:
    """Build export content for one image according to a Pro SD workflow mode."""
    mode = str(content_mode or "tags").strip().lower()
    if mode not in VALID_CONTENT_MODES:
        raise HTTPException(status_code=400, detail=f"Invalid content_mode: {content_mode}")

    blacklist = blacklist or set()
    filtered_tags = _filter_tags(tags, blacklist)
    prompt = str(image.get("prompt") or "").strip()
    negative_prompt = str(image.get("negative_prompt") or "").strip()
    caption = str(image.get("ai_caption") or "").strip()
    prefix = str(prefix or "").strip()

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
        return _join_caption_parts([prefix, caption, *filtered_tags])
    if mode == "caption_merged":
        return _join_caption_parts([prefix, caption, prompt, *filtered_tags])
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


def _allocate_output_path(
    output_folder: str,
    image: Dict[str, Any],
    content_mode: str,
    overwrite_policy: str,
    used_output_paths: set[str],
) -> Optional[str]:
    extension = _sidecar_extension(content_mode)
    filename = sanitize_filename(str(image.get("filename") or f"image_{image.get('id') or 'unknown'}"))
    basename = os.path.splitext(filename)[0]
    if not basename:
        basename = f"image_{image.get('id') or 'unknown'}"
    candidate_names = [f"{basename}{extension}", f"{filename}{extension}"]

    for candidate_name in candidate_names:
        candidate_path = os.path.join(output_folder, candidate_name)
        if overwrite_policy == "overwrite":
            if candidate_path not in used_output_paths:
                return candidate_path
        elif overwrite_policy == "skip":
            if os.path.exists(candidate_path):
                return None
            if candidate_path not in used_output_paths:
                return candidate_path
        elif candidate_path not in used_output_paths and not os.path.exists(candidate_path):
            return candidate_path

    if overwrite_policy == "skip":
        return None

    stem = filename
    counter = 1
    while counter <= 10000:
        candidate_path = os.path.join(output_folder, f"{stem}_{counter}{extension}")
        if candidate_path not in used_output_paths and not os.path.exists(candidate_path):
            return candidate_path
        counter += 1

    return None


def export_tags_batch_request(request: Any) -> Dict[str, Any]:
    """Export selected image metadata to sidecar files."""
    output_folder = normalize_user_path(str(request.output_folder or ""))
    is_valid, error = validate_folder_path(output_folder, allow_create=True)
    if not is_valid:
        raise HTTPException(status_code=400, detail=error or "Invalid output folder")

    blacklist = {str(tag or "").strip().lower() for tag in (request.blacklist or []) if str(tag or "").strip()}
    prefix = str(request.prefix or "")
    content_mode = str(getattr(request, "content_mode", "tags") or "tags").strip().lower()
    if content_mode not in VALID_CONTENT_MODES:
        raise HTTPException(status_code=400, detail=f"Invalid content_mode: {content_mode}")
    overwrite_policy = str(getattr(request, "overwrite_policy", "unique") or "unique").strip().lower()
    if overwrite_policy not in VALID_OVERWRITE_POLICIES:
        raise HTTPException(status_code=400, detail=f"Invalid overwrite_policy: {overwrite_policy}")

    exported = 0
    skipped = 0
    error_count = 0
    error_messages: List[str] = []
    used_output_paths = set()
    output_folder_ready = os.path.isdir(output_folder)

    # Pre-batch DB reads to avoid N+1 — with the 5M ceiling, a per-id
    # round-trip in this loop would block the request for many minutes
    # before the first sidecar is written. `get_images_by_ids` and
    # `get_image_tags_map` already chunk IN(...) at 500 ids internally.
    image_id_list = list(request.image_ids)
    images_map = db.get_images_by_ids(image_id_list)
    tags_map = db.get_image_tags_map(image_id_list)

    for image_id in image_id_list:
        try:
            image = images_map.get(image_id)
            if not image:
                error_count += 1
                error_messages.append(f"Image {image_id} not found")
                continue

            tags = tags_map.get(image_id, [])
            file_content = build_sidecar_content(
                image,
                tags,
                content_mode=content_mode,
                blacklist=blacklist,
                prefix=prefix,
            )
            output_path = _allocate_output_path(output_folder, image, content_mode, overwrite_policy, used_output_paths)
            if output_path is None:
                skipped += 1
                continue

            if not output_folder_ready:
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
            error_messages.append(f"Error exporting sidecar for image {image_id}: {exc}")

    return {
        "exported": exported,
        "skipped": skipped,
        "error_count": error_count,
        "error_messages": error_messages,
        "total": len(request.image_ids),
        "content_mode": content_mode,
        "overwrite_policy": overwrite_policy,
    }
