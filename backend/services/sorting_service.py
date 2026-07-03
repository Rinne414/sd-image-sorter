"""
Sorting service for SD Image Sorter.

Handles business logic for scanning, moving, batch operations, and manual sort sessions.
"""
import logging
import os
import json
import platform
import string
import tempfile
import threading
import time
from pathlib import Path
from typing import Optional, List, Dict, Any, Tuple

from fastapi import HTTPException, BackgroundTasks
from pydantic import ValidationError

from app_info import APP_VERSION, GITHUB_REPOSITORY_URL
from config import MANUAL_SORT_SESSION_FILE, read_float_env
from constants import VALID_ASPECT_RATIOS
import database as db
import image_manager as image_manager_module
from image_manager import scan_folder, move_image, copy_image, parse_metadata_job
from database import add_images_batch
from metadata_parser import verify_image_readable
from services import entry_stats_service
from services.state_compat import MutableStateProxy
from services.sorting_models import (
    BatchMoveRequest,
    BrowseFolderRequest,
    FOLDER_KEY_MAX_LENGTH,
    FolderConfig,
    ManualSortStartRequest,
    MoveRequest,
    ScanRequest,
    SORT_MODE_BRACKET,
    SORT_MODE_CULL,
    SORT_MODE_DEFAULT,
    SORT_MODE_SLOT,
    VALID_BRACKET_ACTIONS,
    VALID_CULL_ACTIONS,
    VALID_FILE_OPERATIONS,
    VALID_PROMPT_MATCH_MODES,
    VALID_SORT_ACTIONS,
    VALID_SORT_MODES,
    ValidatePathRequest,
)
from services.sorting_session_store import (
    SORT_SESSION_SCHEMA_VERSION,
    build_persisted_sort_session_payload,
    discard_persisted_session_files,
    find_existing_session_file,
    get_session_file_candidates,
    parse_persisted_session_version,
    read_persisted_session,
    remove_session_files,
    write_persisted_session,
)
from services.tag_export_service import (
    count_selection_token_ids,
    export_tags_batch_request,
    iter_selection_token_id_chunks,
)
from utils.path_validation import normalize_user_path, validate_folder_path
from utils.source_paths import resolve_existing_indexed_image_path

logger = logging.getLogger(__name__)

__all__ = [
    "BatchMoveRequest",
    "BrowseFolderRequest",
    "FolderConfig",
    "ManualSortStartRequest",
    "MoveRequest",
    "ScanRequest",
    "SORT_MODE_BRACKET",
    "SORT_MODE_CULL",
    "SORT_MODE_DEFAULT",
    "SORT_MODE_SLOT",
    "SORT_SESSION_SCHEMA_VERSION",
    "SortingService",
    "ValidatePathRequest",
    "invalidate_library_health_cache",
]


SESSION_FILE = MANUAL_SORT_SESSION_FILE
LEGACY_SESSION_FILE = os.path.join(os.path.dirname(__file__), '..', 'sort_session.json')

BATCH_MOVE_FETCH_CHUNK = 500
STATS_FACET_LIMIT = 50
ANALYTICS_DEFAULT_LIMIT = 500
SCAN_LOG_HEARTBEAT_SECONDS = max(
    0.0,
    read_float_env("SD_IMAGE_SORTER_SCAN_LOG_HEARTBEAT_SECONDS", 15.0),
)
SCAN_UI_STALLED_SECONDS = max(
    5.0,
    read_float_env(
        "SD_IMAGE_SORTER_SCAN_UI_STALLED_SECONDS",
        max(45.0, SCAN_LOG_HEARTBEAT_SECONDS * 3),
    ),
)


# v3.2.2: TTL cache for /api/library-health.
#
# The underlying SQL aggregates across the whole ``images`` table (~10
# SUM/COUNT operations + duplicate-filename grouping + folder grouping
# + largest-images sort + issue samples). On a 71k-row library the
# cold-cache call takes ~12 seconds. Without caching, the home page,
# gallery, and diagnostics panel all hit the same endpoint and cause
# concurrent reads to time out.
#
# 60s freshness is the right granularity for a "library health" report
# — none of the inputs (image count, embedding completeness, missing
# metadata) change within seconds. Tagging or scanning a batch will
# refresh once the TTL expires; the user can also force a refresh by
# reloading after they trigger a long operation.
#
# Cache keyed by sample_limit so callers asking for different sample
# sizes get the right payload.
_LIBRARY_HEALTH_CACHE_TTL_SECONDS = 60.0
_LIBRARY_HEALTH_CACHE_LOCK = threading.Lock()
_LIBRARY_HEALTH_CACHE: Dict[int, Tuple[float, Dict[str, Any]]] = {}


def invalidate_library_health_cache() -> None:
    """Force the next /api/library-health call to recompute (used by tests)."""
    with _LIBRARY_HEALTH_CACHE_LOCK:
        _LIBRARY_HEALTH_CACHE.clear()


def _get_library_health_cached(sample_limit: int) -> Dict[str, Any]:
    sample_limit = max(1, min(int(sample_limit), 25))
    now = time.time()
    with _LIBRARY_HEALTH_CACHE_LOCK:
        cached = _LIBRARY_HEALTH_CACHE.get(sample_limit)
        if cached is not None and (now - cached[0]) < _LIBRARY_HEALTH_CACHE_TTL_SECONDS:
            return cached[1]

    # Compute outside the lock: SQL is slow, holding the lock would
    # serialize concurrent callers. Multiple parallel cache misses are
    # acceptable; whichever finishes last wins the cache slot.
    payload = db.get_library_health_report(sample_limit=sample_limit)
    with _LIBRARY_HEALTH_CACHE_LOCK:
        _LIBRARY_HEALTH_CACHE[sample_limit] = (time.time(), payload)
    return payload


class SortingService:
    """Service for scanning, moving, and manual sorting operations."""

    @staticmethod
    def _build_default_scan_progress_state() -> Dict[str, Any]:
        """Return the canonical idle scan-progress payload."""
        return {
            "status": "idle",
            "step": "idle",
            "current": 0,
            "processed": 0,
            "total": 0,
            "counted": 0,
            "total_final": False,
            "import_complete": False,
            "errors": 0,
            "new": 0,
            "updated": 0,
            "removed": 0,
            "library_ready": False,
            "quick_import": True,
            "metadata_processed": 0,
            "metadata_total": 0,
            "metadata_total_final": False,
            "metadata_pending": 0,
            "message": "",
            "current_item": None,
            "started_at": None,
            "updated_at": None,
            "attention_required": False,
            "attention_message": "",
            "stalled_seconds": 0,
            "diagnostics_available": True,
            "diagnostics_endpoint": "/api/support/diagnostics",
        }

    @staticmethod
    def _build_default_sort_session_state() -> Dict[str, Any]:
        """Return the canonical inactive manual-sort session payload."""
        return {
            "active": False,
            # v3.3.2 Workbench: which culling/sorting mode this session runs.
            # "slot" == the original WASD slot-sort (default → unchanged behavior).
            "mode": SORT_MODE_DEFAULT,
            "image_ids": [],
            "current_index": 0,
            # v3.3.2 WB-S2: bracket champion pointer (unused in slot mode). The
            # challenger pointer reuses current_index.
            "champion_index": 0,
            "folders": {},
            # v3.3.1: per-slot collection mapping. A slot key (w/a/s/d) whose
            # value is a collection id is "collection-typed": pressing it adds
            # the current image to that collection BY REFERENCE (no file move).
            # Slots with a None value fall back to the normal folder behavior.
            "collection_slots": {},
            "operation_mode": "move",
            "history": [],
            "redo_stack": [],
        }

    def __init__(self):
        """Initialize the sorting service."""
        self._scan_progress: Dict[str, Any] = self._build_default_scan_progress_state()
        self._scan_lock = threading.Lock()
        self._scan_cancel_event: Optional[threading.Event] = None
        self._scan_worker_thread: Optional[threading.Thread] = None
        self._scan_run_id = 0

        self._sort_session: Dict[str, Any] = self._build_default_sort_session_state()
        self._sort_session_lock = threading.Lock()
        self._scan_progress_proxy = MutableStateProxy(self.get_scan_progress, self.set_scan_progress)
        self._sort_session_proxy = MutableStateProxy(self.get_sort_session, self.set_sort_session)
        
        # Batch move progress
        self._batch_move_progress: Dict[str, Any] = {
            "status": "idle",
            "step": "idle",
            "current": 0,
            "total": 0,
            "message": "",
            "errors": 0,
            "moved": 0,
            "current_item": None,
            "recent_errors": [],
            "operation": "move",
            "started_at": None,
            "updated_at": None,
        }
        self._batch_move_lock = threading.Lock()
        self._batch_move_run_id = 0
        # Cooperative cancellation for the active batch-move worker.
        # Mirrors ``self._scan_cancel_event`` / ``cancel_scan``: the worker
        # checks ``is_set()`` between chunks and between images so a cancel
        # request lands within a few image iterations rather than waiting
        # for the entire batch to finish.
        self._batch_move_cancel_event: Optional[threading.Event] = None

        # v3.3.0 USR-1: gallery selection move/copy progress.
        # The synchronous ``/api/move`` endpoint stays for tests and
        # programmatic callers, but the gallery UI now drives a background
        # job so large selections stream progress (and the user can see how
        # far the per-file ``shutil.move`` source-deletion has advanced)
        # instead of staring at a silent blocking request. Mirrors the
        # batch-move run-id epoch + cancel-event pattern exactly. The final
        # progress payload embeds the per-id ``results`` list so the frontend
        # success/failure mapping is identical to the sync endpoint.
        self._move_progress: Dict[str, Any] = {
            "status": "idle",
            "step": "idle",
            "current": 0,
            "total": 0,
            "message": "",
            "errors": 0,
            "moved": 0,
            "current_item": None,
            "recent_errors": [],
            "operation": "move",
            "results": [],
            "started_at": None,
            "updated_at": None,
        }
        self._move_lock = threading.Lock()
        self._move_run_id = 0
        self._move_cancel_event: Optional[threading.Event] = None

    @staticmethod
    def _resolve_image_path(path: str) -> Optional[str]:
        """Resolve a library image path across native Windows and WSL mounts."""
        return resolve_existing_indexed_image_path(path, backend_file=__file__)

    @staticmethod
    def _validate_file_operation(operation: Optional[str]) -> str:
        """Normalize file operations to one of the supported modes."""
        normalized = str(operation or "move").strip().lower()
        if normalized not in VALID_FILE_OPERATIONS:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid operation. Must be one of: {', '.join(VALID_FILE_OPERATIONS)}",
            )
        return normalized

    @staticmethod
    def _write_id_snapshot(id_chunks) -> str:
        """Write matching IDs to a temp file before mutating their rows."""
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False) as handle:
            for batch_ids in id_chunks:
                for image_id in batch_ids:
                    handle.write(f"{int(image_id)}\n")
            return handle.name

    @staticmethod
    def _iter_id_snapshot_file(snapshot_path: str, chunk_size: int):
        batch: List[int] = []
        with open(snapshot_path, "r", encoding="utf-8") as handle:
            for line in handle:
                try:
                    image_id = int(line.strip())
                except ValueError:
                    continue
                batch.append(image_id)
                if len(batch) >= chunk_size:
                    yield batch
                    batch = []
        if batch:
            yield batch

    def _get_sort_history_counts(self, history: Optional[List[Dict[str, Any]]] = None) -> Dict[str, int]:
        """Summarize move/skip counts from the current manual-sort history."""
        active_history = history if history is not None else self._sort_session.get("history", [])
        sorted_count = sum(1 for item in active_history if item.get("action") == "move")
        skipped_count = sum(1 for item in active_history if item.get("action") == "skip")
        collected_count = sum(1 for item in active_history if item.get("action") == "collect")
        return {
            "sorted_count": sorted_count,
            "skipped_count": skipped_count,
            "collected_count": collected_count,
        }

    def _get_sort_session_flags(
        self,
        history: Optional[List[Dict[str, Any]]] = None,
        redo_stack: Optional[List[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        """Expose undo/redo availability alongside move/skip counters."""
        active_history = history if history is not None else self._sort_session.get("history", [])
        active_redo = redo_stack if redo_stack is not None else self._sort_session.get("redo_stack", [])
        return {
            **self._get_sort_history_counts(active_history),
            "undo_available": bool(active_history),
            "redo_available": bool(active_redo),
        }

    def _filter_sort_actions(
        self,
        actions: Optional[List[Dict[str, Any]]],
        valid_image_ids: set[int],
    ) -> List[Dict[str, Any]]:
        """Drop persisted sort actions that point at images no longer in the database."""
        filtered: List[Dict[str, Any]] = []
        for entry in actions or []:
            image_id = entry.get("image_id")
            if image_id in valid_image_ids:
                filtered.append(entry)
        return filtered

    @staticmethod
    def _coerce_sort_filter_values(values: Optional[Any]) -> Optional[List[str]]:
        if values is None:
            return None
        if isinstance(values, str):
            raw_values = values.split(",")
        elif isinstance(values, (list, tuple, set)):
            raw_values = values
        else:
            raw_values = [values]
        normalized = [str(value).strip() for value in raw_values if str(value).strip()]
        return normalized or None

    def _parse_sort_folders(self, folders: Optional[Any]) -> Dict[str, str]:
        """Parse and validate manual-sort folder config from JSON body or legacy query params."""
        if not folders:
            return {}

        if isinstance(folders, dict):
            raw_config = folders
        else:
            try:
                raw_config = json.loads(folders)
            except (TypeError, ValueError) as exc:
                raise HTTPException(status_code=400, detail="Invalid folders payload") from exc

        if not isinstance(raw_config, dict):
            raise HTTPException(status_code=400, detail="Invalid folders payload")

        try:
            config = FolderConfig(folders=raw_config)
        except ValidationError as exc:
            raise HTTPException(status_code=400, detail="Invalid folders payload") from exc

        validated_folders = {}
        for key, path in config.folders.items():
            if not path:
                continue
            normalized_path = normalize_user_path(path)
            is_valid, error = validate_folder_path(normalized_path, allow_create=True)
            if not is_valid:
                raise HTTPException(status_code=400, detail=error or f"Invalid folder path for key '{key}'")
            validated_folders[key] = normalized_path

        return validated_folders

    def _coerce_scan_progress_state(self, state: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        """Normalize externally injected scan-progress state onto the canonical shape."""
        coerced = self._build_default_scan_progress_state()
        if state:
            coerced.update(state)
        return coerced

    @staticmethod
    def _coerce_collection_slots(slots: Optional[Any]) -> Dict[str, Optional[int]]:
        """Normalize a per-slot collection mapping to ``{key: int|None}``.

        v3.3.1: accepts the JSON/dict form the frontend sends. Non-int / blank
        / 0 / negative values collapse to ``None`` (a normal folder slot). Slot
        keys are bounded by ``FOLDER_KEY_MAX_LENGTH`` to match folder configs.
        """
        if not isinstance(slots, dict):
            return {}
        normalized: Dict[str, Optional[int]] = {}
        for key, value in slots.items():
            key_str = str(key)
            if not key_str or len(key_str) > FOLDER_KEY_MAX_LENGTH:
                continue
            if value is None or value == "":
                normalized[key_str] = None
                continue
            try:
                collection_id = int(value)
            except (TypeError, ValueError):
                normalized[key_str] = None
                continue
            normalized[key_str] = collection_id if collection_id > 0 else None
        return normalized

    def _coerce_sort_session_state(self, session: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        """Normalize externally injected sort-session state onto the canonical shape."""
        coerced = self._build_default_sort_session_state()
        session = session or {}
        coerced["active"] = bool(session.get("active", False))
        # Unknown / missing mode (e.g. a session persisted before v3.3.2) falls
        # back to "slot" so old files load without a schema-version bump.
        requested_mode = session.get("mode", SORT_MODE_DEFAULT)
        coerced["mode"] = requested_mode if requested_mode in VALID_SORT_MODES else SORT_MODE_DEFAULT
        coerced["image_ids"] = list(session.get("image_ids", []))
        coerced["folders"] = dict(session.get("folders", {}))
        coerced["collection_slots"] = self._coerce_collection_slots(session.get("collection_slots"))
        coerced["history"] = list(session.get("history", []))
        coerced["redo_stack"] = list(session.get("redo_stack", []))
        coerced["operation_mode"] = self._validate_file_operation(session.get("operation_mode", "move"))

        try:
            current_index = int(session.get("current_index", 0) or 0)
        except (TypeError, ValueError):
            current_index = 0
        coerced["current_index"] = max(0, min(current_index, len(coerced["image_ids"])))

        # WB-S2 bracket champion pointer: clamp into the candidate range.
        try:
            champion_index = int(session.get("champion_index", 0) or 0)
        except (TypeError, ValueError):
            champion_index = 0
        coerced["champion_index"] = max(0, min(champion_index, max(0, len(coerced["image_ids"]) - 1)))
        return coerced

    def _build_persisted_sort_session_payload(self) -> Dict[str, Any]:
        """Return the on-disk manual-sort session payload."""
        session = self._coerce_sort_session_state(self._sort_session)
        return build_persisted_sort_session_payload(session)

    @staticmethod
    def _parse_persisted_session_version(data: Dict[str, Any]) -> int:
        """Read the persisted schema version, treating missing versions as legacy v0."""
        return parse_persisted_session_version(data)

    def _discard_persisted_session_file(self, reason: str, *, paths: Optional[List[Path]] = None) -> None:
        """Delete unusable persisted session files so future boots do not half-restore them."""
        discard_persisted_session_files(reason, paths or self._get_session_file_candidates())

    @staticmethod
    def _get_session_file_candidates() -> List[Path]:
        """Return persisted-session paths in preferred load/save order."""
        return get_session_file_candidates(SESSION_FILE, LEGACY_SESSION_FILE)

    def _find_existing_session_file(self) -> Optional[Path]:
        """Find the first existing persisted sort-session file."""
        return find_existing_session_file(self._get_session_file_candidates())

    def _with_scan_attention_fields(self, progress: Dict[str, Any]) -> Dict[str, Any]:
        """Add UI-facing stalled-scan diagnostics without mutating worker progress."""
        now = time.time()
        updated_at = progress.get("updated_at") or progress.get("started_at") or now
        try:
            idle_for = max(0.0, now - float(updated_at))
        except (TypeError, ValueError):
            idle_for = 0.0

        status = progress.get("status")
        step = str(progress.get("step") or "scan")
        is_active = status in {"running", "cancelling"}
        attention_required = bool(is_active and idle_for >= SCAN_UI_STALLED_SECONDS)
        if attention_required:
            pending = int(progress.get("metadata_pending", 0) or 0)
            current_item = progress.get("current_item") or "current file"
            if step == "metadata" or pending > 0:
                message = (
                    f"No visible metadata progress for {int(idle_for)}s. "
                    f"Pending metadata jobs: {pending}. Current item: {current_item}. "
                    "The scan may still be waiting on a slow or broken image; copy diagnostics if this keeps growing."
                )
            else:
                message = (
                    f"No visible scan progress for {int(idle_for)}s while step={step}. "
                    f"Current item: {current_item}. Copy diagnostics if this keeps growing."
                )
        else:
            message = ""

        return {
            **progress,
            "attention_required": attention_required,
            "attention_message": message,
            "stalled_seconds": int(idle_for),
            "diagnostics_available": True,
            "diagnostics_endpoint": "/api/support/diagnostics",
        }

    def get_scan_progress(self) -> Dict[str, Any]:
        """Get the current scan progress."""
        with self._scan_lock:
            return self._with_scan_attention_fields(self._scan_progress.copy())

    def get_scan_progress_proxy(self) -> MutableStateProxy:
        """Expose the legacy dict-style scan-progress handle from the service."""
        return self._scan_progress_proxy

    def get_system_info_payload(self) -> Dict[str, Any]:
        """Return hardware info and tagger runtime recommendations for the UI."""
        try:
            from config import DEFAULT_TAGGER_MODEL, TAGGER_MODELS
            from hardware_monitor import get_system_info, recommend_tagger_config

            system_info = get_system_info()
            recommendation = recommend_tagger_config(
                system_info,
                model_name=DEFAULT_TAGGER_MODEL,
                use_gpu=True,
            )
            recommendations_by_model = {}
            for model_name in TAGGER_MODELS.keys():
                recommendations_by_model[model_name] = {
                    "gpu": recommend_tagger_config(system_info, model_name=model_name, use_gpu=True),
                    "cpu": recommend_tagger_config(system_info, model_name=model_name, use_gpu=False),
                }
            recommendations_by_model["custom"] = {
                "gpu": recommend_tagger_config(system_info, model_name="custom", use_gpu=True),
                "cpu": recommend_tagger_config(system_info, model_name="custom", use_gpu=False),
            }
            return {
                "system_info": system_info,
                "recommendation": recommendation,
                "recommendations_by_model": recommendations_by_model,
            }
        except Exception as exc:
            return {
                "system_info": {"error": str(exc)},
                "recommendation": {
                    "recommended_batch_size": 2,
                    "recommended_use_gpu": False,
                    "recommended_session_refresh_interval": 0,
                    "risk_level": "medium",
                    "message": f"Hardware detection failed: {exc}",
                },
                "recommendations_by_model": {},
            }

    def set_scan_progress(self, state: Dict[str, Any]) -> None:
        """Set the scan progress state."""
        with self._scan_lock:
            self._scan_progress = self._coerce_scan_progress_state(state)

    def reset_scan_progress(self) -> Dict[str, Any]:
        """Reset a stuck scan task back to idle."""
        with self._scan_lock:
            worker_alive = bool(self._scan_worker_thread and self._scan_worker_thread.is_alive())
            if worker_alive:
                return {"status": self._scan_progress["status"], "message": "Cannot reset while scan worker is still running"}
            if self._scan_progress["status"] in {"running", "cancelling", "error", "done", "cancelled"}:
                self._scan_progress = self._build_default_scan_progress_state()
                self._scan_progress.update({
                    "message": "Reset by user",
                    "updated_at": time.time(),
                })
                self._scan_cancel_event = None
                self._scan_worker_thread = None
                return {"status": "reset", "message": "Scan progress reset to idle"}
            return {"status": self._scan_progress["status"], "message": "Nothing to reset (not running)"}

    def cancel_scan(self) -> Dict[str, Any]:
        """Request cooperative cancellation of the current scan task."""
        with self._scan_lock:
            if self._scan_progress["status"] not in {"running", "cancelling"}:
                return {"status": self._scan_progress["status"], "message": "No scan task is running"}

            current = int(self._scan_progress.get("current", 0) or 0)
            total = int(self._scan_progress.get("total", 0) or 0)
            total_final = bool(self._scan_progress.get("total_final", False))
            worker_alive = bool(self._scan_worker_thread and self._scan_worker_thread.is_alive())

            if self._scan_cancel_event is not None:
                self._scan_cancel_event.set()

            if worker_alive:
                self._scan_progress["status"] = "cancelling"
                self._scan_progress["step"] = "cancelling"
                self._scan_progress["message"] = (
                    f"Cancelling scan... ({current}/{total})"
                    if total_final and total > 0
                    else f"Cancelling scan... ({current} scanned)"
                )
                self._scan_progress["updated_at"] = time.time()
                return {"status": "cancelling", "message": "Scan cancellation requested"}

            self._scan_progress["status"] = "cancelled"
            self._scan_progress["step"] = "cancelled"
            self._scan_progress["message"] = (
                f"Scan cancelled at {current}/{total}."
                if total_final and total > 0
                else f"Scan cancelled after {current} scanned."
            )
            self._scan_progress["updated_at"] = time.time()
            self._scan_cancel_event = None
            self._scan_worker_thread = None
            return {"status": "cancelled", "message": "Scan cancelled"}

    def _set_scan_worker_refs_if_current(self, run_id: int, cancel_event: threading.Event, worker_thread: Optional[threading.Thread]) -> bool:
        """Only the active scan run may own the shared worker references."""
        with self._scan_lock:
            if run_id != self._scan_run_id:
                return False
            self._scan_cancel_event = cancel_event
            self._scan_worker_thread = worker_thread
            # v3.2.2: transition from "starting" to "running" once the
            # worker thread is actually live. start_scan sets the initial
            # status to "starting" so concurrent /api/scan POSTs see the
            # in-flight slot before the background task picks up the
            # work; run_scan immediately calls this method to flip it
            # to "running".
            if self._scan_progress.get("status") == "starting":
                self._scan_progress = {**self._scan_progress, "status": "running"}
            return True

    def _set_scan_progress_if_current(self, run_id: int, state: Dict[str, Any]) -> bool:
        """Only the active scan run may replace shared progress state."""
        with self._scan_lock:
            if run_id != self._scan_run_id:
                return False
            self._scan_progress = state
            return True

    def _update_scan_progress_if_current(self, run_id: int, **updates: Any) -> bool:
        """Only the active scan run may mutate shared progress state."""
        with self._scan_lock:
            if run_id != self._scan_run_id:
                return False
            self._scan_progress = {
                **self._scan_progress,
                **updates,
            }
            return True

    def _clear_scan_worker_refs_if_current(self, run_id: int) -> None:
        """Release scan worker references when the active run ends."""
        with self._scan_lock:
            if run_id != self._scan_run_id:
                return
            self._scan_cancel_event = None
            self._scan_worker_thread = None

    def get_sort_session(self) -> Dict[str, Any]:
        """Get the current sort session."""
        with self._sort_session_lock:
            return self._sort_session.copy()

    def get_sort_session_proxy(self) -> MutableStateProxy:
        """Expose the legacy dict-style sort-session handle from the service."""
        return self._sort_session_proxy


    def get_batch_move_progress(self) -> Dict[str, Any]:
        """Get the current batch move progress."""
        with self._batch_move_lock:
            return self._batch_move_progress.copy()

    def reset_batch_move_progress(self) -> Dict[str, Any]:
        """Reset batch move progress to idle."""
        with self._batch_move_lock:
            if self._batch_move_progress["status"] == "running":
                raise HTTPException(status_code=409, detail="Cannot reset batch move while it is still running")
            return {"status": self._batch_move_progress["status"], "message": "Nothing to reset"}

    def cancel_batch_move(self) -> Dict[str, Any]:
        """Request cooperative cancellation of the active batch-move task.

        Mirrors :meth:`cancel_scan`: flips the worker's cancel event and
        publishes a ``cancelling`` progress state so the UI can show a
        "Cancelling..." indicator while the worker walks to its next
        chunk/image boundary. The worker writes the terminal
        ``cancelled`` state itself once it observes the flag, so this
        method never overwrites a finished run's outcome.
        """
        with self._batch_move_lock:
            current_status = self._batch_move_progress.get("status")
            if current_status not in {"running", "cancelling"}:
                return {
                    "status": current_status,
                    "message": "No batch move task is running",
                }

            current = int(self._batch_move_progress.get("current", 0) or 0)
            total = int(self._batch_move_progress.get("total", 0) or 0)
            operation = self._batch_move_progress.get("operation", "move")

            if self._batch_move_cancel_event is not None:
                self._batch_move_cancel_event.set()

            verb = "copy" if operation == "copy" else "move"
            self._batch_move_progress["status"] = "cancelling"
            self._batch_move_progress["step"] = "cancelling"
            self._batch_move_progress["message"] = (
                f"Cancelling batch {verb}... ({current}/{total})"
                if total > 0
                else f"Cancelling batch {verb}..."
            )
            self._batch_move_progress["updated_at"] = time.time()
            return {"status": "cancelling", "message": "Batch move cancellation requested"}

    def _set_batch_move_progress_if_current(self, run_id: int, state: Dict[str, Any]) -> bool:
        """Only allow the active batch-move task to replace shared progress state."""
        with self._batch_move_lock:
            if run_id != self._batch_move_run_id:
                return False
            self._batch_move_progress = state
            return True

    def _update_batch_move_progress_if_current(self, run_id: int, **updates: Any) -> bool:
        """Only allow the active batch-move task to mutate shared progress state."""
        with self._batch_move_lock:
            if run_id != self._batch_move_run_id:
                return False
            self._batch_move_progress = {
                **self._batch_move_progress,
                **updates,
            }
            return True

    # ------------------------------------------------------------------
    # v3.3.0 USR-1: background gallery move/copy job (progress + cancel).
    # Mirrors the batch-move helpers above.
    # ------------------------------------------------------------------
    def get_move_progress(self) -> Dict[str, Any]:
        """Get the current gallery move/copy job progress."""
        with self._move_lock:
            return self._move_progress.copy()

    def reset_move_progress(self) -> Dict[str, Any]:
        """Reset move job progress to idle (refused while still running)."""
        with self._move_lock:
            if self._move_progress["status"] == "running":
                raise HTTPException(status_code=409, detail="Cannot reset move while it is still running")
            return {"status": self._move_progress["status"], "message": "Nothing to reset"}

    def cancel_move(self) -> Dict[str, Any]:
        """Request cooperative cancellation of the active gallery move/copy job."""
        with self._move_lock:
            current_status = self._move_progress.get("status")
            if current_status not in {"running", "cancelling"}:
                return {"status": current_status, "message": "No move task is running"}

            current = int(self._move_progress.get("current", 0) or 0)
            total = int(self._move_progress.get("total", 0) or 0)
            operation = self._move_progress.get("operation", "move")

            if self._move_cancel_event is not None:
                self._move_cancel_event.set()

            verb = "copy" if operation == "copy" else "move"
            self._move_progress["status"] = "cancelling"
            self._move_progress["step"] = "cancelling"
            self._move_progress["message"] = (
                f"Cancelling {verb}... ({current}/{total})"
                if total > 0
                else f"Cancelling {verb}..."
            )
            self._move_progress["updated_at"] = time.time()
            return {"status": "cancelling", "message": "Move cancellation requested"}

    def _set_move_progress_if_current(self, run_id: int, state: Dict[str, Any]) -> bool:
        """Only allow the active move job to replace shared progress state."""
        with self._move_lock:
            if run_id != self._move_run_id:
                return False
            self._move_progress = state
            return True

    def _update_move_progress_if_current(self, run_id: int, **updates: Any) -> bool:
        """Only allow the active move job to mutate shared progress state."""
        with self._move_lock:
            if run_id != self._move_run_id:
                return False
            self._move_progress = {
                **self._move_progress,
                **updates,
            }
            return True


    def _apply_file_operation(
        self,
        operation: str,
        image_id: int,
        destination_folder: str,
        source_path: str,
        source_row: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Execute either a move or a copy and return a normalized result payload."""
        normalized_operation = self._validate_file_operation(operation)
        if normalized_operation == "copy":
            result = copy_image(
                image_id=image_id,
                destination_folder=destination_folder,
                image_path=source_path,
                source_row=source_row,
            )
            return {
                "operation": "copy",
                "new_path": result["new_path"],
                "new_image_id": result["new_image_id"],
            }

        return {
            "operation": "move",
            "new_path": move_image(image_id, destination_folder, source_path),
            "new_image_id": None,
        }

    def _undo_file_operation(self, history_entry: Dict[str, Any]) -> None:
        """Undo a previous move/copy action recorded in manual sort history."""
        operation = self._validate_file_operation(history_entry.get("operation") or history_entry.get("action"))
        if operation == "copy":
            copied_image_id = history_entry.get("copied_image_id")
            copied_path = self._resolve_image_path(history_entry.get("new_path") or "")
            if copied_path and os.path.exists(copied_path):
                os.remove(copied_path)
            if copied_image_id:
                db.delete_image(int(copied_image_id))
            return

        image = db.get_image_by_id(history_entry["image_id"])
        if not image:
            return

        source_path = self._resolve_image_path(image.get("path") or "")
        original_folder = history_entry.get("original_folder") or os.path.dirname(
            normalize_user_path(history_entry.get("original_path") or "")
        )
        if source_path and original_folder:
            move_image(history_entry["image_id"], original_folder, source_path)

    @staticmethod
    def _undo_collect_action(history_entry: Dict[str, Any]) -> None:
        """Undo a previous collect action by removing the membership reference.

        v3.3.1: collect never touches the file, so undo only drops the
        ``collection_items`` row for ``(collection_id, image_id)``.
        """
        collection_id = history_entry.get("collection_id")
        image_id = history_entry.get("image_id")
        if collection_id is None or image_id is None:
            return
        db.set_collection_membership(int(collection_id), int(image_id), False)

    def _filter_readable_image_ids(self, image_ids: List[int]) -> tuple[List[int], List[Dict[str, Any]]]:
        """Drop unreadable images from interactive sorting/move flows and mark them in DB."""
        if not image_ids:
            return [], []

        filtered: List[int] = []
        skipped: List[Dict[str, Any]] = []
        images_map = db.get_images_by_ids(image_ids)

        for image_id in image_ids:
            image = images_map.get(image_id)
            if not image:
                continue

            path = image.get("path") or ""
            source_path = self._resolve_image_path(path)
            filename = image.get("filename") or f"image-{image_id}"
            if not source_path:
                skipped.append({"image_id": image_id, "filename": filename, "error": "File not found"})
                db.mark_image_unreadable(image_id, "File not found")
                continue

            readable, read_error = verify_image_readable(source_path)
            if not readable:
                skipped.append({"image_id": image_id, "filename": filename, "error": read_error or "Unreadable image"})
                db.mark_image_unreadable(image_id, read_error or "Unreadable image")
                continue

            filtered.append(image_id)

        return filtered, skipped

    def set_sort_session(self, session: Dict[str, Any]) -> None:
        """Set the sort session."""
        with self._sort_session_lock:
            self._sort_session = self._coerce_sort_session_state(session)

    def validate_path(self, request: ValidatePathRequest) -> Dict[str, Any]:
        """Validate a folder path for inline UI feedback."""
        normalized_path = normalize_user_path(request.path)
        is_valid, error = validate_folder_path(normalized_path)
        return {
            "valid": is_valid,
            "error": error,
            "normalized_path": normalized_path if is_valid else None,
        }

    def remove_library_root(self, root_id: int) -> Dict[str, Any]:
        """Unregister a library root. Indexed images are NOT deleted (v3.3.2)."""
        if not db.remove_library_root(int(root_id)):
            raise HTTPException(status_code=404, detail="Library root not found")
        return {"status": "removed", "id": int(root_id)}

    def rescan_library_root(self, root_id: int, background_tasks: BackgroundTasks) -> Dict[str, str]:
        """Re-scan a registered root to pick up new/changed files (quick import)."""
        root = db.get_library_root(int(root_id))
        if not root:
            raise HTTPException(status_code=404, detail="Library root not found")
        request = ScanRequest(
            folder_path=root["path"],
            recursive=True,
            quick_import=True,
            cleanup_missing=False,
            force_reparse=False,
        )
        return self.start_scan(request, background_tasks)

    def auto_refresh_library(self, background_tasks: BackgroundTasks) -> Dict[str, Any]:
        """Idle-triggered quick-scan of the stalest enabled root (v3.3.2 Library Navigation).

        Safe by construction: a no-op while any scan is running (single-scan
        model) or when there are no enabled roots, and it always quick-imports —
        it NEVER runs AI tagging (GPU safety). Successive idle ticks cycle
        through roots oldest-first via ``last_scanned_at``.
        """
        with self._scan_lock:
            status = self._scan_progress.get("status")
        if status in {"running", "cancelling", "starting"}:
            return {"status": "skipped", "reason": "scan_in_progress"}

        roots = [r for r in db.list_library_roots() if r.get("enabled")]
        if not roots:
            return {"status": "idle", "reason": "no_enabled_roots"}

        # Oldest last_scanned_at first; never-scanned (None -> "") sorts first.
        target = min(roots, key=lambda r: r.get("last_scanned_at") or "")
        request = ScanRequest(
            folder_path=target["path"],
            recursive=True,
            quick_import=True,
            cleanup_missing=False,
            force_reparse=False,
        )
        try:
            scan = self.start_scan(request, background_tasks)
        except HTTPException as exc:
            # Lost a race with a manual scan, or the folder is gone/unplugged —
            # auto-refresh degrades quietly and never surfaces an error.
            return {"status": "skipped", "reason": str(exc.detail)}
        return {"status": "started", "root": target["path"], "scan": scan}

    def start_scan(
        self,
        request: ScanRequest,
        background_tasks: BackgroundTasks
    ) -> Dict[str, str]:
        """Start scanning a folder for images."""
        normalized_folder_path = normalize_user_path(request.folder_path)
        is_valid, error = validate_folder_path(normalized_folder_path)
        if not is_valid:
            raise HTTPException(status_code=400, detail=error or "Invalid folder path")

        with self._scan_lock:
            current_status = self._scan_progress["status"]
            worker_alive = bool(self._scan_worker_thread and self._scan_worker_thread.is_alive())
            # v3.2.2: previously this only rejected when ``status == 'running'``
            # AND ``worker_alive``. Three concurrent POSTs to /api/scan all
            # squeezed through the gate because the worker thread isn't
            # created until later (background_tasks schedules it after the
            # lock is released), so the second/third callers all observed
            # worker_alive=False and incorrectly believed nothing was
            # running. Result: three "Scan started" 200 responses but only
            # one real scan with the others left in an inconsistent
            # progress state.
            #
            # Fix: any non-terminal status counts as "in progress". Stale
            # state (status=running but worker died) is recovered through
            # /api/scan/reset which the UI's "Reset stuck scan" button
            # already calls; we should not silently overwrite it here.
            ACTIVE_STATUSES = {"running", "cancelling", "starting"}
            if current_status in ACTIVE_STATUSES:
                if worker_alive or current_status in {"starting", "cancelling"}:
                    raise HTTPException(status_code=409, detail="Scan already in progress")
                raise HTTPException(
                    status_code=409,
                    detail="Previous scan is in a stale state. Call /api/scan/reset first.",
                )

            self._scan_run_id += 1
            run_id = self._scan_run_id
            cancel_event = threading.Event()
            started_at = time.time()
            self._scan_cancel_event = cancel_event
            self._scan_worker_thread = None
            self._scan_progress = {
                "status": "starting",
                "step": "starting",
                "current": 0,
                "processed": 0,
                "total": 0,
                "counted": 0,
                "total_final": False,
                "import_complete": False,
                "errors": 0,
                "new": 0,
                "updated": 0,
                "removed": 0,
                "library_ready": False,
                "quick_import": request.quick_import,
                "metadata_processed": 0,
                "metadata_total": 0,
                "metadata_total_final": False,
                "metadata_pending": 0,
                "message": "Syncing folder index..." if request.cleanup_missing else "Counting images before import...",
                "current_item": None,
                "started_at": started_at,
                "updated_at": started_at,
            }

        def run_scan():
            if not self._set_scan_worker_refs_if_current(run_id, cancel_event, threading.current_thread()):
                return

            try:
                logger.info(
                    "Scan started: folder=%s recursive=%s quick_import=%s cleanup_missing=%s force_reparse=%s metadata_workers=%s metadata_backlog_limit=%s metadata_timeout=%ss heartbeat=%ss",
                    normalized_folder_path,
                    request.recursive,
                    request.quick_import,
                    request.cleanup_missing,
                    request.force_reparse,
                    image_manager_module.DEFAULT_METADATA_WORKERS,
                    image_manager_module._metadata_backlog_limit(image_manager_module.DEFAULT_METADATA_WORKERS),
                    image_manager_module.SCAN_METADATA_TIMEOUT_SECONDS,
                    SCAN_LOG_HEARTBEAT_SECONDS,
                )

                heartbeat_stop = threading.Event()

                def heartbeat_loop() -> None:
                    if SCAN_LOG_HEARTBEAT_SECONDS <= 0:
                        return
                    while not heartbeat_stop.wait(SCAN_LOG_HEARTBEAT_SECONDS):
                        progress = self.get_scan_progress()
                        if progress.get("status") not in {"running", "cancelling"}:
                            continue
                        heartbeat_now = time.time()
                        updated_at = float(progress.get("updated_at") or progress.get("started_at") or heartbeat_now)
                        started = float(progress.get("started_at") or started_at or heartbeat_now)
                        logger.info(
                            "Scan heartbeat: folder=%s status=%s step=%s processed=%s/%s counted=%s import_complete=%s library_ready=%s metadata=%s/%s pending=%s errors=%s current=%s idle_for=%.1fs elapsed=%.1fs",
                            normalized_folder_path,
                            progress.get("status", "unknown"),
                            progress.get("step", "unknown"),
                            progress.get("processed", progress.get("current", 0)),
                            progress.get("total", 0) if progress.get("total_final") else "?",
                            progress.get("counted", 0),
                            progress.get("import_complete", False),
                            progress.get("library_ready", False),
                            progress.get("metadata_processed", 0),
                            progress.get("metadata_total", 0),
                            progress.get("metadata_pending", 0),
                            progress.get("errors", 0),
                            progress.get("current_item") or "-",
                            max(0.0, heartbeat_now - updated_at),
                            max(0.0, heartbeat_now - started),
                        )

                heartbeat_thread = threading.Thread(
                    target=heartbeat_loop,
                    name=f"scan-heartbeat-{run_id}",
                    daemon=True,
                )
                heartbeat_thread.start()

                def progress_cb(current, total, filename, details=None):
                    now = time.time()
                    details = details or {}
                    # Read shared scan state through a single locked snapshot. The route
                    # handler reads/writes self._scan_progress under self._scan_lock via
                    # get_scan_progress(); reading the dict directly here would be a data
                    # race. One snapshot also gives a consistent view across all fields.
                    prev_progress = self.get_scan_progress()
                    last_error = details.get("last_error") if isinstance(details, dict) else None
                    phase = details.get("phase") if isinstance(details, dict) else None
                    library_ready = bool(details.get("library_ready", prev_progress.get("library_ready", False))) if isinstance(details, dict) else prev_progress.get("library_ready", False)
                    metadata_processed = int(details.get("metadata_processed", prev_progress.get("metadata_processed", 0)) or 0) if isinstance(details, dict) else int(prev_progress.get("metadata_processed", 0) or 0)
                    metadata_total = int(details.get("metadata_total", prev_progress.get("metadata_total", 0)) or 0) if isinstance(details, dict) else int(prev_progress.get("metadata_total", 0) or 0)
                    metadata_total_final = bool(details.get("metadata_total_final", prev_progress.get("metadata_total_final", False))) if isinstance(details, dict) else bool(prev_progress.get("metadata_total_final", False))
                    total_final = bool(details.get("total_final", prev_progress.get("total_final", False))) if isinstance(details, dict) else bool(prev_progress.get("total_final", False))
                    counted = int(details.get("counted", prev_progress.get("counted", 0)) or 0) if isinstance(details, dict) else int(prev_progress.get("counted", 0) or 0)
                    import_processed = int(details.get("import_processed", current) or 0) if isinstance(details, dict) else int(current or 0)
                    import_total = int(details.get("import_total", total) or 0) if isinstance(details, dict) else int(total or 0)
                    import_complete = bool(details.get("import_complete", prev_progress.get("import_complete", False))) if isinstance(details, dict) else bool(prev_progress.get("import_complete", False))
                    metadata_pending = int(details.get("metadata_pending", prev_progress.get("metadata_pending", 0)) or 0) if isinstance(details, dict) else int(prev_progress.get("metadata_pending", 0) or 0)
                    state_current = import_processed
                    state_total = import_total or total
                    message = f"Processing: {filename}" if filename else "Scanning files..."
                    current_item = filename or None
                    step = "importing"
                    status = "running"
                    removed_count = details.get("removed", prev_progress.get("removed", 0)) if isinstance(details, dict) else prev_progress.get("removed", 0)

                    if phase == "counting":
                        state_current = counted or current
                        state_total = 0
                        message = f"Counting images... ({state_current} found)"
                        current_item = None
                        step = "counting"
                    elif phase == "counted":
                        state_current = 0
                        state_total = import_total or total
                        message = f"Found {state_total} images. Starting import..."
                        current_item = None
                        step = "importing"
                    elif phase == "cleanup":
                        message = (
                            f"Folder sync complete. Removed {removed_count} missing entr"
                            f"{'y' if removed_count == 1 else 'ies'}."
                        )
                        current_item = None
                        step = "cleanup"
                    elif phase == "library_ready":
                        step = "metadata" if import_complete and metadata_total > metadata_processed else "importing"
                        current_item = None
                        if import_complete and metadata_total > 0:
                            message = f"Library ready. Finishing metadata in background ({metadata_processed}/{metadata_total})..."
                        else:
                            message = f"Library is browseable. Importing continues in background ({state_current}/{state_total or '?'})..."
                    elif phase == "metadata":
                        if import_complete:
                            step = "metadata"
                            message = f"Reading image details: {filename}" if filename else "Reading image details..."
                            current_item = filename or None
                        else:
                            step = "importing"
                            message = (
                                f"Importing library and reading details... ({state_current}/{state_total})"
                                if state_total > 0
                                else "Importing library and reading details..."
                            )
                            current_item = None
                    elif not total_final:
                        state_current = counted or current
                        state_total = 0
                        message = f"Counting images... ({state_current} found)"
                        current_item = None
                        step = "counting"

                    if last_error:
                        message = (
                            f"Skipped unreadable image: {last_error.get('filename', filename)}"
                            f" ({last_error.get('error', 'Unreadable image')})"
                        )
                    if cancel_event.is_set():
                        status = "cancelling"
                        step = "cancelling"
                        message = (
                            f"Cancelling scan... ({state_current}/{state_total})"
                            if total_final and state_total > 0
                            else f"Cancelling scan... ({state_current} scanned)"
                        )
                    self._update_scan_progress_if_current(
                        run_id,
                        status=status,
                        current=state_current,
                        processed=state_current,
                        total=state_total,
                        counted=counted,
                        total_final=total_final,
                        import_complete=import_complete,
                        step=step,
                        errors=details.get("errors", prev_progress.get("errors", 0)) if isinstance(details, dict) else prev_progress.get("errors", 0),
                        removed=removed_count,
                        library_ready=library_ready,
                        quick_import=request.quick_import,
                        metadata_processed=metadata_processed,
                        metadata_total=metadata_total,
                        metadata_total_final=metadata_total_final,
                        metadata_pending=metadata_pending,
                        message=message,
                        current_item=current_item,
                        updated_at=now,
                    )

                result = scan_folder(
                    normalized_folder_path,
                    request.recursive,
                    progress_cb,
                    stop_requested=cancel_event.is_set,
                    force_reparse=request.force_reparse,
                    cleanup_missing=request.cleanup_missing,
                    quick_import=request.quick_import,
                )
                now = time.time()
                errors = result.get("errors", 0)
                new_count = result.get("new", 0)
                updated_count = result.get("updated", 0)
                removed_count = result.get("removed", 0)
                summary = f"Completed! {new_count} images indexed."
                if updated_count:
                    summary += f" {updated_count} updated."
                if removed_count:
                    summary += f" {removed_count} missing entries removed."
                if errors:
                    summary += f" {errors} failed."
                recent_errors = result.get("recent_errors") or []
                if recent_errors:
                    filenames = ", ".join(item.get("filename", "unknown") for item in recent_errors[-3:])
                    summary += f" Bad files: {filenames}."
                duration_seconds = max(0.0, now - float(self._scan_progress.get("started_at") or now))
                metadata_processed = result.get("metadata_processed", 0)
                metadata_total = result.get("metadata_total", 0)
                logger.info(
                    "Scan completed: folder=%s files=%s indexed_new=%s unchanged_or_updated=%s removed=%s metadata=%s/%s errors=%s duration=%.1fs",
                    normalized_folder_path,
                    result.get("total", 0),
                    new_count,
                    updated_count,
                    removed_count,
                    metadata_processed,
                    metadata_total,
                    errors,
                    duration_seconds,
                )

                # v3.3.2 Library Navigation: remember the scanned folder as a
                # library root (multi-root management + idle auto-refresh target
                # list). Bookkeeping must never fail an otherwise-complete scan.
                entry_stats_service.record_activity(
                    entry_stats_service.KIND_ADDED, new_count
                )
                try:
                    db.add_library_root(normalized_folder_path)
                    db.touch_library_root_scanned(normalized_folder_path)
                except Exception as exc:  # pragma: no cover - defensive
                    logger.warning(
                        "Could not register library root %s: %s",
                        normalized_folder_path,
                        exc,
                    )

                if recent_errors:
                    samples = "; ".join(
                        f"{item.get('filename', 'unknown')}: {item.get('error', 'Unreadable image')}"
                        for item in recent_errors[-3:]
                    )
                    logger.warning(
                        "Scan skipped %s unreadable file(s). Samples: %s. Open Scan Progress in the UI for recent errors; set SD_IMAGE_SORTER_LOG_LEVEL=DEBUG for parser tracebacks.",
                        errors,
                        samples,
                    )

                self._set_scan_progress_if_current(
                    run_id,
                    {
                        "status": "done",
                        "step": "done",
                        "current": result["total"],
                        "processed": result["total"],
                        "total": result["total"],
                        "counted": result.get("counted", result["total"]),
                        "total_final": result.get("total_final", True),
                        "import_complete": result.get("import_complete", True),
                        "errors": errors,
                        "new": new_count,
                        "updated": updated_count,
                        "removed": removed_count,
                        "library_ready": result.get("library_ready", request.quick_import),
                        "quick_import": request.quick_import,
                        "metadata_processed": result.get("metadata_processed", 0),
                        "metadata_total": result.get("metadata_total", 0),
                        "metadata_total_final": result.get("metadata_total_final", True),
                        "metadata_pending": 0,
                        "message": summary,
                        "current_item": None,
                        "started_at": self._scan_progress.get("started_at"),
                        "updated_at": now,
                        "result": result,
                        "recent_errors": recent_errors,
                    }
                )
            except Exception as e:
                from exceptions import ScanCancelledError

                now = time.time()
                if isinstance(e, ScanCancelledError):
                    current_state = self.get_scan_progress()
                    logger.info(
                        "Scan cancelled: folder=%s processed=%s total=%s errors=%s",
                        normalized_folder_path,
                        current_state.get("processed", current_state.get("current", 0)),
                        current_state.get("total", 0),
                        current_state.get("errors", 0),
                    )
                    self._set_scan_progress_if_current(
                        run_id,
                        {
                            "status": "cancelled",
                            "step": "cancelled",
                            "current": current_state.get("current", 0),
                            "processed": current_state.get("processed", current_state.get("current", 0)),
                            "total": current_state.get("total", 0),
                            "counted": current_state.get("counted", 0),
                            "total_final": current_state.get("total_final", False),
                            "import_complete": current_state.get("import_complete", False),
                            "errors": current_state.get("errors", 0),
                            "new": current_state.get("new", 0),
                            "updated": current_state.get("updated", 0),
                            "removed": current_state.get("removed", 0),
                            "library_ready": current_state.get("library_ready", False),
                            "quick_import": current_state.get("quick_import", True),
                            "metadata_processed": current_state.get("metadata_processed", 0),
                            "metadata_total": current_state.get("metadata_total", 0),
                            "metadata_total_final": current_state.get("metadata_total_final", False),
                            "metadata_pending": current_state.get("metadata_pending", 0),
                            "message": (
                                f"Scan cancelled at {current_state.get('processed', current_state.get('current', 0))}/{current_state.get('total', 0)}."
                                if current_state.get("total_final", False) and current_state.get("total", 0)
                                else f"Scan cancelled after {current_state.get('processed', current_state.get('current', 0))} scanned."
                            ),
                            "current_item": current_state.get("current_item"),
                            "started_at": current_state.get("started_at"),
                            "updated_at": now,
                        }
                    )
                else:
                    current_state = self.get_scan_progress()
                    logger.exception(
                        "Scan failed: folder=%s processed=%s total=%s errors=%s",
                        normalized_folder_path,
                        current_state.get("processed", current_state.get("current", 0)),
                        current_state.get("total", 0),
                        current_state.get("errors", 0),
                    )
                    self._set_scan_progress_if_current(
                        run_id,
                        {
                            "status": "error",
                            "step": "error",
                            "current": current_state.get("current", 0),
                            "processed": current_state.get("processed", current_state.get("current", 0)),
                            "total": current_state.get("total", 0),
                            "counted": current_state.get("counted", 0),
                            "total_final": current_state.get("total_final", False),
                            "import_complete": current_state.get("import_complete", False),
                            "errors": current_state.get("errors", 0),
                            "new": current_state.get("new", 0),
                            "updated": current_state.get("updated", 0),
                            "removed": current_state.get("removed", 0),
                            "library_ready": current_state.get("library_ready", False),
                            "quick_import": current_state.get("quick_import", True),
                            "metadata_processed": current_state.get("metadata_processed", 0),
                            "metadata_total": current_state.get("metadata_total", 0),
                            "metadata_total_final": current_state.get("metadata_total_final", False),
                            "metadata_pending": current_state.get("metadata_pending", 0),
                            "message": "Scan failed due to an internal error",
                            "current_item": current_state.get("current_item"),
                            "started_at": current_state.get("started_at"),
                            "updated_at": now,
                        }
                    )
            finally:
                if "heartbeat_stop" in locals():
                    heartbeat_stop.set()
                if "heartbeat_thread" in locals() and heartbeat_thread.is_alive():
                    heartbeat_thread.join(timeout=0.5)
                current_state = self.get_scan_progress()
                if current_state["status"] == "running":
                    self._update_scan_progress_if_current(
                        run_id,
                        status="error",
                        step="error",
                        message="Scan ended unexpectedly",
                        updated_at=time.time(),
                    )
                self._clear_scan_worker_refs_if_current(run_id)

        background_tasks.add_task(run_scan)
        return {"status": "started", "message": "Scan started in background"}

    def _move_one_image(
        self,
        image_id: int,
        image: Optional[Dict[str, Any]],
        operation: str,
        destination_folder: str,
    ) -> Dict[str, Any]:
        """Process a single move/copy and return a normalized per-id result.

        v3.3.0 USR-1: shared by the synchronous ``move_images`` endpoint and
        the background move job so both paths produce identical result rows
        and apply the same readability guard before any byte-level move
        deletes a source file.
        """
        source_path = self._resolve_image_path(image.get("path") or "") if image else None
        if not image or not source_path:
            return {"id": image_id, "error": "Image not found", "operation": operation, "success": False}

        readable, read_error = verify_image_readable(source_path)
        if not readable:
            error_message = read_error or "Unreadable image"
            db.mark_image_unreadable(image_id, error_message)
            return {"id": image_id, "error": error_message, "operation": operation, "success": False}

        try:
            operation_result = self._apply_file_operation(
                operation=operation,
                image_id=image_id,
                destination_folder=destination_folder,
                source_path=source_path,
                source_row=image,
            )
            return {
                "id": image_id,
                "new_path": operation_result["new_path"],
                "new_image_id": operation_result.get("new_image_id"),
                "operation": operation,
                "success": True,
            }
        except Exception as e:
            logger.error("Failed to %s image %d: %s", operation, image_id, e)
            return {
                "id": image_id,
                "error": f"Failed to {operation} image",
                "operation": operation,
                "success": False,
            }

    def _expand_move_request_ids(self, request: MoveRequest) -> List[int]:
        """Resolve a MoveRequest into a concrete image-id list.

        v3.2.1 task #34: a ``selection_token`` (Select All Filtered scope) is
        expanded to ids here. ImageService is instantiated directly to avoid
        an import cycle with main.py; the helper is a stateless decoder over
        db (no shared per-instance state matters).
        """
        if request.selection_token:
            from services.image_service import ImageService
            decoder = ImageService()
            image_ids: List[int] = []
            for chunk in decoder._iter_selection_token_snapshot_chunks(
                request.selection_token, chunk_size=500
            ):
                image_ids.extend(chunk)
            return image_ids
        return request.image_ids or []

    def move_images(self, request: MoveRequest) -> Dict[str, Any]:
        """Move specific images to a folder (synchronous; kept for tests and
        programmatic callers — the gallery UI uses ``start_move_job``)."""
        operation = self._validate_file_operation(request.operation)
        destination_folder = normalize_user_path(request.destination_folder)
        is_valid, error = validate_folder_path(destination_folder, allow_create=True)
        if not is_valid:
            raise HTTPException(status_code=400, detail=error or "Invalid destination folder")

        image_ids = self._expand_move_request_ids(request)
        if not image_ids:
            return {"results": []}

        # Batch fetch all images in a single query (N+1 fix). The readability
        # check is done per-image inside ``_move_one_image`` so each result
        # lands as it happens (a byte-level move would otherwise silently copy
        # truncated/corrupt PNGs to the destination).
        images_map = db.get_images_by_ids(image_ids)
        try:
            os.makedirs(destination_folder, exist_ok=True)
        except OSError as exc:
            logger.warning("Could not create destination folder %s: %s", destination_folder, exc)
            raise HTTPException(
                status_code=400,
                detail=f"Could not create destination folder: {exc}",
            ) from exc

        results = [
            self._move_one_image(image_id, images_map.get(image_id), operation, destination_folder)
            for image_id in image_ids
        ]
        return {"results": results}

    def start_move_job(
        self,
        request: MoveRequest,
        background_tasks: BackgroundTasks,
    ) -> Dict[str, Any]:
        """v3.3.0 USR-1: gallery selection move/copy as a background job with
        progress polling, mirroring ``batch_move_images``. The final progress
        payload embeds the per-id ``results`` list so the frontend mapping is
        identical to the synchronous endpoint. Source files are deleted one at
        a time as the worker advances, so the progress bar tracks deletion."""
        operation = self._validate_file_operation(request.operation)
        destination_folder = normalize_user_path(request.destination_folder)
        is_valid, error = validate_folder_path(destination_folder, allow_create=True)
        if not is_valid:
            raise HTTPException(status_code=400, detail=error or "Invalid destination folder")

        with self._move_lock:
            if self._move_progress["status"] in {"running", "cancelling"}:
                raise HTTPException(status_code=409, detail="A move is already in progress")

        image_ids = self._expand_move_request_ids(request)
        total_count = len(image_ids)
        if total_count == 0:
            return {"status": "done", "message": "No images to move", "results": [], "total": 0}

        cancel_event = threading.Event()
        with self._move_lock:
            self._move_run_id += 1
            run_id = self._move_run_id
            self._move_cancel_event = cancel_event
            progress_verb = "Copying" if operation == "copy" else "Moving"
            self._move_progress = {
                "status": "running",
                "step": "starting",
                "current": 0,
                "total": total_count,
                "message": f"Starting {operation} of {total_count} images...",
                "errors": 0,
                "moved": 0,
                "current_item": None,
                "recent_errors": [],
                "operation": operation,
                "results": [],
                "started_at": time.time(),
                "updated_at": time.time(),
            }

        def run_move():
            results: List[Dict[str, Any]] = []
            moved = 0
            processed = 0
            errors: List[Dict[str, Any]] = []
            try:
                os.makedirs(destination_folder, exist_ok=True)

                def _write_cancelled_state() -> None:
                    completed_verb_local = "Copied" if operation == "copy" else "Moved"
                    self._set_move_progress_if_current(
                        run_id,
                        {
                            "status": "cancelled",
                            "step": "cancelled",
                            "current": processed,
                            "total": total_count,
                            "errors": len(errors),
                            "moved": moved,
                            "message": (
                                f"Cancelled at {processed}/{total_count}. "
                                f"{completed_verb_local} {moved} images so far."
                            ),
                            "current_item": None,
                            "recent_errors": errors[-3:],
                            "operation": operation,
                            "results": results,
                            "started_at": self._move_progress.get("started_at"),
                            "updated_at": time.time(),
                        },
                    )

                # Walk the id list in chunks so the per-image DB rows are
                # fetched in batches (matches batch-move's IN(...) chunking)
                # while progress advances per image.
                for start in range(0, total_count, BATCH_MOVE_FETCH_CHUNK):
                    if cancel_event.is_set():
                        _write_cancelled_state()
                        return
                    chunk_ids = image_ids[start:start + BATCH_MOVE_FETCH_CHUNK]
                    image_map = db.get_images_by_ids(chunk_ids)

                    for image_id in chunk_ids:
                        if cancel_event.is_set():
                            _write_cancelled_state()
                            return

                        image = image_map.get(image_id)
                        result = self._move_one_image(image_id, image, operation, destination_folder)
                        results.append(result)
                        filename = (image.get("filename") if image else None) or f"id-{image_id}"
                        if result.get("success"):
                            moved += 1
                        else:
                            errors.append({
                                "image_id": image_id,
                                "filename": filename,
                                "error": result.get("error") or "Failed",
                            })
                        processed += 1
                        if not self._update_move_progress_if_current(
                            run_id,
                            step="moving",
                            current=processed,
                            total=total_count,
                            errors=len(errors),
                            moved=moved,
                            message=f"Processed {filename} ({processed}/{total_count})",
                            current_item=filename,
                            recent_errors=errors[-3:],
                            operation=operation,
                            updated_at=time.time(),
                        ):
                            return

                completed_verb = "Copied" if operation == "copy" else "Moved"
                self._set_move_progress_if_current(
                    run_id,
                    {
                        "status": "done",
                        "step": "done",
                        "current": total_count,
                        "total": total_count,
                        "errors": len(errors),
                        "moved": moved,
                        "message": f"Completed! {completed_verb} {moved} images." + (f" {len(errors)} errors." if errors else ""),
                        "current_item": None,
                        "recent_errors": errors[-3:],
                        "operation": operation,
                        "results": results,
                        "started_at": self._move_progress.get("started_at"),
                        "updated_at": time.time(),
                    },
                )
                entry_stats_service.record_activity(
                    entry_stats_service.KIND_MOVED, moved
                )
            except Exception as e:
                logger.error("Move job failed: %s", e)
                self._set_move_progress_if_current(
                    run_id,
                    {
                        "status": "error",
                        "step": "error",
                        "current": processed,
                        "total": total_count,
                        "errors": len(errors),
                        "moved": moved,
                        "message": "Move failed due to an internal error",
                        "current_item": None,
                        "recent_errors": errors[-3:],
                        "operation": operation,
                        "results": results,
                        "started_at": self._move_progress.get("started_at"),
                        "updated_at": time.time(),
                    },
                )
            finally:
                with self._move_lock:
                    if (
                        self._move_run_id == run_id
                        and self._move_cancel_event is cancel_event
                    ):
                        self._move_cancel_event = None

        background_tasks.add_task(run_move)
        return {
            "status": "started",
            "message": f"{progress_verb} {total_count} images in background",
            "total": total_count,
            "count": total_count,
            "operation": operation,
        }

    def batch_move_images(
        self,
        request: BatchMoveRequest,
        background_tasks: BackgroundTasks
    ) -> Dict[str, Any]:
        """Move all images matching filters to a folder with progress tracking."""
        operation = self._validate_file_operation(request.operation)
        destination_folder = normalize_user_path(request.destination_folder)
        is_valid, error = validate_folder_path(destination_folder, allow_create=True)
        if not is_valid:
            raise HTTPException(status_code=400, detail=error or "Invalid destination folder")

        with self._batch_move_lock:
            # "cancelling" is still busy: the worker is alive and draining; a
            # second start would race it for the shared progress/cancel state.
            if self._batch_move_progress["status"] in {"running", "cancelling"}:
                raise HTTPException(status_code=409, detail="Batch move already in progress")

        generators = request.generators if request.generators else None
        tags = request.tags if request.tags else None
        tag_mode = request.tag_mode
        ratings = request.ratings if request.ratings else None
        checkpoints = request.checkpoints if request.checkpoints else None
        loras = request.loras if request.loras else None
        prompts = request.prompts if request.prompts else None
        prompt_match_mode = request.prompt_match_mode
        artist = request.artist.strip() if request.artist else None
        search_query = request.search.strip() if request.search else None
        exclude_tags = request.exclude_tags if request.exclude_tags else None
        exclude_generators = request.exclude_generators if request.exclude_generators else None
        exclude_ratings = request.exclude_ratings if request.exclude_ratings else None
        exclude_checkpoints = request.exclude_checkpoints if request.exclude_checkpoints else None
        exclude_loras = request.exclude_loras if request.exclude_loras else None
        # v3.3.x gallery-scope parity (None preserves pre-existing behavior)
        exclude_prompts = request.exclude_prompts if request.exclude_prompts else None
        exclude_colors = request.exclude_colors if request.exclude_colors else None
        min_user_rating = request.min_user_rating
        brightness_min = request.brightness_min
        brightness_max = request.brightness_max
        color_temperature = request.color_temperature.strip() if request.color_temperature else None
        brightness_distribution = request.brightness_distribution.strip() if request.brightness_distribution else None
        collection_id = request.collection_id
        folder_scope = request.folder.strip() if request.folder else None
        has_metadata = request.has_metadata

        total_count = db.get_filtered_image_count(
            generators=generators,
            tags=tags,
            tag_mode=tag_mode,
            ratings=ratings,
            checkpoints=checkpoints,
            loras=loras,
            search_query=search_query,
            prompt_terms=prompts,
            prompt_match_mode=prompt_match_mode,
            artist=artist,
            min_width=request.min_width,
            max_width=request.max_width,
            min_height=request.min_height,
            max_height=request.max_height,
            aspect_ratio=request.aspect_ratio,
            min_aesthetic=request.min_aesthetic,
            max_aesthetic=request.max_aesthetic,
            exclude_tags=exclude_tags,
            exclude_generators=exclude_generators,
            exclude_ratings=exclude_ratings,
            exclude_checkpoints=exclude_checkpoints,
            exclude_loras=exclude_loras,
            exclude_prompts=exclude_prompts,
            exclude_colors=exclude_colors,
            min_user_rating=min_user_rating,
            brightness_min=brightness_min,
            brightness_max=brightness_max,
            color_temperature=color_temperature,
            brightness_distribution=brightness_distribution,
            collection_id=collection_id,
            folder=folder_scope,
            has_metadata=has_metadata,
        )

        if total_count == 0:
            return {"message": "No images match the filters", "count": 0}

        # Run actual move in background with progress tracking. The
        # cancel event is allocated under the same lock as run_id so
        # cancel_batch_move() always sees a consistent (run_id, event)
        # pair; the worker checks event.is_set() between chunks and
        # between images so a cancel request lands within a few image
        # iterations rather than after the whole batch completes.
        cancel_event = threading.Event()
        with self._batch_move_lock:
            self._batch_move_run_id += 1
            run_id = self._batch_move_run_id
            self._batch_move_cancel_event = cancel_event
            self._batch_move_progress = {
                "status": "running",
                "step": "starting",
                "current": 0,
                "total": total_count,
                "message": f"Starting {operation} of {total_count} images...",
                "errors": 0,
                "moved": 0,
                "current_item": None,
                "recent_errors": [],
                "operation": operation,
                "started_at": time.time(),
                "updated_at": time.time(),
            }

        def run_batch_move():
            try:
                # Note: previously this called ``_filter_readable_image_ids``
                # before the loop, which did a full pixel decode of every
                # image up front via ``verify_image_readable``. For large
                # batches that blocked the worker for many minutes with no
                # progress emitted, making the operation indistinguishable
                # from a hang. The decode is now done per-image inside the
                # inner loop so progress advances as the worker walks the
                # list (a byte-level move would otherwise silently copy
                # truncated/corrupt PNGs to the destination).

                os.makedirs(destination_folder, exist_ok=True)

                moved = 0
                processed = 0
                errors: List[Dict[str, Any]] = []

                def _write_cancelled_state() -> None:
                    """Publish the cancelled summary for this batch-move run."""
                    completed_verb_local = "Copied" if operation == "copy" else "Moved"
                    self._set_batch_move_progress_if_current(
                        run_id,
                        {
                            "status": "cancelled",
                            "step": "cancelled",
                            "current": processed,
                            "total": total_count,
                            "errors": len(errors),
                            "moved": moved,
                            "message": (
                                f"Cancelled at {processed}/{total_count}. "
                                f"{completed_verb_local} {moved} images so far."
                            ),
                            "current_item": None,
                            "recent_errors": errors[-3:],
                            "operation": operation,
                            "started_at": self._batch_move_progress.get("started_at"),
                            "updated_at": time.time(),
                        }
                    )

                snapshot_path = self._write_id_snapshot(db.iter_filtered_image_id_chunks(
                    chunk_size=BATCH_MOVE_FETCH_CHUNK,
                    generators=generators,
                    tags=tags,
                    tag_mode=tag_mode,
                    ratings=ratings,
                    checkpoints=checkpoints,
                    loras=loras,
                    search_query=search_query,
                    prompt_terms=prompts,
                    prompt_match_mode=prompt_match_mode,
                    artist=artist,
                    min_width=request.min_width,
                    max_width=request.max_width,
                    min_height=request.min_height,
                    max_height=request.max_height,
                    aspect_ratio=request.aspect_ratio,
                    min_aesthetic=request.min_aesthetic,
                    max_aesthetic=request.max_aesthetic,
                    exclude_tags=exclude_tags,
                    exclude_generators=exclude_generators,
                    exclude_ratings=exclude_ratings,
                    exclude_checkpoints=exclude_checkpoints,
                    exclude_loras=exclude_loras,
                    exclude_prompts=exclude_prompts,
                    exclude_colors=exclude_colors,
                    min_user_rating=min_user_rating,
                    brightness_min=brightness_min,
                    brightness_max=brightness_max,
                    color_temperature=color_temperature,
                    brightness_distribution=brightness_distribution,
                    collection_id=collection_id,
                    folder=folder_scope,
                    has_metadata=has_metadata,
                ))
                saw_any_ids = False
                try:
                    snapshot_batches = self._iter_id_snapshot_file(snapshot_path, BATCH_MOVE_FETCH_CHUNK)
                    for batch_ids in snapshot_batches:
                        if cancel_event.is_set():
                            _write_cancelled_state()
                            return

                        saw_any_ids = True
                        image_map = db.get_images_by_ids(batch_ids)

                        for image_id in batch_ids:
                            if cancel_event.is_set():
                                _write_cancelled_state()
                                return

                            image = image_map.get(image_id)
                            if not image:
                                processed += 1
                                errors.append({"image_id": image_id, "filename": f"id-{image_id}", "error": "Image row not found"})
                                continue

                            filename = image.get("filename", "image")
                            error_message = None

                            source_path = self._resolve_image_path(image.get("path") or "")
                            if not source_path:
                                error_message = "Image file not found"
                            else:
                                readable, read_error = verify_image_readable(source_path)
                                if not readable:
                                    error_message = read_error or "Unreadable image"
                                    db.mark_image_unreadable(image["id"], error_message)
                                else:
                                    try:
                                        self._apply_file_operation(
                                            operation=operation,
                                            image_id=image["id"],
                                            destination_folder=destination_folder,
                                            source_path=source_path,
                                            source_row=image,
                                        )
                                        moved += 1
                                    except Exception as e:
                                        error_message = str(e)

                            if error_message:
                                errors.append({"image_id": image_id, "filename": filename, "error": error_message})

                            processed += 1
                            if not self._update_batch_move_progress_if_current(
                                run_id,
                                step="moving",
                                current=processed,
                                total=total_count,
                                errors=len(errors),
                                moved=moved,
                                message=f"Processed {filename} ({processed}/{total_count})",
                                current_item=filename,
                                recent_errors=errors[-3:],
                                operation=operation,
                                updated_at=time.time(),
                            ):
                                return
                finally:
                    try:
                        os.unlink(snapshot_path)
                    except OSError:
                        logger.debug("Failed to remove batch move snapshot temp file: %s", snapshot_path)

                if not saw_any_ids:
                    self._set_batch_move_progress_if_current(
                        run_id,
                        {
                            "status": "done",
                            "step": "done",
                            "current": 0,
                            "total": 0,
                            "message": "No images match the filters",
                            "errors": 0,
                            "moved": 0,
                            "current_item": None,
                            "recent_errors": [],
                            "operation": operation,
                            "started_at": time.time(),
                            "updated_at": time.time(),
                        }
                    )
                    return

                completed_verb = "Copied" if operation == "copy" else "Moved"
                self._set_batch_move_progress_if_current(
                    run_id,
                    {
                        "status": "done",
                        "step": "done",
                        "current": total_count,
                        "total": total_count,
                        "errors": len(errors),
                        "moved": moved,
                        "message": f"Completed! {completed_verb} {moved} images." + (f" {len(errors)} errors." if errors else ""),
                        "current_item": None,
                        "recent_errors": errors[-3:],
                        "operation": operation,
                        "started_at": self._batch_move_progress.get("started_at"),
                        "updated_at": time.time(),
                    }
                )
                entry_stats_service.record_activity(
                    entry_stats_service.KIND_MOVED, moved
                )

            except Exception as e:
                logger.error("Batch move failed: %s", e)
                with self._batch_move_lock:
                    current = self._batch_move_progress.get("current", 0) if run_id == self._batch_move_run_id else 0
                    errors_count = self._batch_move_progress.get("errors", 0) if run_id == self._batch_move_run_id else 0
                    moved_count = self._batch_move_progress.get("moved", 0) if run_id == self._batch_move_run_id else 0

                self._set_batch_move_progress_if_current(
                    run_id,
                    {
                        "status": "error",
                        "step": "error",
                        "current": current,
                        "total": total_count,
                        "errors": errors_count,
                        "moved": moved_count,
                        "message": "Batch move failed due to an internal error",
                        "current_item": None,
                        "recent_errors": self._batch_move_progress.get("recent_errors", []) if run_id == self._batch_move_run_id else [],
                        "operation": operation,
                        "started_at": self._batch_move_progress.get("started_at") if run_id == self._batch_move_run_id else None,
                        "updated_at": time.time(),
                    }
                )
            finally:
                # Release this run's cancel-event reference so cancel_batch_move
                # can't operate on a stale event after the worker has exited.
                # Only clear when we're still the active run — a newer run
                # would have published its own event under the same lock.
                with self._batch_move_lock:
                    if (
                        self._batch_move_run_id == run_id
                        and self._batch_move_cancel_event is cancel_event
                    ):
                        self._batch_move_cancel_event = None

        background_tasks.add_task(run_batch_move)
        progress_verb = "Copying" if operation == "copy" else "Moving"
        return {
            "status": "started",
            "message": f"{progress_verb} {total_count} images in background",
            "total": total_count,
            "count": total_count,
            "operation": operation,
        }

    def start_sort_session(
        self,
        generators: Optional[Any] = None,
        tags: Optional[Any] = None,
        tag_mode: str = "and",
        ratings: Optional[Any] = None,
        checkpoints: Optional[Any] = None,
        loras: Optional[Any] = None,
        prompts: Optional[Any] = None,
        prompt_match_mode: str = "exact",
        artist: Optional[str] = None,
        search: Optional[str] = None,
        min_width: Optional[int] = None,
        max_width: Optional[int] = None,
        min_height: Optional[int] = None,
        max_height: Optional[int] = None,
        aspect_ratio: Optional[str] = None,
        min_aesthetic: Optional[float] = None,
        max_aesthetic: Optional[float] = None,
        folders: Optional[Any] = None,
        operation_mode: str = "move",
        replace_existing: bool = False,
        # v3.2.2 per-item exclude filters
        exclude_tags: Optional[Any] = None,
        exclude_generators: Optional[Any] = None,
        exclude_ratings: Optional[Any] = None,
        exclude_checkpoints: Optional[Any] = None,
        exclude_loras: Optional[Any] = None,
        # v3.3.1: per-slot collection ids ({key: collection_id|None}).
        collection_slots: Optional[Any] = None,
        # v3.3.2 Workbench: which culling/sorting mode to run ("slot" = WASD).
        mode: str = SORT_MODE_DEFAULT,
        # v3.3.x gallery-scope parity (trailing kwargs keep positional callers
        # working; None preserves pre-existing behavior exactly).
        min_user_rating: Optional[int] = None,
        brightness_min: Optional[float] = None,
        brightness_max: Optional[float] = None,
        color_temperature: Optional[str] = None,
        brightness_distribution: Optional[str] = None,
        exclude_prompts: Optional[Any] = None,
        exclude_colors: Optional[Any] = None,
        collection_id: Optional[int] = None,
        folder: Optional[str] = None,
        has_metadata: Optional[bool] = None,
    ) -> Dict[str, Any]:
        """Start a manual sort session."""
        operation_mode = self._validate_file_operation(operation_mode)
        normalized_mode = str(mode or SORT_MODE_DEFAULT).strip().lower()
        if normalized_mode not in VALID_SORT_MODES:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid sort mode. Must be one of: {', '.join(VALID_SORT_MODES)}",
            )
        # Validate aspect_ratio
        if aspect_ratio is not None and aspect_ratio not in VALID_ASPECT_RATIOS:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid aspect_ratio. Must be one of: {', '.join(VALID_ASPECT_RATIOS)}"
            )

        with self._sort_session_lock:
            has_active_session = bool(self._sort_session.get("active")) and int(self._sort_session.get("current_index", 0) or 0) < len(self._sort_session.get("image_ids", []) or [])
        if has_active_session and not replace_existing:
            raise HTTPException(
                status_code=409,
                detail="An unfinished manual sort session already exists. Resume it or explicitly start a new session.",
            )

        # Validate dimension ranges
        if min_width is not None and max_width is not None and min_width > max_width:
            raise HTTPException(status_code=400, detail="min_width cannot be greater than max_width")
        if min_height is not None and max_height is not None and min_height > max_height:
            raise HTTPException(status_code=400, detail="min_height cannot be greater than max_height")
        if min_aesthetic is not None and max_aesthetic is not None and min_aesthetic > max_aesthetic:
            raise HTTPException(status_code=400, detail="min_aesthetic cannot be greater than max_aesthetic")
        normalized_prompt_match_mode = str(prompt_match_mode or "exact").strip().lower()
        if normalized_prompt_match_mode not in VALID_PROMPT_MATCH_MODES:
            raise HTTPException(status_code=400, detail="prompt_match_mode must be exact or contains")
        normalized_tag_mode = str(tag_mode or "and").strip().lower()
        if normalized_tag_mode not in {"and", "or"}:
            raise HTTPException(status_code=400, detail="tag_mode must be and or or")

        gen_list = self._coerce_sort_filter_values(generators)
        tag_list = self._coerce_sort_filter_values(tags)
        rating_list = self._coerce_sort_filter_values(ratings)
        cp_list = self._coerce_sort_filter_values(checkpoints)
        lr_list = self._coerce_sort_filter_values(loras)
        prompt_list = self._coerce_sort_filter_values(prompts)
        artist_name = artist.strip() if artist else None
        search_query = search.strip() if search else None

        image_ids = db.get_filtered_image_ids(
            generators=gen_list,
            tags=tag_list,
            tag_mode=normalized_tag_mode,
            ratings=rating_list,
            checkpoints=cp_list,
            loras=lr_list,
            search_query=search_query,
            prompt_terms=prompt_list,
            prompt_match_mode=normalized_prompt_match_mode,
            artist=artist_name,
            min_width=min_width,
            max_width=max_width,
            min_height=min_height,
            max_height=max_height,
            aspect_ratio=aspect_ratio,
            min_aesthetic=min_aesthetic,
            max_aesthetic=max_aesthetic,
            exclude_tags=self._coerce_sort_filter_values(exclude_tags),
            exclude_generators=self._coerce_sort_filter_values(exclude_generators),
            exclude_ratings=self._coerce_sort_filter_values(exclude_ratings),
            exclude_checkpoints=self._coerce_sort_filter_values(exclude_checkpoints),
            exclude_loras=self._coerce_sort_filter_values(exclude_loras),
            exclude_prompts=self._coerce_sort_filter_values(exclude_prompts),
            exclude_colors=self._coerce_sort_filter_values(exclude_colors),
            min_user_rating=min_user_rating,
            brightness_min=brightness_min,
            brightness_max=brightness_max,
            color_temperature=color_temperature.strip() if color_temperature else None,
            brightness_distribution=brightness_distribution.strip() if brightness_distribution else None,
            collection_id=collection_id,
            folder=folder.strip() if folder else None,
            has_metadata=has_metadata,
        )
        # DB-level filter already excludes images marked unreadable.
        # Per-image verification runs lazily in get_current_sort_image so
        # starting a session doesn't stall on thousands of PIL decodes.

        folder_config = self._parse_sort_folders(folders)
        collection_slot_config = self._coerce_collection_slots(collection_slots)

        # Bracket starts the first candidate (index 0) as champion and the
        # second (index 1) as the first challenger. Slot mode starts at 0.
        initial_index = 1 if normalized_mode == SORT_MODE_BRACKET else 0

        with self._sort_session_lock:
            self._sort_session = self._coerce_sort_session_state({
                "active": True,
                "mode": normalized_mode,
                "image_ids": image_ids,
                "current_index": initial_index,
                "champion_index": 0,
                "folders": folder_config,
                "collection_slots": collection_slot_config,
                "operation_mode": operation_mode,
                "history": [],
                "redo_stack": [],
            })
            self._save_session_to_disk()

        first_image = db.get_image_by_id(image_ids[0]) if image_ids else None

        return {
            "status": "started",
            "total_images": len(image_ids),
            "current": first_image,
            "skipped_unreadable": [],
            "operation_mode": operation_mode,
            "mode": normalized_mode,
        }

    def _resolve_readable_sort_image(self, image_id: int) -> Optional[Dict[str, Any]]:
        """Return {image, tags} for a sortable image, or None if missing/unreadable.

        Marks the row unreadable as a side effect (mirrors the slot path's lazy
        verification) so the caller can advance past it.
        """
        current = db.get_image_by_id(image_id)
        if not current:
            return None
        current_path = self._resolve_image_path(current.get("path") or "")
        if not current_path:
            db.mark_image_unreadable(image_id, "File not found")
            return None
        readable, read_error = verify_image_readable(current_path)
        if not readable:
            db.mark_image_unreadable(image_id, read_error or "Unreadable image")
            return None
        return {"image": current, "tags": db.get_image_tags(image_id)}

    def _get_current_bracket_image(self) -> Dict[str, Any]:
        """Return the current champion/challenger pair for A/B bracket mode.

        Skips unreadable challengers (advance) and unreadable champions (the
        challenger is promoted uncontested), so the user never lands on a broken
        image — mirroring the slot path's lazy readability handling.
        """
        while True:
            with self._sort_session_lock:
                if not self._sort_session.get("active"):
                    return {
                        "active": False,
                        "done": True,
                        "mode": SORT_MODE_BRACKET,
                        "message": "No active sort session",
                        "champion": None,
                        "challenger": None,
                        "winner": None,
                        "total": 0,
                        "remaining": 0,
                        **self._get_sort_session_flags([], []),
                    }
                image_ids = self._sort_session["image_ids"]
                total = len(image_ids)
                champion_index = int(self._sort_session.get("champion_index", 0) or 0)
                challenger_index = int(self._sort_session.get("current_index", 0) or 0)
                history_snapshot = list(self._sort_session.get("history", []))
                redo_snapshot = list(self._sort_session.get("redo_stack", []))

            if total == 0 or challenger_index >= total:
                winner_payload = None
                if total and 0 <= champion_index < total:
                    winner_payload = self._resolve_readable_sort_image(image_ids[champion_index])
                return {
                    "active": True,
                    "done": True,
                    "mode": SORT_MODE_BRACKET,
                    "winner": winner_payload,
                    "champion": winner_payload,
                    "challenger": None,
                    "total": total,
                    "remaining": 0,
                    "message": "Bracket complete" if winner_payload else "No images to compare",
                    **self._get_sort_session_flags(history_snapshot, redo_snapshot),
                }

            champion = self._resolve_readable_sort_image(image_ids[champion_index])
            if champion is None:
                # Champion is broken → the current challenger takes the crown.
                with self._sort_session_lock:
                    self._sort_session["champion_index"] = challenger_index
                    self._sort_session["current_index"] = challenger_index + 1
                    self._save_session_to_disk()
                continue

            challenger = self._resolve_readable_sort_image(image_ids[challenger_index])
            if challenger is None:
                with self._sort_session_lock:
                    self._sort_session["current_index"] = challenger_index + 1
                    self._save_session_to_disk()
                continue

            return {
                "active": True,
                "done": False,
                "mode": SORT_MODE_BRACKET,
                "champion": champion,
                "challenger": challenger,
                "champion_index": champion_index,
                "challenger_index": challenger_index,
                "index": challenger_index,
                "total": total,
                "comparisons_total": max(0, total - 1),
                "remaining": total - challenger_index,
                "image_ids": list(image_ids),
                **self._get_sort_session_flags(history_snapshot, redo_snapshot),
            }

    def _bracket_action(self, action: str) -> Dict[str, Any]:
        """Apply an A/B bracket action (champion/challenger/skip/undo/redo)."""
        if action not in VALID_BRACKET_ACTIONS:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid bracket action. Must be one of: {', '.join(VALID_BRACKET_ACTIONS)}",
            )

        with self._sort_session_lock:
            if not self._sort_session.get("active"):
                raise HTTPException(status_code=400, detail="No active sort session")

            total = len(self._sort_session["image_ids"])
            champion_index = int(self._sort_session.get("champion_index", 0) or 0)
            challenger_index = int(self._sort_session.get("current_index", 0) or 0)
            history = self._sort_session.setdefault("history", [])
            redo_stack = self._sort_session.setdefault("redo_stack", [])

            if action == "undo":
                if not history:
                    return {"status": "nothing_to_undo", **self._get_sort_session_flags(history, redo_stack)}
                last = history.pop()
                redo_stack.append(last)
                self._sort_session["champion_index"] = int(last.get("prev_champion_index", 0))
                self._sort_session["current_index"] = int(last.get("prev_challenger_index", 0))
                self._save_session_to_disk()
                return {"status": "undone", **self._get_sort_session_flags(history, redo_stack)}

            if action == "redo":
                if not redo_stack:
                    return {"status": "nothing_to_redo", **self._get_sort_session_flags(history, redo_stack)}
                entry = redo_stack.pop()
                prev_challenger = int(entry.get("prev_challenger_index", 0))
                if entry.get("action") == "challenger":
                    self._sort_session["champion_index"] = prev_challenger
                else:  # champion / skip → champion stays
                    self._sort_session["champion_index"] = int(entry.get("prev_champion_index", 0))
                self._sort_session["current_index"] = prev_challenger + 1
                history.append(entry)
                self._save_session_to_disk()
                return {"status": "redone", **self._get_sort_session_flags(history, redo_stack)}

            # Forward action.
            if challenger_index >= total:
                raise HTTPException(status_code=400, detail="Bracket already complete")
            entry = {
                "action": action,
                "mode": SORT_MODE_BRACKET,
                "prev_champion_index": champion_index,
                "prev_challenger_index": challenger_index,
            }
            if action == "challenger":
                self._sort_session["champion_index"] = challenger_index
            # champion / skip: champion stays
            self._sort_session["current_index"] = challenger_index + 1
            history.append(entry)
            # A fresh forward choice invalidates any redo branch.
            self._sort_session["redo_stack"] = []
            self._save_session_to_disk()

            new_challenger = self._sort_session["current_index"]
            return {
                "status": "ok",
                "done": new_challenger >= total,
                "mode": SORT_MODE_BRACKET,
                "champion_index": self._sort_session["champion_index"],
                "challenger_index": new_challenger,
                **self._get_sort_session_flags(history, self._sort_session["redo_stack"]),
            }

    @staticmethod
    def _cull_decisions_from_history(history: List[Dict[str, Any]]) -> Dict[str, str]:
        """Map image_id → final keep/reject decision from cull history.

        Lets a resumed cull session rebuild its client-side decision map so the
        keep/reject routing at finish covers decisions made before a reload
        (history is the server-side source of truth). Later entries win; skips
        are not decisions, so they are omitted.
        """
        decisions: Dict[str, str] = {}
        for entry in history or []:
            action = entry.get("action")
            image_id = entry.get("image_id")
            if image_id is None or action not in ("keep", "reject"):
                continue
            decisions[str(image_id)] = action
        return decisions

    def _get_current_cull_image(self) -> Dict[str, Any]:
        """Return the current single image for 留/汰 Keep-Reject (cull) mode.

        Walks past unreadable images (marking them) so the user never lands on a
        broken file — mirroring the slot/bracket lazy readability handling. Keep
        and reject decisions live in the session history (non-destructive: the
        frontend routes kept→Collection / rejected→opt-in target at finish), so
        the kept/rejected tallies are derived from history.
        """
        while True:
            with self._sort_session_lock:
                if not self._sort_session.get("active"):
                    return {
                        "active": False,
                        "done": True,
                        "mode": SORT_MODE_CULL,
                        "message": "No active sort session",
                        "image": None,
                        "index": 0,
                        "total": 0,
                        "remaining": 0,
                        "kept": 0,
                        "rejected": 0,
                        "decisions": {},
                        **self._get_sort_session_flags([], []),
                    }
                image_ids = self._sort_session["image_ids"]
                total = len(image_ids)
                current_index = int(self._sort_session.get("current_index", 0) or 0)
                history_snapshot = list(self._sort_session.get("history", []))
                redo_snapshot = list(self._sort_session.get("redo_stack", []))

            kept = sum(1 for h in history_snapshot if h.get("action") == "keep")
            rejected = sum(1 for h in history_snapshot if h.get("action") == "reject")
            decisions = self._cull_decisions_from_history(history_snapshot)

            if total == 0 or current_index >= total:
                return {
                    "active": True,
                    "done": True,
                    "mode": SORT_MODE_CULL,
                    "image": None,
                    "index": min(current_index, total),
                    "total": total,
                    "remaining": 0,
                    "kept": kept,
                    "rejected": rejected,
                    "message": "Cull complete" if total else "No images to cull",
                    "decisions": decisions,
                    **self._get_sort_session_flags(history_snapshot, redo_snapshot),
                }

            current = self._resolve_readable_sort_image(image_ids[current_index])
            if current is None:
                with self._sort_session_lock:
                    self._sort_session["current_index"] = current_index + 1
                    self._save_session_to_disk()
                continue

            return {
                "active": True,
                "done": False,
                "mode": SORT_MODE_CULL,
                "image": current,
                "index": current_index,
                "total": total,
                "remaining": total - current_index,
                "kept": kept,
                "rejected": rejected,
                "image_ids": list(image_ids),
                "decisions": decisions,
                **self._get_sort_session_flags(history_snapshot, redo_snapshot),
            }

    def _cull_action(self, action: str) -> Dict[str, Any]:
        """Apply a 留/汰 cull action (keep/reject/skip/undo/redo).

        Non-destructive: keep/reject only record the decision + advance the
        cursor; routing kept→Collection / rejected→opt-in target happens
        client-side at finish (mirrors the bracket winner routing). Decisions
        live in history so undo/redo restore both the cursor and the tally.
        """
        if action not in VALID_CULL_ACTIONS:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid cull action. Must be one of: {', '.join(VALID_CULL_ACTIONS)}",
            )

        with self._sort_session_lock:
            if not self._sort_session.get("active"):
                raise HTTPException(status_code=400, detail="No active sort session")

            image_ids = self._sort_session["image_ids"]
            total = len(image_ids)
            current_index = int(self._sort_session.get("current_index", 0) or 0)
            history = self._sort_session.setdefault("history", [])
            redo_stack = self._sort_session.setdefault("redo_stack", [])

            if action == "undo":
                if not history:
                    return {"status": "nothing_to_undo", **self._get_sort_session_flags(history, redo_stack)}
                last = history.pop()
                redo_stack.append(last)
                self._sort_session["current_index"] = int(last.get("prev_index", 0))
                self._save_session_to_disk()
                return {
                    "status": "undone",
                    "decision": last.get("action"),
                    "image_id": last.get("image_id"),
                    **self._get_sort_session_flags(history, redo_stack),
                }

            if action == "redo":
                if not redo_stack:
                    return {"status": "nothing_to_redo", **self._get_sort_session_flags(history, redo_stack)}
                entry = redo_stack.pop()
                self._sort_session["current_index"] = int(entry.get("prev_index", 0)) + 1
                history.append(entry)
                self._save_session_to_disk()
                return {
                    "status": "redone",
                    "decision": entry.get("action"),
                    "image_id": entry.get("image_id"),
                    **self._get_sort_session_flags(history, redo_stack),
                }

            # Forward action (keep / reject / skip).
            if current_index >= total:
                raise HTTPException(status_code=400, detail="Cull already complete")
            image_id = image_ids[current_index]
            entry = {
                "action": action,
                "mode": SORT_MODE_CULL,
                "image_id": image_id,
                "prev_index": current_index,
            }
            self._sort_session["current_index"] = current_index + 1
            history.append(entry)
            # A fresh forward choice invalidates any redo branch.
            self._sort_session["redo_stack"] = []
            self._save_session_to_disk()

            new_index = self._sort_session["current_index"]
            kept = sum(1 for h in history if h.get("action") == "keep")
            rejected = sum(1 for h in history if h.get("action") == "reject")
            return {
                "status": "ok",
                "done": new_index >= total,
                "mode": SORT_MODE_CULL,
                "decision": action,
                "image_id": image_id,
                "index": new_index,
                "total": total,
                "kept": kept,
                "rejected": rejected,
                **self._get_sort_session_flags(history, self._sort_session["redo_stack"]),
            }

    def get_current_sort_image(self) -> Dict[str, Any]:
        """Get the current image in the sort session."""
        with self._sort_session_lock:
            is_bracket = (
                bool(self._sort_session.get("active"))
                and self._sort_session.get("mode") == SORT_MODE_BRACKET
            )
        if is_bracket:
            return self._get_current_bracket_image()
        with self._sort_session_lock:
            is_cull = (
                bool(self._sort_session.get("active"))
                and self._sort_session.get("mode") == SORT_MODE_CULL
            )
        if is_cull:
            return self._get_current_cull_image()
        while True:
            with self._sort_session_lock:
                if not self._sort_session["active"]:
                    return {
                        "active": False,
                        "done": True,
                        "message": "No active sort session",
                        "mode": SORT_MODE_DEFAULT,
                        "image": None,
                        "tags": [],
                        "index": 0,
                        "total": 0,
                        "remaining": 0,
                        "image_ids": [],
                        "folders": {},
                        "collection_slots": {},
                        "operation_mode": "move",
                        **self._get_sort_session_flags([], []),
                    }

                image_ids = self._sort_session["image_ids"]
                if self._sort_session["current_index"] >= len(image_ids):
                    return {
                        "done": True,
                        "message": "All images sorted",
                        "mode": self._sort_session.get("mode", SORT_MODE_DEFAULT),
                    }

                current_id = image_ids[self._sort_session["current_index"]]
                current_index = self._sort_session["current_index"]
                history_snapshot = list(self._sort_session["history"])

            current = db.get_image_by_id(current_id)
            if not current:
                with self._sort_session_lock:
                    self._sort_session["current_index"] += 1
                    self._save_session_to_disk()
                continue

            current_path = self._resolve_image_path(current.get("path") or "")
            if not current_path:
                db.mark_image_unreadable(current_id, "File not found")
                with self._sort_session_lock:
                    self._sort_session["current_index"] += 1
                    self._save_session_to_disk()
                continue

            readable, read_error = verify_image_readable(current_path)
            if not readable:
                db.mark_image_unreadable(current_id, read_error or "Unreadable image")
                with self._sort_session_lock:
                    self._sort_session["current_index"] += 1
                    self._save_session_to_disk()
                continue

            tags = db.get_image_tags(current_id)

            return {
                "image": current,
                "tags": tags,
                "mode": self._sort_session.get("mode", SORT_MODE_DEFAULT),
                "index": current_index,
                "total": len(image_ids),
                "remaining": len(image_ids) - current_index,
                "image_ids": list(image_ids),
                "folders": dict(self._sort_session["folders"]),
                "collection_slots": dict(self._sort_session.get("collection_slots", {})),
                "operation_mode": self._sort_session.get("operation_mode", "move"),
                **self._get_sort_session_flags(history_snapshot, self._sort_session.get("redo_stack", [])),
            }

    def sort_action(
        self,
        action: str,
        folder_key: Optional[str] = None
    ) -> Dict[str, Any]:
        """Perform a sort action.

        Slot mode: move, skip, undo, redo, collect. Bracket mode dispatches to
        the A/B handler (champion, challenger, skip, undo, redo).
        """
        with self._sort_session_lock:
            is_bracket = (
                bool(self._sort_session.get("active"))
                and self._sort_session.get("mode") == SORT_MODE_BRACKET
            )
        if is_bracket:
            return self._bracket_action(action)

        with self._sort_session_lock:
            is_cull = (
                bool(self._sort_session.get("active"))
                and self._sort_session.get("mode") == SORT_MODE_CULL
            )
        if is_cull:
            return self._cull_action(action)

        if action not in VALID_SORT_ACTIONS:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid action. Must be one of: {', '.join(VALID_SORT_ACTIONS)}"
            )

        with self._sort_session_lock:
            if not self._sort_session["active"]:
                raise HTTPException(status_code=400, detail="No active sort session")

            image_ids = self._sort_session["image_ids"]
            operation_mode = self._sort_session.get("operation_mode", "move")

            if action == "undo":
                if self._sort_session["history"]:
                    last = self._sort_session["history"].pop()
                    self._sort_session.setdefault("redo_stack", []).append(last)
                    undone_action = last.get("action")
                    undone_folder_key = last.get("folder_key")
                    if last["action"] == "move":
                        image = db.get_image_by_id(last["image_id"])
                        if image:
                            try:
                                self._undo_file_operation(last)
                            except Exception as e:
                                # Roll the session state back so the user can
                                # retry undo on the same entry. Previously this
                                # silently swallowed the failure and reported
                                # ``status: "undone"`` while the file was
                                # actually still in the destination folder.
                                logger.error(
                                    "Error undoing %s during undo: %s",
                                    last.get("operation") or "move",
                                    e,
                                )
                                self._sort_session["redo_stack"].pop()
                                self._sort_session["history"].append(last)
                                raise HTTPException(
                                    status_code=500,
                                    detail=f"Could not undo last action: {e}",
                                )
                    elif last["action"] == "collect":
                        # v3.3.1: collect adds a membership reference (no file
                        # move). Undo removes that membership. A missing/invalid
                        # collection id can't be reversed; roll the session back
                        # so the user can retry rather than silently advancing.
                        try:
                            self._undo_collect_action(last)
                        except Exception as e:
                            logger.error(
                                "Error undoing collect for image %s: %s",
                                last.get("image_id"),
                                e,
                            )
                            self._sort_session["redo_stack"].pop()
                            self._sort_session["history"].append(last)
                            raise HTTPException(
                                status_code=500,
                                detail=f"Could not undo last action: {e}",
                            )
                    self._sort_session["current_index"] = max(0, self._sort_session["current_index"] - 1)
                else:
                    return {
                        "status": "no_history",
                        "message": "Nothing to undo",
                        "operation_mode": operation_mode,
                        **self._get_sort_session_flags(),
                    }

                session_flags = self._get_sort_session_flags()

                if self._sort_session["current_index"] < len(image_ids):
                    current_id = image_ids[self._sort_session["current_index"]]
                    current_index = self._sort_session["current_index"]
                    self._save_session_to_disk()
                else:
                    return {
                        "status": "undone",
                        "current_index": self._sort_session["current_index"],
                        "undone_action": undone_action,
                        "folder_key": undone_folder_key,
                        "operation_mode": operation_mode,
                        **session_flags,
                    }

                current = db.get_image_by_id(current_id)
                if not current:
                    current = {"id": current_id, "path": None}
                current_tags = db.get_image_tags(current_id) if current else []
                return {
                    "status": "undone",
                    "undone_action": undone_action,
                    "folder_key": undone_folder_key,
                    "image": current,
                    "tags": current_tags,
                    "index": current_index,
                    "total": len(image_ids),
                    "remaining": len(image_ids) - current_index,
                    "image_ids": list(image_ids),
                    "folders": dict(self._sort_session["folders"]),
                    "operation_mode": operation_mode,
                    **session_flags,
                }

            if action == "redo":
                redo_stack = self._sort_session.setdefault("redo_stack", [])
                if not redo_stack:
                    return {
                        "status": "no_redo",
                        "message": "Nothing to redo",
                        "operation_mode": operation_mode,
                        **self._get_sort_session_flags(),
                    }

                redo_entry = redo_stack.pop()
                redone_action = redo_entry.get("action")
                redone_folder_key = redo_entry.get("folder_key")
                target_id = redo_entry.get("image_id")
                entry_operation = self._validate_file_operation(redo_entry.get("operation") or operation_mode)

                if redone_action == "move":
                    folder = self._sort_session["folders"].get(redone_folder_key)
                    if not folder:
                        redo_stack.append(redo_entry)
                        return {
                            "error": f"Folder {str(redone_folder_key).upper()} is not configured",
                            "operation_mode": operation_mode,
                            **self._get_sort_session_flags(),
                        }

                    target_image = db.get_image_by_id(target_id) if target_id is not None else None
                    target_path = self._resolve_image_path(target_image.get("path") or "") if target_image else None
                    if not target_image or not target_path:
                        redo_stack.append(redo_entry)
                        return {
                            "error": "Image file not found on disk",
                            "operation_mode": operation_mode,
                            **self._get_sort_session_flags(),
                        }

                    try:
                        operation_result = self._apply_file_operation(
                            operation=entry_operation,
                            image_id=target_image["id"],
                            destination_folder=folder,
                            source_path=target_path,
                            source_row=target_image,
                        )
                        redo_entry["new_path"] = operation_result["new_path"]
                        redo_entry["copied_image_id"] = operation_result.get("new_image_id")
                    except Exception as e:
                        logger.error("Redo %s failed for image %s: %s", entry_operation, target_id, e)
                        redo_stack.append(redo_entry)
                        return {
                            "error": f"Failed to redo {entry_operation}",
                            "operation_mode": operation_mode,
                            **self._get_sort_session_flags(),
                        }
                elif redone_action == "collect":
                    # v3.3.1: re-add the membership reference (no file move).
                    collection_id = redo_entry.get("collection_id")
                    try:
                        if collection_id is not None and target_id is not None:
                            db.set_collection_membership(int(collection_id), int(target_id), True)
                    except Exception as e:
                        logger.error(
                            "Redo collect failed for image %s into collection %s: %s",
                            target_id,
                            collection_id,
                            e,
                        )
                        redo_stack.append(redo_entry)
                        return {
                            "error": "Failed to redo collect",
                            "operation_mode": operation_mode,
                            **self._get_sort_session_flags(),
                        }

                self._sort_session["history"].append(redo_entry)
                self._sort_session["current_index"] += 1
                session_flags = self._get_sort_session_flags()

                if self._sort_session["current_index"] >= len(image_ids):
                    self._save_session_to_disk()
                    return {
                        "status": "redone",
                        "done": True,
                        "message": "All images sorted",
                        "redone_action": redone_action,
                        "folder_key": redone_folder_key,
                        "operation_mode": operation_mode,
                        **session_flags,
                    }

                next_id = image_ids[self._sort_session["current_index"]]
                next_index = self._sort_session["current_index"]
                self._save_session_to_disk()

                next_image = db.get_image_by_id(next_id)
                next_tags = db.get_image_tags(next_id) if next_image else []

                return {
                    "status": "redone",
                    "redone_action": redone_action,
                    "folder_key": redone_folder_key,
                    "image": next_image,
                    "tags": next_tags,
                    "index": next_index,
                    "total": len(image_ids),
                    "remaining": len(image_ids) - next_index,
                    "image_ids": list(image_ids),
                    "folders": dict(self._sort_session["folders"]),
                    "operation_mode": operation_mode,
                    **session_flags,
                }

            if self._sort_session["current_index"] >= len(image_ids):
                return {"done": True, "operation_mode": operation_mode}

            current_id = image_ids[self._sort_session["current_index"]]
            current_index = self._sort_session["current_index"]

            if action == "move" and not folder_key:
                return {
                    "error": "Folder key is required for move",
                    "operation_mode": operation_mode,
                    **self._get_sort_session_flags(),
                }

            if action == "collect" and not folder_key:
                return {
                    "error": "Folder key is required for collect",
                    "operation_mode": operation_mode,
                    **self._get_sort_session_flags(),
                }

            if action == "move" and folder_key:
                folder = self._sort_session["folders"].get(folder_key)
            else:
                folder = None

            current = db.get_image_by_id(current_id)
            if not current:
                self._sort_session["current_index"] += 1
                self._save_session_to_disk()
                # Skip missing images: fetch next
                session_flags = self._get_sort_session_flags()
                if self._sort_session["current_index"] >= len(image_ids):
                    return {"done": True, "message": "All images sorted", "operation_mode": operation_mode, **session_flags}
                next_id = image_ids[self._sort_session["current_index"]]
                next_index = self._sort_session["current_index"]
                next_image = db.get_image_by_id(next_id)
                next_tags = db.get_image_tags(next_id) if next_image else []
                return {
                    "image": next_image,
                    "tags": next_tags,
                    "index": next_index,
                    "total": len(image_ids),
                    "remaining": len(image_ids) - next_index,
                    "operation_mode": operation_mode,
                    **session_flags,
                }

            if action == "move" and folder_key:
                if not folder:
                    return {
                        "error": f"Folder {folder_key.upper()} is not configured",
                        "operation_mode": operation_mode,
                        **self._get_sort_session_flags(),
                    }
                current_path = self._resolve_image_path(current.get("path") or "")
                if not current_path:
                    return {
                        "error": "Image file not found on disk",
                        "operation_mode": operation_mode,
                        **self._get_sort_session_flags(),
                    }
                try:
                    original_path = current_path
                    operation_result = self._apply_file_operation(
                        operation=operation_mode,
                        image_id=current["id"],
                        destination_folder=folder,
                        source_path=current_path,
                        source_row=current,
                    )
                    self._sort_session["redo_stack"] = []
                    self._sort_session["history"].append({
                        "action": "move",
                        "operation": operation_mode,
                        "image_id": current["id"],
                        "original_path": original_path,
                        "original_folder": os.path.dirname(original_path),
                        "new_path": operation_result["new_path"],
                        "copied_image_id": operation_result.get("new_image_id"),
                        "folder_key": folder_key
                    })
                except Exception as e:
                    logger.error("Sort %s failed for image %d: %s", operation_mode, current["id"], e)
                    return {
                        "error": f"Failed to {operation_mode} image",
                        "operation_mode": operation_mode,
                        **self._get_sort_session_flags(),
                    }
            elif action == "collect":
                # v3.3.1: add the current image to the slot's collection BY
                # REFERENCE. No file is moved/copied — the file stays in place
                # and only a membership row is written, mirroring how the
                # gallery heart/Favorites toggle works.
                collection_id = self._sort_session.get("collection_slots", {}).get(folder_key)
                if not collection_id:
                    return {
                        "error": f"Slot {folder_key.upper()} is not assigned to a collection",
                        "operation_mode": operation_mode,
                        **self._get_sort_session_flags(),
                    }
                try:
                    db.set_collection_membership(int(collection_id), current["id"], True)
                except ValueError as e:
                    logger.error(
                        "Collect failed for image %d into collection %s: %s",
                        current["id"],
                        collection_id,
                        e,
                    )
                    return {
                        "error": "Failed to add image to collection",
                        "operation_mode": operation_mode,
                        **self._get_sort_session_flags(),
                    }
                except Exception as e:
                    logger.error(
                        "Collect failed for image %d into collection %s: %s",
                        current["id"],
                        collection_id,
                        e,
                    )
                    return {
                        "error": "Failed to add image to collection",
                        "operation_mode": operation_mode,
                        **self._get_sort_session_flags(),
                    }
                self._sort_session["redo_stack"] = []
                self._sort_session["history"].append({
                    "action": "collect",
                    "image_id": current["id"],
                    "collection_id": int(collection_id),
                    "folder_key": folder_key,
                })
            elif action == "skip":
                self._sort_session["redo_stack"] = []
                self._sort_session["history"].append({
                    "action": "skip",
                    "image_id": current["id"]
                })

            self._sort_session["current_index"] += 1
            session_flags = self._get_sort_session_flags()

            if self._sort_session["current_index"] >= len(image_ids):
                self._save_session_to_disk()
                return {"done": True, "message": "All images sorted", "operation_mode": operation_mode, **session_flags}

            next_id = image_ids[self._sort_session["current_index"]]
            next_index = self._sort_session["current_index"]
            self._save_session_to_disk()

            next_image = db.get_image_by_id(next_id)
            next_tags = db.get_image_tags(next_id) if next_image else []

            return {
                "image": next_image,
                "tags": next_tags,
                "index": next_index,
                "total": len(image_ids),
                "remaining": len(image_ids) - next_index,
                "operation_mode": operation_mode,
                **session_flags,
            }

    def set_sort_folders(self, config: FolderConfig) -> Dict[str, Any]:
        """Set folder destinations (and optional per-slot collections) for sort keys."""
        normalized_folders = dict(config.folders)
        for key, path in config.folders.items():
            if path:
                normalized_path = normalize_user_path(path)
                is_valid, error = validate_folder_path(normalized_path, allow_create=True)
                if not is_valid:
                    raise HTTPException(status_code=400, detail=error or f"Invalid folder path for key '{key}'")
                try:
                    os.makedirs(normalized_path, exist_ok=True)
                except OSError as exc:
                    raise HTTPException(status_code=400, detail=f"Cannot create folder for key '{key}': {exc}") from exc
                normalized_folders[key] = normalized_path

        # v3.3.1: collection_slots is optional. When provided, validate that
        # each referenced collection actually exists so a stale id can't be
        # silently stored and then no-op at collect time.
        collection_slots = self._validate_collection_slots(config.collection_slots)

        with self._sort_session_lock:
            self._sort_session["folders"] = normalized_folders
            if config.collection_slots is not None:
                self._sort_session["collection_slots"] = collection_slots
            self._save_session_to_disk()
            stored_slots = dict(self._sort_session.get("collection_slots", {}))
        return {"status": "ok", "folders": normalized_folders, "collection_slots": stored_slots}

    def _validate_collection_slots(self, slots: Optional[Any]) -> Dict[str, Optional[int]]:
        """Coerce + verify per-slot collection ids; unknown ids raise a 400."""
        normalized = self._coerce_collection_slots(slots)
        for key, collection_id in normalized.items():
            if collection_id is not None and not db.collection_exists(int(collection_id)):
                raise HTTPException(
                    status_code=400,
                    detail=f"Collection {collection_id} for slot '{key}' does not exist",
                )
        return normalized

    def get_sort_folders(self) -> Dict[str, Any]:
        """Get current folder configuration (and per-slot collections)."""
        with self._sort_session_lock:
            return {
                "folders": self._sort_session["folders"],
                "collection_slots": dict(self._sort_session.get("collection_slots", {})),
            }

    def clear_sort_session(self) -> Dict[str, str]:
        """Clear the current sort session."""
        with self._sort_session_lock:
            self._sort_session = self._build_default_sort_session_state()
        remove_session_files(self._get_session_file_candidates())
        return {'status': 'ok'}

    def clear_gallery(self) -> Dict[str, str]:
        """Clear all image records from the database.

        Tags are removed automatically via ON DELETE CASCADE foreign key.
        """
        with db.get_db() as conn:
            cursor = conn.cursor()
            cursor.execute("DELETE FROM images")
        return {"status": "ok", "message": "Gallery cleared"}

    def get_analytics(
        self,
        facet: Optional[str] = None,
        search_query: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Get all tags, checkpoints, and loras with counts."""
        normalized_facet = str(facet or "").strip().lower()
        if normalized_facet in {"checkpoint", "checkpoints"}:
            return {"checkpoints": db.get_all_checkpoints(limit=limit, search_query=search_query)}
        if normalized_facet in {"lora", "loras"}:
            return db.get_all_loras(limit=limit, search_query=search_query)
        if normalized_facet in {"tag", "tags"}:
            return {"top_tags": db.search_tags(search_query, limit=limit).get("tags", [])}

        effective_limit = ANALYTICS_DEFAULT_LIMIT if limit is None else limit

        with db.get_db() as conn:
            cursor = conn.cursor()

            # Use the normalized image_loras table instead of full-table JSON scan
            cursor.execute("""
                SELECT lora_name AS lora, COUNT(*) as count
                FROM image_loras
                GROUP BY lora_name
                ORDER BY count DESC
                LIMIT ?
            """, (effective_limit,))
            loras = [dict(row) for row in cursor.fetchall()]

            tags = db.search_tags(None, limit=effective_limit).get("tags", [])

        return {
            "checkpoints": db.get_all_checkpoints(limit=effective_limit),
            "loras": loras,
            "top_tags": tags
        }

    def get_stats(self) -> Dict[str, Any]:
        """Get database statistics."""
        analytics_data = self.get_analytics(limit=STATS_FACET_LIMIT)
        metadata_status = db.get_metadata_status_counts()
        metadata_pending = int(metadata_status.get("pending", 0) or 0)
        scan_progress = self.get_scan_progress()
        return {
            "total_images": db.get_image_count(),
            "generators": db.get_all_generators(),
            "top_tags": analytics_data["top_tags"],
            "checkpoints": analytics_data["checkpoints"],
            "loras": analytics_data["loras"],
            "metadata_status": metadata_status,
            "metadata_pending": metadata_pending,
            "metadata_resolving": metadata_pending > 0,
            "scan_status": scan_progress.get("status"),
            "scan_step": scan_progress.get("step"),
            "scan_library_ready": bool(scan_progress.get("library_ready", False)),
            "app_version": APP_VERSION,
            "github_url": GITHUB_REPOSITORY_URL,
        }

    def get_library_health(self, sample_limit: int = 8) -> Dict[str, Any]:
        """Get a read-only library quality and archive-readiness report.

        v3.2.2: cached with a 60s TTL because the underlying SQL does
        ~10 SUM/COUNT aggregations and a duplicate-filename grouping
        across the whole ``images`` table. On a 71k-row library the
        first call takes ~12s of cold cache time. Without this cache,
        50 concurrent clients (the gallery view, the home page, the
        diagnostics panel, etc.) cause read timeouts because each
        request re-runs the same expensive scan.

        Cache keyed by ``sample_limit`` because that controls the
        number of sample rows returned in each section, and a request
        for sample_limit=25 should not be served a cached payload
        built with sample_limit=8.
        """
        return _get_library_health_cached(int(sample_limit))

    def resolve_drop(self, folder_name: str, filenames: List[str], dropped_files: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
        """Resolve browser-dropped folder name or filenames to a real filesystem path."""
        conn = db.get_connection()
        cursor = conn.cursor()

        files_info = dropped_files or []
        names = [f["name"] for f in files_info if f.get("name")] if files_info else filenames[:5]
        names = [n for n in names if n and isinstance(n, str)]

        if names:
            placeholders = ",".join("?" for _ in names)
            cursor.execute(
                f"SELECT path, filename, file_size FROM images WHERE filename IN ({placeholders})",
                names,
            )
            rows = cursor.fetchall()
            if rows:
                size_by_name = {}
                for f in files_info:
                    if f.get("name") and f.get("size"):
                        size_by_name[f["name"]] = int(f["size"])

                folder_scores: Dict[str, int] = {}
                for row in rows:
                    rpath = row[0] if isinstance(row, (tuple, list)) else row["path"]
                    rname = row[1] if isinstance(row, (tuple, list)) else row["filename"]
                    rsize = row[2] if isinstance(row, (tuple, list)) else row["file_size"]
                    parent = str(Path(rpath).parent)
                    expected_size = size_by_name.get(rname)
                    if expected_size and rsize and abs(int(rsize) - expected_size) < 2:
                        folder_scores[parent] = folder_scores.get(parent, 0) + 10
                    else:
                        folder_scores[parent] = folder_scores.get(parent, 0) + 1

                if folder_scores:
                    best = max(folder_scores, key=folder_scores.get)
                    return {"folder_path": best}

        if folder_name and self._is_safe_folder_segment(folder_name):
            like_segment = self._escape_like(folder_name)
            cursor.execute(
                "SELECT path FROM images WHERE path LIKE ? ESCAPE '\\' LIMIT 1",
                [f"%{os.sep}{like_segment}{os.sep}%"],
            )
            row = cursor.fetchone()
            if row:
                raw = row[0] if isinstance(row, (tuple, list)) else row["path"]
                raw = str(raw)
                sep = os.sep
                idx = raw.lower().find(sep + folder_name.lower() + sep)
                if idx >= 0:
                    return {"folder_path": raw[: idx + len(sep) + len(folder_name)]}

            for base in self._common_image_roots():
                candidate = (Path(base) / folder_name).resolve()
                # Defense in depth: candidate must stay under the root we picked.
                try:
                    candidate.relative_to(Path(base).resolve())
                except ValueError:
                    continue
                if candidate.is_dir():
                    return {"folder_path": str(candidate)}

        return {"folder_path": ""}

    @staticmethod
    def _is_safe_folder_segment(name: str) -> bool:
        """Reject browser-supplied folder names that could escape a base dir."""
        if not name or not isinstance(name, str):
            return False
        if name in {".", ".."}:
            return False
        # Path separators or drive markers indicate the caller is trying to
        # supply a multi-segment path, not a single folder name.
        if "/" in name or "\\" in name or ":" in name:
            return False
        # Any control char or NUL byte → reject.
        if any(ord(ch) < 32 for ch in name):
            return False
        return True

    @staticmethod
    def _escape_like(value: str) -> str:
        """Escape SQL LIKE wildcards so user input matches literally."""
        return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")

    async def import_uploaded_files(self, files) -> Dict[str, Any]:
        """Save uploaded files to imports dir and add them to the gallery.

        Path-traversal hardening: the browser-supplied filename is reduced to
        its basename via ``Path(name).name`` so values like ``../../etc/x.png``
        cannot escape ``import_dir``. After constructing ``dest`` we also
        verify it resolves underneath ``import_dir.resolve()`` as a defense in
        depth against weird Windows path semantics.
        """
        from config import DATA_DIR
        import_dir = (Path(DATA_DIR) / "imports").resolve()
        import_dir.mkdir(parents=True, exist_ok=True)

        IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"}
        saved_paths: List[Path] = []
        for upload in files:
            raw_name = upload.filename or ""
            ext = Path(raw_name).suffix.lower()
            if ext not in IMAGE_EXTS:
                continue
            # Basename only — strips any "../" or absolute paths the browser sent.
            safe_stem_name = Path(raw_name).name
            if not safe_stem_name or safe_stem_name in {".", ".."} or safe_stem_name.startswith("."):
                safe_stem_name = f"upload_{len(saved_paths)}{ext}"
            dest = (import_dir / safe_stem_name).resolve()
            counter = 1
            stem = Path(safe_stem_name).stem or "upload"
            while dest.exists():
                dest = (import_dir / f"{stem}_{counter}{ext}").resolve()
                counter += 1
            # Defense in depth: refuse anything that resolves outside import_dir.
            try:
                dest.relative_to(import_dir)
            except ValueError:
                logger.warning("Refusing upload with unsafe filename: %r", raw_name)
                continue
            content = await upload.read()
            dest.write_bytes(content)
            saved_paths.append(dest)

        records = []
        errors = 0
        image_ids = []
        for path in saved_paths:
            result = parse_metadata_job({
                "path": str(path),
                "filename": path.name,
                "compute_content_fingerprint": True,
                "validate_image_data": True,
            })
            if result.get("error"):
                errors += 1
            records.append(result["record"])

        if records:
            batch_result = add_images_batch(records, return_statuses=True)
            for path_str, status in (batch_result.get("statuses") or {}).items():
                image_ids.append(batch_result.get("ids", {}).get(path_str))

        return {
            "imported": len(records) - errors,
            "errors": errors,
            "total": len(records),
            "image_ids": [i for i in image_ids if i],
        }

    @staticmethod
    def _common_image_roots() -> List[str]:
        home = Path.home()
        roots = [
            home / "Pictures",
            home / "Desktop",
            home / "Downloads",
            home / "Documents",
        ]
        if platform.system() == "Windows":
            for drive in "CDEFGH":
                roots.append(Path(f"{drive}:\\"))
        return [str(r) for r in roots if r.exists()]

    def export_tags_batch(self, request) -> Dict[str, Any]:
        """Export tags for each image to individual .txt files."""
        id_chunks = None
        total = None
        selection_token = getattr(request, "selection_token", None)
        if selection_token:
            id_chunks = iter_selection_token_id_chunks(selection_token)
            total = count_selection_token_ids(selection_token)
        result = export_tags_batch_request(request, id_chunks=id_chunks, total=total)
        return {
            "status": "ok",
            "exported": result["exported"],
            "total": result["total"],
            "errors": result["error_messages"] if result["error_messages"] else None,
        }

    def load_session_from_disk(self) -> None:
        """Load persisted session from disk on startup."""
        try:
            for session_file in self._get_session_file_candidates():
                if not session_file.exists():
                    continue
                try:
                    data = read_persisted_session(session_file)

                    try:
                        session_version = self._parse_persisted_session_version(data)
                    except ValueError as exc:
                        self._discard_persisted_session_file(str(exc), paths=[session_file])
                        continue

                    if session_version not in {0, SORT_SESSION_SCHEMA_VERSION}:
                        self._discard_persisted_session_file(
                            f"unsupported session_schema_version={session_version} (current={SORT_SESSION_SCHEMA_VERSION})",
                            paths=[session_file],
                        )
                        continue

                    if not data.get('active'):
                        return

                    # Batch validate image IDs in a single query (N+1 fix)
                    image_ids = data.get('image_ids', [])
                    if image_ids:
                        with db.get_db() as conn:
                            cursor = conn.cursor()
                            placeholders = ','.join(['?' for _ in image_ids])
                            cursor.execute(f"SELECT id FROM images WHERE id IN ({placeholders})", image_ids)
                            valid_set = {row[0] for row in cursor.fetchall()}
                        valid_ids = [iid for iid in image_ids if iid in valid_set]
                    else:
                        valid_ids = []

                    if not valid_ids:
                        try:
                            session_file.unlink()
                        except OSError:
                            pass
                        return

                    original_index = data.get('current_index', 0)
                    try:
                        original_index = int(original_index)
                    except (TypeError, ValueError):
                        original_index = 0
                    original_index = max(0, min(original_index, len(image_ids)))

                    original_positions = {image_id: index for index, image_id in enumerate(image_ids)}
                    restored_history = self._filter_sort_actions(data.get('history', []), valid_set)
                    restored_redo_stack = self._filter_sort_actions(data.get('redo_stack', []), valid_set)
                    history_image_ids = {entry.get('image_id') for entry in restored_history}
                    restored_redo_stack = [
                        entry for entry in restored_redo_stack
                        if entry.get('image_id') not in history_image_ids
                    ]
                    restored_index = sum(1 for iid in image_ids[:original_index] if iid in valid_set)
                    restored_history = [
                        entry for entry in restored_history
                        if original_positions.get(entry.get('image_id'), len(image_ids)) < original_index
                    ]
                    restored_redo_stack = [
                        entry for entry in restored_redo_stack
                        if original_positions.get(entry.get('image_id'), -1) >= original_index
                    ]
                    restored_index = min(len(valid_ids), restored_index)
                    operation_mode = self._validate_file_operation(data.get('operation_mode', 'move'))

                    # Validate all folder paths loaded from JSON
                    validated_folders = {}
                    for key, path in data.get('folders', {}).items():
                        try:
                            normalized_path = normalize_user_path(path)
                            is_valid, _error = validate_folder_path(normalized_path, allow_create=True)
                            if is_valid:
                                validated_folders[key] = normalized_path
                            else:
                                logger.warning("Skipping invalid folder path for key %s", key)
                        except Exception:
                            logger.warning("Skipping invalid folder path for key %s", key)

                    with self._sort_session_lock:
                        self._sort_session = self._coerce_sort_session_state({
                            'active': True,
                            'image_ids': valid_ids,
                            'current_index': restored_index,
                            'folders': validated_folders,
                            # v3.3.1: restore per-slot collection mapping.
                            # Missing in legacy v0 files -> coerces to {}.
                            'collection_slots': data.get('collection_slots'),
                            'operation_mode': operation_mode,
                            'history': restored_history,
                            'redo_stack': restored_redo_stack,
                        })
                        self._save_session_to_disk()
                        preferred_session_file = self._get_session_file_candidates()[0]
                        if session_file != preferred_session_file and session_file.exists():
                            try:
                                session_file.unlink()
                            except OSError as exc:
                                logger.warning("Failed to remove legacy sort session file %s: %s", session_file, exc)
                    logger.info("Restored session: %d images", len(valid_ids))
                    return
                except Exception as e:
                    logger.warning("Failed to restore session from %s: %s", session_file, e)
        except Exception as e:
            logger.warning("Failed to restore session: %s", e)

    def _save_session_to_disk(self) -> None:
        """Persist session to disk."""
        try:
            data = self._build_persisted_sort_session_payload()
            session_file = self._get_session_file_candidates()[0]
            write_persisted_session(session_file, data)
        except Exception as e:
            logger.warning("Failed to save session to disk: %s", e)

    def browse_folder(self, path: str) -> Dict[str, Any]:
        """
        Browse a folder and list its subdirectories.

        Args:
            path: The folder path to browse. Empty string or "/" on Windows
                  lists drive letters. On Linux, empty string lists "/".

        Returns:
            Dictionary with current path, parent path, and subdirectories.
        """
        # Special case: empty path or root-like paths -> list root/drives
        if not path or path.strip() in ("", "/", "\\"):
            if platform.system() == "Windows":
                drives = []
                for letter in string.ascii_uppercase:
                    drive_path = f"{letter}:\\"
                    if os.path.exists(drive_path):
                        try:
                            has_children = any(
                                entry.is_dir()
                                for entry in os.scandir(drive_path)
                                if not entry.name.startswith(".")
                            )
                        except (PermissionError, OSError):
                            has_children = False
                        drives.append({
                            "name": f"{letter}:\\",
                            "path": drive_path,
                            "has_children": has_children,
                        })
                return {
                    "current": "",
                    "parent": None,
                    "subdirs": drives,
                }
            else:
                # Linux/macOS: list "/"
                path = "/"

        # Validate the folder path (must exist)
        normalized_path = normalize_user_path(path)
        is_valid, error = validate_folder_path(normalized_path)
        if not is_valid:
            raise HTTPException(
                status_code=400,
                detail=error or "Invalid folder path",
            )

        resolved = os.path.realpath(normalized_path)

        # Determine parent
        parent = os.path.dirname(resolved)
        if parent == resolved:
            # We are at root (e.g., "/" on Linux or "C:\" on Windows)
            if platform.system() == "Windows":
                parent_result: Optional[str] = ""  # signal to list drives
            else:
                parent_result = None  # no parent above "/"
        else:
            parent_result = parent

        # List subdirectories
        subdirs: List[Dict[str, Any]] = []
        try:
            with os.scandir(resolved) as entries:
                for entry in entries:
                    try:
                        if not entry.is_dir():
                            continue
                        if entry.name.startswith("."):
                            continue
                        try:
                            child_has_children = any(
                                sub.is_dir()
                                for sub in os.scandir(entry.path)
                                if not sub.name.startswith(".")
                            )
                        except (PermissionError, OSError):
                            child_has_children = False
                        subdirs.append({
                            "name": entry.name,
                            "path": entry.path,
                            "has_children": child_has_children,
                        })
                    except (PermissionError, OSError):
                        continue
        except (PermissionError, OSError) as exc:
            raise HTTPException(
                status_code=403,
                detail=f"Cannot read directory: {exc}",
            )

        # Sort alphabetically, case-insensitive
        subdirs.sort(key=lambda d: d["name"].lower())

        return {
            "current": resolved,
            "parent": parent_result,
            "subdirs": subdirs,
        }
