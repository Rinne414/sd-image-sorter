"""Pixiv export of a batch (D18).

Each item uses its censored working copy. When one is missing the export is
refused (``block``, the default) unless the request explicitly says ``skip``
or ``original``; the uncensored original is never used silently. Generation
data is stripped by default with the censor save's own helpers
(``_strip_all_metadata`` / ``_prepare_metadata_for_save``).

Every check that can refuse the export runs before the first byte is written:
output folder, name template, missing censored copies, missing originals,
duplicate names and existing files.
"""

from __future__ import annotations

import logging
import os
import shutil
from dataclasses import dataclass
from functools import partial
from pathlib import Path
from typing import Any, Callable

from fastapi import HTTPException
from PIL import Image, ImageOps

import db_batches as batch_db
from services import batch_workdir
from services.batch_models import BatchExportNamesRequest, BatchExportRequest
from services.batch_naming import (
    BatchNameTemplateError,
    render_output_stem,
    safe_stem,
    validate_template,
)
from services.censor.output_io import _image_has_alpha, _normalize_censor_source
from services.indexed_file_mutation_service import save_and_reconcile_checked
from services.publish_service import CAPTION_FILENAME, _validated_output_folder
from services.watermark_service import (
    TextWatermarkConfig,
    WatermarkServiceError,
    apply_text_watermark,
)
from utils.atomic_staging import (
    create_staging_sibling,
    discard_staging_file,
    publish_staging_file,
)
from utils.source_paths import resolve_existing_indexed_image_path

logger = logging.getLogger(__name__)

_FORMAT_BY_SUFFIX = {
    ".png": ("png", ".png"),
    ".jpg": ("jpg", ".jpg"),
    ".jpeg": ("jpg", ".jpeg"),
    ".webp": ("webp", ".webp"),
}
_SUFFIX_BY_FORMAT = {"png": ".png", "jpg": ".jpg", "webp": ".webp"}
_COPY_BLOCK_BYTES = 1024 * 1024


class BatchExportMissingCensoredError(batch_db.BatchError):
    def __init__(self, missing: list[dict[str, Any]]):
        self.missing = missing
        super().__init__(f"{len(missing)} item(s) have no censored copy")


class BatchExportSourcesMissingError(batch_db.BatchError):
    def __init__(self, missing: list[dict[str, Any]]):
        self.missing = missing
        super().__init__(f"{len(missing)} original file(s) are missing on disk")


class BatchExportDuplicateNamesError(batch_db.BatchError):
    def __init__(self, duplicates: list[dict[str, Any]]):
        self.duplicates = duplicates
        super().__init__("Two or more items would be written to the same file name")


class BatchExportFilesExistError(batch_db.BatchError):
    def __init__(self, existing: list[str]):
        self.existing = existing
        super().__init__("Output files already exist; confirm overwrite")


@dataclass
class _PlannedItem:
    image_id: int
    position: int
    filename: str
    output_name_override: str | None
    source: str  # "censored" | "original"
    source_path: str
    output_format: str = "png"
    output_name: str = ""


def _censor_service():
    import services.censor_service as censor_service

    return censor_service


def _output_format(filename: str, requested: str) -> tuple[str, str]:
    if requested != "original":
        return requested, _SUFFIX_BY_FORMAT[requested]
    return _FORMAT_BY_SUFFIX.get(Path(filename).suffix.lower(), ("png", ".png"))


def _original_path(row: dict[str, Any]) -> str | None:
    return resolve_existing_indexed_image_path(
        str(row["path"] or ""), backend_file=_censor_service()._BACKEND_FILE
    )


def _source_kind(has_copy: bool, policy: str) -> str:
    """Where an item's pixels come from: censored, original, skip or missing (block)."""
    if has_copy:
        return "censored"
    if policy == "original":
        return "original"
    return "skip" if policy == "skip" else "missing"


def _planned_item(row: dict[str, Any], source: str, source_path: str) -> _PlannedItem:
    return _PlannedItem(
        image_id=int(row["image_id"]),
        position=int(row["position"]),
        filename=row["filename"],
        output_name_override=row["output_name"],
        source=source,
        source_path=source_path,
    )


def _plan_sources(batch_id: int, rows: list[dict[str, Any]], policy: str):
    """Pick each item's source; returns (planned, skipped) or raises before writing."""
    planned: list[_PlannedItem] = []
    skipped: list[dict[str, Any]] = []
    no_censored: list[dict[str, Any]] = []
    missing_originals: list[dict[str, Any]] = []
    for row in rows:
        ident = {"image_id": int(row["image_id"]), "filename": row["filename"]}
        censored = batch_workdir.existing_censored_path(batch_id, row["censored_path"])
        kind = _source_kind(censored is not None, policy)
        if kind == "skip":
            skipped.append({**ident, "reason": "no_censored_copy"})
            continue
        if kind == "missing":
            no_censored.append(ident)
            continue
        source_path = str(censored) if kind == "censored" else _original_path(row)
        if not source_path:
            missing_originals.append(ident)
            continue
        planned.append(_planned_item(row, kind, source_path))
    if no_censored:
        raise BatchExportMissingCensoredError(no_censored)
    if missing_originals:
        raise BatchExportSourcesMissingError(missing_originals)
    return planned, skipped


def _name_items(
    planned: list[_PlannedItem], batch_name: str, request: BatchExportNamesRequest
) -> list[dict[str, Any]]:
    """Give every planned item its output name; returns the case-insensitive duplicates."""
    by_key: dict[str, list[_PlannedItem]] = {}
    for offset, item in enumerate(planned):
        item.output_format, suffix = _output_format(
            item.filename, request.output_format
        )
        stem = item.output_name_override or render_output_stem(
            request.name_template,
            batch=batch_name,
            number=request.start_number + offset,
            original=Path(item.filename).stem,
        )
        item.output_name = safe_stem(stem) + suffix
        by_key.setdefault(item.output_name.casefold(), []).append(item)
    return [
        {"output_name": group[0].output_name, "image_ids": [i.image_id for i in group]}
        for group in by_key.values()
        if len(group) > 1
    ]


def _assign_names(
    planned: list[_PlannedItem], batch_name: str, request: BatchExportRequest
):
    duplicates = _name_items(planned, batch_name, request)
    if duplicates:
        raise BatchExportDuplicateNamesError(duplicates)


def _check_existing(
    target: Path, planned: list[_PlannedItem], request: BatchExportRequest
):
    if request.overwrite:
        return
    names = [item.output_name for item in planned]
    if request.caption_text.strip():
        names.append(CAPTION_FILENAME)
    existing = [name for name in names if (target / name).exists()]
    if existing:
        raise BatchExportFilesExistError(existing)


def _load_pixels(item: _PlannedItem, keep_orientation_tag: bool) -> Image.Image:
    with Image.open(item.source_path) as source:
        source.load()
        # The censored copy is already upright; an original's EXIF rotation is
        # applied to the pixels unless its EXIF (with the tag) is being kept.
        if item.source == "original" and not keep_orientation_tag:
            upright = ImageOps.exif_transpose(source)
            return _normalize_censor_source(upright if upright is not None else source)
        return _normalize_censor_source(source)


def _watermarked(image: Image.Image, config: TextWatermarkConfig) -> Image.Image:
    marked = apply_text_watermark(image, config)
    return marked if _image_has_alpha(image) else marked.convert("RGB")


def _copy_file_atomically(source_path: str, final_path: str) -> None:
    """Byte-copy through a staging sibling, then publish it over the destination.

    Same staging and publishing as the encode path
    (``output_io._save_pillow_image_atomically``): a copy interrupted while
    overwriting an earlier export leaves that export intact instead of
    truncated, and a hard-linked destination keeps its links.
    """
    target = Path(final_path)
    staging, descriptor = create_staging_sibling(target)
    try:
        handle = os.fdopen(descriptor, "wb")
    except BaseException:
        try:
            os.close(descriptor)
        except OSError:
            pass
        discard_staging_file(staging)
        raise
    try:
        with handle, open(source_path, "rb") as reader:
            shutil.copyfileobj(reader, handle, _COPY_BLOCK_BYTES)
            handle.flush()
            try:
                os.fsync(handle.fileno())
            except OSError:
                pass
        publish_staging_file(staging, target)
    except BaseException:
        discard_staging_file(staging)
        raise


def _carries_metadata(output_format: str, save_kwargs: dict[str, object]) -> bool:
    # _save_image_with_format writes pnginfo only into PNG and exif only into JPEG/WebP.
    if output_format == "png":
        return "pnginfo" in save_kwargs
    return "exif" in save_kwargs


def _writer_for(
    item: _PlannedItem, request: BatchExportRequest, watermark: TextWatermarkConfig
):
    """Return (writer, generation_data_removed) for one planned item."""
    service_module = _censor_service()
    service = service_module.CensorService
    option = request.metadata_option
    same_format = _output_format(item.filename, "original")[0] == item.output_format
    if (
        option == "keep"
        and item.source == "original"
        and same_format
        and not watermark.enabled
    ):

        def copy_bytes(final_path: str, _overwrite: bool) -> list[str]:
            _copy_file_atomically(item.source_path, final_path)
            return []

        return copy_bytes, False

    image = _load_pixels(item, keep_orientation_tag=option == "keep")
    if watermark.enabled:
        image = _watermarked(image, watermark)
    clean = service._strip_all_metadata(image)
    save_kwargs: dict[str, object] = {}
    if option != "strip":
        save_kwargs = service()._prepare_metadata_for_save(
            clean, item.image_id, option, item.output_format
        )

    def encode(final_path: str, _overwrite: bool) -> list[str]:
        return service._save_image_with_format(
            clean, final_path, item.output_format, save_kwargs
        )

    return encode, not _carries_metadata(item.output_format, save_kwargs)


def _export_one(
    item: _PlannedItem,
    target: Path,
    request: BatchExportRequest,
    watermark: TextWatermarkConfig,
) -> dict[str, Any]:
    service_module = _censor_service()
    service = service_module.CensorService
    destination = service._ensure_output_path(str(target), item.output_name)
    writer, generation_data_removed = _writer_for(item, request, watermark)
    result = save_and_reconcile_checked(
        destination,
        writer,
        allow_overwrite=request.overwrite,
        backend_file=service_module._BACKEND_FILE,
        validation_error_factory=service._output_validation_error,
        conflict_error_factory=service._output_conflict_error,
    )
    return {
        "image_id": item.image_id,
        "position": item.position,
        "filename": item.filename,
        "output_name": item.output_name,
        "output_path": destination,
        "source": item.source,
        "used_censored": item.source == "censored",
        "metadata_option": request.metadata_option,
        "generation_data_removed": generation_data_removed,
        "watermarked": watermark.enabled,
        "overwrote_existing": result.target_existed,
        "reconciled_image_id": result.reconciled_image_id,
        "warnings": list(dict.fromkeys([*result.writer_result, *result.warnings])),
    }


def _write_caption(target: Path, caption_text: str) -> str | None:
    caption = caption_text.strip()
    if not caption:
        return None
    # newline="\n": text mode would otherwise write \r\n on Windows.
    (target / CAPTION_FILENAME).write_text(
        caption + "\n", encoding="utf-8", newline="\n"
    )
    return CAPTION_FILENAME


def _prepare(batch_id: int, request: BatchExportRequest):
    batch_row, rows = batch_db.read_batch(batch_id)
    target = _validated_output_folder(request.output_folder)
    _censor_service().CensorService._ensure_safe_output_directory(str(target))
    validate_template(request.name_template)
    planned, skipped = _plan_sources(batch_id, rows, request.missing_censored)
    _assign_names(planned, str(batch_row["name"]), request)
    _check_existing(target, planned, request)
    return target, planned, skipped


def _guarded(
    action: Callable[[], Any], errors: list[dict[str, Any]], ident: dict[str, Any]
):
    try:
        return action()
    except HTTPException as exc:
        errors.append({**ident, "error": str(exc.detail)})
    except (OSError, ValueError, WatermarkServiceError) as exc:
        logger.warning("Batch export failed for %s: %s", ident, exc)
        errors.append({**ident, "error": str(exc)})
    return None


def _preview_row(
    row: dict[str, Any], has_copy: bool, item: _PlannedItem | None, number: int | None
) -> dict[str, Any]:
    return {
        "image_id": int(row["image_id"]),
        "position": int(row["position"]),
        "filename": row["filename"],
        "has_censored": has_copy,
        "included": item is not None,
        "source": item.source if item is not None else None,
        "number": number,
        "overridden": bool(row["output_name"]),
        "output_name": (item.output_name or None) if item is not None else None,
    }


def preview_names(batch_id: int, request: BatchExportNamesRequest) -> dict[str, Any]:
    """The file names an export with these options would write; nothing is written.

    Uses the export's own source choice and naming, so the two cannot disagree.
    With ``block`` every item is named (as if its missing copy were resolved;
    its ``source`` is ``missing``); ``skip`` leaves items out exactly like the
    export. A broken template and duplicate names come back as data.
    """
    batch_row, rows = batch_db.read_batch(batch_id)
    entries: list[tuple[dict[str, Any], bool, _PlannedItem | None]] = []
    planned: list[_PlannedItem] = []
    for row in rows:
        censored = batch_workdir.existing_censored_path(batch_id, row["censored_path"])
        has_copy = censored is not None
        kind = _source_kind(has_copy, request.missing_censored)
        item = None if kind == "skip" else _planned_item(row, kind, "")
        if item is not None:
            planned.append(item)
        entries.append((row, has_copy, item))
    duplicates: list[dict[str, Any]] = []
    template_error = None
    try:
        validate_template(request.name_template)
        duplicates = _name_items(planned, str(batch_row["name"]), request)
    except BatchNameTemplateError as error:
        template_error = {"token": error.token, "message": str(error)}
        for item in planned:
            item.output_name = ""
    numbers = {id(item): request.start_number + i for i, item in enumerate(planned)}
    return {
        "items": [
            _preview_row(row, has_copy, item, numbers.get(id(item)))
            for row, has_copy, item in entries
        ],
        "duplicates": duplicates,
        "template_error": template_error,
    }


def export_batch(batch_id: int, request: BatchExportRequest) -> dict[str, Any]:
    target, planned, skipped = _prepare(batch_id, request)
    watermark = TextWatermarkConfig(**request.watermark.model_dump())
    os.makedirs(target, exist_ok=True)
    exported: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    for item in planned:
        ident = {"image_id": item.image_id, "filename": item.filename}
        done = _guarded(
            partial(_export_one, item, target, request, watermark), errors, ident
        )
        if done is not None:
            exported.append(done)
    caption_file = _guarded(
        partial(_write_caption, target, request.caption_text),
        errors,
        {"image_id": None, "filename": CAPTION_FILENAME},
    )
    return {
        "success": not errors,
        "batch_id": batch_id,
        "output_folder": str(target),
        "exported": exported,
        "skipped": skipped,
        "errors": errors,
        "caption_file": caption_file,
    }
