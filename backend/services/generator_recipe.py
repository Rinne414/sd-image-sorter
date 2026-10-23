"""Send a picture back to its generator: read its recipe, save or queue it.

The index keeps only the parsed summary (metadata_storage.py); the ComfyUI
``prompt``/``workflow`` chunks and WebUI's ``parameters`` text are read from
the file, falling back to the raw envelope kept for pictures whose prompt did
not parse (``raw_metadata_gz``) when the file is gone.
"""

from __future__ import annotations

import gzip
import json
import logging
import os
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

import config
from database import get_db
from services import generator_formats as formats
from services.comfyui_client import ComfyUIError, configured_comfyui_url, queue_prompt
from services.output_registry import remember_saved_output
from utils.unique_names import numbered_filename

logger = logging.getLogger(__name__)

_WEBUI_FAMILY = ("webui", "forge", "reforge", "a1111", "sdnext", "fooocus")
_MAX_NAME_ATTEMPTS = 10_000


class RecipeNotFound(LookupError):
    """No picture with this id."""


def _image_row(image_id: int) -> Dict[str, Any]:
    with get_db() as conn:
        row = conn.execute(
            "SELECT id, path, filename, generator, prompt, negative_prompt, checkpoint, "
            "width, height, metadata_json, raw_metadata_gz FROM images WHERE id = ?",
            (image_id,),
        ).fetchone()
    if row is None:
        raise RecipeNotFound(image_id)
    return dict(row)


def _parsed_summary(row: Dict[str, Any]) -> Dict[str, Any]:
    try:
        metadata = json.loads(row.get("metadata_json") or "{}")
    except (TypeError, ValueError):
        return {}
    parsed = metadata.get("_parsed") if isinstance(metadata, dict) else None
    return parsed if isinstance(parsed, dict) else {}


def _chunks_from_file(path: str) -> Optional[Dict[str, Any]]:
    from metadata_parser import get_parser

    from config import is_video_path

    if is_video_path(path):
        from services.video_probe import recipe_chunks

        return recipe_chunks(path) or None
    parser = get_parser()
    try:
        loaded = parser._load_image_metadata(path)
    except Exception as exc:  # unreadable file: fall back to the stored copy
        logger.debug("recipe: cannot read %s: %s", path, exc)
        return None
    chunks = loaded.get("metadata") if isinstance(loaded, dict) else None
    if not isinstance(chunks, dict):
        return None
    return parser._promote_carrier_payloads(chunks)


def _chunks_from_store(raw_gz: Any) -> Optional[Dict[str, Any]]:
    if not raw_gz:
        return None
    try:
        envelope = json.loads(gzip.decompress(bytes(raw_gz)).decode("utf-8"))
    except Exception as exc:
        logger.debug("recipe: stored raw metadata unusable: %s", exc)
        return None
    return envelope if isinstance(envelope, dict) and envelope else None


def load_raw_chunks(row: Dict[str, Any]) -> Tuple[Dict[str, Any], Optional[str]]:
    """The picture's metadata chunks and where they came from (file / stored / None)."""
    path = str(row.get("path") or "")
    if path and os.path.isfile(path):
        chunks = _chunks_from_file(path)
        if chunks:
            return chunks, "file"
    stored = _chunks_from_store(row.get("raw_metadata_gz"))
    if stored:
        return stored, "stored"
    return {}, None


def _source_format(generator: str) -> str:
    if "nai" in generator or "novel" in generator:
        return "nai"
    return "sd"


def _webui_text(
    row: Dict[str, Any], settings_line: str, chunks: Dict[str, Any]
) -> Tuple[str, bool]:
    """WebUI text, and whether it is the picture's own ``parameters`` text."""
    generator = str(row.get("generator") or "").lower()
    original = chunks.get("parameters")
    if (
        isinstance(original, str)
        and original.strip()
        and any(name in generator for name in _WEBUI_FAMILY)
    ):
        return original.strip(), True
    return formats.build_webui_text(
        row.get("prompt"), row.get("negative_prompt"), settings_line
    ), False


def _comfy_part(chunks: Dict[str, Any]) -> Dict[str, Any]:
    api_prompt = formats.comfy_api_prompt(chunks)
    workflow = formats.comfy_workflow(chunks)
    return {
        "has_api_prompt": api_prompt is not None,
        "has_workflow": workflow is not None,
        "seed_inputs": formats.count_seed_inputs(api_prompt) if api_prompt else 0,
        "workflow": formats.pasteable_workflow(workflow) if workflow else None,
    }


def build_recipe(image_id: int) -> Dict[str, Any]:
    """Everything the Send to generator menu offers for one picture."""
    row = _image_row(image_id)
    parsed = _parsed_summary(row)
    chunks, chunk_source = load_raw_chunks(row)
    generator = str(row.get("generator") or "").lower()
    source_format = _source_format(generator)
    settings_line = formats.build_webui_settings_line(
        parsed.get("generation_params"),
        checkpoint=row.get("checkpoint"),
        width=row.get("width"),
        height=row.get("height"),
    )
    webui_text, webui_is_original = _webui_text(row, settings_line, chunks)
    character_prompts = (
        parsed.get("character_prompts") if source_format == "nai" else None
    )
    has_prompt = bool(
        str(row.get("prompt") or "").strip()
        or str(row.get("negative_prompt") or "").strip()
    )
    return {
        "image_id": int(row["id"]),
        "generator": generator,
        "source_format": source_format,
        "has_prompt": has_prompt or webui_is_original,
        "webui_text": webui_text if (has_prompt or webui_is_original) else "",
        "webui_is_original": webui_is_original,
        "webui_settings_line": settings_line,
        "nai_text": formats.build_nai_text(
            row.get("prompt"), row.get("negative_prompt"), character_prompts
        )
        if source_format == "nai" and has_prompt
        else "",
        "metadata_source": chunk_source,
        "file_found": chunk_source == "file",
        "comfyui": _comfy_part(chunks),
        "comfyui_url": configured_comfyui_url_or_none(),
        "workflow_file_stem": formats.workflow_file_stem(
            row.get("filename"), int(row["id"])
        ),
    }


def configured_comfyui_url_or_none() -> Optional[str]:
    try:
        return configured_comfyui_url()
    except ValueError:
        return None


def _comfy_sources(image_id: int) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    row = _image_row(image_id)
    chunks, _source = load_raw_chunks(row)
    return row, chunks


def _claim_free_path(folder: Path, stem: str) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    for attempt in range(1, _MAX_NAME_ATTEMPTS + 1):
        candidate = folder / numbered_filename(stem, ".json", attempt)
        try:
            handle = os.open(candidate, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            continue
        os.close(handle)
        return candidate
    raise FileExistsError(f"No free file name is left for {stem}.json in {folder}.")


def save_workflow_file(image_id: int) -> Dict[str, Any]:
    """Write the workflow (UI format, else the API prompt) to output/workflows/."""
    row, chunks = _comfy_sources(image_id)
    workflow = formats.comfy_workflow(chunks)
    api_prompt = formats.comfy_api_prompt(chunks)
    if workflow is None and api_prompt is None:
        return {"saved": False, "reason": "no_comfyui_recipe"}
    kind = "workflow" if workflow is not None else "api_prompt"
    payload = (
        formats.pasteable_workflow(workflow) if workflow is not None else api_prompt
    )
    folder = config.default_output_folder("workflows")
    stem = formats.workflow_file_stem(row.get("filename"), int(row["id"]))
    target = _claim_free_path(folder, stem)
    try:
        target.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    except BaseException:
        target.unlink(missing_ok=True)
        raise
    remember_saved_output(str(target))
    return {"saved": True, "path": str(target), "filename": target.name, "kind": kind}


def queue_in_comfyui(image_id: int, seed_mode: str) -> Dict[str, Any]:
    """Queue the picture's API prompt on ComfyUI, with a new or the same seed."""
    _row, chunks = _comfy_sources(image_id)
    api_prompt = formats.comfy_api_prompt(chunks)
    if api_prompt is None:
        raise ComfyUIError(
            code="no_comfyui_recipe",
            message="This picture has no ComfyUI recipe to run. Its prompt can still be copied.",
            status_code=422,
        )
    try:
        base_url = configured_comfyui_url()
    except ValueError as exc:
        raise ComfyUIError(
            code="bad_address", message=str(exc), status_code=400
        ) from exc
    changed = 0
    if seed_mode == "new":
        api_prompt, changed = formats.randomize_seeds(api_prompt)
    workflow = formats.comfy_workflow(chunks)
    result = queue_prompt(base_url, api_prompt, workflow)
    return {
        **result,
        "comfyui_url": base_url,
        "seed_mode": seed_mode,
        "seeds_changed": changed,
    }
