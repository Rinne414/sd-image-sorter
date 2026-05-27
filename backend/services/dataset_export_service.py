"""Dataset export service.

Implements the user-flow that issue #5 point 6 was asking for:
"copy/move images and write matching .txt sidecars to one folder, all
renamed consistently". Previously the only way to get a LoRA training
dataset out was a two-step dance — Auto-Separate to move images,
then export-batch with beside_image to write captions next to them —
and the renaming feature didn't exist at all.

This service handles the whole thing in one transaction:

  1. Validate output folder (creates if missing, blocks traversal).
  2. Plan the renames via ``dataset_naming.plan_renames``.
  3. For each non-skipped row:
       a. Copy or move the image to its renamed destination.
       b. Render the caption via the same export-template engine the
          rest of the app uses (so the user's blacklist / common-tags /
          underscore-to-space settings line up with the live preview
          they saw in the Dataset Maker UI).
       c. Write the caption to ``{stem}.txt`` next to the renamed image.
  4. If the image copy fails after the caption is partially written, we
     remove the orphaned caption file so the trainer doesn't see broken
     pairs.

Reuses:
  - ``services.dataset_naming``: deterministic stem + collision logic.
  - ``services.tag_export_service.build_sidecar_content``: same caption
    rendering pipeline as ``/api/tags/export-batch``.
  - ``utils.path_validation.validate_folder_path``: the same checks the
    other write endpoints use.
"""
from __future__ import annotations

import logging
import os
import shutil
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, Iterator, List, Optional, Tuple

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field

import database as db
from config import ALLOWED_IMAGE_EXTENSIONS
from services.dataset_naming import NamingError, render_stem, resolve_collision
from services.dataset_session_service import (
    count_scan_manifest_paths,
    iter_scan_manifest_paths,
    virtual_image_record_for_path,
)
from services.tag_export_service import (
    VALID_OUTPUT_MODES,
    VALID_CONTENT_MODES,
    apply_caption_transforms,
    build_sidecar_content,
)
from utils.path_validation import normalize_user_path, validate_folder_path


logger = logging.getLogger(__name__)


VALID_IMAGE_OPS = {"copy", "move"}
VALID_OVERWRITE_POLICIES = {"unique", "overwrite", "skip"}
TRAINING_TAG_CONTENT_MODES = {"tags", "caption_tags", "caption_merged", "tags_nl"}
DATASET_LEGACY_TEMPLATE = "{trigger}, {tags:filtered}, {append}"
# Kept as a compatibility symbol for older imports/tests. It is no longer a
# processing cap; large exports must flow through scan/selection tokens and
# stream in backend chunks instead of failing validation at an arbitrary count.
DATASET_EXPORT_MAX_ITEMS = None
DATASET_EXPORT_RESPONSE_ITEM_LIMIT = 2_000
DATASET_EXPORT_RECENT_ERROR_LIMIT = 20
DATASET_EXPORT_DB_CHUNK_SIZE = 500
_EXPORT_ACTIVE_STATUSES = {"starting", "running", "cancelling"}

ExportProgressCallback = Callable[[Dict[str, Any]], None]


class DatasetExportRequest(BaseModel):
    """Request schema for ``POST /api/dataset/export``.

    The UI still behaves best for curated LoRA-sized sets, but the API no
    longer imposes an arbitrary image-count cap. Large folder imports should
    use ``dataset_scan_tokens`` so the browser sends only a compact token while
    the backend streams the manifest.

    Two import sources are supported in one request:

    * ``image_ids`` — IDs from the main library DB, resolved via
      ``database.get_images_by_ids`` (legacy + 'send selection' flow).
    * ``image_paths`` — absolute file paths supplied by the Dataset
      Maker session for items the user imported directly from a folder
      (issue #5 point 5: "small gallery" without DB pollution). The
      export pipeline builds virtual records for these paths so the
      same rename + caption + sidecar logic applies.

    At least one of the two must be non-empty.
    """
    image_ids: List[int] = Field(default_factory=list)
    image_paths: List[str] = Field(default_factory=list)
    dataset_scan_tokens: List[Dict[str, Any]] = Field(default_factory=list, max_length=100)
    output_folder: str = Field(default="", max_length=4096)
    output_mode: str = Field(default="folder", max_length=24)

    naming_pattern: str = Field(default="{filename}", min_length=1, max_length=200)
    trigger: str = Field(default="", max_length=100)
    image_op: str = Field(default="copy")
    overwrite_policy: str = Field(default="unique")

    # Caption rendering options — match the export-template engine knobs
    # the Dataset Maker UI exposes.
    content_mode: str = Field(default="template", max_length=32)
    prefix: str = Field(default="", max_length=256)
    template_options: Optional[Dict[str, Any]] = None
    caption_transforms: Optional[Dict[str, Any]] = None
    blacklist: List[str] = Field(default_factory=list, max_length=200)
    common_tags: List[str] = Field(default_factory=list, max_length=200)
    normalize_tag_underscores: bool = True

    # User-edited captions, keyed by either ``str(image_id)`` (for
    # gallery-source items) or absolute path (for local-source items).
    # Empty string means "use whatever the template engine renders".
    image_overrides: Dict[str, str] = Field(default_factory=dict)


class DatasetExportPreviewRequest(BaseModel):
    """Request schema for ``POST /api/dataset/export-preview``.

    This mirrors the export request but does not require an output folder.
    The preview must render captions through the exact same helper as export
    so the text the user edits is the text that lands in sidecars.
    """

    model_config = ConfigDict(extra="ignore")

    image_ids: List[int] = Field(default_factory=list)
    image_paths: List[str] = Field(default_factory=list)
    dataset_scan_tokens: List[Dict[str, Any]] = Field(default_factory=list, max_length=100)
    output_folder: str = Field(default="", max_length=4096)
    output_mode: str = Field(default="folder", max_length=24)

    naming_pattern: str = Field(default="{filename}", min_length=1, max_length=200)
    trigger: str = Field(default="", max_length=100)
    overwrite_policy: str = Field(default="unique")

    content_mode: str = Field(default="template", max_length=32)
    prefix: str = Field(default="", max_length=256)
    template_options: Optional[Dict[str, Any]] = None
    caption_transforms: Optional[Dict[str, Any]] = None
    blacklist: List[str] = Field(default_factory=list, max_length=500)
    common_tags: List[str] = Field(default_factory=list, max_length=500)
    normalize_tag_underscores: bool = True
    image_overrides: Dict[str, str] = Field(default_factory=dict)
    limit: int = Field(default=72, ge=1, le=500)


class DatasetExportItemResult(BaseModel):
    image_id: int
    src_image_path: Optional[str] = None
    dst_image_path: Optional[str] = None
    dst_caption_path: Optional[str] = None
    skipped_reason: Optional[str] = None
    error: Optional[str] = None


class DatasetExportResponse(BaseModel):
    status: str  # "ok" | "partial" | "failed" | "cancelled"
    exported: int
    skipped: int
    error_count: int
    output_folder: str
    output_mode: str = "folder"
    items: List[DatasetExportItemResult]
    total_items: int = 0
    items_truncated: bool = False
    error_messages: List[str]


class DatasetExportStartResponse(BaseModel):
    status: str
    job_id: str
    total: int
    output_folder: str
    message: str


def _requested_item_count(request: DatasetExportRequest) -> int:
    total = len(list(_iter_unique_image_ids(request.image_ids or []))) + len(request.image_paths or [])
    for source in request.dataset_scan_tokens or []:
        token = str((source or {}).get("scan_token") or (source or {}).get("token") or "")
        if not token:
            continue
        exclude_paths = (source or {}).get("exclude_paths") or []
        try:
            total += count_scan_manifest_paths(token, exclude_paths)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    return total


def _iter_chunks(values: Iterable[Any], chunk_size: int) -> Iterator[List[Any]]:
    chunk: List[Any] = []
    for value in values or []:
        chunk.append(value)
        if len(chunk) >= chunk_size:
            yield chunk
            chunk = []
    if chunk:
        yield chunk


def _iter_unique_image_ids(values: Iterable[Any]) -> Iterator[int]:
    seen: set[int] = set()
    for raw in values or []:
        try:
            image_id = int(raw)
        except (TypeError, ValueError):
            continue
        if image_id <= 0 or image_id in seen:
            continue
        seen.add(image_id)
        yield image_id


def _resolve_dataset_image_path(raw_path: Any) -> Optional[str]:
    if not raw_path:
        return None
    try:
        resolved = Path(normalize_user_path(str(raw_path))).resolve()
    except (OSError, ValueError):
        return None
    if not resolved.exists() or not resolved.is_file():
        return None
    if resolved.suffix.lower() not in ALLOWED_IMAGE_EXTENSIONS:
        return None
    return str(resolved)


def _dataset_sidecar_extension(content_mode: str) -> str:
    return ".json" if str(content_mode or "").strip().lower() == "json" else ".txt"


def _iter_requested_scan_paths(request: DatasetExportRequest) -> Iterator[str]:
    for source in request.dataset_scan_tokens or []:
        token = str((source or {}).get("scan_token") or (source or {}).get("token") or "")
        if not token:
            continue
        exclude_paths = {
            str(path)
            for path in ((source or {}).get("exclude_paths") or [])
            if str(path)
        }
        try:
            for path in iter_scan_manifest_paths(token):
                if str(path) not in exclude_paths:
                    yield str(path)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc


def _allocate_sidecar_path(
    target_folder: Path,
    stem: str,
    caption_extension: str,
    *,
    overwrite_policy: str,
    used_paths: set[str],
) -> Tuple[Optional[Path], Optional[str]]:
    base = target_folder / f"{stem}{caption_extension}"
    if overwrite_policy == "overwrite":
        used_paths.add(str(base.resolve()))
        return base, None
    if overwrite_policy == "skip" and (base.exists() or str(base.resolve()) in used_paths):
        return None, "existing"
    candidate = base
    counter = 1
    while candidate.exists() or str(candidate.resolve()) in used_paths:
        candidate = target_folder / f"{stem}_{counter}{caption_extension}"
        counter += 1
        if counter > 9999:
            return None, "too_many_collisions"
    used_paths.add(str(candidate.resolve()))
    return candidate, None


def _plan_single_rename(
    record: Dict[str, Any],
    *,
    output_folder: Path,
    pattern: str,
    trigger: str,
    overwrite_policy: str,
    caption_extension: str,
    index: int,
    used_image_paths: set[str],
) -> Tuple[Optional[Path], Optional[Path], Optional[str]]:
    image_filename = record.get("filename") or os.path.basename(record.get("path") or "")
    ext = os.path.splitext(image_filename)[1] or ".png"
    try:
        stem = render_stem(
            pattern,
            image_filename=image_filename,
            index=index,
            trigger=trigger,
            generator=str(record.get("generator") or ""),
        )
    except NamingError as exc:
        return None, None, f"naming_error: {exc}"

    image_path = resolve_collision(
        output_folder,
        stem,
        ext,
        used_paths=used_image_paths,
        overwrite_policy=overwrite_policy,
    )
    if image_path is None:
        return None, None, "existing" if overwrite_policy == "skip" else "too_many_collisions"
    return image_path, output_folder / f"{image_path.stem}{caption_extension}", None


def _plan_beside_image_sidecar(
    record: Dict[str, Any],
    *,
    caption_extension: str,
    overwrite_policy: str,
    used_caption_paths: set[str],
) -> Tuple[Optional[Path], Optional[str]]:
    src_image_path = str(record.get("path") or "").strip()
    if not src_image_path:
        return None, "missing_source_path"
    src = Path(src_image_path)
    if not src.exists() or not src.is_file():
        return None, "source_missing"
    if not src.parent.is_dir():
        return None, "source_folder_missing"
    return _allocate_sidecar_path(
        src.parent,
        src.stem,
        caption_extension,
        overwrite_policy=overwrite_policy,
        used_paths=used_caption_paths,
    )


def _output_mode(request: Any) -> str:
    return str(getattr(request, "output_mode", "folder") or "folder").strip().lower()


def _validate_export_request(request: DatasetExportRequest) -> Optional[Path]:
    output_mode = _output_mode(request)
    if output_mode not in VALID_OUTPUT_MODES:
        raise HTTPException(status_code=400, detail=f"Invalid output_mode: {output_mode!r}")
    if request.image_op not in VALID_IMAGE_OPS:
        raise HTTPException(status_code=400, detail=f"Invalid image_op: {request.image_op!r}")
    if request.overwrite_policy not in VALID_OVERWRITE_POLICIES:
        raise HTTPException(status_code=400, detail=f"Invalid overwrite_policy: {request.overwrite_policy!r}")
    if str(request.content_mode or "template").strip().lower() not in VALID_CONTENT_MODES:
        raise HTTPException(status_code=400, detail=f"Invalid content_mode: {request.content_mode!r}")
    if not request.image_ids and not request.image_paths and not request.dataset_scan_tokens:
        raise HTTPException(status_code=400, detail="Must supply image_ids, image_paths, or dataset_scan_tokens.")

    if output_mode == "beside_image":
        return None

    output_folder_norm = normalize_user_path(request.output_folder)
    if not output_folder_norm:
        raise HTTPException(status_code=400, detail="Output folder is required for folder export mode.")
    is_valid, error = validate_folder_path(output_folder_norm, allow_create=True)
    if not is_valid:
        raise HTTPException(status_code=400, detail=error or "Invalid output folder")
    output_path = Path(output_folder_norm)
    output_path.mkdir(parents=True, exist_ok=True)
    return output_path


def _split_image_overrides(request: Any) -> Tuple[Dict[int, str], Dict[str, str]]:
    """Normalise DB-id and local-path caption overrides.

    Keys are either ``str(image_id)`` for gallery-backed records or absolute
    paths for local Dataset Maker records. Empty strings are valid overrides:
    a user can intentionally export a blank sidecar from the review table.
    """
    image_overrides_int: Dict[int, str] = {}
    image_overrides_path: Dict[str, str] = {}
    for k, v in (getattr(request, "image_overrides", None) or {}).items():
        text = str(v or "")
        try:
            image_overrides_int[int(k)] = text
        except (TypeError, ValueError):
            try:
                normalized = str(Path(normalize_user_path(str(k))).resolve())
            except (OSError, ValueError):
                continue
            image_overrides_path[normalized] = text
    return image_overrides_int, image_overrides_path


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
) -> str:
    image_id = int(record.get("id") or 0)
    src_image_path = str(record.get("path") or "")
    if image_id and image_id in image_overrides_int:
        rendered = image_overrides_int[image_id]
    elif src_image_path and src_image_path in image_overrides_path:
        rendered = image_overrides_path[src_image_path]
    else:
        content_mode = str(getattr(request, "content_mode", "template") or "template").strip().lower()
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
    return apply_caption_transforms(rendered, getattr(request, "caption_transforms", None) or {})


def export_dataset(
    request: DatasetExportRequest,
    *,
    progress_callback: Optional[ExportProgressCallback] = None,
    cancel_event: Optional[threading.Event] = None,
) -> DatasetExportResponse:
    """Run a full dataset export. Atomic-per-row: a per-image failure
    leaves earlier rows intact and adds an error entry for the failed
    one.

    This is intentionally streaming: scan-token folder exports, explicit path
    exports, and DB-backed image exports are consumed in chunks. The backend no
    longer builds a 100k-1M ``image_records`` list or a full rename plan before
    the first file is written.
    """
    output_mode = _output_mode(request)
    output_path = _validate_export_request(request)
    output_mode = _output_mode(request)
    requested_total = _requested_item_count(request)
    if requested_total <= 0:
        raise HTTPException(status_code=400, detail="Dataset export has no images after exclusions.")
    if progress_callback:
        progress_callback({
            "step": "loading",
            "current": 0,
            "total": requested_total,
            "message": f"Preparing {requested_total} dataset items...",
            "output_folder": str(output_path or ""),
            "output_mode": output_mode,
        })

    if progress_callback:
        progress_callback({
            "step": "exporting",
            "current": 0,
            "total": requested_total,
            "message": "Exporting dataset...",
            "output_folder": str(output_path or ""),
            "output_mode": output_mode,
        })

    # ---- Pre-build common state for caption rendering ----
    blacklist_set = {str(t).strip().lower() for t in request.blacklist if str(t).strip()}

    image_overrides_int, image_overrides_path = _split_image_overrides(request)
    caption_extension = _dataset_sidecar_extension(request.content_mode)

    # ---- Execute the plan ----
    items: List[DatasetExportItemResult] = []
    error_messages: List[str] = []
    exported = 0
    skipped = 0
    error_count = 0
    processed = 0
    total_expected = requested_total
    total_items = 0
    cancelled = False
    export_index = 0
    used_image_paths: set[str] = set()
    used_caption_paths: set[str] = set()
    seen_virtual_paths: set[str] = set()

    def _append_item(item: DatasetExportItemResult) -> None:
        nonlocal total_items
        total_items += 1
        if len(items) < DATASET_EXPORT_RESPONSE_ITEM_LIMIT:
            items.append(item)

    def _add_error(message: str) -> None:
        if len(error_messages) < 50:
            error_messages.append(message)
        elif len(error_messages) == 50:
            error_messages.append("... and more errors (showing first 50)")

    def _emit(message: str, current_item: Optional[str] = None) -> None:
        if not progress_callback:
            return
        progress_callback({
            "step": "exporting",
            "current": processed,
            "total": total_expected,
            "exported": exported,
            "skipped": skipped,
            "errors": error_count,
            "current_item": current_item,
            "recent_errors": error_messages[-DATASET_EXPORT_RECENT_ERROR_LIMIT:],
            "message": message,
            "output_folder": str(output_path or ""),
            "output_mode": output_mode,
            "items_truncated": total_items > DATASET_EXPORT_RESPONSE_ITEM_LIMIT,
        })

    def _record_error(image_id: int, src_image_path: str, message: str, current_item: Optional[str] = None) -> None:
        nonlocal error_count, processed
        error_count += 1
        processed += 1
        _add_error(message)
        _append_item(DatasetExportItemResult(
            image_id=int(image_id or 0),
            src_image_path=src_image_path or None,
            error=message,
        ))
        _emit(f"Failed {current_item or src_image_path or image_id} ({processed}/{total_expected})", current_item)

    def _record_skip(image_id: int, src_image_path: str, reason: str, current_item: Optional[str] = None) -> None:
        nonlocal skipped, processed
        skipped += 1
        processed += 1
        _append_item(DatasetExportItemResult(
            image_id=int(image_id or 0),
            src_image_path=src_image_path or None,
            skipped_reason=reason,
        ))
        _emit(f"Skipped {current_item or src_image_path or image_id} ({processed}/{total_expected})", current_item)

    def _export_record(record: Dict[str, Any], tags: Optional[List[Any]] = None) -> bool:
        nonlocal exported, skipped, error_count, processed, export_index, cancelled
        if cancel_event is not None and cancel_event.is_set():
            cancelled = True
            return False

        export_index += 1
        image_id = int(record.get("id") or 0)
        src_image_path = str(record.get("path") or "")
        filename = os.path.basename(src_image_path) or f"image-{image_id}"
        dst_image_path: Optional[Path] = None
        dst_caption_path: Optional[Path] = None
        skip_reason: Optional[str] = None
        if output_mode == "beside_image":
            dst_caption_path, skip_reason = _plan_beside_image_sidecar(
                record,
                caption_extension=caption_extension,
                overwrite_policy=request.overwrite_policy,
                used_caption_paths=used_caption_paths,
            )
        else:
            if output_path is None:
                _record_error(image_id, src_image_path, "Output folder is required for folder export mode.", filename)
                return True
            dst_image_path, dst_caption_path, skip_reason = _plan_single_rename(
                record,
                output_folder=output_path,
                pattern=request.naming_pattern,
                trigger=request.trigger,
                overwrite_policy=request.overwrite_policy,
                caption_extension=caption_extension,
                index=export_index,
                used_image_paths=used_image_paths,
            )

        if dst_caption_path is None:
            _record_skip(image_id, src_image_path, skip_reason or "skipped", filename)
            return True

        # Render caption
        try:
            caption_text = _render_dataset_sidecar(
                record,
                tags or [],
                request,
                blacklist_set=blacklist_set,
                image_overrides_int=image_overrides_int,
                image_overrides_path=image_overrides_path,
            )
        except Exception as exc:  # pragma: no cover - defensive
            msg = f"caption render failed for image {image_id}: {exc}"
            _record_error(image_id, src_image_path, msg, filename)
            return True

        # Verify source exists
        if not src_image_path or not os.path.exists(src_image_path):
            msg = f"image {image_id} source missing on disk: {src_image_path!r}"
            _record_error(image_id, src_image_path, msg, filename)
            return True

        # Copy / move the image in folder mode only. Beside-image mode is a
        # pure sidecar write and must not duplicate or relocate source images.
        if output_mode == "folder":
            try:
                os.makedirs(dst_image_path.parent, exist_ok=True)
                if request.image_op == "copy":
                    # copy2 preserves mtime so trainers and downstream tools
                    # see the original recency.
                    shutil.copy2(src_image_path, str(dst_image_path))
                else:  # move
                    shutil.move(src_image_path, str(dst_image_path))
                    # Keep the DB in sync so the next time the user opens
                    # the gallery the image isn't shown as "missing on disk".
                    if image_id:
                        try:
                            db.update_image_path(image_id, str(dst_image_path))
                        except Exception:
                            pass
            except Exception as exc:
                msg = f"failed to {request.image_op} image {image_id}: {exc}"
                _record_error(image_id, src_image_path, msg, filename)
                return True

        # Write caption sidecar
        try:
            os.makedirs(dst_caption_path.parent, exist_ok=True)
            with open(dst_caption_path, "w", encoding="utf-8") as handle:
                handle.write(caption_text)
        except Exception as exc:
            msg = f"failed to write caption for image {image_id}: {exc}"
            # Don't remove the image — the user can re-run the export and
            # the existing image acts as the resume marker. But do report
            # the partial state in the per-item entry.
            error_count += 1
            processed += 1
            _add_error(msg)
            _append_item(DatasetExportItemResult(
                image_id=image_id,
                src_image_path=src_image_path,
                dst_image_path=str(dst_image_path) if dst_image_path is not None else None,
                error=msg,
            ))
            _emit(f"Failed to write caption for {filename} ({processed}/{total_expected})", filename)
            return True

        exported += 1
        processed += 1
        _append_item(DatasetExportItemResult(
            image_id=image_id,
            src_image_path=src_image_path,
            dst_image_path=str(dst_image_path) if dst_image_path is not None else None,
            dst_caption_path=str(dst_caption_path),
        ))
        _emit(f"Exported {filename} ({processed}/{total_expected})", filename)
        return True

    def _process_path_source(raw_path: Any) -> bool:
        nonlocal cancelled
        if cancel_event is not None and cancel_event.is_set():
            cancelled = True
            return False
        normalized_path = _resolve_dataset_image_path(raw_path)
        display_path = str(raw_path or "")
        if not normalized_path:
            _record_error(0, display_path, f"path not a readable image: {display_path}", os.path.basename(display_path))
            return True
        if normalized_path in seen_virtual_paths:
            _record_skip(0, normalized_path, "duplicate", os.path.basename(normalized_path))
            return True
        seen_virtual_paths.add(normalized_path)
        record = virtual_image_record_for_path(normalized_path, read_dimensions=False)
        return _export_record(record, [])

    _emit(f"Exporting 0/{total_expected} images...")

    # ---- DB-source records in bounded chunks ----
    for image_id_chunk in _iter_chunks(_iter_unique_image_ids(request.image_ids or []), DATASET_EXPORT_DB_CHUNK_SIZE):
        if cancelled:
            break
        if cancel_event is not None and cancel_event.is_set():
            cancelled = True
            break
        ids = [int(image_id) for image_id in image_id_chunk]
        images_map = db.get_images_by_ids(ids) if ids else {}
        tags_map = db.get_image_tags_map(ids) if ids else {}
        for image_id in ids:
            if cancel_event is not None and cancel_event.is_set():
                cancelled = True
                break
            record = images_map.get(image_id)
            if not record:
                _record_error(image_id, "", f"image {image_id} not found in library", f"id-{image_id}")
                continue
            if not _export_record(dict(record), tags_map.get(image_id, []) or []):
                break

    # ---- Explicit path-source records ----
    if not cancelled:
        for raw_path in request.image_paths or []:
            if not _process_path_source(raw_path):
                break

    # ---- Token-backed folder manifest records ----
    if not cancelled:
        for raw_path in _iter_requested_scan_paths(request):
            if not _process_path_source(raw_path):
                break

    if cancelled:
        status = "cancelled"
        _emit(f"Cancelled at {processed}/{total_expected}. Exported {exported} images.")
    elif error_count == 0:
        status = "ok"
    elif exported == 0:
        status = "failed"
    else:
        status = "partial"

    return DatasetExportResponse(
        status=status,
        exported=exported,
        skipped=skipped,
        error_count=error_count,
        output_folder=str(output_path or ""),
        output_mode=output_mode,
        items=items,
        total_items=total_items,
        items_truncated=total_items > len(items),
        error_messages=error_messages,
    )


def preview_dataset_export(request: DatasetExportPreviewRequest) -> Dict[str, Any]:
    """Render a bounded Dataset Maker export preview without writing files."""
    output_mode = _output_mode(request)
    if output_mode not in VALID_OUTPUT_MODES:
        raise HTTPException(status_code=400, detail=f"Invalid output_mode: {output_mode!r}")
    if request.overwrite_policy not in VALID_OVERWRITE_POLICIES:
        raise HTTPException(status_code=400, detail=f"Invalid overwrite_policy: {request.overwrite_policy!r}")
    content_mode = str(request.content_mode or "template").strip().lower()
    if content_mode not in VALID_CONTENT_MODES:
        raise HTTPException(status_code=400, detail=f"Invalid content_mode: {request.content_mode!r}")
    if not request.image_ids and not request.image_paths and not request.dataset_scan_tokens:
        return {
            "total": 0,
            "returned": 0,
            "items_truncated": False,
            "content_mode": content_mode,
            "output_mode": output_mode,
            "sidecar_extension": _dataset_sidecar_extension(content_mode),
            "items": [],
        }

    total = _requested_item_count(request)  # type: ignore[arg-type]
    try:
        output_path = Path(normalize_user_path(request.output_folder)).resolve() if request.output_folder else Path("__dataset_preview__").resolve()
    except (OSError, ValueError):
        output_path = Path("__dataset_preview__").resolve()

    blacklist_set = {str(t).strip().lower() for t in request.blacklist if str(t).strip()}
    image_overrides_int, image_overrides_path = _split_image_overrides(request)
    caption_extension = _dataset_sidecar_extension(content_mode)
    limit = max(1, min(int(request.limit or 72), 500))
    used_image_paths: set[str] = set()
    used_caption_paths: set[str] = set()
    seen_virtual_paths: set[str] = set()
    items: List[Dict[str, Any]] = []
    export_index = 0

    def _thumbnail_url(record: Dict[str, Any]) -> str:
        image_id = int(record.get("id") or 0)
        if image_id > 0:
            return f"/api/image-thumbnail/{image_id}?size=256"
        path = str(record.get("path") or "")
        if not path:
            return ""
        from urllib.parse import quote

        return f"/api/dataset/local-thumbnail?path={quote(path, safe='')}&size=256"

    def _append_preview(record: Dict[str, Any], tags: Optional[List[Any]] = None, *, error: str = "") -> bool:
        nonlocal export_index
        export_index += 1
        if len(items) >= limit:
            return False

        image_id = int(record.get("id") or 0)
        src_image_path = str(record.get("path") or "")
        if output_mode == "beside_image":
            dst_image_path = None
            dst_caption_path, skip_reason = _plan_beside_image_sidecar(
                record,
                caption_extension=caption_extension,
                overwrite_policy=request.overwrite_policy,
                used_caption_paths=used_caption_paths,
            )
        else:
            dst_image_path, dst_caption_path, skip_reason = _plan_single_rename(
                record,
                output_folder=output_path,
                pattern=request.naming_pattern,
                trigger=request.trigger,
                overwrite_policy=request.overwrite_policy,
                caption_extension=caption_extension,
                index=export_index,
                used_image_paths=used_image_paths,
            )
        rendered = ""
        render_error = error
        if not render_error and dst_caption_path is not None:
            try:
                rendered = _render_dataset_sidecar(
                    record,
                    tags or [],
                    request,
                    blacklist_set=blacklist_set,
                    image_overrides_int=image_overrides_int,
                    image_overrides_path=image_overrides_path,
                )
            except Exception as exc:  # pragma: no cover - defensive preview fallback
                render_error = str(exc)

        items.append({
            "index": export_index,
            "image_id": image_id,
            "abs_path": src_image_path,
            "filename": record.get("filename") or os.path.basename(src_image_path) or f"image-{image_id}",
            "thumbnail_url": _thumbnail_url(record),
            "output_image_name": dst_image_path.name if dst_image_path is not None else "",
            "output_caption_name": dst_caption_path.name if dst_caption_path is not None else "",
            "output_image_path": str(dst_image_path) if dst_image_path is not None and request.output_folder else "",
            "output_caption_path": str(dst_caption_path) if dst_caption_path is not None and (request.output_folder or output_mode == "beside_image") else "",
            "caption": rendered,
            "skipped_reason": skip_reason,
            "error": render_error or None,
        })
        return len(items) < limit

    def _preview_path_source(raw_path: Any) -> bool:
        normalized_path = _resolve_dataset_image_path(raw_path)
        display_path = str(raw_path or "")
        if not normalized_path:
            record = {
                "id": 0,
                "path": display_path,
                "filename": os.path.basename(display_path) or "unreadable",
                "generator": "",
            }
            return _append_preview(record, [], error=f"path not a readable image: {display_path}")
        if normalized_path in seen_virtual_paths:
            record = virtual_image_record_for_path(normalized_path, read_dimensions=False)
            return _append_preview(record, [], error="duplicate path in dataset")
        seen_virtual_paths.add(normalized_path)
        return _append_preview(virtual_image_record_for_path(normalized_path, read_dimensions=False), [])

    for image_id_chunk in _iter_chunks(_iter_unique_image_ids(request.image_ids or []), DATASET_EXPORT_DB_CHUNK_SIZE):
        if len(items) >= limit:
            break
        ids = [int(image_id) for image_id in image_id_chunk]
        images_map = db.get_images_by_ids(ids) if ids else {}
        tags_map = db.get_image_tags_map(ids) if ids else {}
        for image_id in ids:
            if len(items) >= limit:
                break
            record = images_map.get(image_id)
            if not record:
                missing = {
                    "id": image_id,
                    "path": "",
                    "filename": f"image_{image_id}",
                    "generator": "",
                }
                _append_preview(missing, [], error=f"image {image_id} not found in library")
                continue
            _append_preview(dict(record), tags_map.get(image_id, []) or [])

    if len(items) < limit:
        for raw_path in request.image_paths or []:
            if not _preview_path_source(raw_path):
                break

    if len(items) < limit:
        for raw_path in _iter_requested_scan_paths(request):  # type: ignore[arg-type]
            if not _preview_path_source(raw_path):
                break

    return {
        "total": total,
        "returned": len(items),
        "items_truncated": total > len(items),
        "content_mode": content_mode,
        "output_mode": output_mode,
        "sidecar_extension": caption_extension,
        "items": items,
    }


_EXPORT_JOB_LOCK = threading.Lock()
_EXPORT_JOB_RUN_ID = 0
_EXPORT_JOB_THREAD: Optional[threading.Thread] = None
_EXPORT_JOB_CANCEL_EVENT: Optional[threading.Event] = None
_EXPORT_JOB_PROGRESS: Dict[str, Any] = {
    "status": "idle",
    "job_id": None,
    "step": "idle",
    "current": 0,
    "total": 0,
    "exported": 0,
    "skipped": 0,
    "errors": 0,
    "current_item": None,
    "recent_errors": [],
    "output_folder": "",
    "items_truncated": False,
    "result": None,
    "message": "No dataset export is running.",
    "started_at": None,
    "updated_at": time.time(),
}


def _copy_progress(progress: Dict[str, Any]) -> Dict[str, Any]:
    snapshot = dict(progress)
    snapshot["recent_errors"] = list(progress.get("recent_errors") or [])
    result = progress.get("result")
    if isinstance(result, DatasetExportResponse):
        snapshot["result"] = result.model_dump()
    elif result is not None:
        snapshot["result"] = result
    return snapshot


def get_dataset_export_progress(job_id: Optional[str] = None) -> Dict[str, Any]:
    with _EXPORT_JOB_LOCK:
        if job_id and _EXPORT_JOB_PROGRESS.get("job_id") not in {None, job_id}:
            raise HTTPException(status_code=404, detail="Dataset export job not found")
        return _copy_progress(_EXPORT_JOB_PROGRESS)


def cancel_dataset_export(job_id: Optional[str] = None) -> Dict[str, Any]:
    global _EXPORT_JOB_PROGRESS
    with _EXPORT_JOB_LOCK:
        if job_id and _EXPORT_JOB_PROGRESS.get("job_id") != job_id:
            raise HTTPException(status_code=404, detail="Dataset export job not found")

        status = str(_EXPORT_JOB_PROGRESS.get("status") or "idle")
        if status not in _EXPORT_ACTIVE_STATUSES:
            return {
                "status": status,
                "job_id": _EXPORT_JOB_PROGRESS.get("job_id"),
                "message": "No dataset export job is running.",
            }

        if _EXPORT_JOB_CANCEL_EVENT is not None:
            _EXPORT_JOB_CANCEL_EVENT.set()

        current = int(_EXPORT_JOB_PROGRESS.get("current", 0) or 0)
        total = int(_EXPORT_JOB_PROGRESS.get("total", 0) or 0)
        _EXPORT_JOB_PROGRESS = {
            **_EXPORT_JOB_PROGRESS,
            "status": "cancelling",
            "step": "cancelling",
            "message": f"Cancelling dataset export... ({current}/{total})" if total else "Cancelling dataset export...",
            "updated_at": time.time(),
        }
        return {
            "status": "cancelling",
            "job_id": _EXPORT_JOB_PROGRESS.get("job_id"),
            "message": "Dataset export cancellation requested.",
        }


def _set_export_progress_if_current(run_id: int, updates: Dict[str, Any]) -> bool:
    global _EXPORT_JOB_PROGRESS
    with _EXPORT_JOB_LOCK:
        if run_id != _EXPORT_JOB_RUN_ID:
            return False
        recent_errors = updates.get("recent_errors")
        if recent_errors is not None:
            updates = {
                **updates,
                "recent_errors": list(recent_errors)[-DATASET_EXPORT_RECENT_ERROR_LIMIT:],
            }
        _EXPORT_JOB_PROGRESS = {
            **_EXPORT_JOB_PROGRESS,
            **updates,
            "updated_at": time.time(),
        }
        return True


def _clear_export_worker_if_current(run_id: int, cancel_event: threading.Event) -> None:
    global _EXPORT_JOB_CANCEL_EVENT
    with _EXPORT_JOB_LOCK:
        if run_id == _EXPORT_JOB_RUN_ID and _EXPORT_JOB_CANCEL_EVENT is cancel_event:
            _EXPORT_JOB_CANCEL_EVENT = None


def start_dataset_export(request: DatasetExportRequest) -> DatasetExportStartResponse:
    """Start a cancellable dataset export worker and return immediately."""
    global _EXPORT_JOB_RUN_ID, _EXPORT_JOB_THREAD, _EXPORT_JOB_CANCEL_EVENT, _EXPORT_JOB_PROGRESS

    output_mode = _output_mode(request)
    output_path = _validate_export_request(request)
    requested_total = _requested_item_count(request)

    with _EXPORT_JOB_LOCK:
        current_status = str(_EXPORT_JOB_PROGRESS.get("status") or "idle")
        if current_status in _EXPORT_ACTIVE_STATUSES:
            raise HTTPException(status_code=409, detail="Dataset export already in progress")

        _EXPORT_JOB_RUN_ID += 1
        run_id = _EXPORT_JOB_RUN_ID
        job_id = uuid.uuid4().hex
        cancel_event = threading.Event()
        started_at = time.time()
        _EXPORT_JOB_CANCEL_EVENT = cancel_event
        _EXPORT_JOB_PROGRESS = {
            "status": "starting",
            "job_id": job_id,
            "step": "starting",
            "current": 0,
            "total": requested_total,
            "exported": 0,
            "skipped": 0,
            "errors": 0,
            "current_item": None,
            "recent_errors": [],
            "output_folder": str(output_path or ""),
            "output_mode": output_mode,
            "items_truncated": False,
            "result": None,
            "message": f"Starting dataset export for {requested_total} images...",
            "started_at": started_at,
            "updated_at": started_at,
        }

    def publish(updates: Dict[str, Any]) -> None:
        _set_export_progress_if_current(run_id, {
            "status": "cancelling" if cancel_event.is_set() else "running",
            **updates,
        })

    def worker() -> None:
        try:
            publish({
                "step": "running",
                "message": f"Preparing dataset export for {requested_total} images...",
            })
            result = export_dataset(
                request,
                progress_callback=publish,
                cancel_event=cancel_event,
            )
            terminal_status = "cancelled" if result.status == "cancelled" else "done"
            _set_export_progress_if_current(run_id, {
                "status": terminal_status,
                "step": terminal_status,
                "current": result.total_items if result.status != "cancelled" else _EXPORT_JOB_PROGRESS.get("current", 0),
                "total": _EXPORT_JOB_PROGRESS.get("total", result.total_items),
                "exported": result.exported,
                "skipped": result.skipped,
                "errors": result.error_count,
                "current_item": None,
                "recent_errors": result.error_messages[-DATASET_EXPORT_RECENT_ERROR_LIMIT:],
                "items_truncated": result.items_truncated,
                "result": result,
                "output_folder": result.output_folder,
                "message": (
                    f"Cancelled at {_EXPORT_JOB_PROGRESS.get('current', 0)}/{_EXPORT_JOB_PROGRESS.get('total', 0)}. "
                    f"Exported {result.exported} images."
                    if result.status == "cancelled"
                    else f"Dataset export finished: {result.exported} exported, {result.error_count} failed, {result.skipped} skipped."
                ),
            })
        except HTTPException as exc:
            detail = str(exc.detail)
            _set_export_progress_if_current(run_id, {
                "status": "failed",
                "step": "failed",
                "current": _EXPORT_JOB_PROGRESS.get("current", 0),
                "total": _EXPORT_JOB_PROGRESS.get("total", requested_total),
                "errors": max(1, int(_EXPORT_JOB_PROGRESS.get("errors", 0) or 0)),
                "current_item": None,
                "recent_errors": [detail],
                "result": {
                    "status": "failed",
                    "exported": int(_EXPORT_JOB_PROGRESS.get("exported", 0) or 0),
                    "skipped": int(_EXPORT_JOB_PROGRESS.get("skipped", 0) or 0),
                    "error_count": 1,
                    "output_folder": str(output_path or ""),
                    "output_mode": output_mode,
                    "items": [],
                    "total_items": 0,
                    "items_truncated": False,
                    "error_messages": [detail],
                },
                "message": detail,
            })
        except Exception as exc:  # pragma: no cover - defensive worker guard
            logger.exception("Dataset export background job failed")
            detail = f"Dataset export failed: {exc}"
            _set_export_progress_if_current(run_id, {
                "status": "failed",
                "step": "failed",
                "current": _EXPORT_JOB_PROGRESS.get("current", 0),
                "total": _EXPORT_JOB_PROGRESS.get("total", requested_total),
                "errors": max(1, int(_EXPORT_JOB_PROGRESS.get("errors", 0) or 0)),
                "current_item": None,
                "recent_errors": [detail],
                "result": {
                    "status": "failed",
                    "exported": int(_EXPORT_JOB_PROGRESS.get("exported", 0) or 0),
                    "skipped": int(_EXPORT_JOB_PROGRESS.get("skipped", 0) or 0),
                    "error_count": 1,
                    "output_folder": str(output_path or ""),
                    "output_mode": output_mode,
                    "items": [],
                    "total_items": 0,
                    "items_truncated": False,
                    "error_messages": [detail],
                },
                "message": detail,
            })
        finally:
            _clear_export_worker_if_current(run_id, cancel_event)

    thread = threading.Thread(target=worker, name=f"dataset-export-{job_id[:8]}", daemon=True)
    with _EXPORT_JOB_LOCK:
        if run_id == _EXPORT_JOB_RUN_ID:
            _EXPORT_JOB_THREAD = thread
    thread.start()

    return DatasetExportStartResponse(
        status="started",
        job_id=job_id,
        total=requested_total,
        output_folder=str(output_path or ""),
        message=f"Dataset export started for {requested_total} images.",
    )
