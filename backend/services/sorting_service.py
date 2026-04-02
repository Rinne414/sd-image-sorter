"""
Sorting service for SD Image Sorter.

Handles business logic for scanning, moving, batch operations, and manual sort sessions.
"""
import logging
import os
import json
import threading
from typing import Optional, List, Dict, Any

from fastapi import HTTPException, BackgroundTasks, Query
from pydantic import BaseModel, Field, field_validator

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
VALID_SORT_ACTIONS = ["move", "skip", "undo"]


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
        self._scan_progress: Dict[str, Any] = {"status": "idle", "current": 0, "total": 0, "message": ""}
        self._scan_lock = threading.Lock()

        self._sort_session: Dict[str, Any] = {
            "active": False,
            "image_ids": [],
            "current_index": 0,
            "folders": {},
            "history": []
        }
        self._sort_session_lock = threading.Lock()
        
        # Batch move progress
        self._batch_move_progress: Dict[str, Any] = {"status": "idle", "current": 0, "total": 0, "message": ""}
        self._batch_move_lock = threading.Lock()

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
                    "current": 0,
                    "total": 0,
                    "message": "Reset by user"
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
                self._batch_move_progress = {
                    "status": "idle",
                    "current": 0,
                    "total": 0,
                    "message": "Reset by user"
                }
                return {"status": "reset", "message": "Batch move progress reset"}
            return {"status": self._batch_move_progress["status"], "message": "Nothing to reset"}

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
                self._scan_progress = {"status": "running", "current": 0, "total": 0, "message": "Starting..."}

            try:
                def progress_cb(current, total, filename):
                    with self._scan_lock:
                        self._scan_progress["current"] = current
                        self._scan_progress["total"] = total
                        self._scan_progress["message"] = f"Processing: {filename}"

                result = scan_folder(request.folder_path, request.recursive, progress_cb)
                with self._scan_lock:
                    self._scan_progress = {
                        "status": "done",
                        "current": result["total"],
                        "total": result["total"],
                        "message": f"Completed! {result['new']} images indexed.",
                        "result": result
                    }
            except Exception as e:
                with self._scan_lock:
                    self._scan_progress = {
                        "status": "error",
                        "current": self._scan_progress.get("current", 0),
                        "total": self._scan_progress.get("total", 0),
                        "message": "Scan failed due to an internal error"
                    }
            finally:
                with self._scan_lock:
                    if self._scan_progress["status"] == "running":
                        self._scan_progress["status"] = "error"
                        self._scan_progress["message"] = "Scan ended unexpectedly"

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

        generators = request.generators if request.generators else None
        tags = request.tags if request.tags else None
        ratings = request.ratings if request.ratings else None
        checkpoints = request.checkpoints if request.checkpoints else None
        loras = request.loras if request.loras else None
        prompts = request.prompts if request.prompts else None

        total_count = db.get_filtered_image_count(
            generators=generators,
            tags=tags,
            ratings=ratings,
            checkpoints=checkpoints,
            loras=loras,
            prompt_terms=prompts,
            min_width=request.min_width,
            max_width=request.max_width,
            min_height=request.min_height,
            max_height=request.max_height,
            aspect_ratio=request.aspect_ratio
        )

        if total_count > BATCH_MOVE_LIMIT:
            return {
                "error": "Too many images to process safely",
                "total_count": total_count,
                "limit": BATCH_MOVE_LIMIT,
                "message": f"Found {total_count} images matching filters. Maximum allowed is {BATCH_MOVE_LIMIT}."
            }

        if total_count == 0:
            return {"message": "No images match the filters", "count": 0}

        # Run actual move in background with progress tracking
        destination_folder = request.destination_folder
        
        def run_batch_move():
            with self._batch_move_lock:
                self._batch_move_progress = {
                    "status": "running",
                    "current": 0,
                    "total": total_count,
                    "message": f"Starting move of {total_count} images..."
                }

            try:
                images = db.get_images(
                    generators=generators,
                    tags=tags,
                    ratings=ratings,
                    checkpoints=checkpoints,
                    loras=loras,
                    prompt_terms=prompts,
                    min_width=request.min_width,
                    max_width=request.max_width,
                    min_height=request.min_height,
                    max_height=request.max_height,
                    aspect_ratio=request.aspect_ratio,
                    limit=BATCH_MOVE_LIMIT
                )

                if not images:
                    with self._batch_move_lock:
                        self._batch_move_progress = {
                            "status": "done",
                            "current": 0,
                            "total": 0,
                            "message": "No images match the filters"
                        }
                    return

                os.makedirs(destination_folder, exist_ok=True)

                moved = 0
                errors = []
                for i, image in enumerate(images):
                    with self._batch_move_lock:
                        self._batch_move_progress["current"] = i + 1
                        self._batch_move_progress["message"] = f"Moving {image.get('filename', 'image')} ({i + 1}/{total_count})"

                    if os.path.exists(image["path"]):
                        try:
                            move_image(image["id"], destination_folder, image["path"])
                            moved += 1
                        except Exception as e:
                            errors.append(f"Error moving {image['path']}: {e}")

                with self._batch_move_lock:
                    self._batch_move_progress = {
                        "status": "done",
                        "current": moved,
                        "total": total_count,
                        "message": f"Completed! Moved {moved} images." + (f" {len(errors)} errors." if errors else "")
                    }

            except Exception as e:
                logger.error("Batch move failed: %s", e)
                with self._batch_move_lock:
                    self._batch_move_progress = {
                        "status": "error",
                        "current": self._batch_move_progress.get("current", 0),
                        "total": total_count,
                        "message": "Batch move failed due to an internal error"
                    }

        background_tasks.add_task(run_batch_move)
        return {"status": "started", "message": f"Moving {total_count} images in background", "total": total_count}

    def start_sort_session(
        self,
        generators: Optional[str] = None,
        tags: Optional[str] = None,
        ratings: Optional[str] = None,
        checkpoints: Optional[str] = None,
        loras: Optional[str] = None,
        prompts: Optional[str] = None,
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

        image_ids = db.get_filtered_image_ids(
            generators=gen_list,
            tags=tag_list,
            ratings=rating_list,
            checkpoints=cp_list,
            loras=lr_list,
            prompt_terms=prompt_list,
            min_width=min_width,
            max_width=max_width,
            min_height=min_height,
            max_height=max_height,
            aspect_ratio=aspect_ratio
        )

        folder_config = {}
        try:
            if folders:
                folder_config = json.loads(folders)
        except (TypeError, ValueError):
            folder_config = {}

        with self._sort_session_lock:
            self._sort_session = {
                "active": True,
                "image_ids": image_ids,
                "current_index": 0,
                "folders": folder_config,
                "history": []
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
                    raise HTTPException(status_code=400, detail="No active sort session")

                image_ids = self._sort_session["image_ids"]
                if self._sort_session["current_index"] >= len(image_ids):
                    return {"done": True, "message": "All images sorted"}

                current_id = image_ids[self._sort_session["current_index"]]
                current_index = self._sort_session["current_index"]

            current = db.get_image_by_id(current_id)
            if not current:
                with self._sort_session_lock:
                    self._sort_session["current_index"] += 1
                continue

            tags = db.get_image_tags(current_id)

            return {
                "image": current,
                "tags": tags,
                "index": current_index,
                "total": len(image_ids),
                "remaining": len(image_ids) - current_index
            }

    def sort_action(
        self,
        action: str,
        folder_key: Optional[str] = None
    ) -> Dict[str, Any]:
        """Perform a sort action: move, skip, or undo."""
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
                    undone_action = last.get("action")
                    if last["action"] == "move":
                        image = db.get_image_by_id(last["image_id"])
                        if image:
                            try:
                                move_image(last["image_id"], os.path.dirname(last["original_path"]), image["path"])
                            except Exception as e:
                                logger.warning("Error moving image back during undo: %s", e)
                    self._sort_session["current_index"] = max(0, self._sort_session["current_index"] - 1)
                else:
                    return {"status": "no_history", "message": "Nothing to undo"}

                if self._sort_session["current_index"] < len(image_ids):
                    current_id = image_ids[self._sort_session["current_index"]]
                    current_index = self._sort_session["current_index"]
                    self._save_session_to_disk()
                else:
                    return {"status": "undone", "current_index": self._sort_session["current_index"]}

                current = db.get_image_by_id(current_id)
                if not current:
                    current = {"id": current_id, "path": None}
                current_tags = db.get_image_tags(current_id) if current else []
                return {
                    "status": "undone",
                    "undone_action": undone_action,
                    "image": current,
                    "tags": current_tags,
                    "index": current_index,
                    "total": len(image_ids),
                    "remaining": len(image_ids) - current_index
                }

            if self._sort_session["current_index"] >= len(image_ids):
                return {"done": True}

            current_id = image_ids[self._sort_session["current_index"]]
            current_index = self._sort_session["current_index"]

            if action == "move" and folder_key:
                folder = self._sort_session["folders"].get(folder_key)
            else:
                folder = None

            current = db.get_image_by_id(current_id)
            if not current:
                self._sort_session["current_index"] += 1
                self._save_session_to_disk()
                # Skip missing images: fetch next
                if self._sort_session["current_index"] >= len(image_ids):
                    return {"done": True, "message": "All images sorted"}
                next_id = image_ids[self._sort_session["current_index"]]
                next_index = self._sort_session["current_index"]
                next_image = db.get_image_by_id(next_id)
                next_tags = db.get_image_tags(next_id) if next_image else []
                return {
                    "image": next_image,
                    "tags": next_tags,
                    "index": next_index,
                    "total": len(image_ids),
                    "remaining": len(image_ids) - next_index
                }

            if action == "move" and folder_key:
                if not folder:
                    return {"error": f"Folder {folder_key.upper()} is not configured"}
                if not current.get("path") or not os.path.exists(current["path"]):
                    return {"error": "Image file not found on disk"}
                try:
                    original_path = current["path"]
                    new_path = move_image(current["id"], folder, current["path"])
                    self._sort_session["history"].append({
                        "action": "move",
                        "image_id": current["id"],
                        "original_path": original_path,
                        "new_path": new_path,
                        "folder_key": folder_key
                    })
                except Exception as e:
                    logger.error("Sort move failed for image %d: %s", current["id"], e)
                    return {"error": "Failed to move image"}
            elif action == "skip":
                self._sort_session["history"].append({
                    "action": "skip",
                    "image_id": current["id"]
                })

            self._sort_session["current_index"] += 1

            if self._sort_session["current_index"] >= len(image_ids):
                self._save_session_to_disk()
                return {"done": True, "message": "All images sorted"}

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
                "remaining": len(image_ids) - next_index
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
            self._sort_session = {'active': False, 'image_ids': [], 'current_index': 0, 'folders': {}, 'history': []}
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
                return

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
                    'current_index': min(data.get('current_index', 0), len(valid_ids)),
                    'folders': validated_folders,
                    'history': data.get('history', [])
                }
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
                'image_ids': self._sort_session['image_ids']
            }
            with open(SESSION_FILE, 'w', encoding='utf-8') as f:
                json.dump(data, f)
        except Exception as e:
            logger.warning("Failed to save session to disk: %s", e)
