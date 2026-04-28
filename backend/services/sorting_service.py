"""
Sorting service for SD Image Sorter.

Handles business logic for scanning, moving, batch operations, and manual sort sessions.
"""
import logging
import os
import json
import platform
import string
import threading
import time
from pathlib import Path
from typing import Optional, List, Dict, Any

from fastapi import HTTPException, BackgroundTasks, Query
from pydantic import BaseModel, Field, ValidationError, field_validator

from config import MANUAL_SORT_SESSION_FILE
import database as db
from constants import VALID_ASPECT_RATIOS
from image_manager import scan_folder, move_image, copy_image
from metadata_parser import verify_image_readable
from services.state_compat import MutableStateProxy
from services.tag_export_service import export_tags_batch_request
from utils.path_validation import normalize_user_path, validate_folder_path
from utils.source_paths import resolve_existing_indexed_image_path

logger = logging.getLogger(__name__)


SESSION_FILE = MANUAL_SORT_SESSION_FILE
LEGACY_SESSION_FILE = os.path.join(os.path.dirname(__file__), '..', 'sort_session.json')
SORT_SESSION_SCHEMA_VERSION = 1

# Validation constants
DIMENSION_MIN = 1
DIMENSION_MAX = 100000
PATH_MAX_LENGTH = 4096
FOLDER_KEY_MAX_LENGTH = 100
BATCH_MOVE_FETCH_CHUNK = 500
SEARCH_MAX_LENGTH = 1000
VALID_SORT_ACTIONS = ["move", "skip", "undo", "redo"]
VALID_FILE_OPERATIONS = ["move", "copy"]


class ScanRequest(BaseModel):
    """Request model for folder scanning."""
    folder_path: str = Field(..., max_length=PATH_MAX_LENGTH)
    recursive: bool = True
    force_reparse: bool = False
    cleanup_missing: bool = False
    quick_import: bool = True

    @field_validator('folder_path')
    @classmethod
    def validate_folder_path_length(cls, v: str) -> str:
        if len(v) > PATH_MAX_LENGTH:
            raise ValueError(f'folder_path must be at most {PATH_MAX_LENGTH} characters')
        return v


class ValidatePathRequest(BaseModel):
    """Request model for path validation."""
    path: str = Field(..., max_length=PATH_MAX_LENGTH)

    @field_validator('path')
    @classmethod
    def validate_path_length(cls, v: str) -> str:
        if len(v) > PATH_MAX_LENGTH:
            raise ValueError(f'path must be at most {PATH_MAX_LENGTH} characters')
        return v


class MoveRequest(BaseModel):
    """Request model for image move operations."""
    image_ids: List[int] = Field(..., min_length=1, max_length=50000)
    destination_folder: str = Field(..., max_length=PATH_MAX_LENGTH)
    operation: str = Field(default="move")

    @field_validator('operation')
    @classmethod
    def validate_operation(cls, v: str) -> str:
        if v not in VALID_FILE_OPERATIONS:
            raise ValueError(f"operation must be one of: {', '.join(VALID_FILE_OPERATIONS)}")
        return v


class BatchMoveRequest(BaseModel):
    """Request model for batch move operations."""
    generators: Optional[List[str]] = None
    tags: Optional[List[str]] = None
    ratings: Optional[List[str]] = None
    checkpoints: Optional[List[str]] = None
    loras: Optional[List[str]] = None
    prompts: Optional[List[str]] = None
    artist: Optional[str] = Field(default=None, max_length=500)
    search: Optional[str] = Field(default=None, max_length=SEARCH_MAX_LENGTH)
    min_width: Optional[int] = Field(default=None, ge=DIMENSION_MIN, le=DIMENSION_MAX)
    max_width: Optional[int] = Field(default=None, ge=DIMENSION_MIN, le=DIMENSION_MAX)
    min_height: Optional[int] = Field(default=None, ge=DIMENSION_MIN, le=DIMENSION_MAX)
    max_height: Optional[int] = Field(default=None, ge=DIMENSION_MIN, le=DIMENSION_MAX)
    aspect_ratio: Optional[str] = None
    min_aesthetic: Optional[float] = Field(default=None, ge=0, le=10)
    max_aesthetic: Optional[float] = Field(default=None, ge=0, le=10)
    destination_folder: str = Field(..., max_length=PATH_MAX_LENGTH)
    operation: str = Field(default="move")

    @field_validator('aspect_ratio')
    @classmethod
    def validate_aspect_ratio_field(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        if v not in VALID_ASPECT_RATIOS:
            raise ValueError(f"aspect_ratio must be one of: {', '.join(VALID_ASPECT_RATIOS)}")
        return v

    @field_validator('max_width')
    @classmethod
    def validate_max_width(cls, v: Optional[int], info) -> Optional[int]:
        if v is not None and info.data.get('min_width') is not None and v < info.data['min_width']:
            raise ValueError('max_width cannot be less than min_width')
        return v

    @field_validator('max_height')
    @classmethod
    def validate_max_height(cls, v: Optional[int], info) -> Optional[int]:
        if v is not None and info.data.get('min_height') is not None and v < info.data['min_height']:
            raise ValueError('max_height cannot be less than min_height')
        return v

    @field_validator('max_aesthetic')
    @classmethod
    def validate_max_aesthetic(cls, v: Optional[float], info) -> Optional[float]:
        if v is not None and info.data.get('min_aesthetic') is not None and v < info.data['min_aesthetic']:
            raise ValueError('max_aesthetic cannot be less than min_aesthetic')
        return v

    @field_validator('operation')
    @classmethod
    def validate_operation(cls, v: str) -> str:
        if v not in VALID_FILE_OPERATIONS:
            raise ValueError(f"operation must be one of: {', '.join(VALID_FILE_OPERATIONS)}")
        return v


class FolderConfig(BaseModel):
    """Request model for folder configuration."""
    folders: Dict[str, str] = Field(...)

    @field_validator('folders')
    @classmethod
    def validate_folders(cls, v: Dict[str, str]) -> Dict[str, str]:
        for key, path in v.items():
            if len(key) > FOLDER_KEY_MAX_LENGTH:
                raise ValueError(f'Folder key "{key}" exceeds max length of {FOLDER_KEY_MAX_LENGTH}')
            if path and len(path) > PATH_MAX_LENGTH:
                raise ValueError(f'Path for key "{key}" exceeds max length of {PATH_MAX_LENGTH}')
        return v


class BrowseFolderRequest(BaseModel):
    """Request model for folder browsing."""
    path: str = Field(default="", max_length=PATH_MAX_LENGTH)


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
            "total_final": False,
            "errors": 0,
            "new": 0,
            "updated": 0,
            "removed": 0,
            "library_ready": False,
            "quick_import": True,
            "metadata_processed": 0,
            "metadata_total": 0,
            "message": "",
            "current_item": None,
            "started_at": None,
            "updated_at": None,
        }

    @staticmethod
    def _build_default_sort_session_state() -> Dict[str, Any]:
        """Return the canonical inactive manual-sort session payload."""
        return {
            "active": False,
            "image_ids": [],
            "current_index": 0,
            "folders": {},
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

    def _get_sort_history_counts(self, history: Optional[List[Dict[str, Any]]] = None) -> Dict[str, int]:
        """Summarize move/skip counts from the current manual-sort history."""
        active_history = history if history is not None else self._sort_session.get("history", [])
        sorted_count = sum(1 for item in active_history if item.get("action") == "move")
        skipped_count = sum(1 for item in active_history if item.get("action") == "skip")
        return {
            "sorted_count": sorted_count,
            "skipped_count": skipped_count,
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

    def _parse_sort_folders(self, folders: Optional[str]) -> Dict[str, str]:
        """Parse and validate manual-sort folder config from query params."""
        if not folders:
            return {}

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

    def _coerce_sort_session_state(self, session: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        """Normalize externally injected sort-session state onto the canonical shape."""
        coerced = self._build_default_sort_session_state()
        session = session or {}
        coerced["active"] = bool(session.get("active", False))
        coerced["image_ids"] = list(session.get("image_ids", []))
        coerced["folders"] = dict(session.get("folders", {}))
        coerced["history"] = list(session.get("history", []))
        coerced["redo_stack"] = list(session.get("redo_stack", []))
        coerced["operation_mode"] = self._validate_file_operation(session.get("operation_mode", "move"))

        try:
            current_index = int(session.get("current_index", 0) or 0)
        except (TypeError, ValueError):
            current_index = 0
        coerced["current_index"] = max(0, min(current_index, len(coerced["image_ids"])))
        return coerced

    def _build_persisted_sort_session_payload(self) -> Dict[str, Any]:
        """Return the on-disk manual-sort session payload."""
        session = self._coerce_sort_session_state(self._sort_session)
        return {
            "session_schema_version": SORT_SESSION_SCHEMA_VERSION,
            "active": session["active"],
            "current_index": session["current_index"],
            "folders": session["folders"],
            "operation_mode": session["operation_mode"],
            "history": session["history"],
            "redo_stack": session["redo_stack"],
            "image_ids": session["image_ids"],
        }

    @staticmethod
    def _parse_persisted_session_version(data: Dict[str, Any]) -> int:
        """Read the persisted schema version, treating missing versions as legacy v0."""
        raw_version = data.get("session_schema_version")
        if raw_version is None:
            return 0
        try:
            version = int(raw_version)
        except (TypeError, ValueError) as exc:
            raise ValueError("Invalid session_schema_version") from exc
        if version < 0:
            raise ValueError("Invalid session_schema_version")
        return version

    def _discard_persisted_session_file(self, reason: str, *, paths: Optional[List[Path]] = None) -> None:
        """Delete unusable persisted session files so future boots do not half-restore them."""
        logger.warning("Discarding persisted sort session: %s", reason)
        for path in (paths or self._get_session_file_candidates()):
            try:
                if path.exists():
                    path.unlink()
            except OSError as exc:
                logger.warning("Failed to remove unsupported session file %s: %s", path, exc)

    @staticmethod
    def _get_session_file_candidates() -> List[Path]:
        """Return persisted-session paths in preferred load/save order."""
        preferred = Path(SESSION_FILE).expanduser()
        legacy = Path(LEGACY_SESSION_FILE).expanduser()
        if preferred.resolve() == legacy.resolve():
            return [preferred]
        return [preferred, legacy]

    def _find_existing_session_file(self) -> Optional[Path]:
        """Find the first existing persisted sort-session file."""
        for candidate in self._get_session_file_candidates():
            if candidate.exists():
                return candidate
        return None

    def get_scan_progress(self) -> Dict[str, Any]:
        """Get the current scan progress."""
        with self._scan_lock:
            return self._scan_progress.copy()

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
                self._scan_progress = {
                    "status": "idle",
                    "step": "idle",
                    "current": 0,
                    "processed": 0,
                    "total": 0,
                    "total_final": False,
                    "errors": 0,
                    "new": 0,
                    "updated": 0,
                    "removed": 0,
                    "library_ready": False,
                    "quick_import": True,
                    "metadata_processed": 0,
                    "metadata_total": 0,
                    "message": "Reset by user",
                    "current_item": None,
                    "started_at": None,
                    "updated_at": time.time(),
                }
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
            worker_alive = bool(self._scan_worker_thread and self._scan_worker_thread.is_alive())
            if self._scan_progress["status"] in {"running", "cancelling"} and worker_alive:
                raise HTTPException(status_code=400, detail="Scan already in progress")

            self._scan_run_id += 1
            run_id = self._scan_run_id
            cancel_event = threading.Event()
            started_at = time.time()
            self._scan_cancel_event = cancel_event
            self._scan_worker_thread = None
            self._scan_progress = {
                "status": "running",
                "step": "starting",
                "current": 0,
                "processed": 0,
                "total": 0,
                "total_final": False,
                "errors": 0,
                "new": 0,
                "updated": 0,
                "removed": 0,
                "library_ready": False,
                "quick_import": request.quick_import,
                "metadata_processed": 0,
                "metadata_total": 0,
                "message": "Syncing folder index..." if request.cleanup_missing else (
                    "Starting fast library import..." if request.quick_import else "Preparing full scan..."
                ),
                "current_item": None,
                "started_at": started_at,
                "updated_at": started_at,
            }

        def run_scan():
            if not self._set_scan_worker_refs_if_current(run_id, cancel_event, threading.current_thread()):
                return

            try:
                def progress_cb(current, total, filename, details=None):
                    now = time.time()
                    details = details or {}
                    last_error = details.get("last_error") if isinstance(details, dict) else None
                    phase = details.get("phase") if isinstance(details, dict) else None
                    library_ready = bool(details.get("library_ready", self._scan_progress.get("library_ready", False))) if isinstance(details, dict) else self._scan_progress.get("library_ready", False)
                    metadata_processed = int(details.get("metadata_processed", self._scan_progress.get("metadata_processed", 0)) or 0) if isinstance(details, dict) else int(self._scan_progress.get("metadata_processed", 0) or 0)
                    metadata_total = int(details.get("metadata_total", self._scan_progress.get("metadata_total", 0)) or 0) if isinstance(details, dict) else int(self._scan_progress.get("metadata_total", 0) or 0)
                    total_final = bool(details.get("total_final", self._scan_progress.get("total_final", False))) if isinstance(details, dict) else bool(self._scan_progress.get("total_final", False))
                    message = f"Processing: {filename}" if filename else "Scanning files..."
                    current_item = filename or None
                    step = "importing"
                    status = "running"
                    removed_count = details.get("removed", self._scan_progress.get("removed", 0)) if isinstance(details, dict) else self._scan_progress.get("removed", 0)
                    if phase == "cleanup":
                        message = (
                            f"Folder sync complete. Removed {removed_count} missing entr"
                            f"{'y' if removed_count == 1 else 'ies'}."
                        )
                        current_item = None
                        step = "cleanup"
                    elif phase == "library_ready":
                        step = "importing"
                        current_item = None
                        if total_final and metadata_total > 0:
                            message = f"Library ready. Finishing metadata in background ({metadata_processed}/{metadata_total})..."
                        else:
                            message = f"Library is browseable. Importing continues in background ({current} scanned)..."
                    elif phase == "metadata":
                        step = "metadata"
                        message = f"Reading metadata: {filename}" if filename else "Reading metadata..."
                        current_item = filename or None
                    elif not total_final:
                        message = f"Fast importing library... ({current} scanned)"
                        current_item = None
                    elif last_error:
                        message = (
                            f"Skipped unreadable image: {last_error.get('filename', filename)}"
                            f" ({last_error.get('error', 'Unreadable image')})"
                        )
                    if cancel_event.is_set():
                        status = "cancelling"
                        step = "cancelling"
                        message = (
                            f"Cancelling scan... ({current}/{total})"
                            if total_final and total > 0
                            else f"Cancelling scan... ({current} scanned)"
                        )
                    self._update_scan_progress_if_current(
                        run_id,
                        status=status,
                        current=current,
                        processed=current,
                        total=total,
                        total_final=total_final,
                        step=step,
                        errors=details.get("errors", self._scan_progress.get("errors", 0)) if isinstance(details, dict) else self._scan_progress.get("errors", 0),
                        removed=removed_count,
                        library_ready=library_ready,
                        quick_import=request.quick_import,
                        metadata_processed=metadata_processed,
                        metadata_total=metadata_total,
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
                self._set_scan_progress_if_current(
                    run_id,
                    {
                        "status": "done",
                        "step": "done",
                        "current": result["total"],
                        "processed": result["total"],
                        "total": result["total"],
                        "total_final": result.get("total_final", True),
                        "errors": errors,
                        "new": new_count,
                        "updated": updated_count,
                        "removed": removed_count,
                        "library_ready": result.get("library_ready", request.quick_import),
                        "quick_import": request.quick_import,
                        "metadata_processed": result.get("metadata_processed", 0),
                        "metadata_total": result.get("metadata_total", 0),
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
                    self._set_scan_progress_if_current(
                        run_id,
                        {
                            "status": "cancelled",
                            "step": "cancelled",
                            "current": current_state.get("current", 0),
                            "processed": current_state.get("processed", current_state.get("current", 0)),
                            "total": current_state.get("total", 0),
                            "total_final": current_state.get("total_final", False),
                            "errors": current_state.get("errors", 0),
                            "new": current_state.get("new", 0),
                            "updated": current_state.get("updated", 0),
                            "removed": current_state.get("removed", 0),
                            "library_ready": current_state.get("library_ready", False),
                            "quick_import": current_state.get("quick_import", True),
                            "metadata_processed": current_state.get("metadata_processed", 0),
                            "metadata_total": current_state.get("metadata_total", 0),
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
                    self._set_scan_progress_if_current(
                        run_id,
                        {
                            "status": "error",
                            "step": "error",
                            "current": current_state.get("current", 0),
                            "processed": current_state.get("processed", current_state.get("current", 0)),
                            "total": current_state.get("total", 0),
                            "total_final": current_state.get("total_final", False),
                            "errors": current_state.get("errors", 0),
                            "new": current_state.get("new", 0),
                            "updated": current_state.get("updated", 0),
                            "removed": current_state.get("removed", 0),
                            "library_ready": current_state.get("library_ready", False),
                            "quick_import": current_state.get("quick_import", True),
                            "metadata_processed": current_state.get("metadata_processed", 0),
                            "metadata_total": current_state.get("metadata_total", 0),
                            "message": "Scan failed due to an internal error",
                            "current_item": current_state.get("current_item"),
                            "started_at": current_state.get("started_at"),
                            "updated_at": now,
                        }
                    )
            finally:
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

    def move_images(self, request: MoveRequest) -> Dict[str, Any]:
        """Move specific images to a folder."""
        operation = self._validate_file_operation(request.operation)
        destination_folder = normalize_user_path(request.destination_folder)
        is_valid, error = validate_folder_path(destination_folder, allow_create=True)
        if not is_valid:
            raise HTTPException(status_code=400, detail=error or "Invalid destination folder")

        # Batch fetch all images in a single query (N+1 fix)
        images_map = db.get_images_by_ids(request.image_ids)
        readable_ids, unreadable_skips = self._filter_readable_image_ids(request.image_ids)
        readable_id_set = set(readable_ids)
        unreadable_map = {
            entry["image_id"]: entry
            for entry in unreadable_skips
        }
        destination_ready = os.path.isdir(destination_folder)

        results = []
        for image_id in request.image_ids:
            if image_id in unreadable_map:
                results.append(
                    {
                        "id": image_id,
                        "error": unreadable_map[image_id]["error"],
                        "success": False,
                    }
                )
                continue

            image = images_map.get(image_id)
            source_path = self._resolve_image_path(image.get("path") or "") if image else None
            if image_id in readable_id_set and image and source_path:
                try:
                    if not destination_ready:
                        os.makedirs(destination_folder, exist_ok=True)
                        destination_ready = True
                    operation_result = self._apply_file_operation(
                        operation=operation,
                        image_id=image_id,
                        destination_folder=destination_folder,
                        source_path=source_path,
                        source_row=image,
                    )
                    results.append({
                        "id": image_id,
                        "new_path": operation_result["new_path"],
                        "new_image_id": operation_result.get("new_image_id"),
                        "operation": operation,
                        "success": True,
                    })
                except Exception as e:
                    logger.error("Failed to %s image %d: %s", operation, image_id, e)
                    results.append({
                        "id": image_id,
                        "error": f"Failed to {operation} image",
                        "operation": operation,
                        "success": False,
                    })
            else:
                results.append({"id": image_id, "error": "Image not found", "operation": operation, "success": False})

        return {"results": results}

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
            if self._batch_move_progress["status"] == "running":
                raise HTTPException(status_code=409, detail="Batch move already in progress")

        generators = request.generators if request.generators else None
        tags = request.tags if request.tags else None
        ratings = request.ratings if request.ratings else None
        checkpoints = request.checkpoints if request.checkpoints else None
        loras = request.loras if request.loras else None
        prompts = request.prompts if request.prompts else None
        artist = request.artist.strip() if request.artist else None
        search_query = request.search.strip() if request.search else None

        total_count = db.get_filtered_image_count(
            generators=generators,
            tags=tags,
            ratings=ratings,
            checkpoints=checkpoints,
            loras=loras,
            search_query=search_query,
            prompt_terms=prompts,
            artist=artist,
            min_width=request.min_width,
            max_width=request.max_width,
            min_height=request.min_height,
            max_height=request.max_height,
            aspect_ratio=request.aspect_ratio,
            min_aesthetic=request.min_aesthetic,
            max_aesthetic=request.max_aesthetic,
        )

        if total_count == 0:
            return {"message": "No images match the filters", "count": 0}

        # Run actual move in background with progress tracking
        with self._batch_move_lock:
            self._batch_move_run_id += 1
            run_id = self._batch_move_run_id
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
                image_ids = db.get_filtered_image_ids(
                    generators=generators,
                    tags=tags,
                    ratings=ratings,
                    checkpoints=checkpoints,
                    loras=loras,
                    search_query=search_query,
                    prompt_terms=prompts,
                    artist=artist,
                    min_width=request.min_width,
                    max_width=request.max_width,
                    min_height=request.min_height,
                    max_height=request.max_height,
                    aspect_ratio=request.aspect_ratio,
                    min_aesthetic=request.min_aesthetic,
                    max_aesthetic=request.max_aesthetic,
                )

                image_ids, unreadable_skips = self._filter_readable_image_ids(image_ids)

                if not image_ids:
                    self._set_batch_move_progress_if_current(
                        run_id,
                        {
                            "status": "done",
                            "step": "done",
                            "current": 0,
                            "total": 0,
                            "message": "No readable images match the filters",
                            "errors": len(unreadable_skips),
                            "moved": 0,
                            "current_item": None,
                            "recent_errors": unreadable_skips[-3:],
                            "operation": operation,
                            "started_at": time.time(),
                            "updated_at": time.time(),
                        }
                    )
                    return

                os.makedirs(destination_folder, exist_ok=True)

                moved = 0
                processed = 0
                errors = list(unreadable_skips)
                for chunk_start in range(0, len(image_ids), BATCH_MOVE_FETCH_CHUNK):
                    batch_ids = image_ids[chunk_start:chunk_start + BATCH_MOVE_FETCH_CHUNK]
                    image_map = db.get_images_by_ids(batch_ids)

                    for image_id in batch_ids:
                        image = image_map.get(image_id)
                        if not image:
                            processed += 1
                            errors.append({"image_id": image_id, "filename": f"id-{image_id}", "error": "Image row not found"})
                            continue

                        filename = image.get("filename", "image")
                        error_message = None

                        source_path = self._resolve_image_path(image.get("path") or "")
                        if source_path:
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
                        else:
                            error_message = "Image file not found"

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

                self._set_batch_move_progress_if_current(
                    run_id,
                    {
                        "status": "done",
                        "step": "done",
                        "current": total_count,
                        "total": total_count,
                        "errors": len(errors),
                        "moved": moved,
                        "message": f"Completed! Moved {moved} images." + (f" {len(errors)} errors." if errors else ""),
                        "current_item": None,
                        "recent_errors": errors[-3:],
                        "operation": operation,
                        "started_at": self._batch_move_progress.get("started_at"),
                        "updated_at": time.time(),
                    }
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
        generators: Optional[str] = None,
        tags: Optional[str] = None,
        ratings: Optional[str] = None,
        checkpoints: Optional[str] = None,
        loras: Optional[str] = None,
        prompts: Optional[str] = None,
        artist: Optional[str] = None,
        search: Optional[str] = None,
        min_width: Optional[int] = None,
        max_width: Optional[int] = None,
        min_height: Optional[int] = None,
        max_height: Optional[int] = None,
        aspect_ratio: Optional[str] = None,
        min_aesthetic: Optional[float] = None,
        max_aesthetic: Optional[float] = None,
        folders: Optional[str] = None,
        operation_mode: str = "move",
        replace_existing: bool = False,
    ) -> Dict[str, Any]:
        """Start a manual sort session."""
        operation_mode = self._validate_file_operation(operation_mode)
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

        gen_list = generators.split(",") if generators else None
        tag_list = tags.split(",") if tags else None
        rating_list = ratings.split(",") if ratings else None
        cp_list = checkpoints.split(",") if checkpoints else None
        lr_list = loras.split(",") if loras else None
        prompt_list = prompts.split(",") if prompts else None
        artist_name = artist.strip() if artist else None
        search_query = search.strip() if search else None

        image_ids = db.get_filtered_image_ids(
            generators=gen_list,
            tags=tag_list,
            ratings=rating_list,
            checkpoints=cp_list,
            loras=lr_list,
            search_query=search_query,
            prompt_terms=prompt_list,
            artist=artist_name,
            min_width=min_width,
            max_width=max_width,
            min_height=min_height,
            max_height=max_height,
            aspect_ratio=aspect_ratio,
            min_aesthetic=min_aesthetic,
            max_aesthetic=max_aesthetic,
        )
        # DB-level filter already excludes images marked unreadable.
        # Per-image verification runs lazily in get_current_sort_image so
        # starting a session doesn't stall on thousands of PIL decodes.

        folder_config = self._parse_sort_folders(folders)

        with self._sort_session_lock:
            self._sort_session = self._coerce_sort_session_state({
                "active": True,
                "image_ids": image_ids,
                "current_index": 0,
                "folders": folder_config,
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
        }

    def get_current_sort_image(self) -> Dict[str, Any]:
        """Get the current image in the sort session."""
        while True:
            with self._sort_session_lock:
                if not self._sort_session["active"]:
                    return {
                        "active": False,
                        "done": True,
                        "message": "No active sort session",
                        "image": None,
                        "tags": [],
                        "index": 0,
                        "total": 0,
                        "remaining": 0,
                        "image_ids": [],
                        "folders": {},
                        "operation_mode": "move",
                        **self._get_sort_session_flags([], []),
                    }

                image_ids = self._sort_session["image_ids"]
                if self._sort_session["current_index"] >= len(image_ids):
                    return {"done": True, "message": "All images sorted"}

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
                "index": current_index,
                "total": len(image_ids),
                "remaining": len(image_ids) - current_index,
                "image_ids": list(image_ids),
                "folders": dict(self._sort_session["folders"]),
                "operation_mode": self._sort_session.get("operation_mode", "move"),
                **self._get_sort_session_flags(history_snapshot, self._sort_session.get("redo_stack", [])),
            }

    def sort_action(
        self,
        action: str,
        folder_key: Optional[str] = None
    ) -> Dict[str, Any]:
        """Perform a sort action: move, skip, undo, or redo."""
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
                                logger.warning("Error undoing %s during undo: %s", last.get("operation") or "move", e)
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
        """Set folder destinations for sort keys."""
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

        with self._sort_session_lock:
            self._sort_session["folders"] = normalized_folders
            self._save_session_to_disk()
        return {"status": "ok", "folders": normalized_folders}

    def get_sort_folders(self) -> Dict[str, Any]:
        """Get current folder configuration."""
        with self._sort_session_lock:
            return {"folders": self._sort_session["folders"]}

    def clear_sort_session(self) -> Dict[str, str]:
        """Clear the current sort session."""
        with self._sort_session_lock:
            self._sort_session = self._build_default_sort_session_state()
        for session_file in self._get_session_file_candidates():
            try:
                if session_file.exists():
                    session_file.unlink()
            except Exception as e:
                logger.warning("Failed to remove session file %s: %s", session_file, e)
        return {'status': 'ok'}

    def clear_gallery(self) -> Dict[str, str]:
        """Clear all image records from the database.

        Tags are removed automatically via ON DELETE CASCADE foreign key.
        """
        with db.get_db() as conn:
            cursor = conn.cursor()
            cursor.execute("DELETE FROM images")
        return {"status": "ok", "message": "Gallery cleared"}

    def get_analytics(self) -> Dict[str, Any]:
        """Get all tags, checkpoints, and loras with counts."""
        with db.get_db() as conn:
            cursor = conn.cursor()

            # Use the normalized image_loras table instead of full-table JSON scan
            cursor.execute("""
                SELECT lora_name AS lora, COUNT(*) as count
                FROM image_loras
                GROUP BY lora_name
                ORDER BY count DESC
            """)
            loras = [dict(row) for row in cursor.fetchall()]

            # No artificial limit on tags
            tags = db.get_all_tags()

        return {
            "checkpoints": db.get_all_checkpoints(),
            "loras": loras,
            "top_tags": tags
        }

    def get_stats(self) -> Dict[str, Any]:
        """Get database statistics."""
        analytics_data = self.get_analytics()
        return {
            "total_images": db.get_image_count(),
            "generators": db.get_all_generators(),
            "top_tags": analytics_data["top_tags"],
            "checkpoints": analytics_data["checkpoints"],
            "loras": analytics_data["loras"]
        }

    def export_tags_batch(self, request) -> Dict[str, Any]:
        """Export tags for each image to individual .txt files."""
        result = export_tags_batch_request(request)
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
                    with session_file.open('r', encoding='utf-8') as f:
                        data = json.load(f)

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
            session_file.parent.mkdir(parents=True, exist_ok=True)
            with session_file.open('w', encoding='utf-8') as f:
                json.dump(data, f)
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
