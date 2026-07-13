"""Dataset export service.

Implements the user-flow that issue #5 point 6 was asking for:
"copy/move images and write matching .txt sidecars to one folder, all
renamed consistently". Previously the only way to get a LoRA training
dataset out was a two-step dance — Auto-Separate to move images,
then export-batch with beside_image to write captions next to them —
and the renaming feature didn't exist at all.

This service handles the whole thing in one transaction:

  1. Validate output folder (creates if missing, blocks traversal).
  2. For each row, plan the rename via ``dataset_naming.render_stem`` +
     ``resolve_collision`` (the streaming export path plans per-row so
     a 100k-image scan-token export does not materialise a full plan
     before the first file is written). ``dataset_naming.plan_renames``
     remains available as a batch helper for tests and small callers.
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

import json
import logging
import os
import shutil
import threading
import time
import uuid
from datetime import datetime, timezone
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
    NL_COMPOSE_MODES,
    VALID_OUTPUT_MODES,
    VALID_CONTENT_MODES,
    apply_caption_transforms,
    build_sidecar_content,
    compose_caption_with_nl,
)
from utils.path_validation import normalize_user_path, validate_folder_path


logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Decomposition (2026-07): the constants, Pydantic models, pure helpers, and
# the two streaming engine functions live in the services/dataset_export/
# package, re-imported below. THIS module remains a real FILE and the single
# monkeypatch surface (claude-dsexport-pins-REPORT.md §2/§3/§6 +
# tests/test_dataset_export_pins.py):
#   * The JOB-REGISTRY family stays DEFINED here in one namespace — the five
#     module globals (_EXPORT_JOB_LOCK / _EXPORT_JOB_RUN_ID /
#     _EXPORT_JOB_THREAD / _EXPORT_JOB_CANCEL_EVENT / _EXPORT_JOB_PROGRESS),
#     _EXPORT_ACTIVE_STATUSES, and every reader/writer (_copy_progress /
#     get_dataset_export_progress / cancel_dataset_export /
#     _set_export_progress_if_current / _clear_export_worker_if_current /
#     start_dataset_export with its worker()/publish() closures). A ``global``
#     rebind only affects the defining module's binding, so moving any writer
#     to a sibling module (or re-exporting a global via ``from x import``)
#     would silently desync progress/cancel.
#   * The header import block above is kept verbatim (per-file F401 ignore in
#     pyproject.toml) so every historical attribute keeps resolving here for
#     tests that patch through this namespace: export_service.shutil.copy2 and
#     des.db.update_image_path (module singletons), des.render_stem and
#     des.DATASET_EXPORT_RESPONSE_ITEM_LIMIT (facade bindings — planning.
#     _plan_single_rename and the engine closures read them back through
#     _svc() at call time).
#   * Every Pydantic model is defined ONCE in services/dataset_export/models.py
#     and re-exported here, so the from-import bindings in routers/dataset.py
#     keep class identity (response_model= coercion + isinstance).
# ---------------------------------------------------------------------------
from services.dataset_export._constants import (
    DATASET_EXPORT_DB_CHUNK_SIZE,
    DATASET_EXPORT_RECENT_ERROR_LIMIT,
    DATASET_EXPORT_RESPONSE_ITEM_LIMIT,
    DATASET_LEGACY_TEMPLATE,
    EXPORT_MANIFEST_FILENAME,
    EXPORT_MANIFEST_VERSION,
    TRAINING_TAG_CONTENT_MODES,
    VALID_IMAGE_OPS,
    VALID_MASK_EXPORT_MODES,
    VALID_OVERWRITE_POLICIES,
    VALID_TRAINER_CONFIGS,
)
from services.dataset_export.models import (
    DatasetExportItemResult,
    DatasetExportPreviewRequest,
    DatasetExportRequest,
    DatasetExportResponse,
    DatasetExportStartResponse,
    ExportProgressCallback,
)
from services.dataset_export.planning import (
    _allocate_sidecar_path,
    _dataset_sidecar_extension,
    _iter_chunks,
    _iter_requested_scan_paths,
    _iter_unique_image_ids,
    _output_mode,
    _plan_beside_image_sidecar,
    _plan_single_rename,
    _reconcile_moved_image_path,
    _requested_item_count,
    _resolve_dataset_image_path,
)
from services.dataset_export.captions import (
    _NL_COMPOSE_MODES,
    _append_common_tags_for_mode,
    _build_dataset_template_options,
    _compose_nl_caption,
    _normalise_common_tag,
    _render_dataset_sidecar,
    _split_image_overrides,
    _split_keyed_str_map,
)
from services.dataset_export.artifacts import (
    _build_export_manifest,
    _manifest_item,
    _mask_export_mode,
    _toml_path_literal,
    _trainer_config_mode,
    _validate_export_request,
    _write_export_manifest,
    _write_kohya_dataset_config,
)
from services.dataset_export.engine import export_dataset, preview_dataset_export

# Kept next to the job-registry family below (co-location rule, report §2):
# the cancel/start guards read this exact set to decide "already running"
# (409) vs "nothing to cancel".
_EXPORT_ACTIVE_STATUSES = {"starting", "running", "cancelling"}


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
        # v3.4.5 cancel-race fix: the worker must NOT overwrite a
        # "cancelling" status back to "running" once the cancel event is
        # set. The previous ``status: "cancelling" if cancel_event.is_set()
        # else "running"`` re-derived the status on every progress tick;
        # if the cancel handler set "cancelling" between two ticks, the
        # next tick could flip it back to "running" for a window. Now the
        # worker never writes "running" after cancel is requested — it
        # only escalates to "cancelling" and leaves terminal-status
        # transitions to the worker()'s final _set_export_progress_if_current
        # call.
        if cancel_event.is_set():
            _set_export_progress_if_current(run_id, {
                "status": "cancelling",
                **updates,
            })
        else:
            _set_export_progress_if_current(run_id, {
                "status": "running",
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
