"""
Write-side database operations for images.

Insert/upsert, batch ingest, source-path reconnect, derived-state
clear/sync/copy, deletions, and the various ``update_*``/``mark_*`` mutators.
Cursor-taking helpers that issue SQL (``_clear_image_derived_state``,
``_sync_image_loras``/``_sync_image_prompt_tokens``, ``_copy_image_derived_state``)
live here rather than in :mod:`db_helpers`.

Depends on :mod:`db_core`, :mod:`db_helpers`, and ``metadata_storage``; it must
not import from ``database``.
"""
import os
import sqlite3
from datetime import datetime
from typing import Optional, List, Dict, Any, Tuple, Union

from utils.source_paths import (
    build_indexed_image_lookup_candidates,
    indexed_image_path_match_key,
)
from metadata_storage import compact_existing_metadata_json, compact_metadata_json
from db_core import (
    get_db,
    _invalidate_facet_caches,
    _invalidate_tags_cache,
)
from db_helpers import (
    _normalize_indexed_image_path,
    _path_query_match_clause,
    normalize_checkpoint_name,
    extract_prompt_tokens,
    extract_lora_names,
    _serialize_loras,
    _normalize_content_fingerprint,
    _row_value,
    _row_to_dict,
    _rows_to_dicts,
    _is_source_fingerprint_changed,
    _should_clear_derived_state,
)


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

def update_image_caption(image_id: int, caption: str) -> None:
    """Update the ai_caption field for an image."""
    with get_db() as conn:
        conn.execute(
            "UPDATE images SET ai_caption = ? WHERE id = ?",
            (caption, image_id),
        )

def set_user_rating(image_id: int, stars: int) -> bool:
    """Set the user-assigned star rating (0-5; 0 = unrated) for one image.

    Returns True when a row was updated, False when no image has ``image_id``.
    Raises ``ValueError`` when ``stars`` is outside 0-5 so a bad client value
    fails loudly at the boundary instead of writing garbage.
    """
    try:
        stars_int = int(stars)
    except (TypeError, ValueError):
        raise ValueError(f"user_rating must be an integer 0-5, got {stars!r}")
    if not 0 <= stars_int <= 5:
        raise ValueError(f"user_rating must be between 0 and 5, got {stars_int}")
    with get_db() as conn:
        cursor = conn.execute(
            "UPDATE images SET user_rating = ? WHERE id = ?",
            (stars_int, image_id),
        )
        return int(cursor.rowcount or 0) > 0

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

def delete_image(image_id: int):
    """Delete an image from the database."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM images WHERE id = ?", (image_id,))
    _invalidate_tags_cache()
    _invalidate_facet_caches()
