"""
SQLite database for storing image metadata and tags.

This module provides direct function-based database access for backward compatibility.
For new code, consider using the repository pattern from db_repos:

    from db_repos import ImageRepository, TagRepository, CollectionRepository
    from db_repos import ImageFilters

    # Example usage:
    image_repo = ImageRepository()
    images = image_repo.find_all(filters=ImageFilters(tags=["portrait"]), limit=50)
    image = image_repo.find_by_id(123)

    # Dependency injection with FastAPI:
    def get_image_repo() -> ImageRepository:
        return ImageRepository()

See backend/db_repos/repositories/ for the repository implementations.
"""
import sqlite3
import os
import json
import logging
import re
from datetime import datetime
from pathlib import Path
from typing import Optional, List, Dict, Any, Tuple, Union, Iterator
from contextlib import contextmanager
import time
import threading

from config import (
    DATABASE_PATH,
    FAVORITES_COLLECTION_SLUG,
    FAVORITES_COLLECTION_NAME,
    FAVORITES_FOLDER_PATH,
)
from utils.source_paths import (
    build_indexed_folder_scope_query_patterns,
    build_indexed_image_lookup_candidates,
    indexed_image_path_match_key,
    is_indexed_image_path_in_folder_scope,
    is_case_insensitive_indexed_path,
    normalize_indexed_image_path,
)
from utils.model_names import (
    checkpoint_identity_key,
    normalize_checkpoint_name as _normalize_checkpoint_name,
)
from utils.pagination_cursor import encode_image_cursor_from_image
from metadata_storage import compact_existing_metadata_json, compact_metadata_json

import db_core
from db_core import (
    PROMPT_MATCH_MODE_EXACT,
    PROMPT_MATCH_MODE_CONTAINS,
    VALID_PROMPT_MATCH_MODES,
    _adapt_datetime_for_sqlite,
    _tags_cache_lock,
    _TAGS_CACHE_TTL,
    _generators_cache_lock,
    _invalidate_facet_caches,
    _invalidate_tags_cache,
    SCHEMA_VERSION_ROW_ID,
    STALE_PENDING_METADATA_READ_ERROR,
    get_db,
)
from db_helpers import (
    _normalize_indexed_image_path,
    _path_query_match_clause,
    _folder_scope_query_match_clause,
    _ensure_content_fingerprint_value,
    normalize_prompt_token,
    normalize_prompt_match_mode,
    escape_like_pattern,
    normalize_lora_name,
    normalize_checkpoint_name,
    extract_prompt_tokens,
    extract_lora_names,
    _serialize_loras,
    _deserialize_loras,
    _normalize_source_fingerprint,
    _normalize_content_fingerprint,
    _row_value,
    _json_safe_db_value,
    _row_to_dict,
    _rows_to_dicts,
    _has_source_fingerprint,
    _is_source_fingerprint_changed,
    _has_derived_state,
    _should_clear_derived_state,
)
from db_query import (
    VALID_SORT_OPTIONS,
    _IMAGE_COLUMNS_BASE_FIELDS,
    _IMAGE_COLUMNS_WITH_PROMPT_FIELDS,
    _IMAGE_COLUMNS_LIGHTWEIGHT_FIELDS,
    _format_image_column_list,
    _IMAGE_COLUMNS_FULL,
    _IMAGE_COLUMNS_WITH_PROMPT,
    _IMAGE_COLUMNS_LIGHTWEIGHT,
    _IMAGE_COLUMNS_BARE,
    _RECONNECT_CANDIDATE_FIELDS,
    _RECONNECT_CANDIDATE_COLUMNS,
    _LIBRARY_ORDER_SQL_UNQUALIFIED,
    _LIBRARY_ORDER_SQL,
    _STABLE_RANDOM_ORDER_SQL,
    _DEFAULT_ORDER_CLAUSE,
    _build_base_query,
    _apply_tag_filter,
    _apply_generator_filter,
    _apply_rating_filter,
    _apply_checkpoint_filter,
    _apply_lora_filter,
    _apply_exclude_tags_filter,
    _apply_exclude_generators_filter,
    _apply_exclude_ratings_filter,
    _apply_exclude_checkpoints_filter,
    _apply_exclude_loras_filter,
    _apply_search_filter,
    _apply_prompt_terms_filter,
    _apply_dimension_filters,
    _apply_aesthetic_filter,
    _apply_color_filter,
    _apply_artist_filter,
    _normalize_filter_id_list,
    _apply_id_list_filter,
    _apply_image_ids_filter,
    _apply_excluded_image_ids_filter,
    _apply_readable_filter,
    _get_order_clause,
    _supports_cursor_sort,
    _fetch_post_filtered_page,
    _fetch_post_filtered_ids,
    _matches_exact_post_filters,
    _post_filter_results,
)
from db_schema import (
    _ensure_schema_version_table,
    _get_schema_version,
    _set_schema_version,
    _run_post_migration_vacuum,
    _recover_stale_pending_metadata_rows,
    init_db,
)


logger = logging.getLogger(__name__)


# Connection state stays on the ``database`` module so the test suite can keep
# monkeypatching ``database.DATABASE_PATH`` / ``database._pragmas_initialized``.
# The concrete factory below is injected into db_core so every db_* module
# shares it via ``db_core.get_db``/``db_core.get_connection`` without importing
# ``database`` (which would create an import cycle).
_pragmas_initialized: set = set()
_pragmas_lock = threading.Lock()


def get_connection() -> sqlite3.Connection:
    """Get a database connection with row factory and performance optimizations."""
    conn = sqlite3.connect(DATABASE_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout=5000")
    # WAL mode and other persistent PRAGMAs only need to be set once per database path
    db_path = os.path.abspath(DATABASE_PATH)
    if db_path not in _pragmas_initialized:
        with _pragmas_lock:
            if db_path not in _pragmas_initialized:
                conn.execute("PRAGMA journal_mode=WAL")
                conn.execute("PRAGMA synchronous=NORMAL")
                conn.execute("PRAGMA cache_size=-64000")  # 64MB cache
                _pragmas_initialized.add(db_path)
    return conn


db_core.set_connection_provider(get_connection)


def _clear_image_derived_state(cursor: sqlite3.Cursor, image_id: int) -> None:
    """Remove derived data that becomes stale when the source image changes."""
    cursor.execute(
        """
        UPDATE images
        SET content_fingerprint = NULL,
            embedding = NULL,
            tagged_at = NULL,
            ai_caption = NULL,
            aesthetic_score = NULL
        WHERE id = ?
        """,
        (image_id,),
    )
    cursor.execute("DELETE FROM tags WHERE image_id = ?", (image_id,))
    cursor.execute("DELETE FROM artist_predictions WHERE image_id = ?", (image_id,))


def _sync_image_loras(
    cursor: sqlite3.Cursor,
    image_id: int,
    loras: Optional[List[str]],
    prompt: Optional[str],
) -> None:
    """Refresh the normalized image_loras rows for an image."""
    cursor.execute("DELETE FROM image_loras WHERE image_id = ?", (image_id,))

    lora_names = extract_lora_names(_serialize_loras(loras) or '', prompt or '')
    for lora_name in lora_names:
        cursor.execute(
            "INSERT OR IGNORE INTO image_loras (image_id, lora_name) VALUES (?, ?)",
            (image_id, lora_name)
        )


def _sync_image_prompt_tokens(
    cursor: sqlite3.Cursor,
    image_id: int,
    prompt: Optional[str],
) -> None:
    """Refresh the normalized image_prompt_tokens rows for an image."""
    cursor.execute("DELETE FROM image_prompt_tokens WHERE image_id = ?", (image_id,))

    for token in extract_prompt_tokens(prompt or ''):
        cursor.execute(
            "INSERT OR IGNORE INTO image_prompt_tokens (image_id, token) VALUES (?, ?)",
            (image_id, token),
        )


def add_image(
    path: str,
    filename: str,
    generator: str = "unknown",
    prompt: Optional[str] = None,
    negative_prompt: Optional[str] = None,
    metadata_json: Optional[str] = None,
    width: Optional[int] = None,
    height: Optional[int] = None,
    file_size: Optional[int] = None,
    checkpoint: Optional[str] = None,
    loras: Optional[List[str]] = None,
    created_at: Optional[datetime] = None,
    library_order_time: Optional[datetime] = None,
    source_file_mtime: Optional[datetime] = None,
    model_hash: Optional[str] = None,
    is_readable: bool = True,
    read_error: Optional[str] = None,
    source_mtime_ns: Optional[int] = None,
    source_size: Optional[int] = None,
    metadata_status: str = "complete",
    content_fingerprint: Optional[str] = None,
    return_status: bool = False,
) -> Union[int, Tuple[int, str]]:
    """Add an image to the database.

    Returns the image ID by default. When ``return_status`` is True, returns
    ``(image_id, "new" | "updated")`` so callers can report truthful scan
    summaries without duplicating the upsert logic.
    """
    resolved_library_order_time = library_order_time or created_at
    resolved_source_file_mtime = source_file_mtime or created_at
    record = {
        "path": path,
        "filename": filename,
        "generator": generator,
        "prompt": prompt,
        "negative_prompt": negative_prompt,
        "metadata_json": metadata_json,
        "width": width,
        "height": height,
        "file_size": file_size,
        "checkpoint": checkpoint,
        "checkpoint_normalized": normalize_checkpoint_name(checkpoint),
        "loras": loras,
        "library_order_time": resolved_library_order_time,
        "source_file_mtime": resolved_source_file_mtime,
        "created_at": resolved_library_order_time,
        "model_hash": model_hash,
        "is_readable": is_readable,
        "read_error": read_error,
        "source_mtime_ns": source_mtime_ns,
        "source_size": source_size,
        "metadata_status": metadata_status,
        "content_fingerprint": content_fingerprint,
    }

    with get_db() as conn:
        cursor = conn.cursor()
        image_id, write_status = _upsert_image_record(cursor, record)
        _invalidate_tags_cache()
        _invalidate_facet_caches()

        if return_status:
            return image_id, write_status
        return image_id


def _get_existing_images_by_paths(
    cursor: sqlite3.Cursor,
    paths: List[str],
) -> Dict[str, sqlite3.Row]:
    """Fetch existing image rows keyed by normalized indexed path."""
    normalized_paths = [_normalize_indexed_image_path(path) for path in paths if path]
    if not normalized_paths:
        return {}

    requested_candidates = {
        path: build_indexed_image_lookup_candidates(path)
        for path in normalized_paths
    }
    existing_rows: Dict[str, sqlite3.Row] = {}
    chunk_size = 100
    for start in range(0, len(normalized_paths), chunk_size):
        chunk_paths = normalized_paths[start:start + chunk_size]
        query_clause, query_params = _path_query_match_clause(chunk_paths)
        if not query_clause:
            continue
        cursor.execute(
            f"""
                    SELECT id, path, filename, generator, prompt, negative_prompt, metadata_json,
                   width, height, file_size, checkpoint, checkpoint_normalized, loras, model_hash,
                   library_order_time, source_file_mtime, created_at,
                   is_readable, read_error, source_mtime_ns, source_size, metadata_status,
                   content_fingerprint, tagged_at, ai_caption, aesthetic_score,
                   CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END AS has_embedding,
                   EXISTS(SELECT 1 FROM artist_predictions ap WHERE ap.image_id = images.id) AS has_artist_predictions
            FROM images
            WHERE {query_clause}
            """,
            query_params,
        )
        for row in cursor.fetchall():
            existing_rows[row["path"]] = row

    existing: Dict[str, sqlite3.Row] = {}
    rows_by_match_key = {
        indexed_image_path_match_key(path): row
        for path, row in existing_rows.items()
    }
    for requested_path, candidates in requested_candidates.items():
        for candidate in candidates:
            row = existing_rows.get(candidate)
            if not row:
                row = rows_by_match_key.get(indexed_image_path_match_key(candidate))
            if row:
                existing[requested_path] = row
                break

    return existing


def _compact_persisted_metadata_json(metadata_json: Any) -> str:
    compacted = compact_existing_metadata_json(metadata_json)
    if compacted is not None:
        return compacted
    return compact_metadata_json({})


def _upsert_image_record(
    cursor: sqlite3.Cursor,
    record: Dict[str, Any],
    existing_row: Optional[sqlite3.Row] = None,
) -> Tuple[int, str]:
    """Insert or update a single image row using an existing transaction."""
    path = _normalize_indexed_image_path(record["path"])
    record["metadata_json"] = _compact_persisted_metadata_json(record.get("metadata_json"))
    serialized_loras = _serialize_loras(record.get("loras"))
    metadata_status = record.get("metadata_status") or "complete"
    record["checkpoint_normalized"] = normalize_checkpoint_name(record.get("checkpoint"))
    incoming_library_order_time = record.get("library_order_time")
    if incoming_library_order_time is None:
        incoming_library_order_time = record.get("created_at")
    incoming_source_file_mtime = record.get("source_file_mtime")
    if incoming_source_file_mtime is None:
        incoming_source_file_mtime = record.get("created_at")
    record["library_order_time"] = incoming_library_order_time
    record["source_file_mtime"] = incoming_source_file_mtime
    record["created_at"] = incoming_library_order_time
    source_changed = False
    mark_unreadable = not record.get("is_readable", True)

    if existing_row is None:
        candidates = build_indexed_image_lookup_candidates(path)
        if candidates:
            query_clause, query_params = _path_query_match_clause(candidates)
            existing_rows = cursor.execute(
                f"""
                SELECT id, path, source_mtime_ns, source_size, content_fingerprint,
                       library_order_time, source_file_mtime, created_at,
                       tagged_at, ai_caption, aesthetic_score,
                       CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END AS has_embedding,
                       EXISTS(SELECT 1 FROM artist_predictions ap WHERE ap.image_id = images.id) AS has_artist_predictions
                FROM images
                WHERE {query_clause}
                """,
                query_params,
            ).fetchall()
            rows_by_path = {row["path"]: row for row in existing_rows}
            rows_by_match_key = {
                indexed_image_path_match_key(row["path"]): row
                for row in existing_rows
            }
            for candidate in candidates:
                existing_row = rows_by_path.get(candidate)
                if not existing_row:
                    existing_row = rows_by_match_key.get(indexed_image_path_match_key(candidate))
                if existing_row:
                    break

    if existing_row:
        image_id = existing_row["id"]
        write_status = "updated"
        source_changed = _is_source_fingerprint_changed(existing_row, record)
        incoming_source_mtime_ns = record.get("source_mtime_ns")
        incoming_source_size = record.get("source_size")
        if metadata_status == "pending":
            # Placeholder scan rows should not consume the new source fingerprint
            # before the final metadata backfill has a chance to compare pixels.
            incoming_source_mtime_ns = None
            incoming_source_size = None
        if _should_clear_derived_state(
            existing_row,
            record,
            source_changed=source_changed,
            mark_unreadable=mark_unreadable,
        ):
            _clear_image_derived_state(cursor, image_id)

        cursor.execute(
            """
            UPDATE images
            SET filename = ?,
                generator = ?,
                prompt = ?,
                negative_prompt = ?,
                metadata_json = ?,
                width = ?,
                height = ?,
                file_size = ?,
                checkpoint = ?,
                checkpoint_normalized = ?,
                loras = ?,
                model_hash = COALESCE(?, model_hash),
                is_readable = ?,
                read_error = ?,
                source_mtime_ns = COALESCE(?, source_mtime_ns),
                source_size = COALESCE(?, source_size),
                metadata_status = ?,
                content_fingerprint = COALESCE(?, content_fingerprint),
                library_order_time = COALESCE(library_order_time, created_at, ?),
                source_file_mtime = COALESCE(?, source_file_mtime),
                created_at = COALESCE(library_order_time, created_at, ?),
                indexed_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (
                record["filename"],
                record.get("generator", "unknown"),
                record.get("prompt"),
                record.get("negative_prompt"),
                record.get("metadata_json"),
                record.get("width"),
                record.get("height"),
                record.get("file_size"),
                record.get("checkpoint"),
                record.get("checkpoint_normalized"),
                serialized_loras,
                record.get("model_hash"),
                1 if record.get("is_readable", True) else 0,
                record.get("read_error"),
                incoming_source_mtime_ns,
                incoming_source_size,
                metadata_status,
                record.get("content_fingerprint"),
                record.get("library_order_time"),
                record.get("source_file_mtime"),
                record.get("created_at"),
                image_id,
            ),
        )
    else:
        write_status = "new"
        cursor.execute(
            """
            INSERT INTO images
            (path, filename, generator, prompt, negative_prompt, metadata_json,
             width, height, file_size, checkpoint, checkpoint_normalized, loras, model_hash, is_readable, read_error,
             source_mtime_ns, source_size, metadata_status, content_fingerprint,
             library_order_time, source_file_mtime, created_at, indexed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            """,
            (
                path,
                record["filename"],
                record.get("generator", "unknown"),
                record.get("prompt"),
                record.get("negative_prompt"),
                record.get("metadata_json"),
                record.get("width"),
                record.get("height"),
                record.get("file_size"),
                record.get("checkpoint"),
                record.get("checkpoint_normalized"),
                serialized_loras,
                record.get("model_hash"),
                1 if record.get("is_readable", True) else 0,
                record.get("read_error"),
                record.get("source_mtime_ns"),
                record.get("source_size"),
                metadata_status,
                record.get("content_fingerprint"),
                record.get("library_order_time"),
                record.get("source_file_mtime"),
                record.get("created_at"),
            ),
        )
        image_id = cursor.lastrowid

    _sync_image_loras(cursor, image_id, record.get("loras"), record.get("prompt"))
    _sync_image_prompt_tokens(cursor, image_id, record.get("prompt"))
    return image_id, write_status


def add_images_batch(image_records: List[Dict[str, Any]], return_statuses: bool = False) -> Dict[str, Any]:
    """Insert or update many images in a single transaction."""
    if not image_records:
        empty_result: Dict[str, Any] = {"new": 0, "updated": 0}
        if return_statuses:
            empty_result["statuses"] = {}
        return empty_result

    normalized_records = []
    for record in image_records:
        normalized = dict(record)
        normalized["path"] = _normalize_indexed_image_path(record["path"])
        normalized_records.append(normalized)

    with get_db() as conn:
        cursor = conn.cursor()
        existing_by_path = _get_existing_images_by_paths(
            cursor,
            [record["path"] for record in normalized_records],
        )
        counts = {"new": 0, "updated": 0}
        statuses: Dict[str, str] = {}

        for record in normalized_records:
            _image_id, status = _upsert_image_record(
                cursor,
                record,
                existing_row=existing_by_path.get(record["path"]),
            )
            counts[status] += 1
            statuses[record["path"]] = status

        _invalidate_tags_cache()
        _invalidate_facet_caches()
        if return_statuses:
            return {
                **counts,
                "statuses": statuses,
            }
        return counts


def get_image_scan_state_by_paths(paths: List[str]) -> Dict[str, Dict[str, Any]]:
    """Fetch lightweight row state used by folder scan optimizations."""
    if not paths:
        return {}

    with get_db() as conn:
        cursor = conn.cursor()
        rows = _get_existing_images_by_paths(cursor, paths)
        return {
            path: _row_to_dict(row)
            for path, row in rows.items()
        }


def get_images_in_folder_scope(folder_path: str, recursive: bool = True) -> List[Dict[str, Any]]:
    """Return lightweight image rows that fall under a scan root."""
    clause, params = _folder_scope_query_match_clause(folder_path)
    if not clause:
        return []

    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            f"""
            SELECT id, path, filename
            FROM images
            WHERE {clause}
            """,
            params,
        )
        rows = _rows_to_dicts(cursor.fetchall())

    if recursive:
        return rows

    return [
        row for row in rows
        if is_indexed_image_path_in_folder_scope(row["path"], folder_path, recursive=False)
    ]


def get_missing_image_reconnect_candidates(limit: Optional[int] = None) -> List[Dict[str, Any]]:
    """Return image rows whose stored source path no longer resolves on disk."""
    from utils.source_paths import resolve_existing_indexed_image_path

    query = f"SELECT {_RECONNECT_CANDIDATE_COLUMNS} FROM images ORDER BY id"
    params: List[Any] = []
    if limit is not None:
        query += " LIMIT ?"
        params.append(max(0, int(limit)))

    candidates: List[Dict[str, Any]] = []
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(query, params)
        while True:
            rows = cursor.fetchmany(1000)
            if not rows:
                break
            for row in _rows_to_dicts(rows):
                source_path = row.get("path") or ""
                resolved_path = resolve_existing_indexed_image_path(source_path, backend_file=__file__)
                if resolved_path:
                    continue
                candidates.append(row)

    return candidates


def reconnect_image_source_path(
    image_id: int,
    new_path: str,
    *,
    source_mtime_ns: Optional[int] = None,
    source_size: Optional[int] = None,
    source_file_mtime: Optional[datetime] = None,
) -> None:
    """Reconnect a missing library row to a found file path without clearing derived data."""
    normalized_path = _normalize_indexed_image_path(new_path)
    filename = os.path.basename(normalized_path)
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            UPDATE images
            SET path = ?,
                filename = ?,
                is_readable = CASE
                    WHEN TRIM(COALESCE(read_error, '')) = ''
                         OR LOWER(COALESCE(read_error, '')) LIKE '%not found%'
                         OR LOWER(COALESCE(read_error, '')) LIKE '%missing%'
                    THEN 1
                    ELSE is_readable
                END,
                read_error = CASE
                    WHEN TRIM(COALESCE(read_error, '')) = ''
                         OR LOWER(COALESCE(read_error, '')) LIKE '%not found%'
                         OR LOWER(COALESCE(read_error, '')) LIKE '%missing%'
                    THEN NULL
                    ELSE read_error
                END,
                metadata_status = CASE
                    WHEN TRIM(COALESCE(read_error, '')) = ''
                         OR LOWER(COALESCE(read_error, '')) LIKE '%not found%'
                         OR LOWER(COALESCE(read_error, '')) LIKE '%missing%'
                    THEN 'complete'
                    ELSE COALESCE(metadata_status, 'complete')
                END,
                source_mtime_ns = COALESCE(?, source_mtime_ns),
                source_size = COALESCE(?, source_size),
                source_file_mtime = COALESCE(?, source_file_mtime),
                indexed_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (
                normalized_path,
                filename,
                source_mtime_ns,
                source_size,
                source_file_mtime,
                image_id,
            ),
        )
    _invalidate_tags_cache()


def _mark_image_tagged(
    cursor: sqlite3.Cursor,
    image_id: int,
    content_fingerprint: Optional[str],
) -> None:
    cursor.execute(
        "UPDATE images SET tagged_at = CURRENT_TIMESTAMP, content_fingerprint = COALESCE(?, content_fingerprint) WHERE id = ?",
        (content_fingerprint, image_id),
    )


def delete_images_by_ids(image_ids: List[int]) -> int:
    """Delete many image rows in chunks and return the removed count."""
    if not image_ids:
        return 0

    removed = 0
    batch_size = 500

    with get_db() as conn:
        cursor = conn.cursor()
        for start in range(0, len(image_ids), batch_size):
            batch = image_ids[start:start + batch_size]
            placeholders = ",".join("?" * len(batch))
            cursor.execute(
                f"DELETE FROM images WHERE id IN ({placeholders})",
                batch,
            )
            removed += cursor.rowcount or 0

    if removed:
        _invalidate_tags_cache()
        _invalidate_facet_caches()

    return removed


def delete_images_by_paths(paths: List[str]) -> int:
    """Delete image rows by absolute file path."""
    if not paths:
        return 0

    removed = 0
    # Conservative path batch size: each path can expand to several lookup
    # candidates inside _path_query_match_clause, so keep batches small to
    # stay well under SQLite's 999 bound-variable limit per statement.
    batch_size = 100

    with get_db() as conn:
        cursor = conn.cursor()
        for start in range(0, len(paths), batch_size):
            path_batch = paths[start:start + batch_size]
            clause, params = _path_query_match_clause(path_batch)
            if not clause:
                continue
            cursor.execute(f"DELETE FROM images WHERE {clause}", params)
            removed += cursor.rowcount or 0

    if removed:
        _invalidate_tags_cache()
        _invalidate_facet_caches()

    return removed


def mark_pending_images_metadata_error(image_ids: List[int], read_error: str) -> int:
    """Mark pending metadata rows as errored without changing derived state."""
    normalized_ids = [int(image_id) for image_id in image_ids if image_id]
    if not normalized_ids:
        return 0

    placeholders = ",".join("?" for _ in normalized_ids)
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            f"""
            UPDATE images
            SET is_readable = 0,
                metadata_status = 'error',
                read_error = ?,
                indexed_at = CURRENT_TIMESTAMP
            WHERE id IN ({placeholders})
              AND LOWER(COALESCE(metadata_status, '')) = 'pending'
            """,
            [read_error, *normalized_ids],
        )
        return int(cursor.rowcount or 0)


def add_tags(image_id: int, tags: List[Dict[str, Any]], content_fingerprint: Optional[str] = None) -> None:
    """REPLACE all tags for an image. Each tag dict should have 'tag' and optionally 'confidence'.

    .. warning::
        The name is historical. This is a **DELETE + INSERT** operation — every
        existing tag row for ``image_id`` is removed before ``tags`` is inserted.
        To append a single tag, fetch the existing list first, append in memory,
        and pass the merged list. See ``backend/routers/tags_bulk.py`` for the
        canonical merge pattern used by bulk add / remove / cleanup operations.

    Uses executemany for batch insert performance.
    """
    with get_db() as conn:
        cursor = conn.cursor()
        content_fingerprint = _ensure_content_fingerprint_value(cursor, image_id, content_fingerprint)
        # Clear existing tags
        cursor.execute("DELETE FROM tags WHERE image_id = ?", (image_id,))
        # Batch insert new tags (N+1 fix: use executemany instead of loop)
        tag_values = [
            (image_id, tag_data.get("tag", ""), tag_data.get("confidence", 1.0))
            for tag_data in tags
            if tag_data.get("tag")
        ]
        if tag_values:
            cursor.executemany(
                "INSERT INTO tags (image_id, tag, confidence) VALUES (?, ?, ?)",
                tag_values
            )
        _mark_image_tagged(cursor, image_id, content_fingerprint)
    _invalidate_tags_cache()


def add_tags_batch(image_tags_list: List[Dict[str, Any]]) -> None:
    """Add tags for multiple images in a single transaction.

    More efficient than calling add_tags() repeatedly for batch tagging operations.
    Uses a single database connection and commits once at the end.

    Args:
        image_tags_list: List of dicts, each with:
            - image_id: int
            - tags: List[Dict] with 'tag' and 'confidence' keys
            - ai_caption: Optional[str] - natural language caption from VLM models
            - content_fingerprint: Optional[str] - metadata-independent image hash
    """
    if not image_tags_list:
        return

    with get_db() as conn:
        cursor = conn.cursor()

        for item in image_tags_list:
            image_id = item["image_id"]
            tags = item["tags"]
            ai_caption = item.get("ai_caption")
            content_fingerprint = _ensure_content_fingerprint_value(cursor, image_id, item.get("content_fingerprint"))

            # Clear existing tags
            cursor.execute("DELETE FROM tags WHERE image_id = ?", (image_id,))

            # Batch insert new tags
            tag_values = [
                (image_id, tag_data.get("tag", ""), tag_data.get("confidence", 1.0))
                for tag_data in tags
                if tag_data.get("tag")
            ]
            if tag_values:
                cursor.executemany(
                    "INSERT INTO tags (image_id, tag, confidence) VALUES (?, ?, ?)",
                    tag_values
                )

            # Update tagged timestamp and caption
            if ai_caption:
                cursor.execute(
                    "UPDATE images SET tagged_at = CURRENT_TIMESTAMP, ai_caption = ?, content_fingerprint = COALESCE(?, content_fingerprint) WHERE id = ?",
                    (ai_caption, content_fingerprint, image_id)
                )
            else:
                cursor.execute(
                    "UPDATE images SET tagged_at = CURRENT_TIMESTAMP, content_fingerprint = COALESCE(?, content_fingerprint) WHERE id = ?",
                    (content_fingerprint, image_id)
                )
        
        # Single commit at the end (automatic with context manager)
    _invalidate_tags_cache()


def get_images(
    generators: Optional[List[str]] = None,
    tags: Optional[List[str]] = None,
    tag_mode: str = "and",
    ratings: Optional[List[str]] = None,
    checkpoints: Optional[List[str]] = None,
    loras: Optional[List[str]] = None,
    search_query: Optional[str] = None,
    sort_by: str = "newest",
    limit: int = 100,
    offset: int = 0,
    min_width: Optional[int] = None,
    max_width: Optional[int] = None,
    min_height: Optional[int] = None,
    max_height: Optional[int] = None,
    prompt_terms: Optional[List[str]] = None,  # Multi-prompt filter (AND logic)
    prompt_match_mode: str = PROMPT_MATCH_MODE_EXACT,
    aspect_ratio: Optional[str] = None,  # 'square', 'landscape', 'portrait'
    artist: Optional[str] = None,  # Artist filter
    image_ids: Optional[List[int]] = None,
    excluded_image_ids: Optional[List[int]] = None,
    min_aesthetic: Optional[float] = None,
    max_aesthetic: Optional[float] = None,
    include_unreadable: bool = False,
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
) -> List[Dict[str, Any]]:
    """
    Get images with optional filters.
    
    .. deprecated::
        Use get_images_paginated() for better performance with large datasets.
        OFFSET pagination becomes slow for large offsets as SQLite must scan
        all preceding rows. Cursor-based pagination in get_images_paginated()
        uses indexed lookups for constant-time page fetching.
    
    Args:
        generators: Filter by generator type (OR logic)
        tags: Filter by tags (AND logic - image must have ALL tags)
        ratings: Filter by rating tags (OR logic - image must have ANY rating OR be untagged)
        checkpoints: Filter by checkpoint names (OR logic)
        loras: Filter by lora names (AND logic - image must have ALL loras)
        search_query: Search in prompt text
        artist: Filter by artist name (from artist_predictions table)
        sort_by: Sorting method (newest, oldest, name_asc, name_desc, generator, generator_desc, prompt_length, prompt_length_asc, tag_count, tag_count_asc, rating, rating_desc, character_count, character_count_asc, random, file_size, file_size_asc)
        min_width, max_width, min_height, max_height: Dimension filters
        aspect_ratio: Filter by aspect ratio ('square', 'landscape', 'portrait')
    
    Returns:
        List of image dictionaries matching the filters.
    """
    if image_ids is not None and len(image_ids) == 0:
        return []

    with get_db() as conn:
        cursor = conn.cursor()

        # Determine if post-filtering is needed (for exact matching)
        normalized_prompt_match_mode = normalize_prompt_match_mode(prompt_match_mode)
        needs_prompt_post_filter = bool(prompt_terms) and normalized_prompt_match_mode == PROMPT_MATCH_MODE_EXACT
        needs_post_filter = needs_prompt_post_filter or bool(loras)
        # Include prompt fields when searching or post-filtering
        needs_prompt_fields = bool(search_query) or needs_post_filter
        if needs_post_filter:
            select_cols = _IMAGE_COLUMNS_FULL
        elif needs_prompt_fields:
            select_cols = _IMAGE_COLUMNS_WITH_PROMPT
        else:
            select_cols = _IMAGE_COLUMNS_LIGHTWEIGHT

        # Build base query with sorting subqueries
        query = _build_base_query(sort_by, select_cols)

        # Initialize conditions and params
        conditions: List[str] = []
        params: List[Any] = []

        # Apply tag filter (JOIN)
        query, params = _apply_tag_filter(query, tags, params, tag_mode)

        # Apply image ID include/exclude filters
        conditions, params = _apply_image_ids_filter(conditions, params, image_ids)
        conditions, params = _apply_excluded_image_ids_filter(conditions, params, excluded_image_ids)

        # Exclude unreadable images from normal library results (unless include_unreadable=True)
        conditions, params = _apply_readable_filter(conditions, params, include_unreadable)

        # Apply generator filter
        conditions, params = _apply_generator_filter(conditions, params, generators)

        # Apply rating filter
        conditions, params = _apply_rating_filter(conditions, params, ratings)

        # Apply checkpoint filter
        conditions, params = _apply_checkpoint_filter(conditions, params, checkpoints)

        # Apply lora filter (SQL-level)
        conditions, params = _apply_lora_filter(conditions, params, loras)

        # Apply search filter
        conditions, params = _apply_search_filter(conditions, params, search_query)

        # Apply prompt terms filter
        conditions, params = _apply_prompt_terms_filter(
            conditions,
            params,
            prompt_terms,
            normalized_prompt_match_mode,
        )

        # Apply dimension filters
        conditions, params = _apply_dimension_filters(
            conditions, params,
            min_width, max_width, min_height, max_height, aspect_ratio
        )

        # Apply aesthetic score filters
        conditions, params = _apply_aesthetic_filter(
            conditions, params, min_aesthetic, max_aesthetic
        )

        # Apply v3.2.1 color filters
        conditions, params = _apply_color_filter(
            conditions, params,
            brightness_min, brightness_max, color_temperature, brightness_distribution,
        )

        # Apply v3.2.2 per-item exclude filters
        conditions, params = _apply_exclude_tags_filter(conditions, params, exclude_tags)
        conditions, params = _apply_exclude_generators_filter(conditions, params, exclude_generators)
        conditions, params = _apply_exclude_ratings_filter(conditions, params, exclude_ratings)
        conditions, params = _apply_exclude_checkpoints_filter(conditions, params, exclude_checkpoints)
        conditions, params = _apply_exclude_loras_filter(conditions, params, exclude_loras)

        # Apply artist filter (JOIN)
        query, conditions, params = _apply_artist_filter(query, conditions, params, artist)

        # Build WHERE clause
        if conditions:
            query += " WHERE " + " AND ".join(conditions)

        # Get order clause and append to query
        order_clause = _get_order_clause(sort_by)

        if needs_post_filter:
            results = _fetch_post_filtered_page(
                conn,
                query,
                params,
                order_clause,
                prompt_terms,
                loras,
                prompt_match_mode=normalized_prompt_match_mode,
                post_offset=offset,
                limit=limit,
            )
        else:
            query += f" ORDER BY {order_clause} LIMIT ? OFFSET ?"
            params.extend([limit, offset])
            cursor.execute(query, params)
            rows = cursor.fetchall()
            results = _rows_to_dicts(rows)

        return results


def get_filtered_image_count(
    generators: Optional[List[str]] = None,
    tags: Optional[List[str]] = None,
    tag_mode: str = "and",
    ratings: Optional[List[str]] = None,
    checkpoints: Optional[List[str]] = None,
    loras: Optional[List[str]] = None,
    search_query: Optional[str] = None,
    min_width: Optional[int] = None,
    max_width: Optional[int] = None,
    min_height: Optional[int] = None,
    max_height: Optional[int] = None,
    prompt_terms: Optional[List[str]] = None,
    prompt_match_mode: str = PROMPT_MATCH_MODE_EXACT,
    aspect_ratio: Optional[str] = None,
    artist: Optional[str] = None,
    image_ids: Optional[List[int]] = None,
    excluded_image_ids: Optional[List[int]] = None,
    min_aesthetic: Optional[float] = None,
    max_aesthetic: Optional[float] = None,
    include_unreadable: bool = False,
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
) -> int:
    """Get count of images matching filters without loading image data.

    Memory-efficient: Only returns a count, doesn't load any image rows.
    For filters requiring post-filtering (prompt_terms, loras), this returns
    an approximate count based on SQL-level filtering.

    Args:
        Same filters as get_images()

    Returns:
        Number of matching images
    """
    if image_ids is not None and len(image_ids) == 0:
        return 0

    with get_db() as conn:
        cursor = conn.cursor()

        # Build count query
        query = "SELECT COUNT(DISTINCT i.id) FROM images i"

        conditions: List[str] = []
        params: List[Any] = []

        # Apply tag filter (JOIN)
        if tags:
            if tag_mode == "or":
                placeholders = ",".join("?" * len(tags))
                query += f" INNER JOIN tags _tor ON i.id = _tor.image_id AND _tor.tag IN ({placeholders})"
                params.extend(tags)
            else:
                for i, tag in enumerate(tags):
                    alias = f"t{i}"
                    query += f" INNER JOIN tags {alias} ON i.id = {alias}.image_id AND {alias}.tag = ?"
                    params.append(tag)


        # Apply image ID include/exclude filters
        conditions, params = _apply_image_ids_filter(conditions, params, image_ids)
        conditions, params = _apply_excluded_image_ids_filter(conditions, params, excluded_image_ids)

        # Exclude unreadable images from normal library results (unless include_unreadable=True)
        conditions, params = _apply_readable_filter(conditions, params, include_unreadable)

        # Apply generator filter
        conditions, params = _apply_generator_filter(conditions, params, generators)

        # Apply rating filter
        conditions, params = _apply_rating_filter(conditions, params, ratings)

        # Apply checkpoint filter
        conditions, params = _apply_checkpoint_filter(conditions, params, checkpoints)

        # Apply lora filter (SQL-level)
        conditions, params = _apply_lora_filter(conditions, params, loras)

        # Apply search filter
        conditions, params = _apply_search_filter(conditions, params, search_query)

        # Apply prompt terms filter
        conditions, params = _apply_prompt_terms_filter(
            conditions,
            params,
            prompt_terms,
            prompt_match_mode,
        )

        # Apply dimension filters
        conditions, params = _apply_dimension_filters(
            conditions, params,
            min_width, max_width, min_height, max_height, aspect_ratio
        )

        conditions, params = _apply_aesthetic_filter(
            conditions, params, min_aesthetic, max_aesthetic
        )

        # Apply v3.2.1 color filters
        conditions, params = _apply_color_filter(
            conditions, params,
            brightness_min, brightness_max, color_temperature, brightness_distribution,
        )

        # Apply v3.2.2 per-item exclude filters
        conditions, params = _apply_exclude_tags_filter(conditions, params, exclude_tags)
        conditions, params = _apply_exclude_generators_filter(conditions, params, exclude_generators)
        conditions, params = _apply_exclude_ratings_filter(conditions, params, exclude_ratings)
        conditions, params = _apply_exclude_checkpoints_filter(conditions, params, exclude_checkpoints)
        conditions, params = _apply_exclude_loras_filter(conditions, params, exclude_loras)

        # Apply artist filter (JOIN)
        query, conditions, params = _apply_artist_filter(query, conditions, params, artist)

        # Build WHERE clause
        if conditions:
            query += " WHERE " + " AND ".join(conditions)

        cursor.execute(query, params)
        return cursor.fetchone()[0]


def get_filtered_image_ids(
    generators: Optional[List[str]] = None,
    tags: Optional[List[str]] = None,
    tag_mode: str = "and",
    ratings: Optional[List[str]] = None,
    checkpoints: Optional[List[str]] = None,
    loras: Optional[List[str]] = None,
    search_query: Optional[str] = None,
    sort_by: str = "newest",
    min_width: Optional[int] = None,
    max_width: Optional[int] = None,
    min_height: Optional[int] = None,
    max_height: Optional[int] = None,
    prompt_terms: Optional[List[str]] = None,
    prompt_match_mode: str = PROMPT_MATCH_MODE_EXACT,
    aspect_ratio: Optional[str] = None,
    artist: Optional[str] = None,
    image_ids: Optional[List[int]] = None,
    excluded_image_ids: Optional[List[int]] = None,
    min_aesthetic: Optional[float] = None,
    max_aesthetic: Optional[float] = None,
    include_unreadable: bool = False,
    fetch_chunk_size: int = 5000,
    max_results: Optional[int] = None,
    offset: int = 0,
    limit: Optional[int] = None,
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
) -> List[int]:
    """Get list of image IDs matching filters without loading full image data.

    Memory-efficient: Returns only IDs, not full image dictionaries.
    Used by sort session to minimize memory footprint.

    Args:
        Same filters as get_images()

    Returns:
        List of image IDs matching the filters
    """
    if image_ids is not None and len(image_ids) == 0:
        return []
    normalized_offset = max(0, int(offset or 0))
    if max_results is not None and max_results <= 0:
        return []
    if limit is not None and limit <= 0:
        return []

    result_limit = limit if limit is not None else max_results

    with get_db() as conn:
        cursor = conn.cursor()

        normalized_prompt_match_mode = normalize_prompt_match_mode(prompt_match_mode)
        needs_prompt_post_filter = bool(prompt_terms) and normalized_prompt_match_mode == PROMPT_MATCH_MODE_EXACT
        needs_post_filter = needs_prompt_post_filter or bool(loras)
        select_cols = "i.id, i.prompt, i.loras" if needs_post_filter else "i.id"
        query = _build_base_query(sort_by, select_cols)

        conditions: List[str] = []
        params: List[Any] = []

        # Apply tag filter (JOIN)
        query, params = _apply_tag_filter(query, tags, params, tag_mode)

        # Apply image ID include/exclude filters
        conditions, params = _apply_image_ids_filter(conditions, params, image_ids)
        conditions, params = _apply_excluded_image_ids_filter(conditions, params, excluded_image_ids)

        # Exclude unreadable images from normal library results (unless include_unreadable=True)
        conditions, params = _apply_readable_filter(conditions, params, include_unreadable)

        # Apply generator filter
        conditions, params = _apply_generator_filter(conditions, params, generators)

        # Apply rating filter
        conditions, params = _apply_rating_filter(conditions, params, ratings)

        # Apply checkpoint filter
        conditions, params = _apply_checkpoint_filter(conditions, params, checkpoints)

        # Apply lora filter (SQL-level)
        conditions, params = _apply_lora_filter(conditions, params, loras)

        # Apply search filter
        conditions, params = _apply_search_filter(conditions, params, search_query)

        # Apply prompt terms filter
        conditions, params = _apply_prompt_terms_filter(
            conditions,
            params,
            prompt_terms,
            normalized_prompt_match_mode,
        )

        # Apply dimension filters
        conditions, params = _apply_dimension_filters(
            conditions, params,
            min_width, max_width, min_height, max_height, aspect_ratio
        )

        conditions, params = _apply_aesthetic_filter(
            conditions, params, min_aesthetic, max_aesthetic
        )

        # Apply v3.2.1 color filters
        conditions, params = _apply_color_filter(
            conditions, params,
            brightness_min, brightness_max, color_temperature, brightness_distribution,
        )

        # Apply v3.2.2 per-item exclude filters
        conditions, params = _apply_exclude_tags_filter(conditions, params, exclude_tags)
        conditions, params = _apply_exclude_generators_filter(conditions, params, exclude_generators)
        conditions, params = _apply_exclude_ratings_filter(conditions, params, exclude_ratings)
        conditions, params = _apply_exclude_checkpoints_filter(conditions, params, exclude_checkpoints)
        conditions, params = _apply_exclude_loras_filter(conditions, params, exclude_loras)

        # Apply artist filter (JOIN)
        query, conditions, params = _apply_artist_filter(query, conditions, params, artist)

        # Build WHERE clause
        if conditions:
            query += " WHERE " + " AND ".join(conditions)

        # Get order clause
        order_clause = _get_order_clause(sort_by)

        if needs_post_filter:
            return _fetch_post_filtered_ids(
                conn,
                query,
                params,
                order_clause,
                prompt_terms,
                loras,
                prompt_match_mode=normalized_prompt_match_mode,
                post_offset=normalized_offset,
                limit=result_limit,
                fetch_size=fetch_chunk_size,
            )

        query += f" ORDER BY {order_clause}"

        if result_limit is not None:
            query += " LIMIT ? OFFSET ?"
            params.extend([result_limit, normalized_offset])
        elif normalized_offset > 0:
            query += " LIMIT -1 OFFSET ?"
            params.append(normalized_offset)

        cursor.execute(query, params)

        ids: List[int] = []
        chunk_size = max(1, int(fetch_chunk_size))
        while True:
            rows = cursor.fetchmany(chunk_size)
            if not rows:
                break
            ids.extend(int(row["id"]) for row in rows)
            if result_limit is not None and len(ids) >= result_limit:
                return ids[:result_limit]

        return ids


def iter_filtered_image_id_chunks(
    *,
    chunk_size: int = 2000,
    generators: Optional[List[str]] = None,
    tags: Optional[List[str]] = None,
    tag_mode: str = "and",
    ratings: Optional[List[str]] = None,
    checkpoints: Optional[List[str]] = None,
    loras: Optional[List[str]] = None,
    search_query: Optional[str] = None,
    sort_by: str = "newest",
    min_width: Optional[int] = None,
    max_width: Optional[int] = None,
    min_height: Optional[int] = None,
    max_height: Optional[int] = None,
    prompt_terms: Optional[List[str]] = None,
    prompt_match_mode: str = PROMPT_MATCH_MODE_EXACT,
    aspect_ratio: Optional[str] = None,
    artist: Optional[str] = None,
    image_ids: Optional[List[int]] = None,
    excluded_image_ids: Optional[List[int]] = None,
    min_aesthetic: Optional[float] = None,
    max_aesthetic: Optional[float] = None,
    include_unreadable: bool = False,
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
) -> Iterator[List[int]]:
    """Yield filtered image IDs in bounded chunks without a giant ID list."""
    normalized_chunk_size = max(1, int(chunk_size or 2000))
    offset = 0
    while True:
        chunk = get_filtered_image_ids(
            generators=generators,
            tags=tags,
            tag_mode=tag_mode,
            ratings=ratings,
            checkpoints=checkpoints,
            loras=loras,
            search_query=search_query,
            sort_by=sort_by,
            min_width=min_width,
            max_width=max_width,
            min_height=min_height,
            max_height=max_height,
            prompt_terms=prompt_terms,
            prompt_match_mode=prompt_match_mode,
            aspect_ratio=aspect_ratio,
            artist=artist,
            image_ids=image_ids,
            excluded_image_ids=excluded_image_ids,
            min_aesthetic=min_aesthetic,
            max_aesthetic=max_aesthetic,
            include_unreadable=include_unreadable,
            brightness_min=brightness_min,
            brightness_max=brightness_max,
            color_temperature=color_temperature,
            brightness_distribution=brightness_distribution,
            exclude_tags=exclude_tags,
            exclude_generators=exclude_generators,
            exclude_ratings=exclude_ratings,
            exclude_checkpoints=exclude_checkpoints,
            exclude_loras=exclude_loras,
            fetch_chunk_size=normalized_chunk_size,
            offset=offset,
            limit=normalized_chunk_size,
        )
        if not chunk:
            break
        yield chunk
        if len(chunk) < normalized_chunk_size:
            break
        offset += len(chunk)


def get_images_paginated(
    generators: Optional[List[str]] = None,
    tags: Optional[List[str]] = None,
    tag_mode: str = "and",
    ratings: Optional[List[str]] = None,
    checkpoints: Optional[List[str]] = None,
    loras: Optional[List[str]] = None,
    search_query: Optional[str] = None,
    sort_by: str = "newest",
    limit: int = 100,
    cursor_id: Optional[int] = None,
    cursor_sort_value: Optional[str] = None,
    cursor_is_opaque: bool = False,
    min_width: Optional[int] = None,
    max_width: Optional[int] = None,
    min_height: Optional[int] = None,
    max_height: Optional[int] = None,
    prompt_terms: Optional[List[str]] = None,
    prompt_match_mode: str = PROMPT_MATCH_MODE_EXACT,
    aspect_ratio: Optional[str] = None,
    artist: Optional[str] = None,
    skip_count: bool = False,  # Option to skip expensive COUNT query
    min_aesthetic: Optional[float] = None,
    max_aesthetic: Optional[float] = None,
    include_unreadable: bool = False,
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
) -> Dict[str, Any]:
    """
    Get images with cursor-based pagination for efficient handling of large datasets.

    Newer clients should use the opaque `next_cursor` token returned by the API.
    Legacy callers may still pass the last image ID and rely on best-effort fallback.

    Args:
        generators: Filter by generator type (OR logic)
        tags: Filter by tags (AND logic - image must have ALL tags)
        ratings: Filter by rating tags (OR logic)
        checkpoints: Filter by checkpoint names (OR logic)
        loras: Filter by lora names (OR logic)
        search_query: Search in prompt text
        sort_by: Sorting method
        limit: Number of images to return (default 100)
        cursor_id: Last image ID from previous page (None for first page)
        cursor_sort_value: Stored sort boundary from an opaque cursor token
        cursor_is_opaque: True when cursor_sort_value came from a server-issued opaque token
        min_width, max_width, min_height, max_height: Dimension filters
        prompt_terms: Multi-prompt filter (AND logic)
        aspect_ratio: Filter by aspect ratio
        artist: Filter by artist name
        skip_count: Skip expensive COUNT query (default False for backward compatibility)

    Returns:
        Dictionary with:
        - images: List of image objects
        - next_cursor: Opaque token to use as cursor for next page (None if no more)
        - has_more: Boolean indicating if more pages exist
        - total: Total count matching filters (-1 if skip_count=True)
    """
    with get_db() as conn:
        cursor = conn.cursor()

        # Determine if post-filtering is needed
        normalized_prompt_match_mode = normalize_prompt_match_mode(prompt_match_mode)
        needs_prompt_post_filter = bool(prompt_terms) and normalized_prompt_match_mode == PROMPT_MATCH_MODE_EXACT
        needs_post_filter = needs_prompt_post_filter or bool(loras)
        select_cols = _IMAGE_COLUMNS_FULL if needs_post_filter else _IMAGE_COLUMNS_LIGHTWEIGHT

        # Build base query with sorting subqueries
        query = _build_base_query(sort_by, select_cols)

        # Initialize conditions and params
        conditions: List[str] = []
        params: List[Any] = []

        # Apply tag filter (JOIN)
        query, params = _apply_tag_filter(query, tags, params, tag_mode)

        # Exclude unreadable images from normal library results (unless include_unreadable=True)
        conditions, params = _apply_readable_filter(conditions, params, include_unreadable)

        # Apply generator filter
        conditions, params = _apply_generator_filter(conditions, params, generators)

        # Apply rating filter
        conditions, params = _apply_rating_filter(conditions, params, ratings)

        # Apply checkpoint filter
        conditions, params = _apply_checkpoint_filter(conditions, params, checkpoints)

        # Apply lora filter (SQL-level)
        conditions, params = _apply_lora_filter(conditions, params, loras)

        # Apply search filter
        conditions, params = _apply_search_filter(conditions, params, search_query)

        # Apply prompt terms filter
        conditions, params = _apply_prompt_terms_filter(
            conditions,
            params,
            prompt_terms,
            normalized_prompt_match_mode,
        )

        # Apply dimension filters
        conditions, params = _apply_dimension_filters(
            conditions, params,
            min_width, max_width, min_height, max_height, aspect_ratio
        )

        # Apply aesthetic score filters
        conditions, params = _apply_aesthetic_filter(
            conditions, params, min_aesthetic, max_aesthetic
        )

        # Apply v3.2.1 color filters
        conditions, params = _apply_color_filter(
            conditions, params,
            brightness_min, brightness_max, color_temperature, brightness_distribution,
        )

        # Apply v3.2.2 per-item exclude filters
        conditions, params = _apply_exclude_tags_filter(conditions, params, exclude_tags)
        conditions, params = _apply_exclude_generators_filter(conditions, params, exclude_generators)
        conditions, params = _apply_exclude_ratings_filter(conditions, params, exclude_ratings)
        conditions, params = _apply_exclude_checkpoints_filter(conditions, params, exclude_checkpoints)
        conditions, params = _apply_exclude_loras_filter(conditions, params, exclude_loras)

        # Apply artist filter (JOIN)
        query, conditions, params = _apply_artist_filter(query, conditions, params, artist)

        # Apply cursor condition for pagination
        # Note: Random sort cannot use cursor pagination effectively (each page is truly random)
        # For random sort, we ignore the cursor and return fresh random results
        if cursor_id is not None and sort_by != "random":
            if not _supports_cursor_sort(sort_by):
                raise ValueError(f"Cursor pagination does not support sort_by={sort_by}")
            effective_cursor_sort_value = cursor_sort_value if cursor_is_opaque else None
            if not cursor_is_opaque:
                cursor_sort_row = cursor.execute(
                    f"SELECT {_LIBRARY_ORDER_SQL_UNQUALIFIED} AS sort_value FROM images WHERE id = ?",
                    (cursor_id,),
                ).fetchone()
                effective_cursor_sort_value = cursor_sort_row["sort_value"] if cursor_sort_row else None
            if sort_by == "newest":
                if effective_cursor_sort_value is None:
                    conditions.append("i.id < ?")
                    params.append(cursor_id)
                else:
                    conditions.append(
                        "("
                        "COALESCE(i.library_order_time, i.created_at) < ? "
                        "OR (COALESCE(i.library_order_time, i.created_at) = ? AND i.id < ?)"
                        ")"
                    )
                    params.extend([effective_cursor_sort_value, effective_cursor_sort_value, cursor_id])
            else:
                if effective_cursor_sort_value is None:
                    conditions.append("i.id > ?")
                    params.append(cursor_id)
                else:
                    conditions.append(
                        "("
                        "COALESCE(i.library_order_time, i.created_at) > ? "
                        "OR (COALESCE(i.library_order_time, i.created_at) = ? AND i.id > ?)"
                        ")"
                    )
                    params.extend([effective_cursor_sort_value, effective_cursor_sort_value, cursor_id])
        if conditions:
            query += " WHERE " + " AND ".join(conditions)

        # Get order clause and append to query
        order_clause = _get_order_clause(sort_by)

        if needs_post_filter:
            results = _fetch_post_filtered_page(
                conn,
                query,
                params,
                order_clause,
                prompt_terms,
                loras,
                prompt_match_mode=normalized_prompt_match_mode,
                post_offset=0,
                limit=limit + 1,
            )
        else:
            # Fetch one extra to check if there are more pages
            query += f" ORDER BY {order_clause} LIMIT ?"
            params.append(limit + 1)
            cursor.execute(query, params)
            rows = cursor.fetchall()
            results = _rows_to_dicts(rows)

        # Check if there are more results
        has_more = len(results) > limit
        if has_more:
            results = results[:limit]  # Remove the extra item

        # Get total count for the filter combination
        # Performance optimization: skip expensive COUNT query when not needed
        # Cursor pagination doesn't need total count for navigation
        effective_skip_count = skip_count or (cursor_id is not None)
        if effective_skip_count:
            total_count = -1  # Indicate count was skipped
        else:
            total_count = _get_filtered_count(
                conn, generators, tags, tag_mode, ratings, checkpoints, loras,
                search_query, prompt_terms, artist, min_width, max_width,
                min_height, max_height, aspect_ratio, include_unreadable,
                min_aesthetic, max_aesthetic,
                prompt_match_mode=normalized_prompt_match_mode,
            )

        # Determine next cursor from the last row returned in this page
        # For random sort, cursor is None since pagination doesn't work with random
        next_cursor = None
        if has_more and results and sort_by != "random":
            next_cursor = encode_image_cursor_from_image(results[-1])

        return {
            "images": results,
            "next_cursor": next_cursor,
            "has_more": has_more,
            "total": total_count
        }


def _get_filtered_count(
    conn,
    generators: Optional[List[str]] = None,
    tags: Optional[List[str]] = None,
    tag_mode: str = "and",
    ratings: Optional[List[str]] = None,
    checkpoints: Optional[List[str]] = None,
    loras: Optional[List[str]] = None,
    search_query: Optional[str] = None,
    prompt_terms: Optional[List[str]] = None,
    artist: Optional[str] = None,
    min_width: Optional[int] = None,
    max_width: Optional[int] = None,
    min_height: Optional[int] = None,
    max_height: Optional[int] = None,
    aspect_ratio: Optional[str] = None,
    include_unreadable: bool = False,
    min_aesthetic: Optional[float] = None,
    max_aesthetic: Optional[float] = None,
    prompt_match_mode: str = PROMPT_MATCH_MODE_EXACT,
) -> int:
    """Get total count for filtered images.

    Uses simplified query for performance on large datasets.
    """
    cursor = conn.cursor()

    query = "SELECT COUNT(DISTINCT i.id) FROM images i"
    conditions: List[str] = []
    params: List[Any] = []

    # Apply tag filter (JOIN)
    query, params = _apply_tag_filter(query, tags, params, tag_mode)

    # Exclude unreadable images from normal library results
    conditions, params = _apply_readable_filter(conditions, params, include_unreadable)

    # Apply generator filter
    conditions, params = _apply_generator_filter(conditions, params, generators)

    # Apply rating filter
    conditions, params = _apply_rating_filter(conditions, params, ratings)

    # Apply checkpoint filter
    conditions, params = _apply_checkpoint_filter(conditions, params, checkpoints)

    # Apply lora filter (SQL-level)
    conditions, params = _apply_lora_filter(conditions, params, loras)

    # Apply search filter
    conditions, params = _apply_search_filter(conditions, params, search_query)

    # Apply prompt terms filter
    conditions, params = _apply_prompt_terms_filter(
        conditions,
        params,
        prompt_terms,
        prompt_match_mode,
    )

    # Apply dimension filters
    conditions, params = _apply_dimension_filters(
        conditions, params,
        min_width, max_width, min_height, max_height, aspect_ratio
    )

    # Apply aesthetic score filters
    conditions, params = _apply_aesthetic_filter(
        conditions, params, min_aesthetic, max_aesthetic
    )

    # Apply artist filter (JOIN)
    query, conditions, params = _apply_artist_filter(query, conditions, params, artist)

    if conditions:
        query += " WHERE " + " AND ".join(conditions)

    cursor.execute(query, params)
    result = cursor.fetchone()
    return result[0] if result else 0


def get_image_by_id(image_id: int) -> Optional[Dict[str, Any]]:
    """Get a single image by ID."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            f"SELECT {_IMAGE_COLUMNS_BARE} FROM images WHERE id = ?",
            (image_id,),
        )
        row = cursor.fetchone()
        return _row_to_dict(row) if row else None


def update_image_caption(image_id: int, caption: str) -> None:
    """Update the ai_caption field for an image."""
    with get_db() as conn:
        conn.execute(
            "UPDATE images SET ai_caption = ? WHERE id = ?",
            (caption, image_id),
        )


def update_image_colors(image_id: int, color_data: Dict[str, Any]) -> None:
    """Update color analysis columns for an image (v3.2.1).

    color_data should match the keys returned by color_analyzer.analyze_image_colors():
      dominant_colors, avg_brightness, color_temperature, color_saturation,
      brightness_histogram, brightness_skew, brightness_distribution.
    """
    if not color_data:
        return
    with get_db() as conn:
        conn.execute(
            """
            UPDATE images
            SET dominant_colors = ?,
                avg_brightness = ?,
                color_temperature = ?,
                color_saturation = ?,
                brightness_histogram = ?,
                brightness_skew = ?,
                brightness_distribution = ?
            WHERE id = ?
            """,
            (
                color_data.get("dominant_colors"),
                color_data.get("avg_brightness"),
                color_data.get("color_temperature"),
                color_data.get("color_saturation"),
                color_data.get("brightness_histogram"),
                color_data.get("brightness_skew"),
                color_data.get("brightness_distribution"),
                image_id,
            ),
        )


def get_images_missing_color_data(limit: int = 100) -> List[Dict[str, Any]]:
    """Find images that haven't had color analysis run yet (for lazy backfill)."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT id, path FROM images
            WHERE avg_brightness IS NULL AND is_readable = 1
            LIMIT ?
            """,
            (limit,),
        )
        return [{"id": row[0], "path": row[1]} for row in cursor.fetchall()]


def count_images_missing_color_data() -> int:
    """Count images still needing color analysis. Uses indexed column; constant memory."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT COUNT(*) FROM images WHERE avg_brightness IS NULL AND is_readable = 1"
        )
        row = cursor.fetchone()
        return int(row[0] if row else 0)


def get_image_by_path(path: str) -> Optional[Dict[str, Any]]:
    """Get a single image by any equivalent indexed path representation."""
    if not path:
        return None

    candidates = build_indexed_image_lookup_candidates(path)
    if not candidates:
        return None

    with get_db() as conn:
        cursor = conn.cursor()
        clause, params = _path_query_match_clause(candidates)
        cursor.execute(
            f"SELECT {_IMAGE_COLUMNS_BARE} FROM images WHERE {clause}",
            params,
        )
        rows = cursor.fetchall()

    rows_by_path = {row["path"]: row for row in rows}
    rows_by_match_key = {
        indexed_image_path_match_key(row["path"]): row
        for row in rows
    }
    for candidate in candidates:
        row = rows_by_path.get(candidate)
        if not row:
            row = rows_by_match_key.get(indexed_image_path_match_key(candidate))
        if row:
            return _row_to_dict(row)
    return None


def get_images_by_ids(image_ids: List[int]) -> Dict[int, Dict[str, Any]]:
    """Get multiple images by IDs in a single query (avoids N+1).

    Chunks into batches of 500 to stay under SQLite's 999-variable limit.

    Args:
        image_ids: List of image IDs to fetch

    Returns:
        Dictionary mapping image_id -> image data
    """
    if not image_ids:
        return {}

    result: Dict[int, Dict[str, Any]] = {}
    batch_size = 500

    with get_db() as conn:
        cursor = conn.cursor()
        for i in range(0, len(image_ids), batch_size):
            batch = image_ids[i:i + batch_size]
            placeholders = ",".join("?" * len(batch))
            cursor.execute(
                f"SELECT {_IMAGE_COLUMNS_BARE} FROM images WHERE id IN ({placeholders})",
                batch
            )
            for row in cursor.fetchall():
                result[row['id']] = _row_to_dict(row)

    return result


def get_image_tags(image_id: int) -> List[Dict[str, Any]]:
    """Get all tags for an image."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT tag, confidence FROM tags WHERE image_id = ? ORDER BY confidence DESC",
            (image_id,)
        )
        return _rows_to_dicts(cursor.fetchall())


def _copy_image_derived_state(cursor: sqlite3.Cursor, source_image_id: int, target_image_id: int) -> None:
    """Copy cached derived fields that remain valid for file duplicates using an existing transaction."""
    if source_image_id == target_image_id:
        return

    source_row = cursor.execute(
        """
        SELECT tagged_at, ai_caption, aesthetic_score, embedding, content_fingerprint
        FROM images
        WHERE id = ?
        """,
        (source_image_id,),
    ).fetchone()
    if source_row:
        cursor.execute(
            """
            UPDATE images
            SET tagged_at = ?,
                ai_caption = ?,
                aesthetic_score = ?,
                embedding = ?,
                content_fingerprint = COALESCE(?, content_fingerprint)
            WHERE id = ?
            """,
            (
                source_row["tagged_at"],
                source_row["ai_caption"],
                source_row["aesthetic_score"],
                source_row["embedding"],
                source_row["content_fingerprint"],
                target_image_id,
            ),
        )

    artist_row = cursor.execute(
        """
        SELECT artist, confidence, top_predictions, identified_at
        FROM artist_predictions
        WHERE image_id = ?
        """,
        (source_image_id,),
    ).fetchone()
    if artist_row:
        cursor.execute(
            """
            INSERT INTO artist_predictions (
                image_id, artist, confidence, top_predictions, identified_at
            )
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(image_id) DO UPDATE SET
                artist = excluded.artist,
                confidence = excluded.confidence,
                top_predictions = excluded.top_predictions,
                identified_at = excluded.identified_at
            """,
            (
                target_image_id,
                artist_row["artist"],
                artist_row["confidence"],
                artist_row["top_predictions"],
                artist_row["identified_at"],
            ),
        )


def copy_image_derived_state(source_image_id: int, target_image_id: int) -> None:
    """Copy cached derived fields that remain valid for file duplicates."""
    with get_db() as conn:
        _copy_image_derived_state(conn.cursor(), source_image_id, target_image_id)


def add_copied_image_with_state(
    source_image_id: int,
    copied_record: Dict[str, Any],
    source_tags: Optional[List[Dict[str, Any]]] = None,
) -> int:
    """Insert a copied image row plus copied tags/derived state in one transaction."""
    with get_db() as conn:
        cursor = conn.cursor()
        copied_image_id, _ = _upsert_image_record(cursor, copied_record)
        cursor.execute("DELETE FROM tags WHERE image_id = ?", (copied_image_id,))
        cursor.execute("DELETE FROM artist_predictions WHERE image_id = ?", (copied_image_id,))
        tags_to_copy = source_tags
        if tags_to_copy is None:
            cursor.execute(
                "SELECT tag, confidence FROM tags WHERE image_id = ? ORDER BY confidence DESC",
                (source_image_id,),
            )
            tags_to_copy = _rows_to_dicts(cursor.fetchall())

        tag_values = [
            (copied_image_id, tag_data.get("tag", ""), tag_data.get("confidence", 1.0))
            for tag_data in tags_to_copy
            if tag_data.get("tag")
        ]
        if tag_values:
            cursor.executemany(
                "INSERT INTO tags (image_id, tag, confidence) VALUES (?, ?, ?)",
                tag_values,
            )
            _mark_image_tagged(cursor, copied_image_id, copied_record.get("content_fingerprint"))

        _copy_image_derived_state(cursor, source_image_id, copied_image_id)

    _invalidate_tags_cache()
    return copied_image_id


def get_image_tags_map(image_ids: List[int]) -> Dict[int, List[Dict[str, Any]]]:
    """Get tags for multiple images with batched queries."""
    if not image_ids:
        return {}

    result: Dict[int, List[Dict[str, Any]]] = {}
    batch_size = 500

    with get_db() as conn:
        cursor = conn.cursor()
        for i in range(0, len(image_ids), batch_size):
            batch = image_ids[i:i + batch_size]
            placeholders = ",".join("?" * len(batch))
            cursor.execute(
                f"""
                SELECT image_id, tag, confidence
                FROM tags
                WHERE image_id IN ({placeholders})
                ORDER BY image_id ASC, confidence DESC, tag ASC
                """,
                batch,
            )
            for row in cursor.fetchall():
                result.setdefault(row["image_id"], []).append(
                    {"tag": row["tag"], "confidence": row["confidence"]}
                )

    return result


def get_all_tags() -> List[Dict[str, Any]]:
    """Get all unique tags with their counts.

    Uses in-memory caching with TTL to reduce database load.
    Cache is invalidated after 60 seconds or when tags are modified.
    """
    current_time = time.time()

    # Check cache
    with _tags_cache_lock:
        if db_core._tags_cache_data is not None and (current_time - db_core._tags_cache_timestamp) < _TAGS_CACHE_TTL:
            return db_core._tags_cache_data

    # Fetch from database
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT tag, COUNT(*) as count
            FROM tags
            GROUP BY tag
            ORDER BY count DESC
        """)
        result = _rows_to_dicts(cursor.fetchall())

    # Update cache
    with _tags_cache_lock:
        db_core._tags_cache_data = result
        db_core._tags_cache_timestamp = current_time

    return result


def _facet_search_rank_params(normalized_query: str) -> List[str]:
    escaped = escape_like_pattern(normalized_query)
    return [
        normalized_query,
        f"{escaped}%",
        f"% {escaped}%",
        f"%({escaped}%",
        f"%[{escaped}%",
    ]


def _facet_search_rank_sql(value_expr: str) -> str:
    return f"""
        CASE
            WHEN {value_expr} = ? THEN 0
            WHEN {value_expr} LIKE ? ESCAPE '\\' THEN 1
            WHEN {value_expr} LIKE ? ESCAPE '\\'
              OR {value_expr} LIKE ? ESCAPE '\\'
              OR {value_expr} LIKE ? ESCAPE '\\' THEN 2
            ELSE 3
        END
    """


def _append_optional_limit(query: str, params: List[Any], limit: Optional[int]) -> Tuple[str, List[Any]]:
    if limit is None:
        return query, params
    query += " LIMIT ?"
    params.append(max(0, int(limit)))
    return query, params


def search_tags(
    search_query: Optional[str],
    *,
    sort_by: str = "frequency",
    limit: Optional[int] = None,
) -> Dict[str, Any]:
    """Search all unique tags with normalized substring matching.

    Unlike `get_all_tags()[:N]`, this searches the full tag table first and only
    applies an optional caller-requested display limit after matching.
    """
    normalized_query = normalize_prompt_token(search_query or "")
    if not normalized_query:
        tags = get_all_tags()
        if sort_by == "alphabetical":
            tags = sorted(tags, key=lambda item: item["tag"].lower())
        return {
            "tags": tags if limit is None else tags[:max(0, int(limit))],
            "total": len(tags),
            "query": normalized_query,
            "sort": sort_by,
        }

    value_expr = "REPLACE(LOWER(tag), '_', ' ')"
    rank_sql = _facet_search_rank_sql(value_expr)
    match_pattern = f"%{escape_like_pattern(normalized_query)}%"
    order_tail = "tag COLLATE NOCASE ASC" if sort_by == "alphabetical" else "count DESC, tag COLLATE NOCASE ASC"
    params: List[Any] = [
        *_facet_search_rank_params(normalized_query),
        match_pattern,
    ]

    with get_db() as conn:
        cursor = conn.cursor()
        total_row = cursor.execute(
            f"""
            SELECT COUNT(*) FROM (
                SELECT tag
                FROM tags
                WHERE {value_expr} LIKE ? ESCAPE '\\'
                GROUP BY tag
            )
            """,
            (match_pattern,),
        ).fetchone()
        total = int(total_row[0] or 0) if total_row else 0

        query = f"""
            SELECT tag, COUNT(*) AS count, {rank_sql} AS relevance
            FROM tags
            WHERE {value_expr} LIKE ? ESCAPE '\\'
            GROUP BY tag
            ORDER BY relevance ASC, {order_tail}
        """
        query, params = _append_optional_limit(query, params, limit)
        cursor.execute(query, params)
        tags = [{"tag": row["tag"], "count": row["count"]} for row in cursor.fetchall()]

    return {"tags": tags, "total": total, "query": normalized_query, "sort": sort_by}


def _query_indexed_facet(
    *,
    table: str,
    value_column: str,
    output_key: str,
    limit: Optional[int] = None,
    search_query: Optional[str] = None,
) -> Dict[str, Any]:
    # Whitelist guard: this helper composes table/column names into raw SQL via f-strings,
    # which is safe today because all callers pass hardcoded constants. The assertion
    # makes that contract explicit so a future caller cannot accidentally route
    # user-supplied identifiers into the query.
    _ALLOWED_FACET_QUERIES = {
        ("image_prompt_tokens", "token"),
        ("image_loras", "lora_name"),
    }
    if (table, value_column) not in _ALLOWED_FACET_QUERIES:
        raise ValueError(
            f"_query_indexed_facet refusing unknown table/column pair: ({table!r}, {value_column!r})"
        )

    normalized_query = normalize_prompt_token(search_query or "")
    value_expr = f"REPLACE(LOWER({value_column}), '_', ' ')"
    where_clause = ""
    where_params: list[Any] = []
    rank_select = ""
    rank_order = ""

    if normalized_query:
        where_clause = f"WHERE {value_expr} LIKE ? ESCAPE '\\'"
        where_params.append(f"%{escape_like_pattern(normalized_query)}%")
        rank_select = f", {_facet_search_rank_sql(value_expr)} AS relevance"
        rank_order = "relevance ASC, "

    with get_db() as conn:
        cursor = conn.cursor()
        total_row = cursor.execute(
            f"SELECT COUNT(DISTINCT {value_column}) FROM {table} {where_clause}",
            where_params,
        ).fetchone()
        total = int(total_row[0] or 0) if total_row else 0

        query = f"""
            SELECT {value_column} AS {output_key}, COUNT(*) AS count{rank_select}
            FROM {table}
            {where_clause}
            GROUP BY {value_column}
            ORDER BY {rank_order}count DESC, {value_column} COLLATE NOCASE ASC
        """
        params: list[Any] = []
        if normalized_query:
            params.extend(_facet_search_rank_params(normalized_query))
        params.extend(where_params)
        query, params = _append_optional_limit(query, params, limit)

        cursor.execute(query, params)
        rows = _rows_to_dicts(cursor.fetchall())

    return {output_key + "s": rows, "total": total, "query": normalized_query}


def get_all_prompt_tokens(*, limit: Optional[int] = None, search_query: Optional[str] = None) -> Dict[str, Any]:
    """Get unique normalized prompt tokens from the indexed prompt-token table."""
    return _query_indexed_facet(
        table="image_prompt_tokens",
        value_column="token",
        output_key="prompt",
        limit=limit,
        search_query=search_query,
    )


def get_all_loras(*, limit: Optional[int] = None, search_query: Optional[str] = None) -> Dict[str, Any]:
    """Get unique normalized LoRAs from the indexed image_loras table."""
    return _query_indexed_facet(
        table="image_loras",
        value_column="lora_name",
        output_key="lora",
        limit=limit,
        search_query=search_query,
    )


def get_all_generators() -> List[Dict[str, Any]]:
    """Get all generators with their counts (cached with 60s TTL)."""
    now = time.time()
    with _generators_cache_lock:
        if db_core._generators_cache_data is not None and (now - db_core._generators_cache_timestamp) < _TAGS_CACHE_TTL:
            return db_core._generators_cache_data
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT generator, COUNT(*) as count
            FROM images
            WHERE COALESCE(is_readable, 1) = 1
            GROUP BY generator
            ORDER BY count DESC
        """)
        result = _rows_to_dicts(cursor.fetchall())
    with _generators_cache_lock:
        db_core._generators_cache_data = result
        db_core._generators_cache_timestamp = time.time()
    return result


def get_metadata_status_counts() -> Dict[str, int]:
    """Get image counts grouped by metadata parsing status."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT LOWER(COALESCE(metadata_status, 'complete')) AS status, COUNT(*) AS count
            FROM images
            WHERE COALESCE(is_readable, 1) = 1
            GROUP BY LOWER(COALESCE(metadata_status, 'complete'))
            """
        )
        counts: Dict[str, int] = {}
        for row in cursor.fetchall():
            status = str(row["status"] or "complete").strip().lower() or "complete"
            counts[status] = int(row["count"] or 0)
        return counts


def _library_health_percent(value: float, total: int) -> float:
    if total <= 0:
        return 0.0
    return round((float(value) / float(total)) * 100.0, 2)


def get_library_health_report(*, sample_limit: int = 8) -> Dict[str, Any]:
    """Return a read-only quality audit for the indexed image library."""
    bounded_sample_limit = max(1, min(int(sample_limit or 8), 25))

    with get_db() as conn:
        cursor = conn.cursor()
        summary_row = cursor.execute(
            """
            SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN COALESCE(is_readable, 1) = 0 THEN 1 ELSE 0 END) AS unreadable,
                SUM(CASE WHEN COALESCE(is_readable, 1) = 1 THEN 1 ELSE 0 END) AS readable,
                SUM(CASE WHEN COALESCE(is_readable, 1) = 1 AND (prompt IS NULL OR TRIM(prompt) = '') THEN 1 ELSE 0 END) AS missing_prompt,
                SUM(CASE WHEN COALESCE(is_readable, 1) = 1 AND (negative_prompt IS NULL OR TRIM(negative_prompt) = '') THEN 1 ELSE 0 END) AS missing_negative_prompt,
                SUM(CASE WHEN COALESCE(is_readable, 1) = 1 AND (checkpoint_normalized IS NULL OR TRIM(checkpoint_normalized) = '') THEN 1 ELSE 0 END) AS missing_checkpoint,
                SUM(CASE WHEN COALESCE(is_readable, 1) = 1 AND (width IS NULL OR height IS NULL OR width <= 0 OR height <= 0) THEN 1 ELSE 0 END) AS missing_dimensions,
                SUM(CASE WHEN COALESCE(is_readable, 1) = 1 AND (file_size IS NULL OR file_size <= 0) THEN 1 ELSE 0 END) AS missing_file_size,
                SUM(CASE WHEN COALESCE(is_readable, 1) = 1 AND tagged_at IS NULL THEN 1 ELSE 0 END) AS untagged,
                SUM(CASE WHEN COALESCE(is_readable, 1) = 1 AND embedding IS NULL THEN 1 ELSE 0 END) AS missing_embedding,
                SUM(CASE WHEN COALESCE(is_readable, 1) = 1 AND aesthetic_score IS NULL THEN 1 ELSE 0 END) AS missing_aesthetic,
                SUM(CASE WHEN LOWER(COALESCE(metadata_status, 'complete')) = 'pending' THEN 1 ELSE 0 END) AS metadata_pending,
                SUM(CASE WHEN LOWER(COALESCE(metadata_status, 'complete')) = 'error' THEN 1 ELSE 0 END) AS metadata_error,
                SUM(CASE WHEN COALESCE(is_readable, 1) = 1 AND generator = 'unknown' THEN 1 ELSE 0 END) AS unknown_generator
            FROM images
            """
        ).fetchone()

        total = int(summary_row["total"] or 0) if summary_row else 0
        readable = int(summary_row["readable"] or 0) if summary_row else 0

        issue_counts: Dict[str, int] = {
            "unreadable": int(summary_row["unreadable"] or 0) if summary_row else 0,
            "missing_prompt": int(summary_row["missing_prompt"] or 0) if summary_row else 0,
            "missing_negative_prompt": int(summary_row["missing_negative_prompt"] or 0) if summary_row else 0,
            "missing_checkpoint": int(summary_row["missing_checkpoint"] or 0) if summary_row else 0,
            "missing_dimensions": int(summary_row["missing_dimensions"] or 0) if summary_row else 0,
            "missing_file_size": int(summary_row["missing_file_size"] or 0) if summary_row else 0,
            "untagged": int(summary_row["untagged"] or 0) if summary_row else 0,
            "missing_embedding": int(summary_row["missing_embedding"] or 0) if summary_row else 0,
            "missing_aesthetic": int(summary_row["missing_aesthetic"] or 0) if summary_row else 0,
            "metadata_pending": int(summary_row["metadata_pending"] or 0) if summary_row else 0,
            "metadata_error": int(summary_row["metadata_error"] or 0) if summary_row else 0,
            "unknown_generator": int(summary_row["unknown_generator"] or 0) if summary_row else 0,
        }

        duplicate_filename_rows = cursor.execute(
            """
            SELECT filename, COUNT(*) AS count, SUM(COALESCE(file_size, 0)) AS total_size
            FROM images
            WHERE filename IS NOT NULL AND TRIM(filename) != ''
            GROUP BY LOWER(filename)
            HAVING COUNT(*) > 1
            ORDER BY count DESC, filename COLLATE NOCASE ASC
            LIMIT ?
            """,
            (bounded_sample_limit,),
        ).fetchall()
        duplicate_filenames = [dict(row) for row in duplicate_filename_rows]

        duplicate_group_row = cursor.execute(
            """
            SELECT COUNT(*) AS groups_count, COALESCE(SUM(count), 0) AS image_count
            FROM (
                SELECT COUNT(*) AS count
                FROM images
                WHERE filename IS NOT NULL AND TRIM(filename) != ''
                GROUP BY LOWER(filename)
                HAVING COUNT(*) > 1
            ) grouped
            """
        ).fetchone()
        duplicate_filename_groups = int(duplicate_group_row["groups_count"] or 0) if duplicate_group_row else 0
        duplicate_filename_images = int(duplicate_group_row["image_count"] or 0) if duplicate_group_row else 0

        oversized_rows = cursor.execute(
            """
            SELECT id, filename, path, file_size, width, height, generator, checkpoint_normalized
            FROM images
            WHERE COALESCE(is_readable, 1) = 1 AND COALESCE(file_size, 0) > 0
            ORDER BY file_size DESC
            LIMIT ?
            """,
            (bounded_sample_limit,),
        ).fetchall()
        largest_images = [dict(row) for row in oversized_rows]

        folder_rows = cursor.execute(
            """
            SELECT folder,
                   COUNT(*) AS count,
                   SUM(COALESCE(file_size, 0)) AS total_size,
                   SUM(CASE WHEN COALESCE(is_readable, 1) = 1 AND (prompt IS NULL OR TRIM(prompt) = '') THEN 1 ELSE 0 END) AS missing_prompt,
                   SUM(CASE WHEN COALESCE(is_readable, 1) = 1 AND tagged_at IS NULL THEN 1 ELSE 0 END) AS untagged,
                   SUM(CASE WHEN COALESCE(is_readable, 1) = 0 THEN 1 ELSE 0 END) AS unreadable
            FROM (
                SELECT *,
                       CASE
                           WHEN filename IS NULL OR TRIM(filename) = '' THEN ''
                           WHEN LENGTH(REPLACE(path, '\\', '/')) <= LENGTH(filename) THEN ''
                           WHEN LOWER(SUBSTR(REPLACE(path, '\\', '/'), -LENGTH(filename))) != LOWER(filename) THEN ''
                           ELSE RTRIM(SUBSTR(REPLACE(path, '\\', '/'), 1, LENGTH(REPLACE(path, '\\', '/')) - LENGTH(filename)), '/')
                       END AS folder
                FROM images
            ) foldered
            GROUP BY folder
            ORDER BY count DESC, folder COLLATE NOCASE ASC
            LIMIT ?
            """,
            (bounded_sample_limit,),
        ).fetchall()
        top_folders = [dict(row) for row in folder_rows]

        issue_sample_rows = cursor.execute(
            """
            SELECT id, filename, path, generator, metadata_status, read_error,
                   prompt, checkpoint_normalized, width, height, file_size, tagged_at
            FROM images
            WHERE COALESCE(is_readable, 1) = 0
               OR LOWER(COALESCE(metadata_status, 'complete')) IN ('pending', 'error')
               OR (COALESCE(is_readable, 1) = 1 AND (prompt IS NULL OR TRIM(prompt) = ''))
               OR (COALESCE(is_readable, 1) = 1 AND (checkpoint_normalized IS NULL OR TRIM(checkpoint_normalized) = ''))
               OR (COALESCE(is_readable, 1) = 1 AND (width IS NULL OR height IS NULL OR width <= 0 OR height <= 0))
               OR (COALESCE(is_readable, 1) = 1 AND tagged_at IS NULL)
            ORDER BY
                CASE
                    WHEN COALESCE(is_readable, 1) = 0 THEN 0
                    WHEN LOWER(COALESCE(metadata_status, 'complete')) = 'error' THEN 1
                    WHEN LOWER(COALESCE(metadata_status, 'complete')) = 'pending' THEN 2
                    WHEN prompt IS NULL OR TRIM(prompt) = '' THEN 3
                    WHEN checkpoint_normalized IS NULL OR TRIM(checkpoint_normalized) = '' THEN 4
                    WHEN width IS NULL OR height IS NULL OR width <= 0 OR height <= 0 THEN 5
                    WHEN tagged_at IS NULL THEN 6
                    ELSE 7
                END,
                id ASC
            LIMIT ?
            """,
            (bounded_sample_limit,),
        ).fetchall()
        issue_samples = [dict(row) for row in issue_sample_rows]

    metadata_ready = max(readable - issue_counts["missing_prompt"] - issue_counts["missing_dimensions"], 0)
    actionable_count = (
        issue_counts["unreadable"]
        + issue_counts["missing_prompt"]
        + issue_counts["missing_checkpoint"]
        + issue_counts["missing_dimensions"]
        + issue_counts["untagged"]
        + duplicate_filename_images
    )
    quality_score = 100.0
    if total > 0:
        weighted_penalty = (
            issue_counts["unreadable"] * 2.0
            + issue_counts["metadata_error"] * 2.0
            + issue_counts["missing_prompt"] * 1.4
            + issue_counts["missing_dimensions"] * 1.3
            + issue_counts["missing_checkpoint"] * 0.8
            + issue_counts["unknown_generator"] * 0.6
            + min(issue_counts["untagged"], total) * 0.5
            + min(duplicate_filename_images, total) * 0.5
        )
        average_penalty = weighted_penalty / float(total)
        quality_score = max(0.0, round(100.0 - min(90.0, average_penalty * 22.0), 1))

    return {
        "summary": {
            "total_images": total,
            "readable_images": readable,
            "metadata_ready": metadata_ready,
            "metadata_ready_percent": _library_health_percent(metadata_ready, readable),
            "tagged_percent": _library_health_percent(readable - issue_counts["untagged"], readable),
            "embedding_percent": _library_health_percent(readable - issue_counts["missing_embedding"], readable),
            "aesthetic_percent": _library_health_percent(readable - issue_counts["missing_aesthetic"], readable),
            "quality_score": quality_score,
            "actionable_count": actionable_count,
        },
        "issue_counts": issue_counts,
        "duplicate_filenames": {
            "groups": duplicate_filename_groups,
            "images": duplicate_filename_images,
            "samples": duplicate_filenames,
        },
        "largest_images": largest_images,
        "top_folders": top_folders,
        "issue_samples": issue_samples,
        "recommendations": _build_library_health_recommendations(
            total=total,
            issue_counts=issue_counts,
            duplicate_filename_images=duplicate_filename_images,
        ),
    }


def _build_library_health_recommendations(
    *,
    total: int,
    issue_counts: Dict[str, int],
    duplicate_filename_images: int,
) -> List[Dict[str, Any]]:
    recommendations: List[Dict[str, Any]] = []
    if total <= 0:
        return recommendations

    if issue_counts.get("metadata_pending", 0) > 0:
        recommendations.append({
            "kind": "metadata_pending",
            "severity": "info",
            "count": issue_counts["metadata_pending"],
        })
    if issue_counts.get("unreadable", 0) > 0 or issue_counts.get("metadata_error", 0) > 0:
        recommendations.append({
            "kind": "reparse_or_reconnect",
            "severity": "warning",
            "count": issue_counts.get("unreadable", 0) + issue_counts.get("metadata_error", 0),
        })
    if issue_counts.get("missing_prompt", 0) > 0:
        recommendations.append({
            "kind": "missing_prompt",
            "severity": "warning" if _library_health_percent(issue_counts["missing_prompt"], total) >= 10 else "info",
            "count": issue_counts["missing_prompt"],
        })
    if issue_counts.get("missing_checkpoint", 0) > 0:
        recommendations.append({
            "kind": "missing_checkpoint",
            "severity": "info",
            "count": issue_counts["missing_checkpoint"],
        })
    if issue_counts.get("untagged", 0) > 0:
        recommendations.append({
            "kind": "untagged",
            "severity": "info",
            "count": issue_counts["untagged"],
        })
    if duplicate_filename_images > 0:
        recommendations.append({
            "kind": "duplicate_filenames",
            "severity": "info",
            "count": duplicate_filename_images,
        })
    return recommendations


def get_all_checkpoints(
    *,
    limit: Optional[int] = None,
    search_query: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Get normalized checkpoint facets with counts for filtering and analytics."""
    normalized_query = checkpoint_identity_key(search_query or "") or normalize_prompt_token(search_query or "")
    value_expr = "LOWER(checkpoint_normalized)"
    conditions = ["checkpoint_normalized IS NOT NULL", "TRIM(checkpoint_normalized) != ''"]
    where_params: List[Any] = []
    rank_select = ""
    rank_order = ""

    if normalized_query:
        conditions.append(f"{value_expr} LIKE ? ESCAPE '\\'")
        where_params.append(f"%{escape_like_pattern(normalized_query)}%")
        rank_select = f", {_facet_search_rank_sql(value_expr)} AS relevance"
        rank_order = "relevance ASC, "

    where_clause = " AND ".join(conditions)

    with get_db() as conn:
        cursor = conn.cursor()
        query = f"""
            SELECT checkpoint_normalized, COUNT(*) as count{rank_select}
            FROM images
            WHERE {where_clause}
            GROUP BY checkpoint_normalized
            ORDER BY {rank_order}count DESC, checkpoint_normalized COLLATE NOCASE ASC
        """
        params: List[Any] = []
        if normalized_query:
            params.extend(_facet_search_rank_params(normalized_query))
        params.extend(where_params)
        query, params = _append_optional_limit(query, params, limit)
        cursor.execute(query, params)
        return [
            {
                "checkpoint": row["checkpoint_normalized"],
                "checkpoint_normalized": row["checkpoint_normalized"],
                "count": row["count"],
            }
            for row in cursor.fetchall()
        ]


def get_untagged_images(limit: int = 100) -> List[Dict[str, Any]]:
    """Get images that haven't been tagged yet."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            f"SELECT {_IMAGE_COLUMNS_BARE} FROM images WHERE tagged_at IS NULL AND COALESCE(is_readable, 1) = 1 LIMIT ?",
            (limit,)
        )
        return _rows_to_dicts(cursor.fetchall())


def get_all_image_ids() -> List[int]:
    """Return all image IDs (lightweight — no row data loaded).

    Used by the tagging pipeline to avoid loading all image rows into
    memory at once. Callers fetch full rows in small batches.
    """
    image_ids: List[int] = []
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id FROM images WHERE COALESCE(is_readable, 1) = 1 ORDER BY id")
        while True:
            rows = cursor.fetchmany(1000)
            if not rows:
                break
            image_ids.extend(int(row[0]) for row in rows)
    return image_ids


def get_untagged_image_ids() -> List[int]:
    """Return IDs of images that have not been tagged yet.

    Lightweight counterpart to get_untagged_images(); callers fetch
    full rows in small batches to avoid OOM on large libraries.
    """
    image_ids: List[int] = []
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id FROM images WHERE tagged_at IS NULL AND COALESCE(is_readable, 1) = 1 ORDER BY id")
        while True:
            rows = cursor.fetchmany(1000)
            if not rows:
                break
            image_ids.extend(int(row[0]) for row in rows)
    return image_ids


def count_all_image_ids() -> int:
    """Count readable image IDs without materializing them."""
    with get_db() as conn:
        row = conn.execute(
            "SELECT COUNT(*) FROM images WHERE COALESCE(is_readable, 1) = 1"
        ).fetchone()
        return int(row[0] or 0) if row else 0


def count_untagged_image_ids() -> int:
    """Count readable untagged image IDs without materializing them."""
    with get_db() as conn:
        row = conn.execute(
            "SELECT COUNT(*) FROM images WHERE tagged_at IS NULL AND COALESCE(is_readable, 1) = 1"
        ).fetchone()
        return int(row[0] or 0) if row else 0


def iter_all_image_id_chunks(chunk_size: int = 1000) -> Iterator[List[int]]:
    """Yield readable image IDs in database order using cursor.fetchmany()."""
    normalized_chunk_size = max(1, int(chunk_size or 1000))
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id FROM images WHERE COALESCE(is_readable, 1) = 1 ORDER BY id")
        while True:
            rows = cursor.fetchmany(normalized_chunk_size)
            if not rows:
                break
            yield [int(row[0]) for row in rows]


def iter_untagged_image_id_chunks(chunk_size: int = 1000) -> Iterator[List[int]]:
    """Yield readable untagged image IDs in database order using cursor.fetchmany()."""
    normalized_chunk_size = max(1, int(chunk_size or 1000))
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id FROM images WHERE tagged_at IS NULL AND COALESCE(is_readable, 1) = 1 ORDER BY id")
        while True:
            rows = cursor.fetchmany(normalized_chunk_size)
            if not rows:
                break
            yield [int(row[0]) for row in rows]


def update_image_path(image_id: int, new_path: str):
    """Update the path of an image after a successful move.

    Gallery requests can race with a move between the filesystem rename and
    this database update. If that stale read marked the old path as missing,
    the successful move must restore the row so the image does not disappear.
    """
    with get_db() as conn:
        cursor = conn.cursor()
        normalized_path = _normalize_indexed_image_path(new_path)
        new_filename = os.path.basename(normalized_path)
        cursor.execute(
            """
            UPDATE images
            SET path = ?,
                filename = ?,
                is_readable = CASE
                    WHEN TRIM(COALESCE(read_error, '')) = ''
                         OR LOWER(COALESCE(read_error, '')) LIKE '%not found%'
                         OR LOWER(COALESCE(read_error, '')) LIKE '%missing%'
                    THEN 1
                    ELSE is_readable
                END,
                read_error = CASE
                    WHEN TRIM(COALESCE(read_error, '')) = ''
                         OR LOWER(COALESCE(read_error, '')) LIKE '%not found%'
                         OR LOWER(COALESCE(read_error, '')) LIKE '%missing%'
                    THEN NULL
                    ELSE read_error
                END,
                metadata_status = CASE
                    WHEN TRIM(COALESCE(read_error, '')) = ''
                         OR LOWER(COALESCE(read_error, '')) LIKE '%not found%'
                         OR LOWER(COALESCE(read_error, '')) LIKE '%missing%'
                    THEN 'complete'
                    ELSE COALESCE(metadata_status, 'complete')
                END,
                indexed_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (normalized_path, new_filename, image_id)
        )


def mark_image_unreadable(image_id: int, read_error: Optional[str]) -> None:
    """Mark an indexed image as unreadable so normal workflows exclude it."""
    with get_db() as conn:
        cursor = conn.cursor()
        _clear_image_derived_state(cursor, image_id)
        cursor.execute(
            """
            UPDATE images
            SET is_readable = 0,
                read_error = ?,
                metadata_status = 'error',
                indexed_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (read_error, image_id),
        )
    _invalidate_tags_cache()


def mark_image_unreadable_by_path(path: str, read_error: Optional[str]) -> None:
    """Mark an existing image row as unreadable based on its file path."""
    candidates = build_indexed_image_lookup_candidates(path)
    if not candidates:
        return

    with get_db() as conn:
        cursor = conn.cursor()
        clause, params = _path_query_match_clause(candidates)
        row = cursor.execute(
            f"SELECT id FROM images WHERE {clause} LIMIT 1",
            params,
        ).fetchone()
        if row:
            _clear_image_derived_state(cursor, row["id"])
        cursor.execute(
            f"""
            UPDATE images
            SET is_readable = 0,
                read_error = ?,
                metadata_status = 'error',
                indexed_at = CURRENT_TIMESTAMP
            WHERE {clause}
            """,
            [read_error, *params],
        )
    _invalidate_tags_cache()


def mark_image_readable(image_id: int) -> None:
    """Restore an image row to readable state after a successful re-parse."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            UPDATE images
            SET is_readable = 1,
                read_error = NULL,
                metadata_status = 'complete',
                indexed_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (image_id,),
        )


def update_image_metadata(
    image_id: int,
    generator: str,
    prompt: Optional[str],
    negative_prompt: Optional[str],
    metadata_json: Optional[str],
    width: Optional[int],
    height: Optional[int],
    file_size: Optional[int],
    checkpoint: Optional[str],
    loras: Optional[List[str]],
    model_hash: Optional[str] = None,
    is_readable: Optional[bool] = None,
    read_error: Optional[str] = None,
    source_mtime_ns: Optional[int] = None,
    source_size: Optional[int] = None,
    metadata_status: Optional[str] = None,
    content_fingerprint: Optional[str] = None,
    preserve_derived_state: bool = False,
):
    """Update parsed metadata fields for an existing image without replacing the row."""
    metadata_json = _compact_persisted_metadata_json(metadata_json)
    with get_db() as conn:
        cursor = conn.cursor()
        serialized_loras = _serialize_loras(loras)
        checkpoint_normalized = normalize_checkpoint_name(checkpoint)
        metadata_status_normalized = str(metadata_status or "").strip().lower()
        existing_row = cursor.execute(
            """
            SELECT id, source_mtime_ns, source_size, content_fingerprint,
                   tagged_at, ai_caption, aesthetic_score,
                   CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END AS has_embedding,
                   EXISTS(SELECT 1 FROM artist_predictions ap WHERE ap.image_id = images.id) AS has_artist_predictions
            FROM images
            WHERE id = ?
            """,
            (image_id,),
        ).fetchone()
        source_changed = _is_source_fingerprint_changed(
            existing_row,
            {
                "source_mtime_ns": source_mtime_ns,
                "source_size": source_size,
            },
        )
        mark_unreadable = (is_readable is False)
        existing_fingerprint = _normalize_content_fingerprint(_row_value(existing_row, "content_fingerprint"))
        incoming_fingerprint = _normalize_content_fingerprint(content_fingerprint)
        can_preserve_derived_state = bool(
            preserve_derived_state
            and not mark_unreadable
            and metadata_status_normalized == "complete"
            and existing_fingerprint is not None
            and incoming_fingerprint is not None
            and existing_fingerprint == incoming_fingerprint
        )
        if (
            _should_clear_derived_state(
                existing_row,
                {
                    "source_mtime_ns": source_mtime_ns,
                    "source_size": source_size,
                    "metadata_status": metadata_status,
                    "content_fingerprint": content_fingerprint,
                },
                source_changed=source_changed,
                mark_unreadable=mark_unreadable,
            )
            and not can_preserve_derived_state
        ):
            _clear_image_derived_state(cursor, image_id)
        cursor.execute(
            """
            UPDATE images
            SET generator = ?,
                prompt = ?,
                negative_prompt = ?,
                metadata_json = ?,
                width = ?,
                height = ?,
                file_size = ?,
                checkpoint = ?,
                checkpoint_normalized = ?,
                loras = ?,
                model_hash = COALESCE(?, model_hash),
                is_readable = COALESCE(?, is_readable),
                read_error = ?,
                source_mtime_ns = COALESCE(?, source_mtime_ns),
                source_size = COALESCE(?, source_size),
                metadata_status = COALESCE(?, metadata_status),
                content_fingerprint = COALESCE(?, content_fingerprint),
                indexed_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (
                generator,
                prompt,
                negative_prompt,
                metadata_json,
                width,
                height,
                file_size,
                checkpoint,
                checkpoint_normalized,
                serialized_loras,
                model_hash,
                None if is_readable is None else (1 if is_readable else 0),
                read_error,
                source_mtime_ns,
                source_size,
                metadata_status,
                content_fingerprint,
                image_id,
            )
        )
        _sync_image_loras(cursor, image_id, loras, prompt)
        _sync_image_prompt_tokens(cursor, image_id, prompt)
    _invalidate_tags_cache()


def get_collection_by_slug(slug: str) -> Optional[Dict[str, Any]]:
    """Get a collection by slug."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM collections WHERE slug = ?", (slug,))
        row = cursor.fetchone()
        return _row_to_dict(row) if row else None


def get_collection_item(collection_id: int, source_image_id: int) -> Optional[Dict[str, Any]]:
    """Get a collection item by collection and source image IDs."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM collection_items WHERE collection_id = ? AND source_image_id = ?",
            (collection_id, source_image_id)
        )
        row = cursor.fetchone()
        return _row_to_dict(row) if row else None


def add_collection_item(
    collection_id: int,
    source_image_id: int,
    copied_path: str,
    prompt: Optional[str],
    negative_prompt: Optional[str],
    checkpoint: Optional[str],
    loras: Optional[str],
    metadata_json: Optional[str],
    created_at: Optional[datetime],
    width: Optional[int],
    height: Optional[int],
    file_size: Optional[int],
) -> int:
    """Insert or replace a collection snapshot item."""
    metadata_json = _compact_persisted_metadata_json(metadata_json)
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO collection_items (
                collection_id, source_image_id, copied_path, prompt, negative_prompt,
                checkpoint, loras, metadata_json, created_at, width, height, file_size
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(collection_id, source_image_id) DO UPDATE SET
                copied_path = excluded.copied_path,
                prompt = excluded.prompt,
                negative_prompt = excluded.negative_prompt,
                checkpoint = excluded.checkpoint,
                loras = excluded.loras,
                metadata_json = excluded.metadata_json,
                created_at = excluded.created_at,
                width = excluded.width,
                height = excluded.height,
                file_size = excluded.file_size,
                added_at = CURRENT_TIMESTAMP
            """,
            (
                collection_id,
                source_image_id,
                copied_path,
                prompt,
                negative_prompt,
                checkpoint,
                loras,
                metadata_json,
                created_at,
                width,
                height,
                file_size,
            )
        )
        return cursor.lastrowid


def remove_collection_item(collection_id: int, source_image_id: int):
    """Remove a collection item without deleting the copied file."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "DELETE FROM collection_items WHERE collection_id = ? AND source_image_id = ?",
            (collection_id, source_image_id)
        )


def get_favorite_source_ids() -> List[int]:
    """Get all source image IDs currently in Favorites."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT ci.source_image_id
            FROM collection_items ci
            INNER JOIN collections c ON c.id = ci.collection_id
            WHERE c.slug = ?
            """,
            (FAVORITES_COLLECTION_SLUG,)
        )
        return [row[0] for row in cursor.fetchall()]


def get_favorites_count() -> int:
    """Get Favorites item count."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT COUNT(*)
            FROM collection_items ci
            INNER JOIN collections c ON c.id = ci.collection_id
            WHERE c.slug = ?
            """,
            (FAVORITES_COLLECTION_SLUG,)
        )
        return cursor.fetchone()[0]


def delete_image(image_id: int):
    """Delete an image from the database."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM images WHERE id = ?", (image_id,))
    _invalidate_tags_cache()
    _invalidate_facet_caches()


def get_image_count() -> int:
    """Get total number of images in database."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) FROM images")
        return cursor.fetchone()[0]


# NOTE: init_db() is called by the lifespan handler in main.py.
# Do not call it at module import time to avoid side effects.
