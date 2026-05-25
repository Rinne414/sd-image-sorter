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
from typing import Any, Callable, Dict, List, Optional

from fastapi import HTTPException
from pydantic import BaseModel, Field

import database as db
from services.dataset_naming import plan_renames
from services.dataset_session_service import (
    resolve_paths_for_dataset,
    virtual_image_record_for_path,
)
from services.tag_export_service import build_sidecar_content
from utils.path_validation import normalize_user_path, validate_folder_path


logger = logging.getLogger(__name__)


VALID_IMAGE_OPS = {"copy", "move"}
VALID_OVERWRITE_POLICIES = {"unique", "overwrite", "skip"}
DATASET_EXPORT_MAX_ITEMS = 100_000
DATASET_EXPORT_RESPONSE_ITEM_LIMIT = 2_000
DATASET_EXPORT_RECENT_ERROR_LIMIT = 20
_EXPORT_ACTIVE_STATUSES = {"starting", "running", "cancelling"}

ExportProgressCallback = Callable[[Dict[str, Any]], None]


class DatasetExportRequest(BaseModel):
    """Request schema for ``POST /api/dataset/export``.

    The UI still behaves best for curated LoRA-sized sets, but the API
    accepts up to 100k rows so large dataset exports do not fail validation
    before the backend can process them in bounded chunks.

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
    image_ids: List[int] = Field(default_factory=list, max_length=DATASET_EXPORT_MAX_ITEMS)
    image_paths: List[str] = Field(default_factory=list, max_length=DATASET_EXPORT_MAX_ITEMS)
    output_folder: str = Field(min_length=1, max_length=4096)

    naming_pattern: str = Field(default="{filename}", min_length=1, max_length=200)
    trigger: str = Field(default="", max_length=100)
    image_op: str = Field(default="copy")
    overwrite_policy: str = Field(default="unique")

    # Caption rendering options — match the export-template engine knobs
    # the Dataset Maker UI exposes.
    blacklist: List[str] = Field(default_factory=list, max_length=200)
    common_tags: List[str] = Field(default_factory=list, max_length=200)
    normalize_tag_underscores: bool = True

    # User-edited captions, keyed by either ``str(image_id)`` (for
    # gallery-source items) or absolute path (for local-source items).
    # Empty string means "use whatever the template engine renders".
    image_overrides: Dict[str, str] = Field(default_factory=dict)


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
    return len(request.image_ids or []) + len(request.image_paths or [])


def _validate_export_request(request: DatasetExportRequest) -> Path:
    if request.image_op not in VALID_IMAGE_OPS:
        raise HTTPException(status_code=400, detail=f"Invalid image_op: {request.image_op!r}")
    if request.overwrite_policy not in VALID_OVERWRITE_POLICIES:
        raise HTTPException(status_code=400, detail=f"Invalid overwrite_policy: {request.overwrite_policy!r}")
    if not request.image_ids and not request.image_paths:
        raise HTTPException(status_code=400, detail="Must supply image_ids or image_paths (or both).")
    if _requested_item_count(request) > DATASET_EXPORT_MAX_ITEMS:
        raise HTTPException(
            status_code=400,
            detail=f"Dataset export accepts at most {DATASET_EXPORT_MAX_ITEMS} images per job.",
        )

    output_folder_norm = normalize_user_path(request.output_folder)
    is_valid, error = validate_folder_path(output_folder_norm, allow_create=True)
    if not is_valid:
        raise HTTPException(status_code=400, detail=error or "Invalid output folder")
    output_path = Path(output_folder_norm)
    output_path.mkdir(parents=True, exist_ok=True)
    return output_path


def export_dataset(
    request: DatasetExportRequest,
    *,
    progress_callback: Optional[ExportProgressCallback] = None,
    cancel_event: Optional[threading.Event] = None,
) -> DatasetExportResponse:
    """Run a full dataset export. Atomic-per-row: a per-image failure
    leaves earlier rows intact and adds an error entry for the failed
    one."""
    output_path = _validate_export_request(request)
    requested_total = _requested_item_count(request)
    if progress_callback:
        progress_callback({
            "step": "loading",
            "current": 0,
            "total": requested_total,
            "message": f"Loading {requested_total} dataset items...",
            "output_folder": str(output_path),
        })

    # ---- Load image records + tags for DB-source items ----
    image_ids = list(dict.fromkeys(int(i) for i in request.image_ids))  # de-dup, preserve order
    images_map = db.get_images_by_ids(image_ids) if image_ids else {}
    tags_map = db.get_image_tags_map(image_ids) if image_ids else {}

    image_records: list[Dict[str, Any]] = []
    missing_ids: list[int] = []
    for image_id in image_ids:
        record = images_map.get(image_id)
        if not record:
            missing_ids.append(image_id)
            continue
        image_records.append(dict(record))  # copy so we can mutate safely

    # ---- Build virtual records for path-source items ----
    # These are images the user imported directly from a folder via the
    # Dataset Maker session — they have no DB row, so we synthesise a
    # record shaped like a DB row (path, filename, no tags, no metadata).
    # The naming + caption pipeline then handles them identically.
    invalid_paths: list[str] = []
    resolved_paths = resolve_paths_for_dataset(request.image_paths)
    resolved_path_set = set(resolved_paths)
    for raw_path in request.image_paths:
        try:
            normalized_path = str(Path(normalize_user_path(str(raw_path))).resolve())
        except (OSError, ValueError):
            normalized_path = ""
        if not normalized_path or normalized_path not in resolved_path_set:
            invalid_paths.append(raw_path)
            continue
        record = virtual_image_record_for_path(normalized_path, read_dimensions=False)
        # Tag map for this synthetic record is empty by default; the
        # caller is expected to supply a full caption override via
        # image_overrides[abs_path]. This matches the small-gallery
        # design (local captions live in localStorage, NOT in the DB).
        image_records.append(record)

    if progress_callback:
        progress_callback({
            "step": "planning",
            "current": 0,
            "total": len(image_records) + len(missing_ids) + len(invalid_paths),
            "message": "Planning output filenames...",
            "output_folder": str(output_path),
        })

    # ---- Plan the rename ----
    plan = plan_renames(
        image_records,
        output_folder=output_path,
        pattern=request.naming_pattern,
        trigger=request.trigger,
        overwrite_policy=request.overwrite_policy,
    )

    # ---- Pre-build common state for caption rendering ----
    blacklist_set = {str(t).strip().lower() for t in request.blacklist if str(t).strip()}

    # image_overrides accepts either ``str(image_id)`` keys (legacy DB
    # source) or absolute path keys (small-gallery local source). We
    # normalise both into a single lookup ``record_to_override`` keyed
    # by (image_id, abs_path) so the per-row loop can fetch in O(1).
    image_overrides_int: Dict[int, str] = {}
    image_overrides_path: Dict[str, str] = {}
    for k, v in request.image_overrides.items():
        text = str(v or "")
        try:
            image_overrides_int[int(k)] = text
        except (TypeError, ValueError):
            # Treat as a path key. Normalise to absolute path so it
            # matches whatever resolve_paths_for_dataset produced.
            try:
                normalized = str(Path(normalize_user_path(str(k))).resolve())
            except (OSError, ValueError):
                continue
            image_overrides_path[normalized] = text

    # Use the template engine via the same content_mode the UI sends.
    # We hard-code the LoRA workflow: tags + common-tags appended,
    # honoring the underscore checkbox.
    template_options: Dict[str, Any] = {
        "preset_id": "custom",
        "template_override": "{trigger}, {tags:filtered}, {append}",
        "trigger": str(request.trigger or ""),
        "blacklist": list(blacklist_set),
        "replace_rules": {},
        "max_tags": 0,
        "append": [str(t).strip() for t in request.common_tags if str(t).strip()],
    }
    if request.normalize_tag_underscores:
        template_options["underscore_to_space_override"] = True
        template_options["preserve_underscore_prefixes_override"] = ["score_"]
    else:
        template_options["underscore_to_space_override"] = False
        template_options["preserve_underscore_prefixes_override"] = ["score_"]

    # ---- Execute the plan ----
    items: List[DatasetExportItemResult] = []
    error_messages: List[str] = []
    exported = 0
    skipped = 0
    error_count = 0
    processed = 0
    total_expected = len(plan) + len(missing_ids) + len(invalid_paths)
    total_items = 0
    cancelled = False

    def _append_item(item: DatasetExportItemResult) -> None:
        nonlocal total_items
        total_items += 1
        if len(items) < DATASET_EXPORT_RESPONSE_ITEM_LIMIT:
            items.append(item)

    def _add_error(message: str) -> None:
        error_messages.append(message)

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
            "output_folder": str(output_path),
            "items_truncated": total_items > DATASET_EXPORT_RESPONSE_ITEM_LIMIT,
        })

    _emit(f"Exporting 0/{total_expected} images...")

    for record, dst_image_path, dst_caption_path, skip_reason in plan:
        if cancel_event is not None and cancel_event.is_set():
            cancelled = True
            break

        image_id = int(record.get("id") or 0)
        src_image_path = str(record.get("path") or "")
        filename = os.path.basename(src_image_path) or f"image-{image_id}"

        if dst_image_path is None:
            # Naming engine declined this row (skip policy hit, or
            # too-many collisions, or naming_error)
            skipped += 1
            processed += 1
            _append_item(DatasetExportItemResult(
                image_id=image_id,
                src_image_path=src_image_path,
                skipped_reason=skip_reason,
            ))
            _emit(f"Skipped {filename} ({processed}/{total_expected})", filename)
            continue

        # Render caption
        try:
            tags = tags_map.get(image_id, [])
            # Resolve override: int-key for DB-backed records, path-key
            # for small-gallery synthetic records (image_id=0 sentinel).
            override_text = ""
            if image_id and image_id in image_overrides_int:
                override_text = image_overrides_int[image_id]
            elif src_image_path and src_image_path in image_overrides_path:
                override_text = image_overrides_path[src_image_path]
            if override_text:
                caption_text = override_text
            else:
                caption_text = build_sidecar_content(
                    record,
                    tags,
                    content_mode="template",
                    blacklist=blacklist_set,
                    template_options=template_options,
                    normalize_tag_underscores=request.normalize_tag_underscores,
                )
        except Exception as exc:  # pragma: no cover - defensive
            error_count += 1
            processed += 1
            msg = f"caption render failed for image {image_id}: {exc}"
            _add_error(msg)
            _append_item(DatasetExportItemResult(
                image_id=image_id,
                src_image_path=src_image_path,
                error=msg,
            ))
            _emit(f"Failed caption render for {filename} ({processed}/{total_expected})", filename)
            continue

        # Verify source exists
        if not src_image_path or not os.path.exists(src_image_path):
            error_count += 1
            processed += 1
            msg = f"image {image_id} source missing on disk: {src_image_path!r}"
            _add_error(msg)
            _append_item(DatasetExportItemResult(
                image_id=image_id,
                src_image_path=src_image_path,
                error=msg,
            ))
            _emit(f"Missing source for {filename} ({processed}/{total_expected})", filename)
            continue

        # Copy / move the image
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
                try:
                    db.update_image_path(image_id, str(dst_image_path))
                except Exception:
                    pass
        except Exception as exc:
            error_count += 1
            processed += 1
            msg = f"failed to {request.image_op} image {image_id}: {exc}"
            _add_error(msg)
            _append_item(DatasetExportItemResult(
                image_id=image_id,
                src_image_path=src_image_path,
                error=msg,
            ))
            _emit(f"Failed to {request.image_op} {filename} ({processed}/{total_expected})", filename)
            continue

        # Write caption sidecar
        try:
            with open(dst_caption_path, "w", encoding="utf-8") as handle:
                handle.write(caption_text)
        except Exception as exc:
            error_count += 1
            processed += 1
            msg = f"failed to write caption for image {image_id}: {exc}"
            _add_error(msg)
            # Don't remove the image — the user can re-run the export and
            # the existing image acts as the resume marker. But do report
            # the partial state in the per-item entry.
            _append_item(DatasetExportItemResult(
                image_id=image_id,
                src_image_path=src_image_path,
                dst_image_path=str(dst_image_path),
                error=msg,
            ))
            _emit(f"Failed to write caption for {filename} ({processed}/{total_expected})", filename)
            continue

        exported += 1
        processed += 1
        _append_item(DatasetExportItemResult(
            image_id=image_id,
            src_image_path=src_image_path,
            dst_image_path=str(dst_image_path),
            dst_caption_path=str(dst_caption_path),
        ))
        _emit(f"Exported {filename} ({processed}/{total_expected})", filename)

    # Surface the missing-from-DB rows
    if not cancelled:
        for missing_id in missing_ids:
            if cancel_event is not None and cancel_event.is_set():
                cancelled = True
                break
            error_count += 1
            processed += 1
            msg = f"image {missing_id} not found in library"
            _add_error(msg)
            _append_item(DatasetExportItemResult(image_id=missing_id, error=msg))
            _emit(f"Missing library image {missing_id} ({processed}/{total_expected})", f"id-{missing_id}")

    # Surface the invalid path-source rows so the frontend can show them.
    if not cancelled:
        for invalid_path in invalid_paths:
            if cancel_event is not None and cancel_event.is_set():
                cancelled = True
                break
            error_count += 1
            processed += 1
            msg = f"path not a readable image: {invalid_path}"
            _add_error(msg)
            _append_item(DatasetExportItemResult(
                image_id=0,
                src_image_path=invalid_path,
                error=msg,
            ))
            _emit(f"Invalid path ({processed}/{total_expected})", os.path.basename(str(invalid_path)))

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
        output_folder=str(output_path),
        items=items,
        total_items=total_items,
        items_truncated=total_items > len(items),
        error_messages=error_messages[:50],  # cap to avoid huge payloads
    )


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
            "output_folder": str(output_path),
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
                    "output_folder": str(output_path),
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
                    "output_folder": str(output_path),
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
        output_folder=str(output_path),
        message=f"Dataset export started for {requested_total} images.",
    )
