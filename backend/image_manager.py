"""
Image manager for file operations (scanning, moving, copying).
"""
import gzip
import logging
import os
import shutil
import time
import itertools
from concurrent.futures import FIRST_COMPLETED, ProcessPoolExecutor, ThreadPoolExecutor, wait
from typing import List, Dict, Any, Optional, Callable, Iterator
from datetime import datetime
from collections.abc import MutableMapping
from pathlib import Path
import json

from config import ALLOWED_IMAGE_EXTENSIONS as IMAGE_EXTENSIONS
from database import (
    add_images_batch,
    add_copied_image_with_state,
    get_image_by_id,
    update_image_path,
    update_image_metadata,
    get_image_scan_state_by_paths,
    get_images_in_folder_scope,
    delete_images_by_ids,
    delete_images_by_paths,
    mark_pending_images_metadata_error,
    STALE_PENDING_METADATA_READ_ERROR,
)
from image_fingerprint import compute_image_content_fingerprint
from metadata_storage import compact_existing_metadata_json, compact_metadata_json
from metadata_parser import PARSED_METADATA_VERSION, parse_image
from exceptions import ScanError, ScanCancelledError, FileOperationError
from utils.path_validation import validate_folder_path
from utils.source_paths import normalize_indexed_image_path, resolve_existing_indexed_image_path
import scan_state

logger = logging.getLogger(__name__)

SCAN_DB_BATCH_SIZE = 200
SCAN_PROGRESS_MIN_INTERVAL_SECONDS = 0.25
SCAN_PROGRESS_EVERY_N_ITEMS = 50
DEFAULT_METADATA_WORKERS = max(2, min(8, (os.cpu_count() or 4)))
SCAN_METADATA_BACKLOG_PER_WORKER = 4
SCAN_METADATA_MIN_BACKLOG = 16
try:
    SCAN_METADATA_TIMEOUT_SECONDS = max(
        0.0,
        float(os.environ.get("SD_IMAGE_SORTER_SCAN_METADATA_TIMEOUT_SECONDS", "120")),
    )
except ValueError:
    SCAN_METADATA_TIMEOUT_SECONDS = 120.0
SCAN_METADATA_DRAIN_WAIT_SECONDS = 0.2
SCAN_METADATA_EXECUTOR_MODE = os.environ.get(
    "SD_IMAGE_SORTER_SCAN_METADATA_EXECUTOR",
    "process",
).strip().lower()


def _metadata_executor_mode() -> str:
    """Return the configured metadata worker isolation mode."""
    if SCAN_METADATA_EXECUTOR_MODE in {"process", "processes", "isolated"}:
        return "process"
    if SCAN_METADATA_EXECUTOR_MODE in {"thread", "threads", "legacy"}:
        return "thread"
    logger.warning(
        "Unknown SD_IMAGE_SORTER_SCAN_METADATA_EXECUTOR=%r; using process isolation",
        SCAN_METADATA_EXECUTOR_MODE,
    )
    return "process"


def _create_metadata_executor(worker_count: int) -> Any:
    """Create the metadata worker executor. Process mode lets timeouts kill stuck C extensions."""
    worker_count = max(1, int(worker_count or 1))
    if _metadata_executor_mode() == "process":
        return ProcessPoolExecutor(max_workers=worker_count)
    return ThreadPoolExecutor(max_workers=worker_count)


def _terminate_metadata_executor_workers(executor: Any) -> bool:
    """Best-effort terminate metadata workers after a hard timeout."""
    terminate_workers = getattr(executor, "terminate_workers", None)
    if callable(terminate_workers):
        terminate_workers()
        return True

    processes = getattr(executor, "_processes", None)
    if isinstance(processes, MutableMapping):
        terminated = False
        for process in list(processes.values()):
            if process is None:
                continue
            try:
                if process.is_alive():
                    process.terminate()
                    terminated = True
            except Exception as exc:
                logger.debug("Failed to terminate metadata worker process: %s", exc)

        for process in list(processes.values()):
            if process is None:
                continue
            try:
                process.join(timeout=1.0)
                if process.is_alive() and hasattr(process, "kill"):
                    process.kill()
                    process.join(timeout=1.0)
            except Exception as exc:
                logger.debug("Failed to join terminated metadata worker process: %s", exc)
        return terminated

    return False


def _shutdown_metadata_executor(executor: Any, *, wait_for_workers: bool = False) -> None:
    try:
        executor.shutdown(wait=wait_for_workers, cancel_futures=True)
    except TypeError:
        executor.shutdown(wait=wait_for_workers)
    except Exception as exc:
        logger.debug("Failed to shut down metadata executor cleanly: %s", exc)


def _metadata_job_for_retry(job: Dict[str, Any]) -> Dict[str, Any]:
    retry_job = dict(job)
    retry_job.pop("submitted_at", None)
    return retry_job


def _chunked(items: Iterator[Any], size: int) -> Iterator[List[Any]]:
    """Yield fixed-size batches from an iterator without buffering the full stream."""
    batch: List[Any] = []
    for item in items:
        batch.append(item)
        if len(batch) >= size:
            yield batch
            batch = []
    if batch:
        yield batch


def _metadata_backlog_limit(worker_count: int) -> int:
    """Return a bounded metadata queue size for large-library scans."""
    per_worker_limit = max(1, int(worker_count or 1)) * max(1, int(SCAN_METADATA_BACKLOG_PER_WORKER))
    return max(1, min(SCAN_DB_BATCH_SIZE, max(SCAN_METADATA_MIN_BACKLOG, per_worker_limit)))


def _deserialize_loras(value: Any) -> Optional[List[str]]:
    """Best-effort deserialize of the stored loras JSON column."""
    if value is None:
        return None
    if isinstance(value, list):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, list) else None
        except (json.JSONDecodeError, TypeError):
            return None
    return None


def _source_fingerprint_matches(existing: Optional[Dict[str, Any]], stat_result: os.stat_result) -> bool:
    """Return True when the indexed source fingerprint matches the current file."""
    if not existing:
        return False

    try:
        source_mtime_ns = int(existing.get("source_mtime_ns"))
        source_size = int(existing.get("source_size"))
    except (TypeError, ValueError):
        return False

    return source_mtime_ns == int(stat_result.st_mtime_ns) and source_size == int(stat_result.st_size)


def _has_source_fingerprint(existing: Optional[Dict[str, Any]]) -> bool:
    """Return True when the row already stores a usable source fingerprint."""
    if not existing:
        return False
    try:
        int(existing.get("source_mtime_ns"))
        int(existing.get("source_size"))
        return True
    except (TypeError, ValueError):
        return False


def _is_unchanged_scan_hit(existing: Optional[Dict[str, Any]], stat_result: os.stat_result) -> bool:
    """Skip reparsing files whose source fingerprint and metadata status still match."""
    if not existing or not existing.get("is_readable", 1):
        return False
    if existing.get("metadata_status") != "complete":
        return False
    if _needs_content_fingerprint_backfill(existing):
        return False
    if _needs_metadata_parser_upgrade(existing):
        return False
    return _source_fingerprint_matches(existing, stat_result)


def _has_cached_derived_state(existing: Optional[Dict[str, Any]]) -> bool:
    """Return True when the indexed row already has derived data that may need preservation."""
    if not existing:
        return False
    return any([
        existing.get("tagged_at") is not None,
        existing.get("ai_caption") is not None,
        existing.get("aesthetic_score") is not None,
        bool(existing.get("has_embedding")),
        bool(existing.get("has_artist_predictions")),
    ])


def _needs_content_fingerprint_backfill(existing: Optional[Dict[str, Any]]) -> bool:
    """Return True when the row has derived state but still lacks a content fingerprint."""
    if not _has_cached_derived_state(existing):
        return False
    return not bool(existing.get("content_fingerprint"))


def _stored_parsed_metadata_version(existing: Optional[Dict[str, Any]]) -> Optional[int]:
    """Return the parser version stored in the compact metadata payload."""
    if not existing:
        return None
    metadata_json = existing.get("metadata_json")
    if isinstance(metadata_json, bytes):
        metadata_json = metadata_json.decode("utf-8", errors="replace")
    if isinstance(metadata_json, str):
        try:
            metadata = json.loads(metadata_json)
        except (TypeError, ValueError, json.JSONDecodeError):
            return None
    elif isinstance(metadata_json, dict):
        metadata = metadata_json
    else:
        return None

    parsed = metadata.get("_parsed") if isinstance(metadata, dict) else None
    if not isinstance(parsed, dict):
        return None

    try:
        return int(parsed.get("version"))
    except (TypeError, ValueError):
        return None


def _needs_metadata_parser_upgrade(existing: Optional[Dict[str, Any]]) -> bool:
    """Return True when an unchanged JPEG row was parsed by an older parser."""
    source_path = str((existing or {}).get("path") or (existing or {}).get("filename") or "")
    if Path(source_path).suffix.lower() not in {".jpg", ".jpeg"}:
        return False

    stored_version = _stored_parsed_metadata_version(existing)
    return stored_version is None or stored_version < PARSED_METADATA_VERSION


def _should_compute_content_fingerprint(existing: Optional[Dict[str, Any]]) -> bool:
    """Only compute fingerprints when they are needed for derived-state safety."""
    if not existing:
        return False
    return bool(existing.get("content_fingerprint")) or _needs_content_fingerprint_backfill(existing)


def _build_placeholder_record(
    image_path: str,
    filename: str,
    stat_result: os.stat_result,
    existing: Optional[Dict[str, Any]],
) -> Dict[str, Any]:
    """Create a fast-import placeholder row before metadata backfill starts."""
    preserve_existing_metadata = bool(existing) and bool(existing.get("is_readable", 1))
    if preserve_existing_metadata and _has_source_fingerprint(existing):
        preserve_existing_metadata = _source_fingerprint_matches(existing, stat_result)
    current_file_time = datetime.fromtimestamp(stat_result.st_mtime)
    library_order_time = (
        existing.get("library_order_time")
        or existing.get("created_at")
        or current_file_time
    ) if existing else current_file_time

    if preserve_existing_metadata:
        return {
            "path": image_path,
            "filename": filename,
            "generator": existing.get("generator"),
            "prompt": existing.get("prompt"),
            "negative_prompt": existing.get("negative_prompt"),
            "metadata_json": existing.get("metadata_json"),
            "width": existing.get("width"),
            "height": existing.get("height"),
            "file_size": int(stat_result.st_size),
            "checkpoint": existing.get("checkpoint"),
            "loras": _deserialize_loras(existing.get("loras")),
            "library_order_time": library_order_time,
            "source_file_mtime": current_file_time,
            "created_at": library_order_time,
            "model_hash": existing.get("model_hash"),
            "is_readable": bool(existing.get("is_readable", 1)),
            "read_error": existing.get("read_error"),
            "source_mtime_ns": int(stat_result.st_mtime_ns),
            "source_size": int(stat_result.st_size),
            "metadata_status": "pending",
            "content_fingerprint": existing.get("content_fingerprint"),
        }

    return {
        "path": image_path,
        "filename": filename,
        "generator": "unknown",
        "prompt": None,
        "negative_prompt": None,
        "metadata_json": compact_metadata_json({}),
        "width": None,
        "height": None,
        "file_size": int(stat_result.st_size),
        "checkpoint": None,
        "loras": [],
        "library_order_time": library_order_time,
        "source_file_mtime": current_file_time,
        "created_at": library_order_time,
        "model_hash": None,
        "is_readable": True,
        "read_error": None,
        "source_mtime_ns": int(stat_result.st_mtime_ns),
        "source_size": int(stat_result.st_size),
        "metadata_status": "pending",
        "content_fingerprint": None,
    }


def _compress_raw_metadata_text(raw_text: Any) -> Optional[bytes]:
    """Gzip the L3 raw-metadata envelope captured by the parser.

    Returns None for anything unusable so scans never fail because of the
    optional retention feature.
    """
    if not isinstance(raw_text, str) or not raw_text.strip():
        return None
    try:
        return gzip.compress(raw_text.encode("utf-8"))
    except Exception as exc:
        logger.debug("raw metadata compression failed: %s", exc)
        return None


def _build_metadata_success_record(
    image_path: str,
    filename: str,
    stat_result: os.stat_result,
    metadata: Dict[str, Any],
    *,
    content_fingerprint: Optional[str] = None,
) -> Dict[str, Any]:
    """Convert parsed metadata into a database row update."""
    metadata_json = compact_metadata_json(metadata.get("metadata"))

    gen_params = metadata.get("metadata", {}).get("_parsed", {}).get("generation_params") or {}
    model_hash = gen_params.get("model_hash")

    return {
        "path": image_path,
        "filename": filename,
        "generator": metadata["generator"],
        "prompt": metadata["prompt"],
        "negative_prompt": metadata["negative_prompt"],
        "metadata_json": metadata_json,
        "width": metadata["width"],
        "height": metadata["height"],
        "file_size": int(stat_result.st_size),
        "checkpoint": metadata["checkpoint"],
        "loras": metadata["loras"],
        "library_order_time": datetime.fromtimestamp(stat_result.st_mtime),
        "source_file_mtime": datetime.fromtimestamp(stat_result.st_mtime),
        "created_at": datetime.fromtimestamp(stat_result.st_mtime),
        "model_hash": model_hash,
        "is_readable": True,
        "read_error": None,
        "source_mtime_ns": int(stat_result.st_mtime_ns),
        "source_size": int(stat_result.st_size),
        "metadata_status": "complete",
        "content_fingerprint": content_fingerprint,
        "raw_metadata_gz": _compress_raw_metadata_text(metadata.get("raw_metadata_text")),
    }


def _build_metadata_error_record(
    image_path: str,
    filename: str,
    stat_result: Optional[os.stat_result],
    error_message: str,
) -> Dict[str, Any]:
    """Build a DB record for files that failed metadata parsing."""
    current_file_time = datetime.fromtimestamp(stat_result.st_mtime) if stat_result else None
    source_mtime_ns = int(stat_result.st_mtime_ns) if stat_result else None
    source_size = int(stat_result.st_size) if stat_result else None

    return {
        "path": image_path,
        "filename": filename,
        "generator": "unknown",
        "prompt": None,
        "negative_prompt": None,
        "metadata_json": compact_metadata_json({}),
        "width": None,
        "height": None,
        "file_size": source_size,
        "checkpoint": None,
        "loras": [],
        "library_order_time": current_file_time,
        "source_file_mtime": current_file_time,
        "created_at": current_file_time,
        "model_hash": None,
        "is_readable": False,
        "read_error": error_message,
        "source_mtime_ns": source_mtime_ns,
        "source_size": source_size,
        "metadata_status": "error",
        "content_fingerprint": None,
    }


def parse_metadata_job(job: Dict[str, Any]) -> Dict[str, Any]:
    """Public wrapper for the metadata-parsing worker.

    Use this from cross-module callers (e.g. SortingService.import_uploaded_files)
    instead of importing the underscored helper. The underscored function is kept
    as the implementation so existing internal call sites and tests stay intact.
    """
    return _parse_metadata_job(job)


def _parse_metadata_job(job: Dict[str, Any]) -> Dict[str, Any]:
    """Parse one file for the background metadata backfill stage."""
    image_path = job["path"]
    filename = job["filename"]
    compute_content_fingerprint = bool(job.get("compute_content_fingerprint"))

    try:
        stat_result = os.stat(image_path)
        metadata = parse_image(image_path, validate_image_data=bool(job.get("validate_image_data", True)))
        parse_error = metadata.get("parse_error")
        if parse_error:
            return {
                "filename": filename,
                "generator": None,
                "record": _build_metadata_error_record(image_path, filename, stat_result, parse_error),
                "error": {"filename": filename, "error": parse_error, "kind": "unreadable"},
            }

        if metadata["width"] <= 0 or metadata["height"] <= 0:
            error_message = "Metadata parse returned no dimensions"
            return {
                "filename": filename,
                "generator": None,
                "record": _build_metadata_error_record(image_path, filename, stat_result, error_message),
                "error": {"filename": filename, "error": error_message, "kind": "unreadable"},
            }

        content_fingerprint = None
        if compute_content_fingerprint:
            try:
                content_fingerprint = compute_image_content_fingerprint(image_path)
            except Exception as exc:
                logger.warning("Could not compute content fingerprint for %s: %s", image_path, exc)

        return {
            "filename": filename,
            "generator": metadata["generator"],
            "record": _build_metadata_success_record(
                image_path,
                filename,
                stat_result,
                metadata,
                content_fingerprint=content_fingerprint,
            ),
            "error": None,
        }
    except PermissionError as exc:
        return {
            "filename": filename,
            "generator": None,
            "record": _build_metadata_error_record(image_path, filename, None, str(exc)),
            "error": {"filename": filename, "error": str(exc), "kind": "permission"},
        }
    except OSError as exc:
        return {
            "filename": filename,
            "generator": None,
            "record": _build_metadata_error_record(image_path, filename, None, str(exc)),
            "error": {"filename": filename, "error": str(exc), "kind": "os_error"},
        }
    except Exception as exc:
        logger.error("Unexpected error processing %s: %s", image_path, exc, exc_info=True)
        return {
            "filename": filename,
            "generator": None,
            "record": _build_metadata_error_record(image_path, filename, None, str(exc)),
            "error": {"filename": filename, "error": str(exc), "kind": "unexpected"},
        }


def _cleanup_missing_scope_entries(
    folder_path: str,
    recursive: bool,
    stop_requested: Optional[Callable[[], bool]] = None,
) -> int:
    """Delete indexed rows whose files no longer exist inside the scan scope."""
    removed_ids: List[int] = []
    for row in get_images_in_folder_scope(folder_path, recursive):
        if callable(stop_requested) and stop_requested():
            raise ScanCancelledError(path=folder_path)
        candidate_path = row.get("path")
        if not candidate_path:
            continue
        resolved_path = resolve_existing_indexed_image_path(candidate_path, backend_file=__file__, allow_symlink=True)
        if not resolved_path or os.path.islink(resolved_path):
            removed_ids.append(int(row["id"]))

    return delete_images_by_ids(removed_ids)


def scan_folder(
    folder_path: str,
    recursive: bool = True,
    progress_callback: Optional[Callable] = None,
    stop_requested: Optional[Callable[[], bool]] = None,
    force_reparse: bool = False,
    cleanup_missing: bool = False,
    quick_import: bool = True,
    metadata_workers: int = DEFAULT_METADATA_WORKERS,
    precise_total: bool = True,
) -> Dict[str, Any]:
    """
    Scan a folder for images and add them to the database.
    
    Args:
        folder_path: Path to scan
        recursive: Whether to scan subdirectories
        progress_callback: Optional callback(current, total, filename)
        stop_requested: Optional callback returning True when the scan should stop
    
    Returns:
        {
            "total": int,
            "new": int,
        "updated": int,
        "removed": int,
        "errors": int,
        "by_generator": {generator: count}
        }
    """
    result: Dict[str, Any] = {
        "total": 0,
        "counted": 0,
        "total_final": False,
        "import_complete": False,
        "new": 0,
        "updated": 0,
        "unchanged": 0,
        "metadata_updated": 0,
        "removed": 0,
        "errors": 0,
        "by_generator": {},
        "recent_errors": [],
        "metadata_total": 0,
        "metadata_processed": 0,
        "metadata_total_final": False,
        "library_ready": False,
    }
    
    # Default to a precise count-first scan so the user sees a real
    # ``current/total`` and can estimate ETA from the first heartbeat.
    # The walk-the-tree-once cost is small on local SSDs (a few seconds
    # for ~50k files) and dwarfed by the import + metadata-parse phase,
    # so the UX win of "Found 48,062 images. Importing 1234/48062…" is
    # worth the upfront pass for the typical user. Callers that scan
    # massive network shares where the count walk itself takes minutes
    # can opt out with ``precise_total=False`` to start importing
    # immediately at the cost of a "?" total in heartbeats.
    folder = Path(folder_path)
    if folder.is_symlink():
        raise ScanError("Refusing to scan symlinked folders", path=folder_path)
    if not folder.exists():
        raise ScanError("Folder does not exist", path=folder_path)
    if not folder.is_dir():
        raise ScanError("Path is not a directory", path=folder_path)

    normalized_folder_path = os.path.abspath(folder_path)

    def _check_cancel() -> None:
        if callable(stop_requested) and stop_requested():
            raise ScanCancelledError(path=folder_path)

    def _iter_images():
        pending_dirs = [os.fspath(folder)]
        root_dir = os.path.abspath(os.fspath(folder))

        while pending_dirs:
            current_dir = pending_dirs.pop()
            _check_cancel()
            try:
                with os.scandir(current_dir) as entries:
                    for entry in entries:
                        _check_cancel()
                        try:
                            if entry.is_symlink():
                                continue
                            if entry.is_dir(follow_symlinks=False):
                                if recursive:
                                    pending_dirs.append(entry.path)
                                continue
                            if not entry.is_file(follow_symlinks=False):
                                continue
                            if Path(entry.name).suffix.lower() not in IMAGE_EXTENSIONS:
                                continue
                            try:
                                stat_result = entry.stat(follow_symlinks=False)
                            except OSError:
                                stat_result = None
                            yield {
                                "path": entry.path,
                                "stat": stat_result,
                            }
                        except FileNotFoundError:
                            continue
            except PermissionError:
                if os.path.abspath(current_dir) == root_dir:
                    raise
                logger.warning("Permission denied listing directory during scan: %s", current_dir)
                continue

    if cleanup_missing:
        _check_cancel()
        result["removed"] = _cleanup_missing_scope_entries(
            normalized_folder_path,
            recursive,
            stop_requested=stop_requested,
        )
        if progress_callback:
            try:
                progress_callback(
                    0,
                    0,
                    "",
                    {
                        "errors": 0,
                        "last_error": None,
                        "phase": "cleanup",
                        "removed": result["removed"],
                        "counted": 0,
                        "import_processed": 0,
                        "import_total": 0,
                        "import_complete": False,
                        "metadata_total_final": False,
                        "total_final": False,
                    },
                )
            except TypeError:
                progress_callback(0, 0, "")

    def _record_scan_error(filename: str, error: str, kind: str = "unreadable") -> Dict[str, str]:
        entry = {
            "filename": filename,
            "error": error,
            "kind": kind,
        }
        result["errors"] += 1
        result["recent_errors"].append(entry)
        result["recent_errors"] = result["recent_errors"][-10:]
        return entry

    def _flush_placeholder_records(pending_records: List[Dict[str, Any]]) -> None:
        if not pending_records:
            return
        counts = add_images_batch(pending_records, return_statuses=True)
        result["new"] += counts["new"]
        result["updated"] += counts["updated"]
        result["metadata_updated"] += counts["updated"]
        placeholder_status_by_path.update(counts.get("statuses") or {})
        for path, status in (counts.get("statuses") or {}).items():
            normalized = normalize_indexed_image_path(path)
            if status == "new":
                run_new_placeholder_paths.add(normalized)
            elif status == "updated":
                run_updated_placeholder_paths.add(normalized)
        pending_records.clear()

    def _flush_metadata_records(pending_records: List[Dict[str, Any]]) -> None:
        if not pending_records:
            return
        add_images_batch(pending_records)
        pending_records.clear()

    def _flush_deleted_new_paths(paths: List[str]) -> None:
        if not paths:
            return
        delete_images_by_paths(paths)
        paths.clear()

    progress_emit_state = {"phase": None, "current": 0, "emitted_at": 0.0}

    def _emit_progress(
        current: int,
        total: int,
        filename: str,
        details: Dict[str, Any],
        *,
        force: bool = False,
    ) -> None:
        if not progress_callback:
            return

        phase = details.get("phase")
        now = time.monotonic()
        should_emit = (
            force
            or progress_emit_state["phase"] != phase
            or current <= 1
            or current - int(progress_emit_state["current"] or 0) >= SCAN_PROGRESS_EVERY_N_ITEMS
            or now - float(progress_emit_state["emitted_at"] or 0.0) >= SCAN_PROGRESS_MIN_INTERVAL_SECONDS
            or bool(details.get("last_error"))
        )
        if not should_emit:
            return

        progress_emit_state["phase"] = phase
        progress_emit_state["current"] = current
        progress_emit_state["emitted_at"] = now
        try:
            progress_callback(current, total, filename, details)
        except TypeError:
            progress_callback(current, total, filename)

    def _count_images_for_total() -> int:
        counted = 0
        for _entry in _iter_images():
            counted += 1
            _emit_progress(
                counted,
                0,
                "",
                {
                    "errors": result["errors"],
                    "last_error": None,
                    "phase": "counting",
                    "counted": counted,
                    "library_ready": result["library_ready"],
                    "import_processed": 0,
                    "import_total": 0,
                    "import_complete": False,
                    "metadata_processed": result["metadata_processed"],
                    "metadata_total": result["metadata_total"],
                    "metadata_total_final": False,
                    "total_final": False,
                },
                force=counted == 1,
            )

        _emit_progress(
            0,
            counted,
            "",
            {
                "errors": result["errors"],
                "last_error": None,
                "phase": "counted",
                "counted": counted,
                "library_ready": result["library_ready"],
                "import_processed": 0,
                "import_total": counted,
                "import_complete": False,
                "metadata_processed": result["metadata_processed"],
                "metadata_total": result["metadata_total"],
                "metadata_total_final": False,
                "metadata_pending": 0,
                "total_final": True,
            },
            force=True,
        )
        return counted

    def _emit_library_ready() -> None:
        if result["library_ready"] or not quick_import or not progress_callback:
            return
        result["library_ready"] = True
        _emit_progress(
            processed_count,
            result["counted"] or result["total"],
            "",
            {
                "errors": result["errors"],
                "last_error": None,
                "phase": "library_ready",
                "library_ready": True,
                "counted": result["counted"],
                "import_processed": processed_count,
                "import_total": result["counted"] or result["total"],
                "import_complete": result["import_complete"],
                "metadata_processed": result["metadata_processed"],
                "metadata_total": result["metadata_total"],
                "metadata_total_final": result["metadata_total_final"],
                "metadata_pending": len(in_flight),
                "total_final": result["total_final"],
            },
            force=True,
        )

    pending_placeholder_records: List[Dict[str, Any]] = []
    pending_metadata_records: List[Dict[str, Any]] = []
    pending_deleted_new_paths: List[str] = []
    placeholder_status_by_path: Dict[str, str] = {}
    run_new_placeholder_paths: set[str] = set()
    run_updated_placeholder_paths: set[str] = set()
    metadata_completed_paths: set[str] = set()
    processed_count = 0
    worker_count = max(1, int(metadata_workers or DEFAULT_METADATA_WORKERS))
    backlog_limit = _metadata_backlog_limit(worker_count)
    in_flight: Dict[Any, Dict[str, Any]] = {}

    def _ensure_metadata_executor() -> Any:
        nonlocal executor
        if executor is None:
            executor = _create_metadata_executor(worker_count)
        return executor

    def _restart_metadata_executor() -> Any:
        nonlocal executor
        if executor is not None:
            _shutdown_metadata_executor(executor)
        executor = _create_metadata_executor(worker_count)
        return executor

    def _submit_metadata_job(active_executor: Any, job: Dict[str, Any], *, count_total: bool = True) -> None:
        nonlocal executor
        try:
            future = active_executor.submit(parse_metadata_job, job)
        except Exception as exc:
            logger.warning("Restarting metadata executor after submit failure: %s", exc)
            active_executor = _restart_metadata_executor()
            future = active_executor.submit(parse_metadata_job, job)
        in_flight[future] = {**job, "submitted_at": time.monotonic()}
        if count_total:
            result["metadata_total"] += 1

    def _handle_metadata_job_result(job_result: Dict[str, Any]) -> None:
        filename = job_result["filename"]
        normalized_path = normalize_indexed_image_path(job_result["record"]["path"])
        metadata_completed_paths.add(normalized_path)
        progress_details = {
            "phase": "metadata",
            "library_ready": result["library_ready"],
            "metadata_total": result["metadata_total"],
            "metadata_total_final": result["metadata_total_final"],
            "last_error": None,
            "counted": result["counted"],
            "import_processed": processed_count,
            "import_total": result["counted"] or result["total"],
            "import_complete": result["import_complete"],
            "total_final": result["total_final"],
        }

        pending_metadata_records.append(job_result["record"])
        if job_result.get("generator"):
            generator = job_result["generator"] or "unknown"
            result["by_generator"][generator] = result["by_generator"].get(generator, 0) + 1

        if job_result.get("error"):
            job_status = placeholder_status_by_path.get(
                normalize_indexed_image_path(job_result["record"]["path"])
            )
            if job_status == "new":
                result["new"] = max(0, result["new"] - 1)
                pending_metadata_records.pop()
                pending_deleted_new_paths.append(job_result["record"]["path"])
            elif job_status == "updated":
                result["updated"] = max(0, result["updated"] - 1)
                result["metadata_updated"] = max(0, result["metadata_updated"] - 1)
            progress_details["last_error"] = _record_scan_error(
                filename,
                job_result["error"]["error"],
                kind=job_result["error"]["kind"],
            )

        result["metadata_processed"] += 1
        progress_details["errors"] = result["errors"]
        progress_details["metadata_processed"] = result["metadata_processed"]
        progress_details["metadata_pending"] = len(in_flight)

        if len(pending_metadata_records) >= SCAN_DB_BATCH_SIZE:
            _flush_metadata_records(pending_metadata_records)
        if len(pending_deleted_new_paths) >= SCAN_DB_BATCH_SIZE:
            _flush_deleted_new_paths(pending_deleted_new_paths)

        _emit_progress(
            result["metadata_processed"],
            result["metadata_total"],
            filename,
            progress_details,
            force=bool(progress_details.get("last_error")),
        )

    def _build_metadata_timeout_result(job: Dict[str, Any]) -> Dict[str, Any]:
        image_path = job["path"]
        filename = job["filename"]
        try:
            stat_result = os.stat(image_path)
        except OSError:
            stat_result = None
        timeout_seconds = SCAN_METADATA_TIMEOUT_SECONDS
        error_message = f"Metadata extraction timed out after {timeout_seconds:g} seconds"
        return {
            "filename": filename,
            "generator": None,
            "record": _build_metadata_error_record(image_path, filename, stat_result, error_message),
            "error": {"filename": filename, "error": error_message, "kind": "timeout"},
        }

    def _handle_timed_out_metadata_futures() -> int:
        nonlocal executor
        if SCAN_METADATA_TIMEOUT_SECONDS <= 0:
            return 0
        now = time.monotonic()
        timed_out = []
        for future, job in tuple(in_flight.items()):
            submitted_at = float(job.get("submitted_at") or now)
            if now - submitted_at >= SCAN_METADATA_TIMEOUT_SECONDS:
                timed_out.append((future, job))

        if not timed_out:
            return 0

        timeout_futures = {future for future, _job in timed_out}
        killed_workers = bool(executor is not None and _terminate_metadata_executor_workers(executor))
        retry_jobs: List[Dict[str, Any]] = []

        if killed_workers:
            all_in_flight = list(in_flight.items())
            in_flight.clear()
            for future, job in all_in_flight:
                future.cancel()
                if future in timeout_futures:
                    _handle_metadata_job_result(_build_metadata_timeout_result(job))
                else:
                    retry_jobs.append(_metadata_job_for_retry(job))
            if executor is not None:
                _shutdown_metadata_executor(executor, wait_for_workers=False)
            executor = None
            if retry_jobs:
                restarted_executor = _ensure_metadata_executor()
                for retry_job in retry_jobs:
                    _submit_metadata_job(restarted_executor, retry_job, count_total=False)
        else:
            for future, job in timed_out:
                in_flight.pop(future, None)
                future.cancel()
                _handle_metadata_job_result(_build_metadata_timeout_result(job))

        return len(timed_out)

    def _emit_metadata_waiting_progress() -> None:
        _emit_progress(
            result["metadata_processed"],
            result["metadata_total"],
            "",
            {
                "errors": result["errors"],
                "last_error": None,
                "phase": "metadata",
                "library_ready": result["library_ready"],
                "counted": result["counted"],
                "import_processed": processed_count,
                "import_total": result["counted"] or result["total"],
                "import_complete": result["import_complete"],
                "metadata_processed": result["metadata_processed"],
                "metadata_total": result["metadata_total"],
                "metadata_total_final": result["metadata_total_final"],
                "metadata_pending": len(in_flight),
                "total_final": result["total_final"],
            },
        )

    def _metadata_future_error_result(job: Dict[str, Any], exc: Exception) -> Dict[str, Any]:
        image_path = job.get("path", "")
        filename = job.get("filename") or os.path.basename(image_path)
        try:
            stat_result = os.stat(image_path)
        except OSError:
            stat_result = None
        error_message = str(exc)
        return {
            "filename": filename,
            "generator": None,
            "record": _build_metadata_error_record(image_path, filename, stat_result, error_message),
            "error": {"filename": filename, "error": error_message, "kind": "unexpected"},
        }

    def _drain_metadata_futures(wait_for_all: bool = False, wait_for_one: bool = False) -> None:
        while in_flight:
            _check_cancel()
            if _handle_timed_out_metadata_futures() and wait_for_one:
                break
            if not in_flight:
                break

            timeout = SCAN_METADATA_DRAIN_WAIT_SECONDS if wait_for_all or wait_for_one else 0
            done, _pending = wait(tuple(in_flight.keys()), timeout=timeout, return_when=FIRST_COMPLETED)
            if not done:
                if wait_for_all or wait_for_one:
                    _emit_metadata_waiting_progress()
                    continue
                break

            for future in done:
                job = in_flight.pop(future, None)
                try:
                    job_result = future.result()
                except Exception as exc:
                    logger.error("Unexpected metadata worker failure: %s", exc, exc_info=True)
                    job_result = _metadata_future_error_result(job or {}, exc)
                _handle_metadata_job_result(job_result)

            if wait_for_one:
                break

    def _drain_metadata_until_backlog_below_limit() -> None:
        while len(in_flight) >= backlog_limit:
            _drain_metadata_futures(wait_for_one=True)

    def _reconcile_interrupted_scan_placeholders() -> None:
        _flush_metadata_records(pending_metadata_records)
        _flush_deleted_new_paths(pending_deleted_new_paths)

        in_flight_paths = {
            normalize_indexed_image_path(job.get("path", ""))
            for job in in_flight.values()
            if job.get("path")
        }

        unresolved_new_paths = {
            path for path in run_new_placeholder_paths
            if path in in_flight_paths or path not in metadata_completed_paths
        }
        unresolved_updated_paths = {
            path for path in run_updated_placeholder_paths
            if path in in_flight_paths or path not in metadata_completed_paths
        }

        if unresolved_new_paths:
            removed = delete_images_by_paths(sorted(unresolved_new_paths))
            result["new"] = max(0, result["new"] - int(removed or 0))

        if unresolved_updated_paths:
            rows = get_image_scan_state_by_paths(sorted(unresolved_updated_paths))
            image_ids = [
                int(row.get("id"))
                for row in rows.values()
                if row.get("id") and str(row.get("metadata_status") or "").lower() == "pending"
            ]
            if image_ids:
                marked = mark_pending_images_metadata_error(image_ids, STALE_PENDING_METADATA_READ_ERROR)
                result["updated"] = max(0, result["updated"] - marked)
                result["metadata_updated"] = max(0, result["metadata_updated"] - marked)

    executor: Optional[Any] = None
    try:
        scan_state.scan_started()
        if precise_total:
            result["counted"] = _count_images_for_total()
            result["total"] = result["counted"]
            result["total_final"] = True

        try:
            # Pipeline: placeholder import and metadata backfill overlap.
            for image_batch in _chunked(_iter_images(), SCAN_DB_BATCH_SIZE):
                _check_cancel()
                image_paths = [entry["path"] for entry in image_batch]
                existing_rows = get_image_scan_state_by_paths(image_paths)
                batch_metadata_jobs: List[Dict[str, Any]] = []

                for image_entry in image_batch:
                    _check_cancel()
                    image_path = image_entry["path"]
                    cached_stat = image_entry.get("stat")
                    processed_count += 1
                    if not precise_total:
                        result["counted"] = processed_count
                        result["total"] = processed_count
                    filename = os.path.basename(image_path)
                    progress_details: Dict[str, Any] = {"errors": result["errors"], "last_error": None}
                    try:
                        stat = cached_stat if cached_stat is not None else os.stat(image_path)
                        existing = existing_rows.get(normalize_indexed_image_path(image_path))
                        if not force_reparse and _is_unchanged_scan_hit(existing, stat):
                            result["updated"] += 1
                            result["unchanged"] += 1
                            generator = existing.get("generator") or "unknown"
                            result["by_generator"][generator] = result["by_generator"].get(generator, 0) + 1
                            continue

                        pending_placeholder_records.append(
                            _build_placeholder_record(image_path, filename, stat, existing)
                        )
                        batch_metadata_jobs.append(
                            {
                                "path": image_path,
                                "filename": filename,
                                "compute_content_fingerprint": _should_compute_content_fingerprint(existing),
                                "validate_image_data": not quick_import,
                            }
                        )
                    except PermissionError as e:
                        logger.warning("Permission denied processing %s: %s", image_path, e)
                        progress_details["last_error"] = _record_scan_error(filename, str(e), kind="permission")
                        progress_details["errors"] = result["errors"]
                    except OSError as e:
                        logger.warning("OS error processing %s: %s", image_path, e)
                        progress_details["last_error"] = _record_scan_error(filename, str(e), kind="os_error")
                        progress_details["errors"] = result["errors"]
                    except Exception as e:
                        logger.error("Unexpected error processing %s: %s", image_path, e, exc_info=True)
                        progress_details["last_error"] = _record_scan_error(filename, str(e), kind="unexpected")
                        progress_details["errors"] = result["errors"]
                    finally:
                        import_details = {
                            **progress_details,
                            "phase": "importing",
                            "library_ready": result["library_ready"],
                            "counted": result["counted"],
                            "import_processed": processed_count,
                            "import_total": result["counted"] or result["total"],
                            "import_complete": result["import_complete"],
                            "metadata_processed": result["metadata_processed"],
                            "metadata_total": result["metadata_total"],
                            "metadata_total_final": result["metadata_total_final"],
                            "total_final": result["total_final"],
                        }
                        _emit_progress(
                            processed_count,
                            result["counted"] or result["total"],
                            filename,
                            import_details,
                            force=bool(progress_details.get("last_error")),
                        )

                _flush_placeholder_records(pending_placeholder_records)
                for job in batch_metadata_jobs:
                    _drain_metadata_until_backlog_below_limit()
                    _submit_metadata_job(_ensure_metadata_executor(), job)

                if batch_metadata_jobs or processed_count > 0:
                    _emit_library_ready()
                _drain_metadata_futures(wait_for_all=False)

            result["import_complete"] = True
            result["total_final"] = True
            result["metadata_total_final"] = True
            _flush_placeholder_records(pending_placeholder_records)
            if result["total"] > 0:
                _emit_library_ready()
            _drain_metadata_futures(wait_for_all=True)
            if result["metadata_total"] > 0:
                _emit_progress(
                    result["metadata_processed"],
                    result["metadata_total"],
                    "",
                    {
                        "errors": result["errors"],
                        "last_error": None,
                        "phase": "metadata",
                        "library_ready": result["library_ready"],
                        "counted": result["counted"],
                        "import_processed": result["total"],
                        "import_total": result["total"],
                        "import_complete": result["import_complete"],
                        "metadata_processed": result["metadata_processed"],
                        "metadata_total": result["metadata_total"],
                        "metadata_total_final": result["metadata_total_final"],
                        "metadata_pending": len(in_flight),
                        "total_final": result["total_final"],
                    },
                    force=True,
                )
        finally:
            if executor is not None:
                if in_flight:
                    for future in tuple(in_flight.keys()):
                        future.cancel()
                    _terminate_metadata_executor_workers(executor)
                _shutdown_metadata_executor(executor, wait_for_workers=False)
    except ScanCancelledError:
        _reconcile_interrupted_scan_placeholders()
        raise
    except Exception:
        _reconcile_interrupted_scan_placeholders()
        raise
    finally:
        scan_state.scan_finished()

    _flush_metadata_records(pending_metadata_records)
    _flush_deleted_new_paths(pending_deleted_new_paths)
    result["recent_errors"] = sorted(
        result["recent_errors"],
        key=lambda entry: (entry.get("filename") or "", entry.get("error") or ""),
    )[-10:]

    return result


def _prepare_destination_path(
    image_path: str,
    destination_folder: str,
    operation: str,
) -> tuple[str, str]:
    """Validate destination folder and build a conflict-free output path."""
    destination_folder = os.path.abspath(destination_folder)
    image_path = os.path.abspath(image_path)

    is_valid, error = validate_folder_path(destination_folder, allow_create=True)
    if not is_valid:
        raise FileOperationError(
            f"Invalid destination: {error}",
            path=destination_folder,
            operation=operation,
        )

    os.makedirs(destination_folder, exist_ok=True)

    filename = os.path.basename(image_path)
    new_path = os.path.abspath(os.path.join(destination_folder, filename))

    if os.path.exists(new_path) and (new_path != image_path or operation == "copy"):
        base, ext = os.path.splitext(filename)
        counter = 1
        while os.path.exists(new_path) and counter <= 10000:
            new_filename = f"{base}_{counter}{ext}"
            new_path = os.path.abspath(os.path.join(destination_folder, new_filename))
            counter += 1
        if os.path.exists(new_path):
            raise FileOperationError(
                "Could not find an available filename after 10000 attempts",
                path=destination_folder,
                operation=operation,
            )

    return image_path, new_path


def _build_copied_image_record(
    source_row: Dict[str, Any],
    new_path: str,
    stat_result: os.stat_result,
) -> Dict[str, Any]:
    """Create a new database row for a copied image using source metadata."""
    return {
        "path": new_path,
        "filename": os.path.basename(new_path),
        "generator": source_row.get("generator") or "unknown",
        "prompt": source_row.get("prompt"),
        "negative_prompt": source_row.get("negative_prompt"),
        "metadata_json": compact_existing_metadata_json(source_row.get("metadata_json")) or compact_metadata_json({}),
        "width": source_row.get("width"),
        "height": source_row.get("height"),
        "file_size": int(stat_result.st_size),
        "checkpoint": source_row.get("checkpoint"),
        "loras": _deserialize_loras(source_row.get("loras")) or [],
        # Preserve the original gallery sort date so copy workflows do not
        # scramble chronology when users need a reversible export.
        "library_order_time": (
            source_row.get("library_order_time")
            or source_row.get("created_at")
            or datetime.fromtimestamp(stat_result.st_mtime)
        ),
        "source_file_mtime": datetime.fromtimestamp(stat_result.st_mtime),
        "created_at": (
            source_row.get("library_order_time")
            or source_row.get("created_at")
            or datetime.fromtimestamp(stat_result.st_mtime)
        ),
        "model_hash": source_row.get("model_hash"),
        "is_readable": bool(source_row.get("is_readable", 1)),
        "read_error": source_row.get("read_error"),
        "source_mtime_ns": int(stat_result.st_mtime_ns),
        "source_size": int(stat_result.st_size),
        "metadata_status": source_row.get("metadata_status") or "complete",
        "content_fingerprint": source_row.get("content_fingerprint"),
    }


def move_image(image_id: int, destination_folder: str, image_path: str) -> str:
    """
    Move an image to a new folder.

    Args:
        image_id: Database ID of the image
        destination_folder: Target folder path
        image_path: Current path of the image

    Returns:
        New path of the image

    Raises:
        FileOperationError: If the move operation fails
    """
    try:
        image_path, new_path = _prepare_destination_path(image_path, destination_folder, "move")

        shutil.move(image_path, new_path)
        try:
            update_image_path(image_id, new_path)
        except Exception as db_error:
            try:
                if os.path.exists(new_path):
                    shutil.move(new_path, image_path)
            except Exception as rollback_error:
                raise FileOperationError(
                    f"Database update failed after moving file, and rollback failed: {db_error}; rollback error: {rollback_error}",
                    path=image_path,
                    operation="move",
                ) from db_error
            raise FileOperationError(
                f"Database update failed after moving file; file was restored to original path: {db_error}",
                path=image_path,
                operation="move",
            ) from db_error

        return new_path
    except FileOperationError:
        raise
    except PermissionError as e:
        raise FileOperationError(
            f"Permission denied: {e}",
            path=image_path,
            operation="move"
        ) from e
    except OSError as e:
        raise FileOperationError(
            f"Failed to move file: {e}",
            path=image_path,
            operation="move"
        ) from e
    except Exception as e:
        raise FileOperationError(
            f"Unexpected error during move: {e}",
            path=image_path,
            operation="move"
        ) from e


def copy_image(
    image_id: int,
    destination_folder: str,
    image_path: str,
    source_row: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Copy an image to a new folder.

    Args:
        image_id: Database ID of the source image
        image_path: Path of the image to copy
        destination_folder: Target folder path
        source_row: Optional already-fetched DB row for the source image

    Returns:
        Dict with the copied path and database ID

    Raises:
        FileOperationError: If the copy operation fails
    """
    try:
        image_path, new_path = _prepare_destination_path(image_path, destination_folder, "copy")

        shutil.copy2(image_path, new_path)
        stat_result = os.stat(new_path)
        source = source_row or get_image_by_id(image_id) or {}
        copied_record = _build_copied_image_record(source, new_path, stat_result)
        try:
            copied_image_id = add_copied_image_with_state(image_id, copied_record)
        except Exception as db_error:
            try:
                if os.path.exists(new_path):
                    os.remove(new_path)
            except Exception as rollback_error:
                raise FileOperationError(
                    f"Database update failed after copying file, and rollback failed: {db_error}; rollback error: {rollback_error}",
                    path=image_path,
                    operation="copy",
                ) from db_error
            raise FileOperationError(
                f"Database update failed after copying file; copied file was removed: {db_error}",
                path=image_path,
                operation="copy",
            ) from db_error

        return {
            "new_path": new_path,
            "new_image_id": copied_image_id,
        }
    except FileOperationError:
        raise
    except PermissionError as e:
        raise FileOperationError(
            f"Permission denied: {e}",
            path=image_path,
            operation="copy"
        ) from e
    except OSError as e:
        raise FileOperationError(
            f"Failed to copy file: {e}",
            path=image_path,
            operation="copy"
        ) from e
    except Exception as e:
        raise FileOperationError(
            f"Unexpected error during copy: {e}",
            path=image_path,
            operation="copy"
        ) from e



def reparse_image_metadata(
    image_id: int,
    image_path: str,
    preserve_derived_state: bool = False,
) -> Dict[str, Any]:
    """Re-parse a single image and update its stored metadata fields."""
    stat_result = os.stat(image_path)
    metadata = parse_image(image_path, validate_image_data=True)
    content_fingerprint = None

    parse_error = metadata.get("parse_error")
    if not parse_error and (metadata["width"] <= 0 or metadata["height"] <= 0):
        parse_error = "Metadata parse returned no dimensions"
    if parse_error:
        update_image_metadata(
            image_id=image_id,
            generator="unknown",
            prompt=None,
            negative_prompt=None,
            metadata_json=compact_metadata_json({}),
            width=None,
            height=None,
            file_size=stat_result.st_size,
            checkpoint=None,
            loras=[],
            is_readable=False,
            read_error=parse_error,
            source_mtime_ns=stat_result.st_mtime_ns,
            source_size=stat_result.st_size,
            metadata_status="error",
            preserve_derived_state=preserve_derived_state,
        )
        return metadata

    try:
        metadata_json = compact_metadata_json(metadata.get("metadata"))
    except (TypeError, ValueError):
        metadata_json = compact_metadata_json({})

    try:
        content_fingerprint = compute_image_content_fingerprint(image_path)
    except Exception as exc:
        logger.warning("Could not compute content fingerprint for %s: %s", image_path, exc)

    update_image_metadata(
        image_id=image_id,
        generator=metadata["generator"],
        prompt=metadata["prompt"],
        negative_prompt=metadata["negative_prompt"],
        metadata_json=metadata_json,
        width=metadata["width"],
        height=metadata["height"],
        file_size=metadata["file_size"],
        checkpoint=metadata["checkpoint"],
        loras=metadata["loras"],
        is_readable=True,
        read_error=None,
        source_mtime_ns=stat_result.st_mtime_ns,
        source_size=stat_result.st_size,
        metadata_status="complete",
        content_fingerprint=content_fingerprint,
        preserve_derived_state=preserve_derived_state,
    )

    return metadata


def batch_move(
    image_ids: List[int],
    image_paths: List[str],
    destination_folder: str,
    progress_callback: Optional[Callable] = None
) -> Dict[str, Any]:
    """
    Move multiple images to a folder.

    Returns:
        {
            "total": int,
            "moved": int,
            "errors": int,
            "new_paths": [str]
        }
    """
    result: Dict[str, Any] = {
        "total": len(image_ids),
        "moved": 0,
        "errors": 0,
        "new_paths": []
    }

    for i, (img_id, img_path) in enumerate(zip(image_ids, image_paths)):
        try:
            if progress_callback:
                progress_callback(i + 1, result["total"], os.path.basename(img_path))

            new_path = move_image(img_id, destination_folder, img_path)
            result["new_paths"].append(new_path)
            result["moved"] += 1
        except FileOperationError as e:
            logger.warning("Failed to move %s: %s", img_path, e.message)
            result["errors"] += 1
        except Exception as e:
            logger.error("Unexpected error moving %s: %s", img_path, e, exc_info=True)
            result["errors"] += 1

    return result


def get_folder_stats(folder_path: str, max_files: Optional[int] = None) -> Dict[str, Any]:
    """Get statistics about a folder's images.

    Args:
        folder_path: Folder to walk recursively.
        max_files: Optional cap on the number of entries visited from rglob.
            None (default) preserves the original unbounded walk. When set, the
            walk is bounded via itertools.islice so an enormous tree cannot block
            indefinitely.
    """
    folder = Path(folder_path)

    stats: Dict[str, Any] = {
        "total_files": 0,
        "total_size": 0,
        "by_extension": {}
    }

    entries: Iterator[Path] = folder.rglob("*")
    if max_files is not None:
        entries = itertools.islice(entries, max_files)

    for file_path in entries:
        if file_path.is_symlink():
            continue
        if file_path.is_file():
            ext = file_path.suffix.lower()
            if ext in IMAGE_EXTENSIONS:
                stats["total_files"] += 1
                stats["total_size"] += file_path.stat().st_size
                stats["by_extension"][ext] = stats["by_extension"].get(ext, 0) + 1

    return stats
