"""
Image service for SD Image Sorter.

Handles business logic for image retrieval, filtering, and file operations.
"""
import logging
import base64
import binascii
import io
import json
import os
import subprocess
import tempfile
import threading
import time
import uuid
from pathlib import Path
from collections import defaultdict
from datetime import datetime, timezone
from email.utils import format_datetime
from typing import Optional, Dict, Any, List, Callable

from fastapi import HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from PIL import Image, UnidentifiedImageError
from starlette.concurrency import run_in_threadpool

import database as db
from constants import VALID_ASPECT_RATIOS
from image_manager import reparse_image_metadata
from metadata_parser import parse_image, verify_image_readable
from services.indexed_file_mutation_service import save_and_reconcile_checked
from services.image_metadata_writer import (
    JPEG_LIMITATION_WARNING,
    WEBP_LIMITATION_WARNING,
    build_exif_bytes,
    build_pnginfo,
    build_sd_parameters_text,
    normalize_edited_metadata,
    prepare_image_for_save,
)
from services.bulk_job_service import (
    JOB_KIND_DELETE_FILES,
    JOB_KIND_REMOVE_FROM_GALLERY,
    get_bulk_job_service,
)
from services.tag_export_service import extract_generation_params
from thumbnail_cache import (
    get_thumbnail_async,
    generate_placeholder_thumbnail,
    clear_cache as clear_thumbnail_cache,
    cleanup_old_cache,
    enforce_cache_size_limit,
    get_cache_stats,
    SUPPORTED_SIZES,
)
from utils.path_validation import (
    ALLOWED_IMAGE_EXTENSIONS,
    PathValidationError,
    validate_file_path,
    normalize_user_path,
    validate_folder_path,
    validate_image_output_path,
)
from utils.pagination_cursor import (
    decode_image_cursor,
    encode_image_cursor_from_image,
)
from utils.source_paths import resolve_existing_indexed_image_path


logger = logging.getLogger(__name__)

# Validation constants
DIMENSION_MIN = 1
DIMENSION_MAX = 100000
LIMIT_MAX = 1000
OFFSET_MAX = 10000000
SEARCH_MAX_LENGTH = 1000
DEFAULT_PAGE_SIZE = 100
SELECTION_IDS_FETCH_CHUNK = 2000
SELECTION_IDS_MAX_RESPONSE = 100000
SELECTION_TOKEN_DEFAULT_CHUNK = 2000
SELECTION_TOKEN_MAX_CHUNK = 10000
SELECTION_TOKEN_MAX_EXCLUDED_IDS = 10000
SELECTION_TOKEN_VERSION = 2
# v3.3.2 Phase-1: chunk size for the background delete-to-trash job's batched
# DB reads (matches the literal 500 the synchronous delete path already used and
# SortingService.BATCH_MOVE_FETCH_CHUNK in spirit).
DELETE_FETCH_CHUNK = 500
PROMPT_MATCH_MODE_EXACT = "exact"
PROMPT_MATCH_MODE_CONTAINS = "contains"
VALID_PROMPT_MATCH_MODES = {PROMPT_MATCH_MODE_EXACT, PROMPT_MATCH_MODE_CONTAINS}
VALID_COLOR_TEMPERATURES = {"warm", "cool", "neutral"}
VALID_BRIGHTNESS_DISTRIBUTIONS = {"left_heavy", "right_heavy", "middle_heavy", "edge_heavy", "balanced"}
SELECTION_TOKEN_RANDOM_SORT_ERROR = (
    "random sort cannot use the chunked selection token protocol; use selection-ids or a snapshot protocol"
)
RECONNECT_PROGRESS_EVERY_N_FILES = 100
RECONNECT_PROGRESS_MIN_INTERVAL_SECONDS = 0.5
RECONNECT_MTIME_TOLERANCE_NS = 2_000_000_000


def _invalid_selection_token() -> HTTPException:
    return HTTPException(status_code=400, detail="Invalid selection token")


def _coerce_optional_int_filter(value: Any, field_name: str) -> Optional[int]:
    if value is None:
        return None
    if isinstance(value, bool):
        raise _invalid_selection_token()
    try:
        return int(value)
    except (TypeError, ValueError):
        raise _invalid_selection_token()


def _coerce_optional_float_filter(value: Any, field_name: str) -> Optional[float]:
    if value is None:
        return None
    if isinstance(value, bool):
        raise _invalid_selection_token()
    try:
        return float(value)
    except (TypeError, ValueError):
        raise _invalid_selection_token()


def _coerce_optional_string_filter(value: Any, field_name: str) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, (dict, list, tuple, set)):
        raise _invalid_selection_token()
    text = str(value).strip()
    return text or None


def _coerce_optional_bool_filter(value: Any, field_name: str) -> Optional[bool]:
    """Coerce a tri-state boolean filter for the selection contract.

    None stays None (no-op filter). Real bools pass through. Strings/ints that
    look boolean ("true"/"1"/"false"/"0") are accepted so a JSON-decoded token
    round-trips cleanly; anything else is a malformed token.
    """
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and value in (0, 1):
        return bool(value)
    if isinstance(value, str):
        text = value.strip().lower()
        if text in ("true", "1", "yes", "on"):
            return True
        if text in ("false", "0", "no", "off"):
            return False
    raise _invalid_selection_token()


def _coerce_prompt_match_mode(value: Any) -> str:
    mode = _coerce_optional_string_filter(value, "promptMatchMode") or PROMPT_MATCH_MODE_EXACT
    mode = mode.lower()
    if mode not in VALID_PROMPT_MATCH_MODES:
        raise _invalid_selection_token()
    return mode


def _coerce_tag_mode(value: Any) -> str:
    mode = _coerce_optional_string_filter(value, "tagMode") or "and"
    mode = mode.lower()
    if mode not in {"and", "or"}:
        raise _invalid_selection_token()
    return mode


def _coerce_selection_id_list(value: Any, field_name: str, *, max_length: int) -> List[int]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise _invalid_selection_token()
    if len(value) > max_length:
        raise HTTPException(status_code=400, detail=f"{field_name} exceeds max length of {max_length}")

    normalized: List[int] = []
    seen_ids: set[int] = set()
    for raw_id in value:
        if isinstance(raw_id, bool):
            raise _invalid_selection_token()
        try:
            image_id = int(raw_id)
        except (TypeError, ValueError):
            raise _invalid_selection_token()
        if image_id <= 0:
            raise _invalid_selection_token()
        if image_id in seen_ids:
            continue
        seen_ids.add(image_id)
        normalized.append(image_id)
    return normalized


def move_file_to_trash(path: str) -> None:
    """Move a file to the OS trash/recycle bin without falling back to permanent delete.

    On Windows, ``send2trash`` uses ``IFileOperation`` which normally moves the
    file to the per-volume Recycle Bin (e.g. ``I:\\$RECYCLE.BIN``). When the
    target volume has Recycle Bin disabled, is over quota, or is a network /
    removable drive without trash support, the call may silently succeed
    without actually moving the file (older Windows versions) or move it
    cross-volume in a way that surprises the user. We verify the source is
    gone after the call and raise a clear error otherwise so the caller can
    surface "Trash unavailable on this drive" instead of pretending success.
    """
    try:
        from send2trash import send2trash
    except ImportError as exc:
        raise RuntimeError(
            "Trash support is not installed. Reinstall dependencies and try again."
        ) from exc

    if not path:
        raise RuntimeError("Cannot move to trash: empty path")

    target = Path(path)
    if not target.exists():
        raise RuntimeError(f"Cannot move to trash: file does not exist at {path}")
    if target.is_dir():
        # Defensive: the indexed path should always point to a file. If a
        # directory ever sneaks in (data corruption, manual edit) we refuse
        # to trash it because that would surprise the user with a folder
        # appearing in the Recycle Bin alongside their images.
        raise RuntimeError(
            f"Refusing to move directory to trash (expected a file): {path}"
        )

    logger.info("Moving file to trash: %s", path)
    send2trash(path)

    if target.exists():
        # send2trash returned without raising but the file is still there.
        # This is the symptom users have reported on drives where Windows
        # silently disables Recycle Bin support. Surface it as a real error
        # so the caller adds the image to the failed[] array instead of
        # claiming success.
        raise RuntimeError(
            f"send2trash reported success but the file still exists on disk: {path}. "
            "The drive may have Recycle Bin disabled or be a network/removable volume "
            "without trash support."
        )


# Valid sort options and aspect ratios
VALID_SORT_OPTIONS = [
    "newest", "oldest", "name_asc", "name_desc", "generator", "generator_desc",
    "prompt_length", "prompt_length_asc", "tag_count", "tag_count_asc",
    "rating", "rating_desc", "character_count", "character_count_asc",
    "aesthetic", "aesthetic_asc",
    # v3.3.2 user star rating (FF-2)
    "user_rating", "user_rating_asc",
    "random", "file_size", "file_size_asc",
    # v3.2.1 color sorts
    "brightness", "brightness_asc",
    "saturation", "saturation_asc",
    "brightness_skew", "brightness_skew_asc",
]
def _cleanup_stale_reader_uploads(temp_dir: Path, ttl_seconds: int) -> None:
    """Best-effort cleanup for temporary Reader uploads kept for follow-up save actions."""
    try:
        temp_dir.mkdir(parents=True, exist_ok=True)
        cutoff = datetime.now(timezone.utc).timestamp() - ttl_seconds
        for candidate in temp_dir.iterdir():
            try:
                if candidate.is_file() and candidate.stat().st_mtime < cutoff:
                    candidate.unlink()
            except OSError:
                continue
    except OSError:
        logger.debug("Failed to prepare Reader temp directory", exc_info=True)


def _allocate_reader_upload_path(temp_dir: Path, filename: str) -> Path:
    suffix = Path(filename or "").suffix.lower() or ".png"
    if suffix not in {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff"}:
        suffix = ".png"
    temp_dir.mkdir(parents=True, exist_ok=True)
    return temp_dir / f"{uuid.uuid4().hex}{suffix}"



def _sanitize_filter_value(value: str) -> str:
    """
    Sanitize a filter value to prevent potential injection or corruption.
    
    - Strips leading/trailing whitespace
    - Removes null bytes
    - Limits length to prevent abuse
    """
    if not value:
        return value
    # Remove null bytes and strip whitespace
    sanitized = value.replace('\x00', '').strip()
    # Limit length to reasonable maximum (1000 chars)
    if len(sanitized) > 1000:
        sanitized = sanitized[:1000]
    return sanitized


def _sanitize_filter_list(items: Optional[str]) -> Optional[List[str]]:
    """
    Parse and sanitize a comma-separated filter string into a list.
    
    Returns None if input is None or empty after sanitization.
    """
    if not items:
        return None
    # Split and sanitize each item
    parts = items.split(',')
    sanitized = [_sanitize_filter_value(p) for p in parts]
    # Filter out empty strings
    result = [p for p in sanitized if p]
    return result if result else None


def _sanitize_filter_values(items: Any) -> Optional[List[str]]:
    """Normalize string or iterable filter inputs into one sanitized string list."""
    if items is None:
        return None

    if isinstance(items, str):
        return _sanitize_filter_list(items)

    if isinstance(items, (list, tuple, set)):
        result: List[str] = []
        for item in items:
            sanitized = _sanitize_filter_value(str(item or ""))
            if sanitized:
                result.append(sanitized)
        return result or None

    sanitized = _sanitize_filter_value(str(items))
    return [sanitized] if sanitized else None


class ImageService:
    """Service for image retrieval, filtering, and file operations."""

    @staticmethod
    def _build_default_reconnect_progress_state() -> Dict[str, Any]:
        """Return the canonical idle reconnect-progress payload."""
        return {
            "status": "idle",
            "step": "idle",
            "current": 0,
            "processed": 0,
            "total": 0,
            "total_final": False,
            "checked_files": 0,
            "missing_total": 0,
            "library_missing_total": 0,
            "matched": 0,
            "ambiguous": 0,
            "conflicts": 0,
            "skipped": 0,
            "errors": 0,
            "message": "",
            "current_item": None,
            "started_at": None,
            "updated_at": None,
        }

    def __init__(self):
        self._reconnect_progress: Dict[str, Any] = self._build_default_reconnect_progress_state()
        self._reconnect_lock = threading.Lock()
        self._reconnect_cancel_event: Optional[threading.Event] = None
        self._reconnect_run_id = 0
        # v3.3.2 Phase-1: gallery "delete selected" runs as a background job
        # (cloned from SortingService.start_move_job) so large selections stream
        # progress instead of freezing the browser on one blocking POST. Run-id
        # epoch + cooperative cancel-event guard exactly as the move job does.
        self._delete_progress: Dict[str, Any] = self._build_default_delete_progress_state()
        self._delete_lock = threading.Lock()
        self._delete_cancel_event: Optional[threading.Event] = None
        self._delete_run_id = 0
        # v3.3.2 Phase-1: background "remove from gallery" job (DB-only, no file
        # ops), cloned from the delete job above.
        self._remove_progress: Dict[str, Any] = self._build_default_remove_progress_state()
        self._remove_lock = threading.Lock()
        self._remove_cancel_event: Optional[threading.Event] = None
        self._remove_run_id = 0

    @staticmethod
    def _build_default_delete_progress_state() -> Dict[str, Any]:
        """Return the canonical idle delete-to-trash job progress payload.

        Mirrors SortingService._move_progress but reports ``deleted`` instead of
        ``moved`` and embeds the per-id ``failed`` list the frontend already
        consumes from the synchronous /delete-selected response, so the
        background path needs no new client-side mapping.
        """
        return {
            "status": "idle",
            "step": "idle",
            "current": 0,
            "total": 0,
            "message": "",
            "errors": 0,
            "deleted": 0,
            "current_item": None,
            "recent_errors": [],
            "operation": "delete",
            "failed": [],
            "started_at": None,
            "updated_at": None,
        }

    @staticmethod
    def _coerce_reconnect_progress_state(state: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        coerced = ImageService._build_default_reconnect_progress_state()
        if state:
            coerced.update(state)
        return coerced

    def get_reconnect_progress(self) -> Dict[str, Any]:
        """Return current missing-file reconnect progress."""
        with self._reconnect_lock:
            return self._reconnect_progress.copy()

    def _set_reconnect_progress_if_current(self, run_id: int, state: Dict[str, Any]) -> bool:
        with self._reconnect_lock:
            if run_id != self._reconnect_run_id:
                return False
            self._reconnect_progress = self._coerce_reconnect_progress_state(state)
            return True

    def _update_reconnect_progress_if_current(self, run_id: int, **updates: Any) -> bool:
        with self._reconnect_lock:
            if run_id != self._reconnect_run_id:
                return False
            current = self._coerce_reconnect_progress_state(self._reconnect_progress)
            current.update(updates)
            self._reconnect_progress = current
            return True

    @staticmethod
    def _parse_datetime_to_ns(value: Any) -> Optional[int]:
        if value is None:
            return None
        if isinstance(value, datetime):
            return int(value.timestamp() * 1_000_000_000)
        text = str(value).strip()
        if not text:
            return None
        normalized = text.replace("Z", "+00:00")
        try:
            parsed = datetime.fromisoformat(normalized)
        except ValueError:
            return None
        return int(parsed.timestamp() * 1_000_000_000)

    @staticmethod
    def _candidate_expected_size(candidate: Dict[str, Any]) -> Optional[int]:
        for key in ("source_size", "file_size"):
            value = candidate.get(key)
            if value is None:
                continue
            try:
                return int(value)
            except (TypeError, ValueError):
                continue
        return None

    @classmethod
    def _candidate_expected_mtime_ns(cls, candidate: Dict[str, Any]) -> Optional[int]:
        value = candidate.get("source_mtime_ns")
        if value is not None:
            try:
                return int(value)
            except (TypeError, ValueError):
                pass
        return cls._parse_datetime_to_ns(candidate.get("source_file_mtime"))

    @staticmethod
    def _mtime_matches(expected_ns: Optional[int], stat_result: os.stat_result) -> bool:
        if expected_ns is None:
            return False
        return abs(int(expected_ns) - int(stat_result.st_mtime_ns)) <= RECONNECT_MTIME_TOLERANCE_NS

    @staticmethod
    def _normalized_fingerprint(value: Any) -> Optional[str]:
        text = str(value or "").strip().lower()
        return text or None

    def _find_reconnect_match(
        self,
        found_path: str,
        stat_result: os.stat_result,
        candidates: List[Dict[str, Any]],
        *,
        verify_uncertain: bool,
    ) -> tuple[Optional[Dict[str, Any]], str]:
        """Find a safe row match for one discovered file."""
        stat_matches: List[Dict[str, Any]] = []
        fingerprint_candidates: List[Dict[str, Any]] = []
        name_size_only: List[Dict[str, Any]] = []

        for candidate in candidates:
            expected_size = self._candidate_expected_size(candidate)
            if expected_size is not None and expected_size != int(stat_result.st_size):
                continue

            expected_mtime_ns = self._candidate_expected_mtime_ns(candidate)
            if self._mtime_matches(expected_mtime_ns, stat_result):
                stat_matches.append(candidate)
                continue

            if verify_uncertain and self._normalized_fingerprint(candidate.get("content_fingerprint")):
                fingerprint_candidates.append(candidate)
                continue

            if expected_mtime_ns is None and not self._normalized_fingerprint(candidate.get("content_fingerprint")):
                name_size_only.append(candidate)

        if len(stat_matches) == 1:
            return stat_matches[0], "stat"
        if len(stat_matches) > 1:
            return None, "ambiguous"

        if fingerprint_candidates:
            try:
                from image_fingerprint import compute_image_content_fingerprint

                found_fingerprint = self._normalized_fingerprint(compute_image_content_fingerprint(found_path))
            except Exception as exc:
                logger.debug("Could not fingerprint reconnect candidate %s: %s", found_path, exc)
                found_fingerprint = None
            if found_fingerprint:
                verified = [
                    candidate for candidate in fingerprint_candidates
                    if self._normalized_fingerprint(candidate.get("content_fingerprint")) == found_fingerprint
                ]
                if len(verified) == 1:
                    return verified[0], "fingerprint"
                if len(verified) > 1:
                    return None, "ambiguous"

        if len(name_size_only) == 1:
            return name_size_only[0], "name_size"
        if len(name_size_only) > 1:
            return None, "ambiguous"

        return None, "none"

    @staticmethod
    def _iter_reconnect_image_files(search_folder: str, recursive: bool, stop_requested: Optional[Callable[[], bool]] = None):
        pending_dirs = [os.path.abspath(search_folder)]
        while pending_dirs:
            if callable(stop_requested) and stop_requested():
                raise InterruptedError("Reconnect cancelled")
            current_dir = pending_dirs.pop()
            try:
                with os.scandir(current_dir) as entries:
                    for entry in entries:
                        if callable(stop_requested) and stop_requested():
                            raise InterruptedError("Reconnect cancelled")
                        try:
                            if entry.is_symlink():
                                continue
                            if entry.is_dir(follow_symlinks=False):
                                if recursive:
                                    pending_dirs.append(entry.path)
                                continue
                            if not entry.is_file(follow_symlinks=False):
                                continue
                            if Path(entry.name).suffix.lower() not in ALLOWED_IMAGE_EXTENSIONS:
                                continue
                            yield entry.path, entry.name
                        except FileNotFoundError:
                            continue
            except PermissionError as exc:
                logger.warning("Permission denied while reconnecting missing files in %s: %s", current_dir, exc)
                continue

    def reconnect_missing_files_once(
        self,
        search_folder: str,
        *,
        recursive: bool = True,
        verify_uncertain: bool = True,
        progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None,
        stop_requested: Optional[Callable[[], bool]] = None,
    ) -> Dict[str, Any]:
        """Search one folder for files that can reconnect missing library rows."""
        normalized_folder = normalize_user_path(search_folder)
        missing_candidates = db.get_missing_image_reconnect_candidates()
        candidates_by_name: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
        for candidate in missing_candidates:
            filename = str(candidate.get("filename") or Path(str(candidate.get("path") or "")).name)
            if filename:
                candidates_by_name[filename].append(candidate)

        result: Dict[str, Any] = {
            "checked_files": 0,
            "missing_total": 0,
            "library_missing_total": len(missing_candidates),
            "matched": 0,
            "ambiguous": 0,
            "conflicts": 0,
            "skipped": 0,
            "errors": 0,
            "still_missing": 0,
            "updated": [],
            "needs_review": [],
            "conflict_samples": [],
            "still_missing_samples": [],
            "recent_errors": [],
        }
        used_image_ids: set[int] = set()
        accounted_image_ids: set[int] = set()
        target_candidate_ids: set[int] = set()
        used_found_paths: set[str] = set()
        last_emit = 0.0

        def candidate_id(row: Dict[str, Any]) -> int:
            try:
                return int(row.get("id") or 0)
            except (TypeError, ValueError):
                return 0

        def refresh_scoped_missing_counts() -> None:
            result["missing_total"] = len(target_candidate_ids)
            result["still_missing"] = max(0, len(target_candidate_ids - accounted_image_ids))

        def emit(force: bool = False, current_item: Optional[str] = None) -> None:
            nonlocal last_emit
            if not progress_callback:
                return
            now = time.monotonic()
            if not force and result["checked_files"] % RECONNECT_PROGRESS_EVERY_N_FILES != 0 and now - last_emit < RECONNECT_PROGRESS_MIN_INTERVAL_SECONDS:
                return
            last_emit = now
            progress_callback({**result, "current_item": current_item})

        emit(force=True)
        if not missing_candidates:
            return result

        for found_path, filename in self._iter_reconnect_image_files(normalized_folder, recursive, stop_requested):
            if callable(stop_requested) and stop_requested():
                raise InterruptedError("Reconnect cancelled")
            result["checked_files"] += 1
            candidate_rows = [
                row for row in candidates_by_name.get(filename, [])
                if candidate_id(row) not in used_image_ids
            ]
            if not candidate_rows:
                emit(current_item=filename)
                continue

            for row in candidate_rows:
                row_id = candidate_id(row)
                if row_id > 0:
                    target_candidate_ids.add(row_id)
            refresh_scoped_missing_counts()

            try:
                stat_result = os.stat(found_path)
                match, reason = self._find_reconnect_match(
                    found_path,
                    stat_result,
                    candidate_rows,
                    verify_uncertain=verify_uncertain,
                )
                resolved_found_path = os.path.abspath(found_path)
                if match and resolved_found_path not in used_found_paths:
                    image_id = int(match["id"])
                    existing_at_found_path = db.get_image_by_path(resolved_found_path)
                    if existing_at_found_path and int(existing_at_found_path.get("id") or 0) != image_id:
                        result["conflicts"] += 1
                        accounted_image_ids.add(image_id)
                        refresh_scoped_missing_counts()
                        if len(result["conflict_samples"]) < 10:
                            result["conflict_samples"].append({
                                "filename": filename,
                                "old_image_id": image_id,
                                "old_path": match.get("path"),
                                "found_path": resolved_found_path,
                                "existing_image_id": existing_at_found_path.get("id"),
                                "existing_path": existing_at_found_path.get("path"),
                            })
                        emit(current_item=filename)
                        continue

                    db.reconnect_image_source_path(
                        image_id,
                        resolved_found_path,
                        source_mtime_ns=int(stat_result.st_mtime_ns),
                        source_size=int(stat_result.st_size),
                        source_file_mtime=datetime.fromtimestamp(stat_result.st_mtime),
                    )
                    used_image_ids.add(image_id)
                    accounted_image_ids.add(image_id)
                    used_found_paths.add(resolved_found_path)
                    result["matched"] += 1
                    refresh_scoped_missing_counts()
                    if len(result["updated"]) < 10:
                        result["updated"].append({
                            "image_id": image_id,
                            "filename": filename,
                            "old_path": match.get("path"),
                            "new_path": resolved_found_path,
                            "match": reason,
                        })
                elif reason == "ambiguous":
                    result["ambiguous"] += 1
                    for row in candidate_rows:
                        row_id = candidate_id(row)
                        if row_id > 0:
                            accounted_image_ids.add(row_id)
                    refresh_scoped_missing_counts()
                    if len(result["needs_review"]) < 10:
                        result["needs_review"].append({
                            "filename": filename,
                            "found_path": resolved_found_path,
                            "candidate_count": len(candidate_rows),
                            "old_paths": [row.get("path") for row in candidate_rows[:3]],
                        })
                else:
                    result["skipped"] += 1
            except OSError as exc:
                result["errors"] += 1
                result["recent_errors"].append({"filename": filename, "error": str(exc)})
                result["recent_errors"] = result["recent_errors"][-5:]
            emit(current_item=filename)

        refresh_scoped_missing_counts()
        still_missing_samples = []
        for candidate in missing_candidates:
            candidate_id_value = candidate_id(candidate)
            if candidate_id_value not in target_candidate_ids or candidate_id_value in accounted_image_ids:
                continue
            still_missing_samples.append({
                "image_id": candidate_id_value,
                "filename": candidate.get("filename") or Path(str(candidate.get("path") or "")).name,
                "old_path": candidate.get("path"),
            })
            if len(still_missing_samples) >= 10:
                break
        result["still_missing_samples"] = still_missing_samples
        emit(force=True)
        return result

    def start_reconnect_missing_files(self, request: Any, background_tasks: Any) -> Dict[str, str]:
        """Start a background task that reconnects missing image rows to found files."""
        normalized_folder = normalize_user_path(request.search_folder)
        is_valid, error = validate_folder_path(normalized_folder)
        if not is_valid:
            raise HTTPException(status_code=400, detail=error or "Invalid folder path")

        with self._reconnect_lock:
            if self._reconnect_progress.get("status") in {"running", "cancelling"}:
                raise HTTPException(status_code=400, detail="Missing-file reconnect already in progress")
            self._reconnect_run_id += 1
            run_id = self._reconnect_run_id
            cancel_event = threading.Event()
            started_at = time.time()
            self._reconnect_cancel_event = cancel_event
            self._reconnect_progress = {
                **self._build_default_reconnect_progress_state(),
                "status": "running",
                "step": "starting",
                "message": "Looking for missing library files...",
                "started_at": started_at,
                "updated_at": started_at,
            }

        def progress_cb(snapshot: Dict[str, Any]) -> None:
            checked = int(snapshot.get("checked_files", 0) or 0)
            missing_total = int(snapshot.get("missing_total", 0) or 0)
            library_missing_total = int(snapshot.get("library_missing_total", 0) or 0)
            matched = int(snapshot.get("matched", 0) or 0)
            ambiguous = int(snapshot.get("ambiguous", 0) or 0)
            conflicts = int(snapshot.get("conflicts", 0) or 0)
            errors = int(snapshot.get("errors", 0) or 0)
            self._update_reconnect_progress_if_current(
                run_id,
                status="running",
                step="searching",
                current=checked,
                processed=checked,
                total=0,
                total_final=False,
                checked_files=checked,
                missing_total=missing_total,
                library_missing_total=library_missing_total,
                matched=matched,
                ambiguous=ambiguous,
                conflicts=conflicts,
                skipped=int(snapshot.get("skipped", 0) or 0),
                errors=errors,
                message=f"Checked {checked} files. Reconnected {matched}/{missing_total} missing files.",
                current_item=snapshot.get("current_item"),
                updated_at=time.time(),
            )

        def run_reconnect() -> None:
            try:
                result = self.reconnect_missing_files_once(
                    normalized_folder,
                    recursive=bool(request.recursive),
                    verify_uncertain=bool(request.verify_uncertain),
                    progress_callback=progress_cb,
                    stop_requested=cancel_event.is_set,
                )
                now = time.time()
                self._set_reconnect_progress_if_current(
                    run_id,
                    {
                        **self._build_default_reconnect_progress_state(),
                        "status": "done",
                        "step": "done",
                        "current": result.get("checked_files", 0),
                        "processed": result.get("checked_files", 0),
                        "total": result.get("checked_files", 0),
                        "total_final": True,
                        "checked_files": result.get("checked_files", 0),
                        "missing_total": result.get("missing_total", 0),
                        "library_missing_total": result.get("library_missing_total", 0),
                        "matched": result.get("matched", 0),
                        "ambiguous": result.get("ambiguous", 0),
                        "conflicts": result.get("conflicts", 0),
                        "skipped": result.get("skipped", 0),
                        "errors": result.get("errors", 0),
                        "message": (
                            f"Reconnected {result.get('matched', 0)} missing files. "
                            f"{result.get('still_missing', 0)} still missing."
                        ),
                        "current_item": None,
                        "started_at": self._reconnect_progress.get("started_at"),
                        "updated_at": now,
                        "result": result,
                    },
                )
            except InterruptedError:
                current = self.get_reconnect_progress()
                now = time.time()
                self._set_reconnect_progress_if_current(
                    run_id,
                    {
                        **current,
                        "status": "cancelled",
                        "step": "cancelled",
                        "message": f"Stopped after checking {current.get('checked_files', 0)} files.",
                        "updated_at": now,
                    },
                )
            except Exception as exc:
                logger.error("Missing-file reconnect failed: %s", exc, exc_info=True)
                current = self.get_reconnect_progress()
                self._set_reconnect_progress_if_current(
                    run_id,
                    {
                        **current,
                        "status": "error",
                        "step": "error",
                        "errors": int(current.get("errors", 0) or 0) + 1,
                        "message": "Could not finish finding moved files.",
                        "updated_at": time.time(),
                    },
                )

        background_tasks.add_task(run_reconnect)
        return {"status": "started", "message": "Missing-file reconnect started in background"}

    def cancel_reconnect_missing_files(self) -> Dict[str, Any]:
        """Request cancellation of the missing-file reconnect task."""
        with self._reconnect_lock:
            if self._reconnect_progress.get("status") not in {"running", "cancelling"}:
                return self._reconnect_progress.copy()
            if self._reconnect_cancel_event:
                self._reconnect_cancel_event.set()
            self._reconnect_progress = {
                **self._reconnect_progress,
                "status": "cancelling",
                "step": "cancelling",
                "message": "Stopping missing-file search...",
                "updated_at": time.time(),
            }
            return self._reconnect_progress.copy()

    def _validate_common_gallery_filters(
        self,
        *,
        sort_by: str,
        aspect_ratio: Optional[str],
        min_width: Optional[int],
        max_width: Optional[int],
        min_height: Optional[int],
        max_height: Optional[int],
        brightness_min: Optional[float] = None,
        brightness_max: Optional[float] = None,
        color_temperature: Optional[str] = None,
        brightness_distribution: Optional[str] = None,
    ) -> None:
        """Validate shared gallery filter constraints used by list and selection flows."""
        if sort_by not in VALID_SORT_OPTIONS:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid sort_by value. Must be one of: {', '.join(VALID_SORT_OPTIONS)}"
            )

        if aspect_ratio is not None and aspect_ratio not in VALID_ASPECT_RATIOS:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid aspect_ratio value. Must be one of: {', '.join(VALID_ASPECT_RATIOS)}"
            )

        if min_width is not None and max_width is not None and min_width > max_width:
            raise HTTPException(
                status_code=400,
                detail="min_width cannot be greater than max_width"
            )
        if min_height is not None and max_height is not None and min_height > max_height:
            raise HTTPException(
                status_code=400,
                detail="min_height cannot be greater than max_height"
            )
        if brightness_min is not None and (brightness_min < 0 or brightness_min > 255):
            raise HTTPException(status_code=400, detail="brightness_min must be between 0 and 255")
        if brightness_max is not None and (brightness_max < 0 or brightness_max > 255):
            raise HTTPException(status_code=400, detail="brightness_max must be between 0 and 255")
        if brightness_min is not None and brightness_max is not None and brightness_min > brightness_max:
            raise HTTPException(status_code=400, detail="brightness_min cannot be greater than brightness_max")
        if color_temperature is not None and color_temperature.lower() not in VALID_COLOR_TEMPERATURES:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid color_temperature value. Must be one of: {', '.join(sorted(VALID_COLOR_TEMPERATURES))}"
            )
        if brightness_distribution is not None and brightness_distribution.lower() not in VALID_BRIGHTNESS_DISTRIBUTIONS:
            raise HTTPException(
                status_code=400,
                detail=(
                    "Invalid brightness_distribution value. Must be one of: "
                    f"{', '.join(sorted(VALID_BRIGHTNESS_DISTRIBUTIONS))}"
                )
            )

    def _filter_and_mark_missing_images(self, images: List[Dict[str, Any]]) -> tuple[List[Dict[str, Any]], int]:
        """Drop rows whose backing files no longer exist and persist that state in SQLite."""
        live_images: List[Dict[str, Any]] = []
        missing_count = 0

        for image in images:
            image_id = int(image.get("id") or 0)
            primary_path = str(image.get("path") or "")
            resolved_path = resolve_existing_indexed_image_path(primary_path, backend_file=__file__)
            if resolved_path:
                live_images.append(image)
                continue

            current_image = db.get_image_by_id(image_id) if image_id > 0 else None
            if current_image:
                current_path = str(current_image.get("path") or "")
                current_resolved_path = resolve_existing_indexed_image_path(current_path, backend_file=__file__)
                if current_resolved_path:
                    live_images.append(current_image)
                    continue

            missing_count += 1
            if image_id > 0:
                db.mark_image_unreadable(image_id, "File not found on disk")

        return live_images, missing_count

    # ------------------------------------------------------------------
    # v3.3.2 Phase-1: background "delete selected" job. Cloned 1:1 from the
    # sorting-service move job (start_move_job / get_move_progress /
    # cancel_move / reset_move_progress / _set_move_progress_if_current /
    # _update_move_progress_if_current). Delete-ONLY for now; it is the concrete
    # template for backgrounding remove/export in a later slice (no generic job
    # abstraction yet, by design).
    # ------------------------------------------------------------------
    def get_delete_progress(self) -> Dict[str, Any]:
        """Get the current gallery delete-to-trash job progress."""
        with self._delete_lock:
            return self._delete_progress.copy()

    def reset_delete_progress(self) -> Dict[str, Any]:
        """Reset a stuck delete job (refused while it is still running)."""
        with self._delete_lock:
            if self._delete_progress["status"] == "running":
                raise HTTPException(status_code=409, detail="Cannot reset delete while it is still running")
            return {"status": self._delete_progress["status"], "message": "Nothing to reset"}

    def cancel_delete(self) -> Dict[str, Any]:
        """Request cooperative cancellation of the active delete-to-trash job."""
        with self._delete_lock:
            current_status = self._delete_progress.get("status")
            if current_status not in {"running", "cancelling"}:
                return {"status": current_status, "message": "No delete task is running"}

            current = int(self._delete_progress.get("current", 0) or 0)
            total = int(self._delete_progress.get("total", 0) or 0)

            if self._delete_cancel_event is not None:
                self._delete_cancel_event.set()

            self._delete_progress["status"] = "cancelling"
            self._delete_progress["step"] = "cancelling"
            self._delete_progress["message"] = (
                f"Cancelling delete... ({current}/{total})"
                if total > 0
                else "Cancelling delete..."
            )
            self._delete_progress["updated_at"] = time.time()
            return {"status": "cancelling", "message": "Delete cancellation requested"}

    def _set_delete_progress_if_current(self, run_id: int, state: Dict[str, Any]) -> bool:
        """Only allow the active delete job to replace shared progress state."""
        with self._delete_lock:
            if run_id != self._delete_run_id:
                return False
            self._delete_progress = state
            return True

    def _update_delete_progress_if_current(self, run_id: int, **updates: Any) -> bool:
        """Only allow the active delete job to mutate shared progress state."""
        with self._delete_lock:
            if run_id != self._delete_run_id:
                return False
            self._delete_progress = {
                **self._delete_progress,
                **updates,
            }
            return True

    def _normalize_delete_ids(self, image_ids: List[int]) -> List[int]:
        """Dedup a delete id list preserving order.

        Matches the synchronous path's normalization exactly (int-cast + dedup,
        intentionally NO ``<= 0`` filtering — that is a remove-from-gallery
        concern, not a delete one).
        """
        normalized_ids: List[int] = []
        seen_ids: set[int] = set()
        for raw_image_id in image_ids or []:
            image_id = int(raw_image_id)
            if image_id in seen_ids:
                continue
            seen_ids.add(image_id)
            normalized_ids.append(image_id)
        return normalized_ids

    def _delete_one_image_to_trash(self, image_id: int, image: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        """Trash one image file + drop its DB row; return a normalized per-id result.

        v3.3.2 Phase-1: shared by the synchronous ``delete_selected_image_files``
        endpoint and the background delete job (mirrors how ``_move_one_image`` is
        shared by ``move_images`` and ``start_move_job``) so both paths produce
        identical ``failed`` rows and the same trash-then-delete-row ordering.
        ``move_file_to_trash`` is referenced as a module global so existing tests
        that monkeypatch ``image_service.move_file_to_trash`` still intercept it.
        """
        if not image:
            return {"id": image_id, "success": False, "filename": None, "error": "Image not found"}

        filename = image.get("filename") or Path(str(image.get("path") or "")).name or f"image_{image_id}"
        try:
            source_path = self.resolve_image_source_path(image_id, image.get("path", ""))
            move_file_to_trash(source_path)
            db.delete_image(image_id)
            return {"id": image_id, "success": True, "filename": filename}
        except HTTPException as exc:
            return {
                "id": image_id,
                "success": False,
                "filename": filename,
                "error": exc.detail or "Image file not found on disk",
            }
        except Exception as exc:
            return {"id": image_id, "success": False, "filename": filename, "error": str(exc)}

    def _expand_delete_request_ids(
        self, image_ids: Optional[List[int]], selection_token: Optional[str]
    ) -> List[int]:
        """Resolve a delete request into a concrete, deduped image-id snapshot.

        v3.3.2 Phase-1: a ``selection_token`` (Select All Filtered scope) is
        snapshotted to a temp file and read back via
        ``_iter_selection_token_snapshot_chunks`` BEFORE any deletion, so the id
        set is frozen and unaffected by the rows the job is about to remove.
        Mirrors ``SortingService._expand_move_request_ids``.
        """
        if selection_token:
            snapshot: List[int] = []
            for chunk in self._iter_selection_token_snapshot_chunks(selection_token, chunk_size=500):
                snapshot.extend(chunk)
            return snapshot
        return self._normalize_delete_ids(image_ids or [])

    def start_delete_selected_job(self, request: Any, background_tasks: Any) -> Dict[str, Any]:
        """v3.3.2 Phase-1: gallery "delete selected" as a background job with
        progress polling, cloned from ``SortingService.start_move_job``. The
        final progress payload embeds ``deleted`` + ``failed`` so the frontend
        mapping is identical to the synchronous ``/delete-selected`` endpoint.
        Files are trashed one at a time as the worker advances, so the progress
        bar tracks deletion. The id set is snapshotted before the worker starts.
        """
        with self._delete_lock:
            if self._delete_progress["status"] in {"running", "cancelling"}:
                raise HTTPException(status_code=409, detail="A delete is already in progress")

        image_ids = self._expand_delete_request_ids(
            getattr(request, "image_ids", None),
            getattr(request, "selection_token", None),
        )
        total_count = len(image_ids)
        if total_count == 0:
            return {
                "status": "done",
                "message": "No images to delete",
                "deleted": 0,
                "failed": [],
                "total": 0,
                "operation": "delete",
                "permanent_delete": False,
                "trash_used": True,
            }

        cancel_event = threading.Event()
        with self._delete_lock:
            self._delete_run_id += 1
            run_id = self._delete_run_id
            self._delete_cancel_event = cancel_event
            self._delete_progress = {
                **self._build_default_delete_progress_state(),
                "status": "running",
                "step": "starting",
                "current": 0,
                "total": total_count,
                "message": f"Starting delete of {total_count} images...",
                "started_at": time.time(),
                "updated_at": time.time(),
            }

        def run_delete():
            deleted = 0
            processed = 0
            errors: List[Dict[str, Any]] = []
            try:
                def _write_cancelled_state() -> None:
                    self._set_delete_progress_if_current(
                        run_id,
                        {
                            **self._build_default_delete_progress_state(),
                            "status": "cancelled",
                            "step": "cancelled",
                            "current": processed,
                            "total": total_count,
                            "errors": len(errors),
                            "deleted": deleted,
                            "message": (
                                f"Cancelled at {processed}/{total_count}. "
                                f"Trashed {deleted} images so far."
                            ),
                            "current_item": None,
                            "recent_errors": errors[-3:],
                            "operation": "delete",
                            "failed": errors,
                            "started_at": self._delete_progress.get("started_at"),
                            "updated_at": time.time(),
                        },
                    )

                # Walk the snapshotted id list in chunks so the per-image DB rows
                # are fetched in batches (matches the sync path's IN(...) chunking)
                # while progress advances per image. Cancel is honored at the
                # chunk boundary AND before each individual trash.
                for start in range(0, total_count, DELETE_FETCH_CHUNK):
                    if cancel_event.is_set():
                        _write_cancelled_state()
                        return
                    chunk_ids = image_ids[start:start + DELETE_FETCH_CHUNK]
                    image_map = db.get_images_by_ids(chunk_ids)

                    for image_id in chunk_ids:
                        if cancel_event.is_set():
                            _write_cancelled_state()
                            return

                        image = image_map.get(image_id)
                        result = self._delete_one_image_to_trash(image_id, image)
                        filename = result.get("filename") or f"id-{image_id}"
                        if result.get("success"):
                            deleted += 1
                        else:
                            errors.append({
                                "image_id": image_id,
                                "filename": result.get("filename"),
                                "error": result.get("error") or "Failed",
                            })
                        processed += 1
                        if not self._update_delete_progress_if_current(
                            run_id,
                            step="deleting",
                            current=processed,
                            total=total_count,
                            errors=len(errors),
                            deleted=deleted,
                            message=f"Trashed {filename} ({processed}/{total_count})",
                            current_item=filename,
                            recent_errors=errors[-3:],
                            operation="delete",
                            updated_at=time.time(),
                        ):
                            return

                self._set_delete_progress_if_current(
                    run_id,
                    {
                        **self._build_default_delete_progress_state(),
                        "status": "done",
                        "step": "done",
                        "current": total_count,
                        "total": total_count,
                        "errors": len(errors),
                        "deleted": deleted,
                        "message": f"Completed! Trashed {deleted} images." + (f" {len(errors)} errors." if errors else ""),
                        "current_item": None,
                        "recent_errors": errors[-3:],
                        "operation": "delete",
                        "failed": errors,
                        "started_at": self._delete_progress.get("started_at"),
                        "updated_at": time.time(),
                    },
                )
            except Exception as e:
                logger.error("Delete job failed: %s", e)
                self._set_delete_progress_if_current(
                    run_id,
                    {
                        **self._build_default_delete_progress_state(),
                        "status": "error",
                        "step": "error",
                        "current": processed,
                        "total": total_count,
                        "errors": len(errors),
                        "deleted": deleted,
                        "message": "Delete failed due to an internal error",
                        "current_item": None,
                        "recent_errors": errors[-3:],
                        "operation": "delete",
                        "failed": errors,
                        "started_at": self._delete_progress.get("started_at"),
                        "updated_at": time.time(),
                    },
                )
            finally:
                with self._delete_lock:
                    if (
                        self._delete_run_id == run_id
                        and self._delete_cancel_event is cancel_event
                    ):
                        self._delete_cancel_event = None

        background_tasks.add_task(run_delete)
        return {
            "status": "started",
            "message": f"Deleting {total_count} images in background",
            "total": total_count,
            "count": total_count,
            "operation": "delete",
        }

    def delete_selected_image_files(self, image_ids: List[int]) -> Dict[str, Any]:
        """Move image files to OS trash and remove their database rows.

        Returns a partial-failure payload so the frontend can show a truthful
        summary instead of pretending the whole batch succeeded.

        v3.3.2 Phase-1: the per-image trash+delete step is shared with the
        background delete job via ``_delete_one_image_to_trash``, so the two
        paths stay byte-for-byte identical in their failure reporting. Kept
        synchronous and unchanged in its public contract for back-compat (tests
        and programmatic callers); the gallery UI now drives ``start_delete_selected_job``.
        """
        deleted = 0
        failed: List[Dict[str, Any]] = []

        # Two-pass: normalize + dedup first so we can batch the DB read.
        # `get_images_by_ids` chunks IN(...) at 500 ids internally so the
        # access pattern stays bounded even under the raised 5M ceiling.
        normalized_ids = self._normalize_delete_ids(image_ids)

        if not normalized_ids:
            return {
                "deleted": 0,
                "failed": [],
                "permanent_delete": False,
                "trash_used": True,
            }

        for batch_start in range(0, len(normalized_ids), DELETE_FETCH_CHUNK):
            batch_ids = normalized_ids[batch_start:batch_start + DELETE_FETCH_CHUNK]
            images_map = db.get_images_by_ids(batch_ids)

            for image_id in batch_ids:
                result = self._delete_one_image_to_trash(image_id, images_map.get(image_id))
                if result.get("success"):
                    deleted += 1
                else:
                    failed.append({
                        "image_id": image_id,
                        "filename": result.get("filename"),
                        "error": result.get("error") or "Failed",
                    })

        return {
            "deleted": deleted,
            "failed": failed,
            "permanent_delete": False,
            "trash_used": True,
        }

    def delete_selected_image_files_by_token(self, selection_token: str) -> Dict[str, Any]:
        """Move all images referenced by a filtered-selection token to trash in chunks."""
        deleted = 0
        failed: List[Dict[str, Any]] = []
        for batch_ids in self._iter_selection_token_snapshot_chunks(selection_token, chunk_size=500):
            result = self.delete_selected_image_files(batch_ids)
            deleted += int(result.get("deleted", 0) or 0)
            failed.extend(result.get("failed", []) or [])

        return {
            "deleted": deleted,
            "failed": failed,
            "permanent_delete": False,
            "trash_used": True,
        }

    def _remove_selected_image_id_chunk(self, image_ids: List[int]) -> Dict[str, Any]:
        normalized_ids: List[int] = []
        seen_ids = set()
        for raw_image_id in image_ids or []:
            image_id = int(raw_image_id)
            if image_id <= 0 or image_id in seen_ids:
                continue
            seen_ids.add(image_id)
            normalized_ids.append(image_id)

        if not normalized_ids:
            return {"removed": 0, "missing_ids": []}

        existing_ids = {
            int(image_id)
            for image_id, image in db.get_images_by_ids(normalized_ids).items()
            if image
        }
        removed = db.delete_images_by_ids(normalized_ids)
        missing_ids = [image_id for image_id in normalized_ids if image_id not in existing_ids]

        return {"removed": removed, "missing_ids": missing_ids}

    def remove_selected_images_from_gallery(self, image_ids: List[int]) -> Dict[str, Any]:
        """Remove images from the local gallery index without deleting files."""
        removed = 0
        missing_ids: List[int] = []

        normalized_ids: List[int] = []
        seen_ids = set()
        for raw_image_id in image_ids or []:
            image_id = int(raw_image_id)
            if image_id <= 0 or image_id in seen_ids:
                continue
            seen_ids.add(image_id)
            normalized_ids.append(image_id)

        for batch_start in range(0, len(normalized_ids), 500):
            result = self._remove_selected_image_id_chunk(normalized_ids[batch_start:batch_start + 500])
            removed += int(result.get("removed", 0) or 0)
            missing_ids.extend(result.get("missing_ids", []) or [])

        return {
            "removed": removed,
            "missing_ids": missing_ids,
            "permanent_delete": False,
        }

    def remove_selected_images_from_gallery_by_token(self, selection_token: str) -> Dict[str, Any]:
        """Remove token-selected images from the gallery index in bounded chunks."""
        removed = 0
        missing_ids: List[int] = []
        for batch_ids in self._iter_selection_token_snapshot_chunks(selection_token, chunk_size=500):
            result = self._remove_selected_image_id_chunk(batch_ids)
            removed += int(result.get("removed", 0) or 0)
            missing_ids.extend(result.get("missing_ids", []) or [])

        return {
            "removed": removed,
            "missing_ids": missing_ids,
            "permanent_delete": False,
        }

    @staticmethod
    def _build_default_remove_progress_state() -> Dict[str, Any]:
        """Idle progress payload for the background remove-from-gallery job.

        Mirrors the delete job but reports ``removed`` + ``missing_ids`` (the
        fields the frontend already consumes from the synchronous
        /remove-selected response) instead of ``deleted`` + ``failed``.
        """
        return {
            "status": "idle",
            "step": "idle",
            "current": 0,
            "total": 0,
            "message": "",
            "removed": 0,
            "missing_ids": [],
            "current_item": None,
            "operation": "remove",
            "permanent_delete": False,
            "started_at": None,
            "updated_at": None,
        }

    def get_remove_progress(self) -> Dict[str, Any]:
        with self._remove_lock:
            return self._remove_progress.copy()

    def reset_remove_progress(self) -> Dict[str, Any]:
        with self._remove_lock:
            if self._remove_progress["status"] == "running":
                return {"status": "running", "message": "Cannot reset a running job"}
            self._remove_progress = self._build_default_remove_progress_state()
            return {"status": self._remove_progress["status"], "message": "Nothing to reset"}

    def cancel_remove(self) -> Dict[str, Any]:
        with self._remove_lock:
            current_status = self._remove_progress.get("status")
            if current_status not in {"running", "cancelling"}:
                return {"status": current_status, "message": "No remove in progress"}
            if self._remove_cancel_event is not None:
                self._remove_cancel_event.set()
            self._remove_progress["status"] = "cancelling"
            self._remove_progress["step"] = "cancelling"
            self._remove_progress["message"] = "Stopping remove..."
            self._remove_progress["updated_at"] = time.time()
            return {"status": "cancelling", "message": "Stopping remove..."}

    def _set_remove_progress_if_current(self, run_id: int, state: Dict[str, Any]) -> bool:
        with self._remove_lock:
            if run_id != self._remove_run_id:
                return False
            self._remove_progress = state
            return True

    def _update_remove_progress_if_current(self, run_id: int, **updates: Any) -> bool:
        with self._remove_lock:
            if run_id != self._remove_run_id:
                return False
            self._remove_progress = {**self._remove_progress, **updates}
            return True

    def _expand_remove_request_ids(
        self, image_ids: Optional[List[int]], selection_token: Optional[str]
    ) -> List[int]:
        """Resolve a remove request into a deduped image-id snapshot (mirrors
        ``_expand_delete_request_ids``; token rows are frozen before mutation)."""
        if selection_token:
            snapshot: List[int] = []
            for chunk in self._iter_selection_token_snapshot_chunks(selection_token, chunk_size=500):
                snapshot.extend(chunk)
            return snapshot
        normalized: List[int] = []
        seen: set = set()
        for raw_image_id in image_ids or []:
            image_id = int(raw_image_id)
            if image_id <= 0 or image_id in seen:
                continue
            seen.add(image_id)
            normalized.append(image_id)
        return normalized

    def start_remove_selected_job(self, request: Any, background_tasks: Any) -> Dict[str, Any]:
        """v3.3.2 Phase-1: gallery "remove from gallery" as a background job with
        progress polling, cloned from ``start_delete_selected_job``. DB-only (no
        file ops); the final payload embeds ``removed`` + ``missing_ids`` so the
        frontend mapping matches the synchronous ``/remove-selected`` endpoint.
        The id set is snapshotted before the worker starts.
        """
        with self._remove_lock:
            if self._remove_progress["status"] in {"running", "cancelling"}:
                raise HTTPException(status_code=409, detail="A remove is already in progress")

        image_ids = self._expand_remove_request_ids(
            getattr(request, "image_ids", None),
            getattr(request, "selection_token", None),
        )
        total_count = len(image_ids)
        if total_count == 0:
            return {
                "status": "done",
                "message": "No images to remove",
                "removed": 0,
                "missing_ids": [],
                "total": 0,
                "operation": "remove",
                "permanent_delete": False,
            }

        cancel_event = threading.Event()
        with self._remove_lock:
            self._remove_run_id += 1
            run_id = self._remove_run_id
            self._remove_cancel_event = cancel_event
            self._remove_progress = {
                **self._build_default_remove_progress_state(),
                "status": "running",
                "step": "starting",
                "current": 0,
                "total": total_count,
                "message": f"Starting remove of {total_count} images...",
                "started_at": time.time(),
                "updated_at": time.time(),
            }

        def run_remove():
            removed = 0
            processed = 0
            missing_ids: List[int] = []
            try:
                def _write_cancelled_state() -> None:
                    self._set_remove_progress_if_current(
                        run_id,
                        {
                            **self._build_default_remove_progress_state(),
                            "status": "cancelled",
                            "step": "cancelled",
                            "current": processed,
                            "total": total_count,
                            "removed": removed,
                            "missing_ids": missing_ids,
                            "message": (
                                f"Cancelled at {processed}/{total_count}. "
                                f"Removed {removed} records so far."
                            ),
                            "operation": "remove",
                            "started_at": self._remove_progress.get("started_at"),
                            "updated_at": time.time(),
                        },
                    )

                # Walk the snapshotted id list in chunks (DB-only); cancel is
                # honored at each chunk boundary.
                for start in range(0, total_count, DELETE_FETCH_CHUNK):
                    if cancel_event.is_set():
                        _write_cancelled_state()
                        return
                    chunk_ids = image_ids[start:start + DELETE_FETCH_CHUNK]
                    result = self._remove_selected_image_id_chunk(chunk_ids)
                    removed += int(result.get("removed", 0) or 0)
                    missing_ids.extend(result.get("missing_ids", []) or [])
                    processed += len(chunk_ids)
                    if not self._update_remove_progress_if_current(
                        run_id,
                        step="removing",
                        current=processed,
                        total=total_count,
                        removed=removed,
                        missing_ids=missing_ids,
                        message=f"Removed {removed} records ({processed}/{total_count})",
                        operation="remove",
                        updated_at=time.time(),
                    ):
                        return

                self._set_remove_progress_if_current(
                    run_id,
                    {
                        **self._build_default_remove_progress_state(),
                        "status": "done",
                        "step": "done",
                        "current": total_count,
                        "total": total_count,
                        "removed": removed,
                        "missing_ids": missing_ids,
                        "message": f"Completed! Removed {removed} records." + (
                            f" {len(missing_ids)} already missing." if missing_ids else ""
                        ),
                        "operation": "remove",
                        "started_at": self._remove_progress.get("started_at"),
                        "updated_at": time.time(),
                    },
                )
            except Exception as e:
                logger.error("Remove job failed: %s", e)
                self._set_remove_progress_if_current(
                    run_id,
                    {
                        **self._build_default_remove_progress_state(),
                        "status": "error",
                        "step": "error",
                        "current": processed,
                        "total": total_count,
                        "removed": removed,
                        "missing_ids": missing_ids,
                        "message": "Remove failed due to an internal error",
                        "operation": "remove",
                        "started_at": self._remove_progress.get("started_at"),
                        "updated_at": time.time(),
                    },
                )
            finally:
                with self._remove_lock:
                    if (
                        self._remove_run_id == run_id
                        and self._remove_cancel_event is cancel_event
                    ):
                        self._remove_cancel_event = None

        background_tasks.add_task(run_remove)
        return {
            "status": "started",
            "message": f"Removing {total_count} images in background",
            "total": total_count,
            "count": total_count,
            "operation": "remove",
        }

    # ------------------------------------------------------------------
    # Debt-22: durable job-ID background path via the shared BulkJobService.
    # These sit alongside the Phase-1 singleton jobs above; the ``background``
    # opt-in on the sync endpoints routes here so delete / remove appear in the
    # unified /api/bulk-jobs registry (durable id, list, cancel-by-id) while
    # reusing the exact per-item helpers so failure reporting stays identical.
    # The id set is snapshotted server-side BEFORE the worker mutates anything.
    # ------------------------------------------------------------------
    def start_delete_bulk_job(self, request: Any, background_tasks: Any) -> Dict[str, Any]:
        """Start a durable-id background delete-to-trash job and return its envelope."""
        bulk_jobs = get_bulk_job_service()
        image_ids = self._expand_delete_request_ids(
            getattr(request, "image_ids", None),
            getattr(request, "selection_token", None),
        )
        job_id = bulk_jobs.create_job(
            JOB_KIND_DELETE_FILES,
            total=len(image_ids),
            message=f"Deleting {len(image_ids)} images...",
        )

        def process_chunk(chunk_ids: List[int]) -> Dict[str, Any]:
            image_map = db.get_images_by_ids(chunk_ids)
            deleted = 0
            errors: List[str] = []
            for image_id in chunk_ids:
                result = self._delete_one_image_to_trash(image_id, image_map.get(image_id))
                if result.get("success"):
                    deleted += 1
                else:
                    filename = result.get("filename") or f"id-{image_id}"
                    errors.append(f"{filename}: {result.get('error') or 'Failed'}")
            return {
                "processed": len(chunk_ids),
                "errors": errors,
                "result_delta": {"deleted": deleted},
            }

        worker = bulk_jobs.chunked_worker(
            lambda: image_ids, process_chunk, chunk_size=DELETE_FETCH_CHUNK
        )
        background_tasks.add_task(bulk_jobs.run_job, job_id, worker)
        envelope = bulk_jobs.get_job(job_id) or {}
        envelope["operation"] = "delete"
        return envelope

    def start_remove_bulk_job(self, request: Any, background_tasks: Any) -> Dict[str, Any]:
        """Start a durable-id background remove-from-gallery job (DB rows only)."""
        bulk_jobs = get_bulk_job_service()
        image_ids = self._expand_remove_request_ids(
            getattr(request, "image_ids", None),
            getattr(request, "selection_token", None),
        )
        job_id = bulk_jobs.create_job(
            JOB_KIND_REMOVE_FROM_GALLERY,
            total=len(image_ids),
            message=f"Removing {len(image_ids)} images...",
        )

        def process_chunk(chunk_ids: List[int]) -> Dict[str, Any]:
            result = self._remove_selected_image_id_chunk(chunk_ids)
            removed = int(result.get("removed", 0) or 0)
            missing = len(result.get("missing_ids", []) or [])
            return {
                "processed": len(chunk_ids),
                "errors": [],
                "result_delta": {"removed": removed, "missing": missing},
            }

        worker = bulk_jobs.chunked_worker(
            lambda: image_ids, process_chunk, chunk_size=DELETE_FETCH_CHUNK
        )
        background_tasks.add_task(bulk_jobs.run_job, job_id, worker)
        envelope = bulk_jobs.get_job(job_id) or {}
        envelope["operation"] = "remove"
        return envelope

    def _iter_selection_token_snapshot_chunks(self, selection_token: str, *, chunk_size: int = 500):
        """Snapshot token IDs to a temp file before mutating matching rows."""
        contract = self._decode_selection_token(selection_token)
        if contract["sortBy"] == "random":
            raise HTTPException(status_code=400, detail=SELECTION_TOKEN_RANDOM_SORT_ERROR)

        temp_path: Optional[str] = None
        try:
            with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False) as handle:
                temp_path = handle.name
                for batch_ids in db.iter_filtered_image_id_chunks(
                    chunk_size=chunk_size,
                    generators=contract["generators"],
                    tags=contract["tags"],
                    tag_mode=contract.get("tagMode", "and"),
                    ratings=contract["ratings"],
                    checkpoints=contract["checkpoints"],
                    loras=contract["loras"],
                    search_query=contract["search"] or None,
                    sort_by=contract["sortBy"],
                    min_width=contract["minWidth"],
                    max_width=contract["maxWidth"],
                    min_height=contract["minHeight"],
                    max_height=contract["maxHeight"],
                    prompt_terms=contract["prompts"],
                    prompt_match_mode=contract["promptMatchMode"],
                    aspect_ratio=contract["aspectRatio"],
                    artist=contract["artist"],
                    min_aesthetic=contract["minAesthetic"],
                    max_aesthetic=contract["maxAesthetic"],
                    min_user_rating=contract["minUserRating"],
                    brightness_min=contract["brightnessMin"],
                    brightness_max=contract["brightnessMax"],
                    color_temperature=contract["colorTemperature"],
                    brightness_distribution=contract["brightnessDistribution"],
                    exclude_tags=contract.get("excludeTags"),
                    exclude_generators=contract.get("excludeGenerators"),
                    exclude_ratings=contract.get("excludeRatings"),
                    exclude_checkpoints=contract.get("excludeCheckpoints"),
                    exclude_loras=contract.get("excludeLoras"),
                    exclude_prompts=contract.get("excludePrompts"),
                    exclude_colors=contract.get("excludeColors"),
                    collection_id=contract.get("collectionId"),
                    folder=contract.get("folder"),
                    has_metadata=contract.get("hasMetadata"),
                ):
                    for image_id in batch_ids:
                        handle.write(f"{int(image_id)}\n")

            batch: List[int] = []
            with open(temp_path, "r", encoding="utf-8") as handle:
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
        finally:
            if temp_path:
                try:
                    os.unlink(temp_path)
                except OSError:
                    logger.debug("Failed to remove selection snapshot temp file: %s", temp_path)

    def set_user_rating(self, image_id: int, stars: int) -> Dict[str, Any]:
        """Set an image's user star rating (0-5; 0 = unrated) — v3.3.2 FF-2.

        ``db.set_user_rating`` validates the range (raising ``ValueError`` for
        out-of-range input, which the router surfaces as HTTP 400) and reports
        whether a row matched so the router can return 404 for an unknown id.
        """
        updated = db.set_user_rating(image_id, stars)
        return {"image_id": int(image_id), "user_rating": int(stars), "updated": bool(updated)}

    def get_images(
        self,
        generators: Optional[str] = None,
        tags: Optional[str] = None,
        tag_mode: str = "and",
        ratings: Optional[str] = None,
        checkpoints: Optional[str] = None,
        loras: Optional[str] = None,
        search: Optional[str] = None,
        artist: Optional[str] = None,
        sort_by: str = "newest",
        limit: int = DEFAULT_PAGE_SIZE,
        cursor: Optional[str] = None,
        offset: Optional[int] = None,
        min_width: Optional[int] = None,
        max_width: Optional[int] = None,
        min_height: Optional[int] = None,
        max_height: Optional[int] = None,
        prompts: Optional[str] = None,
        prompt_match_mode: str = PROMPT_MATCH_MODE_EXACT,
        aspect_ratio: Optional[str] = None,
        min_aesthetic: Optional[float] = None,
        max_aesthetic: Optional[float] = None,
        min_user_rating: Optional[int] = None,  # v3.3.2 FF-2: gallery "★≥N" filter
        excluded_image_ids: Optional[List[int]] = None,
        # v3.2.1 color filters
        brightness_min: Optional[float] = None,
        brightness_max: Optional[float] = None,
        color_temperature: Optional[str] = None,
        brightness_distribution: Optional[str] = None,
        # v3.2.2 per-item exclude filters
        exclude_tags: Optional[str] = None,
        exclude_generators: Optional[str] = None,
        exclude_ratings: Optional[str] = None,
        exclude_checkpoints: Optional[str] = None,
        exclude_loras: Optional[str] = None,
        # v3.3.0 FEAT-EXCLUDE-EXTRA
        exclude_prompts: Optional[str] = None,
        exclude_colors: Optional[str] = None,
        collection_id: Optional[int] = None,
        folder: Optional[str] = None,  # v3.3.2 Library Navigation: recursive folder-subtree scope
        has_metadata: Optional[bool] = None,  # v3.3.2 small-opt: "has SD generation parameters" filter
    ) -> Dict[str, Any]:
        """
        Retrieve images with optional filtering using cursor-based pagination.

        Args:
            generators: Comma-separated list of generators
            tags: Comma-separated tags (AND logic)
            ratings: Comma-separated ratings
            checkpoints: Comma-separated checkpoint names
            loras: Comma-separated LoRA names
            search: Free-text search in prompts
            artist: Artist name filter
            sort_by: Sorting method
            limit: Number of images to return
            cursor: Opaque cursor token from a previous page (legacy integer IDs still accepted)
            offset: Offset for fallback pagination when cursor sorting is unavailable
            min_width: Minimum width filter
            max_width: Maximum width filter
            min_height: Minimum height filter
            max_height: Maximum height filter
            prompts: Comma-separated prompt terms
            aspect_ratio: 'square', 'landscape', or 'portrait'

        Returns:
            Dict containing images, next_cursor, has_more, total

        Raises:
            HTTPException 400: Invalid parameters
        """
        self._validate_common_gallery_filters(
            sort_by=sort_by,
            aspect_ratio=aspect_ratio,
            min_width=min_width,
            max_width=max_width,
            min_height=min_height,
            max_height=max_height,
            brightness_min=brightness_min,
            brightness_max=brightness_max,
            color_temperature=color_temperature,
            brightness_distribution=brightness_distribution,
        )

        gen_list = _sanitize_filter_values(generators)
        tag_list = _sanitize_filter_values(tags)
        rating_list = _sanitize_filter_values(ratings)
        cp_list = _sanitize_filter_values(checkpoints)
        lr_list = _sanitize_filter_values(loras)
        prompt_list = _sanitize_filter_values(prompts)
        normalized_prompt_match_mode = _coerce_prompt_match_mode(prompt_match_mode)
        search = _sanitize_filter_value(search) if search else None
        artist = _sanitize_filter_value(artist) if artist else None
        color_temperature = _sanitize_filter_value(color_temperature).lower() if color_temperature else None
        brightness_distribution = _sanitize_filter_value(brightness_distribution).lower() if brightness_distribution else None

        # v3.2.2 per-item exclude filters
        ex_tag_list = _sanitize_filter_values(exclude_tags)
        ex_gen_list = _sanitize_filter_values(exclude_generators)
        ex_rating_list = _sanitize_filter_values(exclude_ratings)
        ex_cp_list = _sanitize_filter_values(exclude_checkpoints)
        ex_lr_list = _sanitize_filter_values(exclude_loras)
        # v3.3.0 FEAT-EXCLUDE-EXTRA
        ex_prompt_list = _sanitize_filter_values(exclude_prompts)
        ex_color_list = _sanitize_filter_values(exclude_colors)

        cursor_payload = None
        if cursor:
            try:
                cursor_payload = decode_image_cursor(cursor)
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc

        supports_cursor_pagination = sort_by in {"newest", "oldest"} and offset is None

        if supports_cursor_pagination:
            collected: List[Dict[str, Any]] = []
            current_cursor = cursor_payload
            total = -1
            total_missing = 0
            fetch_limit = min(max(limit * 2, 32), LIMIT_MAX)

            while len(collected) < limit + 1:
                result = db.get_images_paginated(
                    folder=folder,
                    has_metadata=has_metadata,
                    generators=gen_list,
                    tags=tag_list,
                    tag_mode=tag_mode,
                    ratings=rating_list,
                    checkpoints=cp_list,
                    loras=lr_list,
                    search_query=search,
                    prompt_terms=prompt_list,
                    prompt_match_mode=normalized_prompt_match_mode,
                    artist=artist,
                    sort_by=sort_by,
                    limit=fetch_limit,
                    cursor_id=current_cursor.image_id if current_cursor else None,
                    cursor_sort_value=current_cursor.sort_value if current_cursor else None,
                    cursor_is_opaque=current_cursor.is_opaque if current_cursor else False,
                    min_width=min_width,
                    max_width=max_width,
                    min_height=min_height,
                    max_height=max_height,
                    aspect_ratio=aspect_ratio,
                    min_aesthetic=min_aesthetic,
                    max_aesthetic=max_aesthetic,
                    min_user_rating=min_user_rating,
                    brightness_min=brightness_min,
                    brightness_max=brightness_max,
                    color_temperature=color_temperature,
                    brightness_distribution=brightness_distribution,
                    exclude_tags=ex_tag_list,
                    exclude_generators=ex_gen_list,
                    exclude_ratings=ex_rating_list,
                    exclude_checkpoints=ex_cp_list,
                    exclude_loras=ex_lr_list,
                    exclude_prompts=ex_prompt_list,
                    exclude_colors=ex_color_list,
                    collection_id=collection_id,
                    skip_count=total >= 0,
                )
                if total < 0:
                    total = result.get("total", -1)

                live_images, missing_count = self._filter_and_mark_missing_images(result.get("images", []))
                total_missing += missing_count
                collected.extend(live_images)

                if len(collected) >= limit + 1 or not result.get("has_more") or not result.get("images"):
                    break

                current_cursor = decode_image_cursor(result["next_cursor"])

            has_more = len(collected) > limit
            if has_more:
                collected = collected[:limit]

            if total >= 0:
                total = max(0, total - total_missing)

            return {
                "images": collected,
                "next_cursor": encode_image_cursor_from_image(collected[-1]) if has_more and collected else None,
                "next_offset": None,
                "has_more": has_more,
                "total": total,
            }

        page_offset = max(0, offset or 0)
        fetch_limit = min(max(limit * 2, 32), LIMIT_MAX)
        scan_offset = page_offset
        images: List[Dict[str, Any]] = []
        total_missing = 0

        while len(images) < limit + 1:
            batch = db.get_images(
                folder=folder,
                has_metadata=has_metadata,
                generators=gen_list,
                tags=tag_list,
                tag_mode=tag_mode,
                ratings=rating_list,
                checkpoints=cp_list,
                loras=lr_list,
                search_query=search,
                prompt_terms=prompt_list,
                prompt_match_mode=normalized_prompt_match_mode,
                artist=artist,
                sort_by=sort_by,
                limit=fetch_limit,
                offset=scan_offset,
                min_width=min_width,
                max_width=max_width,
                min_height=min_height,
                max_height=max_height,
                aspect_ratio=aspect_ratio,
                min_aesthetic=min_aesthetic,
                max_aesthetic=max_aesthetic,
                min_user_rating=min_user_rating,
                brightness_min=brightness_min,
                brightness_max=brightness_max,
                color_temperature=color_temperature,
                brightness_distribution=brightness_distribution,
                exclude_tags=ex_tag_list,
                exclude_generators=ex_gen_list,
                exclude_ratings=ex_rating_list,
                exclude_checkpoints=ex_cp_list,
                exclude_loras=ex_lr_list,
                exclude_prompts=ex_prompt_list,
                exclude_colors=ex_color_list,
                collection_id=collection_id,
            )
            if not batch:
                break

            live_batch, missing_count = self._filter_and_mark_missing_images(batch)
            total_missing += missing_count
            images.extend(live_batch)
            scan_offset += len(batch)

            if len(images) >= limit + 1 or len(batch) < fetch_limit:
                break

        has_more = len(images) > limit
        if has_more:
            images = images[:limit]

        total = db.get_filtered_image_count(
            folder=folder,
            has_metadata=has_metadata,
            generators=gen_list,
            tags=tag_list,
            tag_mode=tag_mode,
            ratings=rating_list,
            checkpoints=cp_list,
            loras=lr_list,
            search_query=search,
            prompt_terms=prompt_list,
            prompt_match_mode=normalized_prompt_match_mode,
            artist=artist,
            min_width=min_width,
            max_width=max_width,
            min_height=min_height,
            max_height=max_height,
            aspect_ratio=aspect_ratio,
            min_aesthetic=min_aesthetic,
            max_aesthetic=max_aesthetic,
            min_user_rating=min_user_rating,
            brightness_min=brightness_min,
            brightness_max=brightness_max,
            color_temperature=color_temperature,
            brightness_distribution=brightness_distribution,
            exclude_tags=ex_tag_list,
            exclude_generators=ex_gen_list,
            exclude_ratings=ex_rating_list,
            exclude_checkpoints=ex_cp_list,
            exclude_loras=ex_lr_list,
            exclude_prompts=ex_prompt_list,
            exclude_colors=ex_color_list,
            collection_id=collection_id,
        )

        return {
            "images": images,
            "next_cursor": None,
            "next_offset": page_offset + len(images) if has_more else None,
            "has_more": has_more,
            "total": total,
        }

    def get_library_folders(self) -> Dict[str, Any]:
        """List distinct image directories for the gallery folder tree (v3.3.2 Library Navigation)."""
        return {"folders": db.get_library_folders()}

    def get_library_roots(self) -> Dict[str, Any]:
        """List registered library roots, each with a live indexed-image count (v3.3.2).

        Counts reuse the recursive folder filter so a root reports every image in
        its subtree. Count failures degrade to 0 rather than failing the list.
        """
        roots = db.list_library_roots()
        enriched = []
        for root in roots:
            try:
                count = db.get_filtered_image_count(folder=root.get("path"))
            except Exception:
                count = 0
            path = root.get("path") or ""
            exists = bool(path) and os.path.isdir(path)
            enriched.append({**root, "image_count": count, "exists": exists})
        return {"roots": enriched}

    def _build_selection_filter_contract(
        self,
        *,
        generators: Optional[List[str]] = None,
        tags: Optional[List[str]] = None,
        ratings: Optional[List[str]] = None,
        checkpoints: Optional[List[str]] = None,
        loras: Optional[List[str]] = None,
        prompts: Optional[List[str]] = None,
        tag_mode: str = "and",
        prompt_match_mode: str = PROMPT_MATCH_MODE_EXACT,
        artist: Optional[str] = None,
        search: Optional[str] = None,
        sort_by: str = "newest",
        min_width: Optional[int] = None,
        max_width: Optional[int] = None,
        min_height: Optional[int] = None,
        max_height: Optional[int] = None,
        aspect_ratio: Optional[str] = None,
        min_aesthetic: Optional[float] = None,
        max_aesthetic: Optional[float] = None,
        min_user_rating: Optional[int] = None,
        excluded_image_ids: Optional[List[int]] = None,
        # v3.2.1 color filters
        brightness_min: Optional[float] = None,
        brightness_max: Optional[float] = None,
        color_temperature: Optional[str] = None,
        brightness_distribution: Optional[str] = None,
        # v3.2.2 per-item exclude filters
        exclude_tags: Optional[List[str]] = None,
        exclude_generators: Optional[List[str]] = None,
        exclude_ratings: Optional[List[str]] = None,
        exclude_checkpoints: Optional[List[str]] = None,
        exclude_loras: Optional[List[str]] = None,
        exclude_prompts: Optional[List[str]] = None,
        exclude_colors: Optional[List[str]] = None,
        collection_id: Optional[int] = None,
        folder: Optional[str] = None,  # v3.3.2 Library Navigation
        has_metadata: Optional[bool] = None,  # v3.3.2 small-opt: "has SD generation parameters" filter
    ) -> Dict[str, Any]:
        """Build the canonical filter contract encoded into selection tokens."""
        sort_by = _coerce_optional_string_filter(sort_by, "sortBy") or "newest"
        artist = _coerce_optional_string_filter(artist, "artist")
        search = _coerce_optional_string_filter(search, "search")
        aspect_ratio = _coerce_optional_string_filter(aspect_ratio, "aspectRatio")
        min_width = _coerce_optional_int_filter(min_width, "minWidth")
        max_width = _coerce_optional_int_filter(max_width, "maxWidth")
        min_height = _coerce_optional_int_filter(min_height, "minHeight")
        max_height = _coerce_optional_int_filter(max_height, "maxHeight")
        min_aesthetic = _coerce_optional_float_filter(min_aesthetic, "minAesthetic")
        max_aesthetic = _coerce_optional_float_filter(max_aesthetic, "maxAesthetic")
        min_user_rating = _coerce_optional_int_filter(min_user_rating, "minUserRating")
        brightness_min = _coerce_optional_float_filter(brightness_min, "brightnessMin")
        brightness_max = _coerce_optional_float_filter(brightness_max, "brightnessMax")
        color_temperature = _coerce_optional_string_filter(color_temperature, "colorTemperature")
        color_temperature = color_temperature.lower() if color_temperature else None
        brightness_distribution = _coerce_optional_string_filter(brightness_distribution, "brightnessDistribution")
        brightness_distribution = brightness_distribution.lower() if brightness_distribution else None
        collection_id = _coerce_optional_int_filter(collection_id, "collectionId")
        tag_mode = _coerce_tag_mode(tag_mode)
        prompt_match_mode = _coerce_prompt_match_mode(prompt_match_mode)
        excluded_image_ids = _coerce_selection_id_list(
            excluded_image_ids,
            "excludedImageIds",
            max_length=SELECTION_TOKEN_MAX_EXCLUDED_IDS,
        )

        self._validate_common_gallery_filters(
            sort_by=sort_by,
            aspect_ratio=aspect_ratio,
            min_width=min_width,
            max_width=max_width,
            min_height=min_height,
            max_height=max_height,
            brightness_min=brightness_min,
            brightness_max=brightness_max,
            color_temperature=color_temperature,
            brightness_distribution=brightness_distribution,
        )
        return {
            "generators": _sanitize_filter_values(generators) or [],
            "tags": _sanitize_filter_values(tags) or [],
            "tagMode": tag_mode,
            "ratings": _sanitize_filter_values(ratings) or [],
            "checkpoints": _sanitize_filter_values(checkpoints) or [],
            "loras": _sanitize_filter_values(loras) or [],
            "prompts": _sanitize_filter_values(prompts) or [],
            "promptMatchMode": prompt_match_mode,
            "artist": _sanitize_filter_value(artist) if artist else None,
            "search": _sanitize_filter_value(search) if search else "",
            "sortBy": sort_by or "newest",
            "minWidth": min_width,
            "maxWidth": max_width,
            "minHeight": min_height,
            "maxHeight": max_height,
            "aspectRatio": aspect_ratio,
            "minAesthetic": min_aesthetic,
            "maxAesthetic": max_aesthetic,
            "minUserRating": min_user_rating,
            "brightnessMin": brightness_min,
            "brightnessMax": brightness_max,
            "colorTemperature": color_temperature,
            "brightnessDistribution": brightness_distribution,
            "excludedImageIds": excluded_image_ids,
            "excludeTags": _sanitize_filter_values(exclude_tags) or [],
            "excludeGenerators": _sanitize_filter_values(exclude_generators) or [],
            "excludeRatings": _sanitize_filter_values(exclude_ratings) or [],
            "excludeCheckpoints": _sanitize_filter_values(exclude_checkpoints) or [],
            "excludeLoras": _sanitize_filter_values(exclude_loras) or [],
            "excludePrompts": _sanitize_filter_values(exclude_prompts) or [],
            "excludeColors": _sanitize_filter_values(exclude_colors) or [],
            "collectionId": collection_id,
            "folder": _coerce_optional_string_filter(folder, "folder"),
            "hasMetadata": _coerce_optional_bool_filter(has_metadata, "hasMetadata"),
        }

    def _selection_ids_from_contract(
        self,
        contract: Dict[str, Any],
        *,
        offset: int = 0,
        limit: Optional[int] = None,
    ) -> List[int]:
        return db.get_filtered_image_ids(
            generators=contract["generators"],
            tags=contract["tags"],
            tag_mode=contract.get("tagMode", "and"),
            ratings=contract["ratings"],
            checkpoints=contract["checkpoints"],
            loras=contract["loras"],
            search_query=contract["search"] or None,
            sort_by=contract["sortBy"],
            min_width=contract["minWidth"],
            max_width=contract["maxWidth"],
            min_height=contract["minHeight"],
            max_height=contract["maxHeight"],
            prompt_terms=contract["prompts"],
            prompt_match_mode=contract["promptMatchMode"],
            aspect_ratio=contract["aspectRatio"],
            artist=contract["artist"],
            min_aesthetic=contract["minAesthetic"],
            max_aesthetic=contract["maxAesthetic"],
            min_user_rating=contract["minUserRating"],
            brightness_min=contract["brightnessMin"],
            brightness_max=contract["brightnessMax"],
            color_temperature=contract["colorTemperature"],
            brightness_distribution=contract["brightnessDistribution"],
            excluded_image_ids=contract.get("excludedImageIds"),
            exclude_tags=contract.get("excludeTags"),
            exclude_generators=contract.get("excludeGenerators"),
            exclude_ratings=contract.get("excludeRatings"),
            exclude_checkpoints=contract.get("excludeCheckpoints"),
            exclude_loras=contract.get("excludeLoras"),
            exclude_prompts=contract.get("excludePrompts"),
            exclude_colors=contract.get("excludeColors"),
            collection_id=contract.get("collectionId"),
            folder=contract.get("folder"),
            has_metadata=contract.get("hasMetadata"),
            fetch_chunk_size=SELECTION_IDS_FETCH_CHUNK,
            offset=offset,
            limit=limit,
        )

    def _selection_total_estimate(self, contract: Dict[str, Any]) -> int:
        return db.get_filtered_image_count(
            generators=contract["generators"],
            tags=contract["tags"],
            tag_mode=contract.get("tagMode", "and"),
            ratings=contract["ratings"],
            checkpoints=contract["checkpoints"],
            loras=contract["loras"],
            search_query=contract["search"] or None,
            min_width=contract["minWidth"],
            max_width=contract["maxWidth"],
            min_height=contract["minHeight"],
            max_height=contract["maxHeight"],
            prompt_terms=contract["prompts"],
            prompt_match_mode=contract["promptMatchMode"],
            aspect_ratio=contract["aspectRatio"],
            artist=contract["artist"],
            min_aesthetic=contract["minAesthetic"],
            max_aesthetic=contract["maxAesthetic"],
            min_user_rating=contract["minUserRating"],
            brightness_min=contract["brightnessMin"],
            brightness_max=contract["brightnessMax"],
            color_temperature=contract["colorTemperature"],
            brightness_distribution=contract["brightnessDistribution"],
            excluded_image_ids=contract.get("excludedImageIds"),
            exclude_tags=contract.get("excludeTags"),
            exclude_generators=contract.get("excludeGenerators"),
            exclude_ratings=contract.get("excludeRatings"),
            exclude_checkpoints=contract.get("excludeCheckpoints"),
            exclude_loras=contract.get("excludeLoras"),
            exclude_prompts=contract.get("excludePrompts"),
            exclude_colors=contract.get("excludeColors"),
            collection_id=contract.get("collectionId"),
            folder=contract.get("folder"),
            has_metadata=contract.get("hasMetadata"),
        )

    def _encode_selection_token(self, contract: Dict[str, Any]) -> str:
        payload = {
            "v": SELECTION_TOKEN_VERSION,
            "issued_at": datetime.now(timezone.utc).isoformat(),
            "filters": contract,
        }
        raw = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
        return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")

    def _decode_selection_token(self, selection_token: str) -> Dict[str, Any]:
        try:
            padded = selection_token + "=" * (-len(selection_token) % 4)
            payload = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8"))
        except (binascii.Error, json.JSONDecodeError, UnicodeDecodeError, ValueError):
            raise HTTPException(status_code=400, detail="Invalid selection token")

        if not isinstance(payload, dict) or payload.get("v") != SELECTION_TOKEN_VERSION:
            raise HTTPException(status_code=400, detail="Invalid selection token")
        filters = payload.get("filters")
        if not isinstance(filters, dict):
            raise HTTPException(status_code=400, detail="Invalid selection token")
        for list_field in (
            "generators",
            "tags",
            "ratings",
            "checkpoints",
            "loras",
            "prompts",
            "excludeTags",
            "excludeGenerators",
            "excludeRatings",
            "excludeCheckpoints",
            "excludeLoras",
            "excludePrompts",
            "excludeColors",
        ):
            value = filters.get(list_field)
            if value is not None and not isinstance(value, list):
                raise _invalid_selection_token()

        try:
            return self._build_selection_filter_contract(
                generators=filters.get("generators"),
                tags=filters.get("tags"),
                tag_mode=filters.get("tagMode") or filters.get("tag_mode") or "and",
                ratings=filters.get("ratings"),
                checkpoints=filters.get("checkpoints"),
                loras=filters.get("loras"),
                prompts=filters.get("prompts"),
                prompt_match_mode=filters.get("promptMatchMode") or filters.get("prompt_match_mode") or PROMPT_MATCH_MODE_EXACT,
                artist=filters.get("artist"),
                search=filters.get("search"),
                sort_by=filters.get("sortBy") or "newest",
                min_width=filters.get("minWidth"),
                max_width=filters.get("maxWidth"),
                min_height=filters.get("minHeight"),
                max_height=filters.get("maxHeight"),
                aspect_ratio=filters.get("aspectRatio"),
                min_aesthetic=filters.get("minAesthetic"),
                max_aesthetic=filters.get("maxAesthetic"),
                min_user_rating=filters.get("minUserRating") or filters.get("min_user_rating"),
                brightness_min=filters.get("brightnessMin"),
                brightness_max=filters.get("brightnessMax"),
                color_temperature=filters.get("colorTemperature"),
                brightness_distribution=filters.get("brightnessDistribution"),
                excluded_image_ids=filters.get("excludedImageIds"),
                exclude_tags=filters.get("excludeTags"),
                exclude_generators=filters.get("excludeGenerators"),
                exclude_ratings=filters.get("excludeRatings"),
                exclude_checkpoints=filters.get("excludeCheckpoints"),
                exclude_loras=filters.get("excludeLoras"),
                exclude_prompts=filters.get("excludePrompts"),
                exclude_colors=filters.get("excludeColors"),
                collection_id=filters.get("collectionId") or filters.get("collection_id"),
                folder=filters.get("folder"),
                has_metadata=filters.get("hasMetadata"),
            )
        except HTTPException:
            raise
        except (TypeError, ValueError):
            raise _invalid_selection_token()

    def create_selection_token(
        self,
        *,
        chunk_size: int = SELECTION_TOKEN_DEFAULT_CHUNK,
        **filters: Any,
    ) -> Dict[str, Any]:
        """Create a stateless filtered-selection token for chunked ID retrieval."""
        contract = self._build_selection_filter_contract(**filters)
        if contract["sortBy"] == "random":
            raise HTTPException(status_code=400, detail=SELECTION_TOKEN_RANDOM_SORT_ERROR)
        normalized_chunk = max(1, min(int(chunk_size or SELECTION_TOKEN_DEFAULT_CHUNK), SELECTION_TOKEN_MAX_CHUNK))
        exact_total = not bool(contract["prompts"]) or contract["promptMatchMode"] == PROMPT_MATCH_MODE_CONTAINS
        return {
            "selection_token": self._encode_selection_token(contract),
            "total_estimate": self._selection_total_estimate(contract),
            "exact_total": exact_total,
            "chunk_size": normalized_chunk,
        }

    def get_selection_chunk(self, selection_token: str, *, offset: int = 0, limit: int = SELECTION_TOKEN_DEFAULT_CHUNK) -> Dict[str, Any]:
        """Resolve one ordered chunk of image IDs from a selection token."""
        contract = self._decode_selection_token(selection_token)
        if contract["sortBy"] == "random":
            raise HTTPException(status_code=400, detail=SELECTION_TOKEN_RANDOM_SORT_ERROR)
        normalized_offset = max(0, int(offset or 0))
        normalized_limit = max(1, min(int(limit or SELECTION_TOKEN_DEFAULT_CHUNK), SELECTION_TOKEN_MAX_CHUNK))
        ids = self._selection_ids_from_contract(
            contract,
            offset=normalized_offset,
            limit=normalized_limit + 1,
        )
        image_ids = ids[:normalized_limit]
        has_more = len(ids) > normalized_limit
        return {
            "image_ids": image_ids,
            "offset": normalized_offset,
            "limit": normalized_limit,
            "next_offset": normalized_offset + len(image_ids) if has_more else None,
            "has_more": has_more,
        }

    def get_filtered_selection_ids(
        self,
        *,
        generators: Optional[List[str]] = None,
        tags: Optional[List[str]] = None,
        tag_mode: str = "and",
        ratings: Optional[List[str]] = None,
        checkpoints: Optional[List[str]] = None,
        loras: Optional[List[str]] = None,
        prompts: Optional[List[str]] = None,
        prompt_match_mode: str = PROMPT_MATCH_MODE_EXACT,
        artist: Optional[str] = None,
        search: Optional[str] = None,
        sort_by: str = "newest",
        min_width: Optional[int] = None,
        max_width: Optional[int] = None,
        min_height: Optional[int] = None,
        max_height: Optional[int] = None,
        aspect_ratio: Optional[str] = None,
        min_aesthetic: Optional[float] = None,
        max_aesthetic: Optional[float] = None,
        min_user_rating: Optional[int] = None,
        brightness_min: Optional[float] = None,
        brightness_max: Optional[float] = None,
        color_temperature: Optional[str] = None,
        brightness_distribution: Optional[str] = None,
        exclude_tags: Optional[List[str]] = None,
        exclude_generators: Optional[List[str]] = None,
        exclude_ratings: Optional[List[str]] = None,
        exclude_checkpoints: Optional[List[str]] = None,
        exclude_loras: Optional[List[str]] = None,
        exclude_prompts: Optional[List[str]] = None,
        exclude_colors: Optional[List[str]] = None,
        collection_id: Optional[int] = None,
        folder: Optional[str] = None,
        has_metadata: Optional[bool] = None,
    ) -> Dict[str, Any]:
        """Resolve the full filtered-result ID set in current gallery sort order."""
        contract = self._build_selection_filter_contract(
            generators=generators,
            tags=tags,
            tag_mode=tag_mode,
            ratings=ratings,
            checkpoints=checkpoints,
            loras=loras,
            prompts=prompts,
            prompt_match_mode=prompt_match_mode,
            artist=artist,
            search=search,
            sort_by=sort_by,
            min_width=min_width,
            max_width=max_width,
            min_height=min_height,
            max_height=max_height,
            aspect_ratio=aspect_ratio,
            min_aesthetic=min_aesthetic,
            max_aesthetic=max_aesthetic,
            min_user_rating=min_user_rating,
            brightness_min=brightness_min,
            brightness_max=brightness_max,
            color_temperature=color_temperature,
            brightness_distribution=brightness_distribution,
            exclude_tags=exclude_tags,
            exclude_generators=exclude_generators,
            exclude_ratings=exclude_ratings,
            exclude_checkpoints=exclude_checkpoints,
            exclude_loras=exclude_loras,
            exclude_prompts=exclude_prompts,
            exclude_colors=exclude_colors,
            collection_id=collection_id,
            folder=folder,
            has_metadata=has_metadata,
        )
        image_ids = self._selection_ids_from_contract(
            contract,
            limit=SELECTION_IDS_MAX_RESPONSE + 1,
        )
        if len(image_ids) > SELECTION_IDS_MAX_RESPONSE:
            raise HTTPException(
                status_code=413,
                detail=(
                    f"selection-ids is limited to {SELECTION_IDS_MAX_RESPONSE} IDs. "
                    "Use selection-token and selection-chunk for larger filtered selections."
                ),
            )
        return {
            "image_ids": image_ids,
            "total": len(image_ids),
        }

    def get_image_by_id(self, image_id: int) -> Dict[str, Any]:
        """
        Get a single image with its associated tags.

        Args:
            image_id: The unique identifier of the image

        Returns:
            Dict containing 'image' and 'tags' fields

        Raises:
            HTTPException 404: Image not found
        """
        image = db.get_image_by_id(image_id)
        if not image:
            raise HTTPException(status_code=404, detail="Image not found")

        tags = db.get_image_tags(image_id)
        return {"image": image, "tags": tags}

    def get_export_selection_data(
        self,
        image_ids: List[int],
        *,
        source: str = "image_ids",
        total: Optional[int] = None,
        offset: int = 0,
        limit: Optional[int] = None,
        has_more: bool = False,
        next_offset: Optional[int] = None,
        exact_total: bool = True,
    ) -> Dict[str, Any]:
        """Return prompt and tag export data for multiple images in one request."""
        images_map = db.get_images_by_ids(image_ids)
        tags_map = db.get_image_tags_map(image_ids)

        export_images: List[Dict[str, Any]] = []
        missing_ids: List[int] = []

        for image_id in image_ids:
            image = images_map.get(image_id)
            if not image:
                missing_ids.append(image_id)
                continue

            export_images.append(
                {
                    "id": image_id,
                    "filename": image.get("filename") or "",
                    "generator": image.get("generator"),
                    "prompt": image.get("prompt") or "",
                    "negative_prompt": image.get("negative_prompt") or "",
                    "checkpoint": image.get("checkpoint"),
                    "width": image.get("width"),
                    "height": image.get("height"),
                    "aesthetic_score": image.get("aesthetic_score"),
                    "ai_caption": image.get("ai_caption") or "",
                    "generation_params": extract_generation_params(image),
                    "tags": [tag["tag"] for tag in tags_map.get(image_id, [])],
                }
            )

        normalized_limit = int(limit if limit is not None else len(image_ids))
        return {
            "images": export_images,
            "missing_ids": missing_ids,
            "count": len(export_images),
            "total": int(total if total is not None else len(image_ids)),
            "offset": max(0, int(offset or 0)),
            "limit": max(0, normalized_limit),
            "next_offset": next_offset,
            "has_more": bool(has_more),
            "source": source,
            "exact_total": bool(exact_total),
        }

    def get_export_selection_data_for_token(
        self,
        selection_token: str,
        *,
        offset: int = 0,
        limit: int = SELECTION_TOKEN_DEFAULT_CHUNK,
    ) -> Dict[str, Any]:
        """Return one export-data page from a filtered selection token."""
        contract = self._decode_selection_token(selection_token)
        if contract["sortBy"] == "random":
            raise HTTPException(status_code=400, detail=SELECTION_TOKEN_RANDOM_SORT_ERROR)

        normalized_offset = max(0, int(offset or 0))
        normalized_limit = max(1, min(int(limit or SELECTION_TOKEN_DEFAULT_CHUNK), SELECTION_TOKEN_MAX_CHUNK))
        ids = self._selection_ids_from_contract(
            contract,
            offset=normalized_offset,
            limit=normalized_limit + 1,
        )
        image_ids = ids[:normalized_limit]
        has_more = len(ids) > normalized_limit
        return self.get_export_selection_data(
            image_ids,
            source="selection_token",
            total=self._selection_total_estimate(contract),
            offset=normalized_offset,
            limit=normalized_limit,
            has_more=has_more,
            next_offset=normalized_offset + len(image_ids) if has_more else None,
            exact_total=not bool(contract["prompts"]) or contract["promptMatchMode"] == PROMPT_MATCH_MODE_CONTAINS,
        )

    def resolve_image_source_path(self, image_id: int, primary_path: str) -> str:
        """
        Resolve the best available image source path.

        Args:
            image_id: Image ID for error messages
            primary_path: Primary path from database

        Returns:
            Resolved absolute path to the image file

        Raises:
            HTTPException 404: Image file not found on disk
        """
        resolved_path = resolve_existing_indexed_image_path(primary_path, backend_file=__file__)
        if resolved_path:
            return resolved_path

        raise HTTPException(status_code=404, detail="Image file not found on disk")

    def reparse_image(self, image_id: int) -> Dict[str, Any]:
        """
        Re-parse metadata for a single image and update the database.

        Args:
            image_id: The unique identifier of the image

        Returns:
            Updated image data

        Raises:
            HTTPException 404: Image not found
            HTTPException 500: Failed to parse metadata
        """
        image = db.get_image_by_id(image_id)
        if not image:
            raise HTTPException(status_code=404, detail="Image not found")

        source_path = self.resolve_image_source_path(image_id, image["path"])

        try:
            reparse_image_metadata(image_id, source_path)
        except Exception as exc:
            raise HTTPException(status_code=500, detail="Failed to reparse metadata") from exc

        return self.get_image_by_id(image_id)

    def save_image_with_edited_metadata(
        self,
        source_path: str,
        output_path: str,
        image_format: str,
        metadata: Optional[Dict[str, Any]],
        allow_overwrite: bool = False,
        quality: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Save a copy of an image with edited SD metadata."""
        is_valid, error = validate_file_path(source_path, ALLOWED_IMAGE_EXTENSIONS)
        if not is_valid:
            raise PathValidationError(error or "Invalid source image path")

        source = Path(source_path).resolve()
        output = validate_image_output_path(output_path, allow_overwrite=allow_overwrite)

        normalized_output_format = output.extension.lstrip(".").lower()
        if normalized_output_format == "jpeg":
            normalized_output_format = "jpg"

        requested_format = str(image_format or normalized_output_format).strip().lower()
        if requested_format == "jpeg":
            requested_format = "jpg"
        if requested_format not in {"png", "webp", "jpg"}:
            raise ValueError("Unsupported output format")
        if requested_format != normalized_output_format:
            raise ValueError("Output path extension does not match the selected format")

        if quality is not None and (quality < 1 or quality > 100):
            raise ValueError("Quality must be between 1 and 100")

        normalized_metadata = normalize_edited_metadata(metadata)
        parameters_text = build_sd_parameters_text(normalized_metadata)
        warnings: List[str] = []

        pil_format = "PNG"
        if requested_format == "webp":
            pil_format = "WEBP"
            warnings.append(WEBP_LIMITATION_WARNING)
        elif requested_format == "jpg":
            pil_format = "JPEG"
            warnings.append(JPEG_LIMITATION_WARNING)

        def _write_edited_image(final_output_path: str, _overwrite_requested: bool) -> None:
            with Image.open(source) as image:
                save_image = prepare_image_for_save(image, pil_format, warnings)
                save_kwargs: Dict[str, Any] = {}
                icc_profile = image.info.get("icc_profile")
                if icc_profile:
                    save_kwargs["icc_profile"] = icc_profile

                if pil_format == "PNG":
                    save_kwargs["pnginfo"] = build_pnginfo(normalized_metadata, parameters_text)
                else:
                    exif_bytes = build_exif_bytes(image, parameters_text)
                    if exif_bytes:
                        save_kwargs["exif"] = exif_bytes
                    save_kwargs["quality"] = int(quality if quality is not None else (92 if pil_format == "JPEG" else 95))

                try:
                    save_image.save(final_output_path, format=pil_format, **save_kwargs)
                finally:
                    save_image.close()

        write_result = save_and_reconcile_checked(
            str(output.path),
            _write_edited_image,
            allow_overwrite=allow_overwrite,
            source_path=str(source),
            preserve_derived_state=(source == output.path),
            backend_file=__file__,
        )
        warnings.extend(write_result.warnings)

        return {
            "output_path": str(output.path),
            "format": requested_format,
            "warnings": warnings,
        }

    def open_image_folder(
        self,
        image_id: int,
        *,
        platform: str,
        popen: Callable[[List[str]], Any] = subprocess.Popen,
    ) -> Dict[str, Any]:
        """Open the containing folder of an indexed image in the OS file explorer."""
        image = db.get_image_by_id(image_id)
        if not image:
            raise HTTPException(status_code=404, detail="Image not found")

        try:
            file_path = self.resolve_image_source_path(image_id, image.get("path", ""))
            normalized_path = os.path.normpath(file_path)

            if platform == "win32":
                popen(["explorer", "/select,", normalized_path])
            elif platform == "darwin":
                popen(["open", "-R", normalized_path])
            else:
                popen(["xdg-open", os.path.dirname(normalized_path)])

            return {"success": True, "path": normalized_path}
        except HTTPException:
            raise
        except Exception as exc:
            logger.error("Failed to open folder for image %s: %s", image_id, exc)
            raise HTTPException(
                status_code=500,
                detail=f"Failed to open folder: {exc}",
            ) from exc

    async def parse_uploaded_image(
        self,
        file: UploadFile,
        *,
        temp_dir: Path,
        temp_ttl_seconds: int,
        max_bytes: int,
        chunk_size: int,
    ) -> Dict[str, Any]:
        """Parse uploaded image metadata without persisting the image in the library DB."""
        if not file or not file.filename:
            raise HTTPException(status_code=400, detail="No file uploaded")

        tmp_path: Optional[Path] = None
        cleanup_tmp = True

        try:
            _cleanup_stale_reader_uploads(temp_dir, temp_ttl_seconds)
            tmp_path = _allocate_reader_upload_path(temp_dir, file.filename)

            with open(tmp_path, "wb") as tmp_handle:
                total_bytes = 0
                while True:
                    chunk = await file.read(chunk_size)
                    if not chunk:
                        break
                    total_bytes += len(chunk)
                    if total_bytes > max_bytes:
                        raise HTTPException(
                            status_code=413,
                            detail="Uploaded image is too large to parse (max 64MB)",
                        )
                    tmp_handle.write(chunk)

            readable, read_error = await run_in_threadpool(verify_image_readable, str(tmp_path))
            if not readable:
                raise HTTPException(
                    status_code=422,
                    detail=f"Invalid or unreadable image file: {read_error or 'image decode failed'}",
                )

            result = await run_in_threadpool(parse_image, str(tmp_path))
            if result.get("parse_error") or result.get("width", 0) <= 0 or result.get("height", 0) <= 0:
                raise HTTPException(
                    status_code=422,
                    detail=f"Failed to parse image metadata: {result.get('parse_error') or 'image metadata could not be read'}",
                )

            result["source_temp_path"] = str(tmp_path.resolve())
            cleanup_tmp = False
            return result
        except HTTPException:
            raise
        except Exception as exc:
            logger.error("Failed to parse uploaded image %s: %s", getattr(file, "filename", None), exc)
            raise HTTPException(
                status_code=500,
                detail=f"Failed to parse image metadata: {exc}",
            ) from exc
        finally:
            await file.close()
            if cleanup_tmp and tmp_path and os.path.exists(tmp_path):
                try:
                    os.unlink(tmp_path)
                except OSError as cleanup_exc:
                    logger.warning(
                        "Failed to remove temp upload file %s: %s",
                        tmp_path,
                        cleanup_exc,
                    )

    def get_image_file(self, image_id: int) -> FileResponse:
        """
        Serve the actual image file.

        Args:
            image_id: The unique identifier of the image

        Returns:
            FileResponse with the image binary data

        Raises:
            HTTPException 404: Image not found or file missing
        """
        image = db.get_image_by_id(image_id)
        if not image:
            raise HTTPException(status_code=404, detail="Image not found")

        file_path = self.resolve_image_source_path(image_id, image["path"])
        filename = image.get("filename") or os.path.basename(file_path)
        ext = os.path.splitext(filename)[1].lower()
        media_types = {
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".webp": "image/webp",
            ".bmp": "image/bmp",
            ".gif": "image/gif",
        }
        return FileResponse(
            file_path,
            media_type=media_types.get(ext),
            filename=filename,
            content_disposition_type="inline",
        )

    async def get_image_thumbnail(
        self,
        image_id: int,
        size: int = 256
    ) -> StreamingResponse:
        """
        Get a thumbnail of the image with persistent disk caching.

        Args:
            image_id: The unique identifier of the image
            size: Maximum thumbnail dimension

        Returns:
            StreamingResponse with WebP image data

        Raises:
            HTTPException 404: Image not found
            HTTPException 500: Failed to generate thumbnail
        """
        image = db.get_image_by_id(image_id)
        if not image:
            raise HTTPException(status_code=404, detail="Image not found")

        source_path = self.resolve_image_source_path(image_id, image["path"])

        try:
            if os.path.islink(source_path):
                raise HTTPException(status_code=404, detail="Image file not found on disk")
            thumbnail_bytes, last_modified, cache_hit = await get_thumbnail_async(source_path, size)
            media_type = "image/webp"
            max_age = 86400 if cache_hit else 3600

            return StreamingResponse(
                io.BytesIO(thumbnail_bytes),
                media_type=media_type,
                headers={
                    "Cache-Control": f"public, max-age={max_age}",
                    "Last-Modified": format_datetime(last_modified, usegmt=True),
                    "X-Thumbnail-Cache": "HIT" if cache_hit else "MISS",
                },
            )
        except (UnidentifiedImageError, OSError):
            placeholder_bytes = generate_placeholder_thumbnail(size)
            return StreamingResponse(
                io.BytesIO(placeholder_bytes),
                media_type="image/webp",
                headers={
                    "Cache-Control": "no-cache",
                    "X-Thumbnail-Cache": "MISS",
                    "X-Thumbnail-Placeholder": "UNREADABLE",
                },
            )
        except Exception as exc:
            raise HTTPException(status_code=500, detail="Failed to generate thumbnail") from exc

    def get_thumbnail_cache_stats(self) -> Dict[str, Any]:
        """Get thumbnail cache statistics."""
        stats = get_cache_stats()
        return {
            "cache_stats": stats,
            "supported_sizes": list(SUPPORTED_SIZES),
        }

    def clear_thumbnail_cache(self) -> Dict[str, int]:
        """Clear all cached thumbnails."""
        count = clear_thumbnail_cache()
        return {"deleted_count": count}

    def cleanup_thumbnail_cache(self, max_age_days: int = 30) -> Dict[str, Any]:
        """Remove cached thumbnails older than max_age_days, then enforce size cap."""
        count = cleanup_old_cache(max_age_days)
        size_cleanup = enforce_cache_size_limit(force=True)
        return {"deleted_count": count, "max_age_days": max_age_days, "size_cleanup": size_cleanup}
