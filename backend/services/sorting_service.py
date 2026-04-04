"""
Sorting service for SD Image Sorter.

Handles business logic for scanning, moving, batch operations, and manual sort sessions.
"""
import logging
import os
import json
import threading
import time
from typing import Optional, List, Dict, Any

from fastapi import HTTPException, BackgroundTasks, Query
from pydantic import BaseModel, Field, ValidationError, field_validator

import database as db
from image_manager import scan_folder, move_image
from utils.path_validation import validate_folder_path

logger = logging.getLogger(__name__)


SESSION_FILE = os.path.join(os.path.dirname(__file__), '..', 'sort_session.json')

# Validation constants
DIMENSION_MIN = 1
DIMENSION_MAX = 100000
PATH_MAX_LENGTH = 4096
FOLDER_KEY_MAX_LENGTH = 100
BATCH_MOVE_LIMIT = 5000
SEARCH_MAX_LENGTH = 1000
VALID_ASPECT_RATIOS = ["square", "landscape", "portrait"]
VALID_SORT_ACTIONS = ["move", "skip", "undo", "redo"]


class ScanRequest(BaseModel):
    """Request model for folder scanning."""
    folder_path: str = Field(..., max_length=PATH_MAX_LENGTH)
    recursive: bool = True

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
    image_ids: List[int] = Field(..., min_length=1, max_length=BATCH_MOVE_LIMIT)
    destination_folder: str = Field(..., max_length=PATH_MAX_LENGTH)


class BatchMoveRequest(BaseModel):
    """Request model for batch move operations."""
    generators: Optional[List[str]] = None
    tags: Optional[List[str]] = None
    ratings: Optional[List[str]] = None
    checkpoints: Optional[List[str]] = None
    loras: Optional[List[str]] = None
    prompts: Optional[List[str]] = None
    search: Optional[str] = Field(default=None, max_length=SEARCH_MAX_LENGTH)
    min_width: Optional[int] = Field(default=None, ge=DIMENSION_MIN, le=DIMENSION_MAX)
    max_width: Optional[int] = Field(default=None, ge=DIMENSION_MIN, le=DIMENSION_MAX)
    min_height: Optional[int] = Field(default=None, ge=DIMENSION_MIN, le=DIMENSION_MAX)
    max_height: Optional[int] = Field(default=None, ge=DIMENSION_MIN, le=DIMENSION_MAX)
    aspect_ratio: Optional[str] = None
    destination_folder: str = Field(..., max_length=PATH_MAX_LENGTH)

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


class SortingService:
    """Service for scanning, moving, and manual sorting operations."""

    def __init__(self):
        """Initialize the sorting service."""
        self._scan_progress: Dict[str, Any] = {
            "status": "idle",
            "step": "idle",
            "current": 0,
            "processed": 0,
            "total": 0,
            "errors": 0,
            "new": 0,
            "updated": 0,
            "message": "",
            "current_item": None,
            "started_at": None,
            "updated_at": None,
        }
        self._scan_lock = threading.Lock()

        self._sort_session: Dict[str, Any] = {
            "active": False,
            "image_ids": [],
            "current_index": 0,
            "folders": {},
            "history": [],
            "redo_stack": [],
        }
        self._sort_session_lock = threading.Lock()
        
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
            "started_at": None,
            "updated_at": None,
        }
        self._batch_move_lock = threading.Lock()
        self._batch_move_run_id = 0

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
            is_valid, error = validate_folder_path(path, allow_create=True)
            if not is_valid:
                raise HTTPException(status_code=400, detail=error or f"Invalid folder path for key '{key}'")
            validated_folders[key] = path

        return validated_folders

    def get_scan_progress(self) -> Dict[str, Any]:
        """Get the current scan progress."""
        with self._scan_lock:
            return self._scan_progress.copy()

    def set_scan_progress(self, state: Dict[str, Any]) -> None:
        """Set the scan progress state."""
        with self._scan_lock:
            self._scan_progress = state

    def reset_scan_progress(self) -> Dict[str, Any]:
        """Reset a stuck scan task back to idle."""
        with self._scan_lock:
            if self._scan_progress["status"] == "running":
                self._scan_progress = {
                    "status": "idle",
                    "step": "idle",
                    "current": 0,
                    "processed": 0,
                    "total": 0,
                    "errors": 0,
                    "new": 0,
                    "updated": 0,
                    "message": "Reset by user",
                    "current_item": None,
                    "started_at": None,
                    "updated_at": time.time(),
                }
                return {"status": "reset", "message": "Scan progress reset to idle"}
            return {"status": self._scan_progress["status"], "message": "Nothing to reset (not running)"}

    def get_sort_session(self) -> Dict[str, Any]:
        """Get the current sort session."""
        with self._sort_session_lock:
            return self._sort_session.copy()


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

    def set_sort_session(self, session: Dict[str, Any]) -> None:
        """Set the sort session."""
        with self._sort_session_lock:
            self._sort_session = session

    def validate_path(self, request: ValidatePathRequest) -> Dict[str, Any]:
        """Validate a folder path for inline UI feedback."""
        is_valid, error = validate_folder_path(request.path)
        return {"valid": is_valid, "error": error}

    def start_scan(
        self,
        request: ScanRequest,
        background_tasks: BackgroundTasks
    ) -> Dict[str, str]:
        """Start scanning a folder for images."""
        is_valid, error = validate_folder_path(request.folder_path)
        if not is_valid:
            raise HTTPException(status_code=400, detail=error or "Invalid folder path")

        if self._scan_progress["status"] == "running":
            raise HTTPException(status_code=400, detail="Scan already in progress")

        def run_scan():
            with self._scan_lock:
                started_at = time.time()
                self._scan_progress = {
                    "status": "running",
                    "step": "starting",
                    "current": 0,
                    "processed": 0,
                    "total": 0,
                    "errors": 0,
                    "new": 0,
                    "updated": 0,
                    "message": "Starting...",
                    "current_item": None,
                    "started_at": started_at,
                    "updated_at": started_at,
                }

            try:
                def progress_cb(current, total, filename):
                    with self._scan_lock:
                        now = time.time()
                        self._scan_progress["current"] = current
                        self._scan_progress["processed"] = current
                        self._scan_progress["total"] = total
                        self._scan_progress["step"] = "scanning"
                        self._scan_progress["message"] = f"Processing: {filename}"
                        self._scan_progress["current_item"] = filename
                        self._scan_progress["updated_at"] = now

                result = scan_folder(request.folder_path, request.recursive, progress_cb)
                with self._scan_lock:
                    now = time.time()
                    errors = result.get("errors", 0)
                    new_count = result.get("new", 0)
                    updated_count = result.get("updated", 0)
                    summary = f"Completed! {new_count} images indexed."
                    if updated_count:
                        summary += f" {updated_count} updated."
                    if errors:
                        summary += f" {errors} failed."
                    self._scan_progress = {
                        "status": "done",
                        "step": "done",
                        "current": result["total"],
                        "processed": result["total"],
                        "total": result["total"],
                        "errors": errors,
                        "new": new_count,
                        "updated": updated_count,
                        "message": summary,
                        "current_item": None,
                        "started_at": self._scan_progress.get("started_at"),
                        "updated_at": now,
                        "result": result
                    }
            except Exception as e:
                with self._scan_lock:
                    now = time.time()
                    self._scan_progress = {
                        "status": "error",
                        "step": "error",
                        "current": self._scan_progress.get("current", 0),
                        "processed": self._scan_progress.get("processed", self._scan_progress.get("current", 0)),
                        "total": self._scan_progress.get("total", 0),
                        "errors": self._scan_progress.get("errors", 0),
                        "new": self._scan_progress.get("new", 0),
                        "updated": self._scan_progress.get("updated", 0),
                        "message": "Scan failed due to an internal error",
                        "current_item": self._scan_progress.get("current_item"),
                        "started_at": self._scan_progress.get("started_at"),
                        "updated_at": now,
                    }
            finally:
                with self._scan_lock:
                    if self._scan_progress["status"] == "running":
                        self._scan_progress["status"] = "error"
                        self._scan_progress["step"] = "error"
                        self._scan_progress["message"] = "Scan ended unexpectedly"
                        self._scan_progress["updated_at"] = time.time()

        background_tasks.add_task(run_scan)
        return {"status": "started", "message": "Scan started in background"}

    def move_images(self, request: MoveRequest) -> Dict[str, Any]:
        """Move specific images to a folder."""
        is_valid, error = validate_folder_path(request.destination_folder, allow_create=True)
        if not is_valid:
            raise HTTPException(status_code=400, detail=error or "Invalid destination folder")

        os.makedirs(request.destination_folder, exist_ok=True)

        # Batch fetch all images in a single query (N+1 fix)
        images_map = db.get_images_by_ids(request.image_ids)

        results = []
        for image_id in request.image_ids:
            image = images_map.get(image_id)
            if image and os.path.exists(image["path"]):
                try:
                    new_path = move_image(image_id, request.destination_folder, image["path"])
                    results.append({"id": image_id, "new_path": new_path, "success": True})
                except Exception as e:
                    logger.error("Failed to move image %d: %s", image_id, e)
                    results.append({"id": image_id, "error": "Failed to move image", "success": False})
            else:
                results.append({"id": image_id, "error": "Image not found", "success": False})

        return {"results": results}

    def batch_move_images(
        self,
        request: BatchMoveRequest,
        background_tasks: BackgroundTasks
    ) -> Dict[str, Any]:
        """Move all images matching filters to a folder with progress tracking."""
        is_valid, error = validate_folder_path(request.destination_folder, allow_create=True)
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
        search_query = request.search.strip() if request.search else None

        total_count = db.get_filtered_image_count(
            generators=generators,
            tags=tags,
            ratings=ratings,
            checkpoints=checkpoints,
            loras=loras,
            search_query=search_query,
            prompt_terms=prompts,
            min_width=request.min_width,
            max_width=request.max_width,
            min_height=request.min_height,
            max_height=request.max_height,
            aspect_ratio=request.aspect_ratio
        )

        if total_count > BATCH_MOVE_LIMIT:
            raise HTTPException(
                status_code=400,
                detail=f"Found {total_count} images matching filters. Maximum allowed is {BATCH_MOVE_LIMIT}.",
            )

        if total_count == 0:
            return {"message": "No images match the filters", "count": 0}

        # Run actual move in background with progress tracking
        destination_folder = request.destination_folder
        with self._batch_move_lock:
            self._batch_move_run_id += 1
            run_id = self._batch_move_run_id
            self._batch_move_progress = {
                "status": "running",
                "step": "starting",
                "current": 0,
                "total": total_count,
                "message": f"Starting move of {total_count} images...",
                "errors": 0,
                "moved": 0,
                "current_item": None,
                "recent_errors": [],
                "started_at": time.time(),
                "updated_at": time.time(),
            }
        
        def run_batch_move():
            try:
                images = db.get_images(
                    generators=generators,
                    tags=tags,
                    ratings=ratings,
                    checkpoints=checkpoints,
                    loras=loras,
                    search_query=search_query,
                    prompt_terms=prompts,
                    min_width=request.min_width,
                    max_width=request.max_width,
                    min_height=request.min_height,
                    max_height=request.max_height,
                    aspect_ratio=request.aspect_ratio,
                    limit=BATCH_MOVE_LIMIT
                )

                if not images:
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
                            "started_at": time.time(),
                            "updated_at": time.time(),
                        }
                    )
                    return

                os.makedirs(destination_folder, exist_ok=True)

                moved = 0
                processed = 0
                errors = []
                for image in images:
                    filename = image.get("filename", "image")
                    error_message = None

                    if os.path.exists(image["path"]):
                        try:
                            move_image(image["id"], destination_folder, image["path"])
                            moved += 1
                        except Exception as e:
                            error_message = f"Error moving {image['path']}: {e}"
                    else:
                        error_message = f"Image file not found: {image['path']}"

                    if error_message:
                        errors.append(error_message)

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
                        "started_at": self._batch_move_progress.get("started_at") if run_id == self._batch_move_run_id else None,
                        "updated_at": time.time(),
                    }
                )

        background_tasks.add_task(run_batch_move)
        return {
            "status": "started",
            "message": f"Moving {total_count} images in background",
            "total": total_count,
            "count": total_count,
        }

    def start_sort_session(
        self,
        generators: Optional[str] = None,
        tags: Optional[str] = None,
        ratings: Optional[str] = None,
        checkpoints: Optional[str] = None,
        loras: Optional[str] = None,
        prompts: Optional[str] = None,
        search: Optional[str] = None,
        min_width: Optional[int] = None,
        max_width: Optional[int] = None,
        min_height: Optional[int] = None,
        max_height: Optional[int] = None,
        aspect_ratio: Optional[str] = None,
        folders: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Start a manual sort session."""
        # Validate aspect_ratio
        if aspect_ratio is not None and aspect_ratio not in VALID_ASPECT_RATIOS:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid aspect_ratio. Must be one of: {', '.join(VALID_ASPECT_RATIOS)}"
            )

        # Validate dimension ranges
        if min_width is not None and max_width is not None and min_width > max_width:
            raise HTTPException(status_code=400, detail="min_width cannot be greater than max_width")
        if min_height is not None and max_height is not None and min_height > max_height:
            raise HTTPException(status_code=400, detail="min_height cannot be greater than max_height")

        gen_list = generators.split(",") if generators else None
        tag_list = tags.split(",") if tags else None
        rating_list = ratings.split(",") if ratings else None
        cp_list = checkpoints.split(",") if checkpoints else None
        lr_list = loras.split(",") if loras else None
        prompt_list = prompts.split(",") if prompts else None
        search_query = search.strip() if search else None

        image_ids = db.get_filtered_image_ids(
            generators=gen_list,
            tags=tag_list,
            ratings=rating_list,
            checkpoints=cp_list,
            loras=lr_list,
            search_query=search_query,
            prompt_terms=prompt_list,
            min_width=min_width,
            max_width=max_width,
            min_height=min_height,
            max_height=max_height,
            aspect_ratio=aspect_ratio
        )

        folder_config = self._parse_sort_folders(folders)

        with self._sort_session_lock:
            self._sort_session = {
                "active": True,
                "image_ids": image_ids,
                "current_index": 0,
                "folders": folder_config,
                "history": [],
                "redo_stack": [],
            }
            self._save_session_to_disk()

        first_image = db.get_image_by_id(image_ids[0]) if image_ids else None

        return {
            "status": "started",
            "total_images": len(image_ids),
            "current": first_image
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

            tags = db.get_image_tags(current_id)

            return {
                "image": current,
                "tags": tags,
                "index": current_index,
                "total": len(image_ids),
                "remaining": len(image_ids) - current_index,
                "image_ids": list(image_ids),
                "folders": dict(self._sort_session["folders"]),
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
                                move_image(last["image_id"], os.path.dirname(last["original_path"]), image["path"])
                            except Exception as e:
                                logger.warning("Error moving image back during undo: %s", e)
                    self._sort_session["current_index"] = max(0, self._sort_session["current_index"] - 1)
                else:
                    return {
                        "status": "no_history",
                        "message": "Nothing to undo",
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
                    **session_flags,
                }

            if action == "redo":
                redo_stack = self._sort_session.setdefault("redo_stack", [])
                if not redo_stack:
                    return {
                        "status": "no_redo",
                        "message": "Nothing to redo",
                        **self._get_sort_session_flags(),
                    }

                redo_entry = redo_stack.pop()
                redone_action = redo_entry.get("action")
                redone_folder_key = redo_entry.get("folder_key")
                target_id = redo_entry.get("image_id")

                if redone_action == "move":
                    folder = self._sort_session["folders"].get(redone_folder_key)
                    if not folder:
                        redo_stack.append(redo_entry)
                        return {
                            "error": f"Folder {str(redone_folder_key).upper()} is not configured",
                            **self._get_sort_session_flags(),
                        }

                    target_image = db.get_image_by_id(target_id) if target_id is not None else None
                    if not target_image or not target_image.get("path") or not os.path.exists(target_image["path"]):
                        redo_stack.append(redo_entry)
                        return {
                            "error": "Image file not found on disk",
                            **self._get_sort_session_flags(),
                        }

                    try:
                        redo_entry["new_path"] = move_image(target_image["id"], folder, target_image["path"])
                    except Exception as e:
                        logger.error("Redo move failed for image %s: %s", target_id, e)
                        redo_stack.append(redo_entry)
                        return {
                            "error": "Failed to redo move",
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
                    **session_flags,
                }

            if self._sort_session["current_index"] >= len(image_ids):
                return {"done": True}

            current_id = image_ids[self._sort_session["current_index"]]
            current_index = self._sort_session["current_index"]

            if action == "move" and not folder_key:
                return {
                    "error": "Folder key is required for move",
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
                    return {"done": True, "message": "All images sorted", **session_flags}
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
                    **session_flags,
                }

            if action == "move" and folder_key:
                if not folder:
                    return {
                        "error": f"Folder {folder_key.upper()} is not configured",
                        **self._get_sort_session_flags(),
                    }
                if not current.get("path") or not os.path.exists(current["path"]):
                    return {
                        "error": "Image file not found on disk",
                        **self._get_sort_session_flags(),
                    }
                try:
                    original_path = current["path"]
                    new_path = move_image(current["id"], folder, current["path"])
                    self._sort_session["redo_stack"] = []
                    self._sort_session["history"].append({
                        "action": "move",
                        "image_id": current["id"],
                        "original_path": original_path,
                        "new_path": new_path,
                        "folder_key": folder_key
                    })
                except Exception as e:
                    logger.error("Sort move failed for image %d: %s", current["id"], e)
                    return {
                        "error": "Failed to move image",
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
                return {"done": True, "message": "All images sorted", **session_flags}

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
                **session_flags,
            }

    def set_sort_folders(self, config: FolderConfig) -> Dict[str, Any]:
        """Set folder destinations for sort keys."""
        for key, path in config.folders.items():
            if path:
                is_valid, error = validate_folder_path(path, allow_create=True)
                if not is_valid:
                    raise HTTPException(status_code=400, detail=error or f"Invalid folder path for key '{key}'")
                os.makedirs(path, exist_ok=True)

        with self._sort_session_lock:
            self._sort_session["folders"] = config.folders
            self._save_session_to_disk()
        return {"status": "ok", "folders": config.folders}

    def get_sort_folders(self) -> Dict[str, Any]:
        """Get current folder configuration."""
        with self._sort_session_lock:
            return {"folders": self._sort_session["folders"]}

    def clear_sort_session(self) -> Dict[str, str]:
        """Clear the current sort session."""
        with self._sort_session_lock:
            self._sort_session = {
                'active': False,
                'image_ids': [],
                'current_index': 0,
                'folders': {},
                'history': [],
                'redo_stack': [],
            }
        try:
            if os.path.exists(SESSION_FILE):
                os.remove(SESSION_FILE)
        except Exception as e:
            logger.warning("Failed to remove session file: %s", e)
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
        """Get popular tags, checkpoints, and loras."""
        with db.get_db() as conn:
            cursor = conn.cursor()

            cursor.execute("""
                SELECT checkpoint, COUNT(*) as count
                FROM images
                WHERE checkpoint IS NOT NULL AND checkpoint != ''
                GROUP BY checkpoint
                ORDER BY count DESC
                LIMIT 50
            """)
            checkpoints = [dict(row) for row in cursor.fetchall()]

            cursor.execute("""
                SELECT id, loras, prompt
                FROM images
                WHERE (loras IS NOT NULL AND loras != '[]' AND loras != '')
                   OR (prompt IS NOT NULL AND prompt LIKE '%<lora:%')
            """)
            all_loras_rows = cursor.fetchall()
            lora_counts = {}
            for row in all_loras_rows:
                image_loras = db.extract_lora_names(row["loras"] or "", row["prompt"] or "")
                for lora_name in image_loras:
                    lora_counts[lora_name] = lora_counts.get(lora_name, 0) + 1

            sorted_loras = sorted(lora_counts.items(), key=lambda x: x[1], reverse=True)[:50]
            loras = [{"lora": l, "count": c} for l, c in sorted_loras]

            tags = db.get_all_tags()[:20]

        return {
            "checkpoints": checkpoints,
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
        is_valid, error = validate_folder_path(request.output_folder, allow_create=True)
        if not is_valid:
            raise HTTPException(status_code=400, detail=error or "Invalid output folder")

        os.makedirs(request.output_folder, exist_ok=True)

        blacklist = set(tag.strip().lower() for tag in (request.blacklist or []))
        prefix = request.prefix or ""

        exported = 0
        errors = []

        for image_id in request.image_ids:
            image = db.get_image_by_id(image_id)
            if not image:
                errors.append(f"Image {image_id} not found")
                continue

            tags = db.get_image_tags(image_id)
            filtered_tags = [t["tag"] for t in tags if t["tag"].lower() not in blacklist]
            tag_string = prefix + ", ".join(filtered_tags) if filtered_tags else prefix.rstrip(", ")

            image_basename = os.path.splitext(image["filename"])[0]
            output_path = os.path.join(request.output_folder, f"{image_basename}.txt")

            try:
                with open(output_path, "w", encoding="utf-8") as f:
                    f.write(tag_string)
                exported += 1
            except Exception as e:
                errors.append(f"Error writing {output_path}: {e}")

        return {
            "status": "ok",
            "exported": exported,
            "total": len(request.image_ids),
            "errors": errors if errors else None
        }

    def load_session_from_disk(self) -> None:
        """Load persisted session from disk on startup."""
        try:
            if not os.path.exists(SESSION_FILE):
                return
            with open(SESSION_FILE, 'r', encoding='utf-8') as f:
                data = json.load(f)
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
                    os.remove(SESSION_FILE)
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

            # Validate all folder paths loaded from JSON
            validated_folders = {}
            for key, path in data.get('folders', {}).items():
                try:
                    is_valid, _error = validate_folder_path(path, allow_create=True)
                    if is_valid:
                        validated_folders[key] = path
                    else:
                        logger.warning("Skipping invalid folder path for key %s", key)
                except Exception:
                    logger.warning("Skipping invalid folder path for key %s", key)

            with self._sort_session_lock:
                self._sort_session = {
                    'active': True,
                    'image_ids': valid_ids,
                    'current_index': restored_index,
                    'folders': validated_folders,
                    'history': restored_history,
                    'redo_stack': restored_redo_stack,
                }
                self._save_session_to_disk()
            logger.info("Restored session: %d images", len(valid_ids))
        except Exception as e:
            logger.warning("Failed to restore session: %s", e)

    def _save_session_to_disk(self) -> None:
        """Persist session to disk."""
        try:
            data = {
                'active': self._sort_session['active'],
                'current_index': self._sort_session['current_index'],
                'folders': self._sort_session['folders'],
                'history': self._sort_session['history'],
                'redo_stack': self._sort_session.get('redo_stack', []),
                'image_ids': self._sort_session['image_ids']
            }
            with open(SESSION_FILE, 'w', encoding='utf-8') as f:
                json.dump(data, f)
        except Exception as e:
            logger.warning("Failed to save session to disk: %s", e)
