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
import re
from datetime import datetime
from pathlib import Path
from typing import Optional, List, Dict, Any, Tuple, Union
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


def _adapt_datetime_for_sqlite(value: datetime) -> str:
    """Serialize datetimes explicitly; Python 3.12 deprecates sqlite3's default adapter."""
    return value.isoformat(sep=" ")


sqlite3.register_adapter(datetime, _adapt_datetime_for_sqlite)


# ============== Tags Cache ==============
_tags_cache_lock = threading.Lock()
_tags_cache_data = None
_tags_cache_timestamp = 0
_TAGS_CACHE_TTL = 60  # seconds

def _invalidate_tags_cache():
    """Clear the tags cache when tags are modified."""
    global _tags_cache_data, _tags_cache_timestamp
    with _tags_cache_lock:
        _tags_cache_data = None
        _tags_cache_timestamp = 0


def _normalize_indexed_image_path(path: Optional[str]) -> str:
    """Normalize image paths consistently across Windows and POSIX runtimes."""
    return normalize_indexed_image_path(path)


def _path_query_match_clause(paths: List[str]) -> Tuple[str, List[str]]:
    """Build a SQL clause plus candidate list for equivalent indexed paths."""
    normalized_paths = [_normalize_indexed_image_path(path) for path in paths if path]
    if not normalized_paths:
        return "", []

    candidates: List[str] = []
    seen: set[str] = set()
    casefold_candidates: List[str] = []
    seen_casefold: set[str] = set()
    for path in normalized_paths:
        for candidate in build_indexed_image_lookup_candidates(path):
            match_key = indexed_image_path_match_key(candidate)
            if match_key in seen:
                continue
            seen.add(match_key)
            candidates.append(candidate)
            if is_case_insensitive_indexed_path(candidate) and match_key not in seen_casefold:
                seen_casefold.add(match_key)
                casefold_candidates.append(match_key)

    clauses: List[str] = []
    params: List[str] = []
    if candidates:
        placeholders = ",".join("?" * len(candidates))
        clauses.append(f"path IN ({placeholders})")
        params.extend(candidates)
    if casefold_candidates:
        placeholders = ",".join("?" * len(casefold_candidates))
        clauses.append(f"LOWER(path) IN ({placeholders})")
        params.extend(casefold_candidates)

    if not clauses:
        return "", []

    return " OR ".join(clauses), params


def _folder_scope_query_match_clause(folder_path: str) -> Tuple[str, List[str]]:
    """Build a SQL clause plus patterns for equivalent indexed folder scopes."""
    patterns = build_indexed_folder_scope_query_patterns(folder_path)
    if not patterns:
        return "", []

    exact_candidates: List[str] = []
    exact_casefold_candidates: List[str] = []
    prefix_candidates: List[str] = []
    prefix_casefold_candidates: List[str] = []
    seen_exact: set[str] = set()
    seen_prefix: set[str] = set()
    seen_exact_casefold: set[str] = set()
    seen_prefix_casefold: set[str] = set()

    for exact, prefix in patterns:
        exact_match_key = indexed_image_path_match_key(exact)
        prefix_match_key = indexed_image_path_match_key(prefix)

        if exact_match_key not in seen_exact:
            seen_exact.add(exact_match_key)
            exact_candidates.append(exact)
        if prefix_match_key not in seen_prefix:
            seen_prefix.add(prefix_match_key)
            prefix_candidates.append(f"{prefix}%")

        if is_case_insensitive_indexed_path(exact) and exact_match_key not in seen_exact_casefold:
            seen_exact_casefold.add(exact_match_key)
            exact_casefold_candidates.append(exact_match_key)
        if is_case_insensitive_indexed_path(prefix) and prefix_match_key not in seen_prefix_casefold:
            seen_prefix_casefold.add(prefix_match_key)
            prefix_casefold_candidates.append(f"{prefix_match_key}%")

    clauses: List[str] = []
    params: List[str] = []
    if exact_candidates:
        placeholders = ",".join("?" * len(exact_candidates))
        clauses.append(f"path IN ({placeholders})")
        params.extend(exact_candidates)
    if prefix_candidates:
        like_clause = " OR ".join("path LIKE ?" for _ in prefix_candidates)
        clauses.append(f"({like_clause})")
        params.extend(prefix_candidates)
    if exact_casefold_candidates:
        placeholders = ",".join("?" * len(exact_casefold_candidates))
        clauses.append(f"LOWER(path) IN ({placeholders})")
        params.extend(exact_casefold_candidates)
    if prefix_casefold_candidates:
        like_clause = " OR ".join("LOWER(path) LIKE ?" for _ in prefix_casefold_candidates)
        clauses.append(f"({like_clause})")
        params.extend(prefix_casefold_candidates)

    if not clauses:
        return "", []

    return " OR ".join(clauses), params


def _ensure_content_fingerprint_value(
    cursor: sqlite3.Cursor,
    image_id: int,
    content_fingerprint: Optional[str],
) -> Optional[str]:
    """Return a usable content fingerprint, computing it on demand if needed."""
    normalized = _normalize_content_fingerprint(content_fingerprint)
    if normalized:
        return normalized

    row = cursor.execute(
        "SELECT path, content_fingerprint FROM images WHERE id = ?",
        (image_id,),
    ).fetchone()
    if not row:
        return None

    existing = _normalize_content_fingerprint(row["content_fingerprint"])
    if existing:
        return existing

    try:
        from image_fingerprint import compute_image_content_fingerprint
        from utils.source_paths import resolve_existing_indexed_image_path

        resolved_path = resolve_existing_indexed_image_path(row["path"], backend_file=__file__)
        if not resolved_path:
            return None
        return compute_image_content_fingerprint(resolved_path)
    except Exception:
        return None


def normalize_prompt_token(token: str) -> str:
    """Normalize a prompt token for consistent matching.

    Rules:
    1. Convert to lowercase
    2. Replace underscores with spaces
    3. Strip whitespace

    Example: "Best_quality" = "best quality" = "BeStQualITY" -> "best quality"
    """
    return token.lower().replace('_', ' ').strip()


def escape_like_pattern(value: str) -> str:
    """Escape SQL LIKE wildcard characters to prevent pattern injection.

    Escapes % and _ characters so they are treated as literals in LIKE patterns.

    Example: "test_file" -> "test\\_file" (matches literal "test_file", not "testXfile")
    """
    return value.replace('%', r'\%').replace('_', r'\_')


def normalize_lora_name(lora_name: str) -> str:
    """Normalize a LORA name for consistent matching.

    Strips path prefixes, weight notation, and file extensions:
    - "Anima\\anime\\my_lora.safetensors" -> "my_lora"
    - "my_lora:0.8" -> "my_lora"
    - "my_lora.safetensors" -> "my_lora"
    - Lowercase for matching
    """
    # Strip weight notation (everything after last colon if it's a number)
    if ':' in lora_name:
        parts = lora_name.rsplit(':', 1)
        try:
            float(parts[1])
            lora_name = parts[0]
        except ValueError:
            pass

    # Strip path prefix (keep only filename)
    lora_name = lora_name.replace('\\', '/').rsplit('/', 1)[-1]

    # Strip common model file extensions
    extensions_to_strip = ['.safetensors', '.ckpt', '.pt', '.pth', '.bin']
    lora_lower = lora_name.lower()
    for ext in extensions_to_strip:
        if lora_lower.endswith(ext):
            lora_name = lora_name[:-len(ext)]
            break
    
    return lora_name.lower().strip()


def normalize_checkpoint_name(checkpoint_name: Optional[str]) -> Optional[str]:
    """Normalize checkpoint names for cross-generator filter semantics."""
    return _normalize_checkpoint_name(checkpoint_name)


def extract_prompt_tokens(prompt: str) -> set:
    """Extract normalized tokens from a prompt string.
    
    Used for exact token matching in filters.
    Splits by comma only, cleans parentheses/weights, normalizes.
    """
    if not prompt:
        return set()
    
    # Remove XML-like tags and lora tags
    clean_prompt = re.sub(r'<[^>]+>[^<]*</[^>]+>', '', prompt)
    clean_prompt = re.sub(r'<lora:[^>]+>', '', clean_prompt)
    clean_prompt = re.sub(r'<[^>]+>', '', clean_prompt)
    
    tokens = set()
    for token in clean_prompt.split(','):
        token = token.strip()
        if not token:
            continue
        # Remove leading/trailing parentheses and weight suffixes
        clean_token = re.sub(r'^\(+|\)+$', '', token)
        clean_token = re.sub(r':\d+\.?\d*\)?$', '', clean_token)
        clean_token = clean_token.strip()
        
        if clean_token and len(clean_token) > 1:
            normalized = normalize_prompt_token(clean_token)
            if normalized and len(normalized) > 1:
                tokens.add(normalized)
    
    return tokens


def extract_lora_names(loras_json: str, prompt: str) -> set:
    """Extract normalized LORA names from loras JSON and prompt.
    
    Used for exact LORA matching in filters.
    """
    loras = set()
    
    # Extract from JSON array
    if loras_json:
        try:
            loras_list = json.loads(loras_json)
            for lora_name in loras_list:
                if lora_name and len(lora_name) > 2:
                    normalized = normalize_lora_name(lora_name)
                    if normalized and len(normalized) > 2:
                        loras.add(normalized)
        except (json.JSONDecodeError, TypeError) as e:
            # Invalid JSON format, skip
            pass
    
    # Extract from prompt (format: <lora:name:weight>)
    if prompt:
        lora_matches = re.findall(r'<lora:([^:>]+)(?::[^>]+)?>', prompt, re.IGNORECASE)
        for lora_name in lora_matches:
            if lora_name and len(lora_name) > 2:
                normalized = normalize_lora_name(lora_name)
                if normalized and len(normalized) > 2:
                    loras.add(normalized)
    
    return loras


def _serialize_loras(loras: Optional[List[str]]) -> Optional[str]:
    """Serialize LoRA names for storage while preserving empty lists."""
    return json.dumps(loras) if loras is not None else None


def _deserialize_loras(loras: Any) -> Optional[List[str]]:
    """Best-effort deserialize of stored LoRA JSON."""
    if loras is None:
        return None
    if isinstance(loras, list):
        return loras
    if isinstance(loras, str):
        try:
            value = json.loads(loras)
            return value if isinstance(value, list) else None
        except (json.JSONDecodeError, TypeError):
            return None
    return None


def _normalize_source_fingerprint(value: Any) -> Optional[int]:
    """Convert stored source fingerprint values to integers when possible."""
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _normalize_content_fingerprint(value: Any) -> Optional[str]:
    """Normalize stored image content fingerprints."""
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _row_value(row: Optional[Any], key: str) -> Any:
    """Read a field from either sqlite rows or plain dictionaries."""
    if row is None:
        return None
    if isinstance(row, dict):
        return row.get(key)
    try:
        return row[key]
    except (KeyError, IndexError, TypeError):
        return None


def _json_safe_db_value(value: Any) -> Any:
    """Convert SQLite row values into JSON-safe Python values."""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    if isinstance(value, bytearray):
        return bytes(value).decode("utf-8", errors="replace")
    if isinstance(value, memoryview):
        return value.tobytes().decode("utf-8", errors="replace")
    if isinstance(value, dict):
        return {key: _json_safe_db_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_json_safe_db_value(item) for item in value]
    return value


def _row_to_dict(row: Optional[Any]) -> Optional[Dict[str, Any]]:
    """Convert sqlite3.Row objects into JSON-safe dictionaries."""
    if row is None:
        return None
    return {
        key: _json_safe_db_value(value)
        for key, value in dict(row).items()
    }


def _rows_to_dicts(rows: List[Any]) -> List[Dict[str, Any]]:
    """Convert a sequence of sqlite3.Row objects into JSON-safe dictionaries."""
    return [_row_to_dict(row) for row in rows if row is not None]


def _has_source_fingerprint(row: Optional[Dict[str, Any]]) -> bool:
    """Return True when a row has both source fingerprint fields populated."""
    if not row:
        return False
    return (
        _normalize_source_fingerprint(_row_value(row, "source_mtime_ns")) is not None
        and _normalize_source_fingerprint(_row_value(row, "source_size")) is not None
    )


def _is_source_fingerprint_changed(existing_row: Optional[Dict[str, Any]], record: Dict[str, Any]) -> bool:
    """Check whether the stored source fingerprint differs from the incoming record."""
    if not existing_row or not _has_source_fingerprint(existing_row):
        return False

    incoming_mtime_ns = _normalize_source_fingerprint(record.get("source_mtime_ns"))
    incoming_size = _normalize_source_fingerprint(record.get("source_size"))
    if incoming_mtime_ns is None or incoming_size is None:
        return False

    return (
        _normalize_source_fingerprint(_row_value(existing_row, "source_mtime_ns")) != incoming_mtime_ns
        or _normalize_source_fingerprint(_row_value(existing_row, "source_size")) != incoming_size
    )


def _has_derived_state(row: Optional[Dict[str, Any]]) -> bool:
    """Return True when the row currently has derived data cached."""
    if not row:
        return False
    return any([
        _row_value(row, "tagged_at") is not None,
        _row_value(row, "ai_caption") is not None,
        _row_value(row, "aesthetic_score") is not None,
        bool(_row_value(row, "has_embedding")),
        bool(_row_value(row, "has_artist_predictions")),
    ])


def _should_clear_derived_state(
    existing_row: Optional[Dict[str, Any]],
    record: Dict[str, Any],
    *,
    source_changed: bool,
    mark_unreadable: bool,
) -> bool:
    """Decide whether the source change invalidates cached derived data."""
    if mark_unreadable:
        return True
    if not _has_derived_state(existing_row):
        return False

    metadata_status = str(record.get("metadata_status") or "complete").strip().lower()
    if metadata_status == "pending":
        # Placeholder scan rows do not know yet whether pixel data changed.
        return False

    previous_fingerprint = _normalize_content_fingerprint(_row_value(existing_row, "content_fingerprint"))
    incoming_fingerprint = _normalize_content_fingerprint(record.get("content_fingerprint"))
    if previous_fingerprint is not None and incoming_fingerprint is not None:
        return previous_fingerprint != incoming_fingerprint

    if not source_changed:
        return False

    if previous_fingerprint is None or incoming_fingerprint is None:
        return True

    return False


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

_pragmas_initialized: set = set()
_pragmas_lock = threading.Lock()
SCHEMA_VERSION_ROW_ID = 1
STALE_PENDING_METADATA_READ_ERROR = (
    "Scan interrupted before metadata refresh completed. Re-scan the source folder to recover this row."
)


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


@contextmanager
def get_db():
    """Context manager for database connections."""
    conn = get_connection()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _ensure_schema_version_table(conn: sqlite3.Connection) -> None:
    """Create the schema-version ledger when it does not exist yet."""
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS schema_version (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            version INTEGER NOT NULL
        )
        """
    )
    conn.execute(
        "INSERT OR IGNORE INTO schema_version (id, version) VALUES (?, 0)",
        (SCHEMA_VERSION_ROW_ID,),
    )


def _get_schema_version(conn: sqlite3.Connection) -> int:
    row = conn.execute(
        "SELECT version FROM schema_version WHERE id = ?",
        (SCHEMA_VERSION_ROW_ID,),
    ).fetchone()
    if not row:
        return 0
    return int(row[0] or 0)


def _set_schema_version(conn: sqlite3.Connection, version: int) -> None:
    conn.execute(
        "UPDATE schema_version SET version = ? WHERE id = ?",
        (int(version), SCHEMA_VERSION_ROW_ID),
    )


def _recover_stale_pending_metadata_rows(conn: sqlite3.Connection) -> int:
    """
    Quarantine placeholder scan rows that survived a previous process crash.

    Pending rows are safe while a scan is running, but once the app starts again
    there is no in-flight worker left that can finish them. Mark them as
    recoverable `error` rows so they stop bypassing invalidation logic and can
    be repaired truthfully by the next re-scan.
    """
    row = conn.execute(
        """
        SELECT COUNT(*)
        FROM images
        WHERE LOWER(COALESCE(metadata_status, '')) = 'pending'
        """
    ).fetchone()
    pending_count = int(row[0] or 0) if row else 0
    if pending_count <= 0:
        return 0

    conn.execute(
        """
        UPDATE images
        SET is_readable = 0,
            read_error = CASE
                WHEN TRIM(COALESCE(read_error, '')) = '' THEN ?
                ELSE read_error
            END,
            metadata_status = 'error',
            indexed_at = CURRENT_TIMESTAMP
        WHERE LOWER(COALESCE(metadata_status, '')) = 'pending'
        """,
        (STALE_PENDING_METADATA_READ_ERROR,),
    )
    return pending_count


def init_db() -> None:
    """Initialize or migrate the database schema to the latest known version."""
    from migrations import get_migrations

    conn = get_connection()
    try:
        _ensure_schema_version_table(conn)
        current_version = _get_schema_version(conn)

        for migration in get_migrations():
            if migration.version <= current_version:
                continue
            savepoint_name = f"migration_{migration.version}"
            conn.execute(f"SAVEPOINT {savepoint_name}")
            try:
                migration.apply(conn)
                _set_schema_version(conn, migration.version)
                conn.execute(f"RELEASE SAVEPOINT {savepoint_name}")
            except Exception:
                conn.execute(f"ROLLBACK TO SAVEPOINT {savepoint_name}")
                conn.execute(f"RELEASE SAVEPOINT {savepoint_name}")
                raise
            current_version = migration.version

        _recover_stale_pending_metadata_rows(conn)

        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


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


def _upsert_image_record(
    cursor: sqlite3.Cursor,
    record: Dict[str, Any],
    existing_row: Optional[sqlite3.Row] = None,
) -> Tuple[int, str]:
    """Insert or update a single image row using an existing transaction."""
    path = _normalize_indexed_image_path(record["path"])
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

    return removed


def delete_images_by_paths(paths: List[str]) -> int:
    """Delete image rows by absolute file path."""
    clause, params = _path_query_match_clause(paths)
    if not clause:
        return 0

    removed = 0

    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(f"DELETE FROM images WHERE {clause}", params)
        removed += cursor.rowcount or 0

    if removed:
        _invalidate_tags_cache()

    return removed


def add_tags(image_id: int, tags: List[Dict[str, Any]], content_fingerprint: Optional[str] = None) -> None:
    """Add tags for an image. Each tag dict should have 'tag' and optionally 'confidence'.

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
        # Update tagged timestamp
        cursor.execute(
            "UPDATE images SET tagged_at = CURRENT_TIMESTAMP, content_fingerprint = COALESCE(?, content_fingerprint) WHERE id = ?",
            (content_fingerprint, image_id)
        )
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


# =============================================================================
# Query Building Helpers for get_images()
# =============================================================================

VALID_SORT_OPTIONS = {
    "newest", "oldest", "name_asc", "name_desc", "generator", "generator_desc",
    "prompt_length", "prompt_length_asc", "tag_count", "tag_count_asc",
    "rating", "rating_desc", "character_count", "character_count_asc",
    "random", "file_size", "file_size_asc", "aesthetic", "aesthetic_asc",
}

# Canonical column lists for image queries.
# All functions selecting image rows should reference these constants
# so column additions only need to change one place.
_IMAGE_COLUMNS_BASE_FIELDS = (
    "id",
    "path",
    "filename",
    "generator",
    "prompt",
    "negative_prompt",
    "metadata_json",
    "width",
    "height",
    "file_size",
    "checkpoint",
    "checkpoint_normalized",
    "loras",
    "model_hash",
    "is_readable",
    "read_error",
    "source_mtime_ns",
    "source_size",
    "metadata_status",
    "library_order_time",
    "source_file_mtime",
    "created_at",
    "indexed_at",
    "tagged_at",
    "ai_caption",
    "aesthetic_score",
)
_IMAGE_COLUMNS_WITH_PROMPT_FIELDS = (
    "id",
    "filename",
    "path",
    "generator",
    "prompt",
    "negative_prompt",
    "width",
    "height",
    "file_size",
    "checkpoint",
    "checkpoint_normalized",
    "loras",
    "model_hash",
    "is_readable",
    "read_error",
    "source_mtime_ns",
    "source_size",
    "metadata_status",
    "library_order_time",
    "source_file_mtime",
    "created_at",
    "tagged_at",
    "aesthetic_score",
)
_IMAGE_COLUMNS_LIGHTWEIGHT_FIELDS = (
    "id",
    "filename",
    "path",
    "generator",
    "width",
    "height",
    "file_size",
    "checkpoint",
    "checkpoint_normalized",
    "loras",
    "model_hash",
    "is_readable",
    "read_error",
    "source_mtime_ns",
    "source_size",
    "metadata_status",
    "library_order_time",
    "source_file_mtime",
    "created_at",
    "tagged_at",
    "aesthetic_score",
)


def _format_image_column_list(columns: Tuple[str, ...], *, alias: Optional[str] = None) -> str:
    """Return a comma-joined image column list, optionally qualified by an alias."""
    prefix = f"{alias}." if alias else ""
    return ", ".join(f"{prefix}{column}" for column in columns)


_IMAGE_COLUMNS_FULL = _format_image_column_list(_IMAGE_COLUMNS_BASE_FIELDS, alias="i")
_IMAGE_COLUMNS_WITH_PROMPT = _format_image_column_list(_IMAGE_COLUMNS_WITH_PROMPT_FIELDS, alias="i")
_IMAGE_COLUMNS_LIGHTWEIGHT = _format_image_column_list(_IMAGE_COLUMNS_LIGHTWEIGHT_FIELDS, alias="i")
_IMAGE_COLUMNS_BARE = _format_image_column_list(_IMAGE_COLUMNS_BASE_FIELDS)

_LIBRARY_ORDER_SQL_UNQUALIFIED = "COALESCE(library_order_time, created_at)"
_LIBRARY_ORDER_SQL = "COALESCE(i.library_order_time, i.created_at)"


def _build_base_query(sort_by: str, select_cols: str) -> str:
    """Build the base SELECT query with optional subqueries for tag-based sorting.

    Args:
        sort_by: Sorting method identifier
        select_cols: Column selection string

    Returns:
        Base SQL query string
    """
    if sort_by not in VALID_SORT_OPTIONS:
        sort_by = "newest"

    if sort_by in ("tag_count", "tag_count_asc"):
        return f"""SELECT DISTINCT {select_cols},
                   (SELECT COUNT(*) FROM tags t WHERE t.image_id = i.id) as tag_count
                   FROM images i"""
    elif sort_by in ("character_count", "character_count_asc"):
        return f"""SELECT DISTINCT {select_cols},
                   (SELECT COUNT(*) FROM tags t WHERE t.image_id = i.id AND t.tag LIKE '%character%') as char_count
                   FROM images i"""
    elif sort_by in ("rating", "rating_desc"):
        # Priority: explicit > questionable > sensitive > general > unrated
        return f"""SELECT DISTINCT {select_cols},
                   CASE
                       WHEN EXISTS (SELECT 1 FROM tags t WHERE t.image_id = i.id AND t.tag = 'explicit') THEN 1
                       WHEN EXISTS (SELECT 1 FROM tags t WHERE t.image_id = i.id AND t.tag = 'questionable') THEN 2
                       WHEN EXISTS (SELECT 1 FROM tags t WHERE t.image_id = i.id AND t.tag = 'sensitive') THEN 3
                       WHEN EXISTS (SELECT 1 FROM tags t WHERE t.image_id = i.id AND t.tag = 'general') THEN 4
                       ELSE 5
                   END as rating_order
                   FROM images i"""
    else:
        return f"SELECT DISTINCT {select_cols} FROM images i"


def _apply_tag_filter(query: str, tags: Optional[List[str]], params: List[Any]) -> tuple:
    """Apply tag filtering with JOINs (AND logic).

    Args:
        query: Current query string
        tags: List of tags to filter by
        params: Current parameter list

    Returns:
        Tuple of (modified query, modified params)
    """
    if not tags:
        return query, params

    for i, tag in enumerate(tags):
        alias = f"t{i}"
        query += f" INNER JOIN tags {alias} ON i.id = {alias}.image_id AND {alias}.tag = ?"
        params.append(tag)


    return query, params


def _apply_generator_filter(conditions: List[str], params: List[Any],
                            generators: Optional[List[str]]) -> tuple:
    """Apply generator filtering (OR logic).

    Args:
        conditions: Current WHERE conditions list
        params: Current parameter list
        generators: List of generators to filter by

    Returns:
        Tuple of (modified conditions, modified params)
    """
    if not generators:
        return conditions, params

    placeholders = ",".join("?" * len(generators))
    conditions.append(f"i.generator IN ({placeholders})")
    params.extend(generators)

    return conditions, params


def _apply_rating_filter(conditions: List[str], params: List[Any],
                         ratings: Optional[List[str]]) -> tuple:
    """Apply rating filtering (OR logic with untagged fallback).

    When all 4 ratings are selected, don't filter at all (show everything).
    When some ratings are selected, show images with those rating tags OR untagged images.

    Args:
        conditions: Current WHERE conditions list
        params: Current parameter list
        ratings: List of ratings to filter by

    Returns:
        Tuple of (modified conditions, modified params)
    """
    if not ratings:
        return conditions, params

    all_ratings = {'general', 'sensitive', 'questionable', 'explicit'}
    selected_ratings = set(ratings)

    # Only apply filter if not all ratings are selected
    if selected_ratings == all_ratings:
        return conditions, params

    rating_placeholders = ",".join("?" * len(ratings))
    # Image has one of the selected ratings OR image has no tags at all (untagged)
    conditions.append(f"""(
        EXISTS (SELECT 1 FROM tags rt WHERE rt.image_id = i.id AND rt.tag IN ({rating_placeholders}))
        OR i.tagged_at IS NULL
    )""")
    params.extend(ratings)

    return conditions, params


def _apply_checkpoint_filter(conditions: List[str], params: List[Any],
                             checkpoints: Optional[List[str]]) -> tuple:
    """Apply checkpoint filtering (OR logic).

    Args:
        conditions: Current WHERE conditions list
        params: Current parameter list
        checkpoints: List of checkpoints to filter by

    Returns:
        Tuple of (modified conditions, modified params)
    """
    if not checkpoints:
        return conditions, params

    normalized_checkpoints: List[str] = []
    seen: set[str] = set()
    for checkpoint in checkpoints:
        normalized = normalize_checkpoint_name(checkpoint)
        identity = checkpoint_identity_key(normalized)
        if not normalized or identity in seen:
            continue
        seen.add(identity)
        normalized_checkpoints.append(normalized)

    if not normalized_checkpoints:
        return conditions, params

    placeholders = ",".join("?" * len(normalized_checkpoints))
    conditions.append(f"i.checkpoint_normalized COLLATE NOCASE IN ({placeholders})")
    params.extend(normalized_checkpoints)

    return conditions, params


def _apply_lora_filter(conditions: List[str], params: List[Any],
                       loras: Optional[List[str]]) -> tuple:
    """Apply LoRA filtering (OR logic - image has ANY of the selected loras).

    Uses the image_loras junction table for efficient indexed lookups
    instead of LIKE scans on TEXT columns.

    Args:
        conditions: Current WHERE conditions list
        params: Current parameter list
        loras: List of loras to filter by

    Returns:
        Tuple of (modified conditions, modified params)
    """
    if not loras:
        return conditions, params

    lora_conditions = []
    for lora in loras:
        lora_normalized = normalize_lora_name(lora)
        lora_conditions.append(
            "EXISTS (SELECT 1 FROM image_loras il WHERE il.image_id = i.id AND LOWER(il.lora_name) = ?)"
        )
        params.append(lora_normalized)

    conditions.append(f"({' OR '.join(lora_conditions)})")

    return conditions, params


def _apply_search_filter(conditions: List[str], params: List[Any],
                         search_query: Optional[str]) -> tuple:
    """Apply prompt search filtering with normalization.

    Normalizes: lowercase and replace underscore with space.

    Args:
        conditions: Current WHERE conditions list
        params: Current parameter list
        search_query: Search term to look for

    Returns:
        Tuple of (modified conditions, modified params)
    """
    if not search_query:
        return conditions, params

    normalized_search = normalize_prompt_token(search_query)
    checkpoint_search = checkpoint_identity_key(search_query) or search_query.lower()
    conditions.append(
        "("
        "REPLACE(LOWER(i.prompt), '_', ' ') LIKE ? ESCAPE '\\' "
        "OR LOWER(i.filename) LIKE ? ESCAPE '\\' "
        "OR LOWER(COALESCE(i.checkpoint_normalized, '')) LIKE ? ESCAPE '\\'"
        ")"
    )
    params.extend(
        [
            f"%{escape_like_pattern(normalized_search)}%",
            f"%{escape_like_pattern(search_query.lower())}%",
            f"%{escape_like_pattern(checkpoint_search)}%",
        ]
    )

    return conditions, params


def _apply_prompt_terms_filter(conditions: List[str], params: List[Any],
                               prompt_terms: Optional[List[str]]) -> tuple:
    """Apply multi-prompt filter (AND logic - prompt must contain ALL terms).

    Uses substring matching (LIKE %term%) with normalization.

    Args:
        conditions: Current WHERE conditions list
        params: Current parameter list
        prompt_terms: List of prompt terms to filter by

    Returns:
        Tuple of (modified conditions, modified params)
    """
    if not prompt_terms:
        return conditions, params

    for term in prompt_terms:
        normalized_term = normalize_prompt_token(term)
        conditions.append("REPLACE(LOWER(i.prompt), '_', ' ') LIKE ? ESCAPE '\\'")
        params.append(f"%{escape_like_pattern(normalized_term)}%")

    return conditions, params


def _apply_dimension_filters(conditions: List[str], params: List[Any],
                             min_width: Optional[int], max_width: Optional[int],
                             min_height: Optional[int], max_height: Optional[int],
                             aspect_ratio: Optional[str]) -> tuple:
    """Apply dimension and aspect ratio filters.

    Args:
        conditions: Current WHERE conditions list
        params: Current parameter list
        min_width, max_width: Width range constraints
        min_height, max_height: Height range constraints
        aspect_ratio: One of 'square', 'landscape', 'portrait'

    Returns:
        Tuple of (modified conditions, modified params)
    """
    if min_width:
        conditions.append("i.width >= ?")
        params.append(min_width)
    if max_width:
        conditions.append("i.width <= ?")
        params.append(max_width)
    if min_height:
        conditions.append("i.height >= ?")
        params.append(min_height)
    if max_height:
        conditions.append("i.height <= ?")
        params.append(max_height)

    # Aspect ratio filter
    if aspect_ratio:
        if aspect_ratio == 'square':
            conditions.append("i.height > 0 AND ABS(CAST(i.width AS FLOAT) / i.height - 1.0) < 0.1")
        elif aspect_ratio == 'landscape':
            conditions.append("i.height > 0 AND CAST(i.width AS FLOAT) / i.height > 1.1")
        elif aspect_ratio == 'portrait':
            conditions.append("i.height > 0 AND CAST(i.width AS FLOAT) / i.height < 0.9")

    return conditions, params


def _apply_aesthetic_filter(conditions: List[str], params: List[Any],
                            min_aesthetic: Optional[float],
                            max_aesthetic: Optional[float]) -> tuple:
    """Apply aesthetic score range filters."""
    if min_aesthetic is not None:
        conditions.append("i.aesthetic_score IS NOT NULL AND i.aesthetic_score >= ?")
        params.append(min_aesthetic)
    if max_aesthetic is not None:
        conditions.append("i.aesthetic_score IS NOT NULL AND i.aesthetic_score <= ?")
        params.append(max_aesthetic)
    return conditions, params


def _apply_artist_filter(query: str, conditions: List[str], params: List[Any],
                         artist: Optional[str]) -> tuple:
    """Apply artist filter by joining with artist_predictions table.

    Args:
        query: Current query string
        conditions: Current WHERE conditions list
        params: Current parameter list
        artist: Artist name to filter by

    Returns:
        Tuple of (modified query, modified conditions, modified params)
    """
    if not artist:
        return query, conditions, params

    query += " INNER JOIN artist_predictions ap ON i.id = ap.image_id"
    conditions.append("ap.artist = ?")
    params.append(artist)

    return query, conditions, params


def _apply_image_ids_filter(conditions: List[str], params: List[Any],
                            image_ids: Optional[List[int]]) -> tuple:
    """Filter by specific image IDs.

    Args:
        conditions: Current WHERE conditions list
        params: Current parameter list
        image_ids: List of image IDs to filter by

    Returns:
        Tuple of (modified conditions, modified params)
    """
    if image_ids is None:
        return conditions, params

    placeholders = ",".join("?" * len(image_ids))
    conditions.append(f"i.id IN ({placeholders})")
    params.extend(image_ids)

    return conditions, params


def _apply_readable_filter(
    conditions: List[str],
    params: List[Any],
    include_unreadable: bool = False,
) -> tuple:
    """Exclude unreadable images from normal library workflows by default."""
    if include_unreadable:
        return conditions, params

    conditions.append("COALESCE(i.is_readable, 1) = 1")
    return conditions, params

def _get_order_clause(sort_by: str) -> str:
    """Get the ORDER BY clause for a given sort method.

    Args:
        sort_by: Sorting method identifier

    Returns:
        SQL ORDER BY clause string
    """
    sort_options = {
        "newest": f"{_LIBRARY_ORDER_SQL} DESC, i.id DESC",
        "oldest": f"{_LIBRARY_ORDER_SQL} ASC, i.id ASC",
        "name_asc": "i.filename ASC, i.id ASC",
        "name_desc": "i.filename DESC, i.id DESC",
        "generator": f"i.generator ASC, {_LIBRARY_ORDER_SQL} DESC, i.id DESC",
        "generator_desc": f"i.generator DESC, {_LIBRARY_ORDER_SQL} DESC, i.id DESC",
        "prompt_length": "LENGTH(COALESCE(i.prompt, '')) DESC, i.id DESC",
        "prompt_length_asc": "LENGTH(COALESCE(i.prompt, '')) ASC, i.id ASC",
        "tag_count": "tag_count DESC, i.id DESC",
        "tag_count_asc": "tag_count ASC, i.id ASC",
        "rating": "rating_order ASC, i.id ASC",
        "rating_desc": "rating_order DESC, i.id DESC",
        "character_count": "char_count DESC, i.id DESC",
        "character_count_asc": "char_count ASC, i.id ASC",
        "random": "RANDOM()",
        "file_size": "i.file_size DESC, i.id DESC",
        "file_size_asc": "i.file_size ASC, i.id ASC",
        "aesthetic": "COALESCE(i.aesthetic_score, 0) DESC, i.id DESC",
        "aesthetic_asc": "COALESCE(i.aesthetic_score, 0) ASC, i.id ASC",
    }
    return sort_options.get(sort_by, f"{_LIBRARY_ORDER_SQL} DESC, i.id DESC")


def _supports_cursor_sort(sort_by: str) -> bool:
    """Return True when cursor pagination is safe for the requested sort."""
    return sort_by in {"newest", "oldest"}


def _fetch_post_filtered_page(
    conn,
    base_query: str,
    base_params: List[Any],
    order_clause: str,
    prompt_terms: Optional[List[str]],
    loras: Optional[List[str]],
    *,
    post_offset: int = 0,
    limit: int,
    fetch_size: Optional[int] = None,
) -> List[Dict[str, Any]]:
    """Fetch a post-filtered page by scanning SQL rows in deterministic chunks."""
    cursor = conn.cursor()
    if limit < 0:
        raise ValueError("limit must be >= 0")

    normalized_offset = max(0, int(post_offset))
    normalized_limit = max(0, int(limit))
    target_count = None if normalized_limit == 0 else normalized_offset + normalized_limit

    effective_fetch_size = int(fetch_size or 0)
    if effective_fetch_size <= 0:
        baseline = normalized_limit if normalized_limit > 0 else 50
        effective_fetch_size = max(baseline * 2, 50)

    raw_offset = 0
    collected: List[Dict[str, Any]] = []

    while True:
        query = f"{base_query} ORDER BY {order_clause} LIMIT ? OFFSET ?"
        params = list(base_params) + [effective_fetch_size, raw_offset]
        cursor.execute(query, params)
        rows = cursor.fetchall()
        if not rows:
            break

        batch = _post_filter_results(_rows_to_dicts(rows), prompt_terms, loras, 0, 0)
        collected.extend(batch)
        if target_count is not None and len(collected) >= target_count:
            break

        if len(rows) < effective_fetch_size:
            break
        raw_offset += effective_fetch_size

    if normalized_limit == 0:
        return collected[normalized_offset:]
    return collected[normalized_offset:normalized_offset + normalized_limit]


def _matches_exact_post_filters(
    prompt: Optional[str],
    lora_text: Optional[str],
    normalized_prompt_terms: List[str],
    normalized_loras: List[str],
) -> bool:
    """Apply the exact prompt/LORA matching semantics used by post-filter paths."""
    if normalized_prompt_terms:
        image_tokens = extract_prompt_tokens(prompt or "")
        if not all(term in image_tokens for term in normalized_prompt_terms):
            return False

    if normalized_loras:
        image_loras = extract_lora_names(lora_text or "", prompt or "")
        if not any(lora in image_loras for lora in normalized_loras):
            return False

    return True


def _post_filter_results(results: List[Dict[str, Any]],
                         prompt_terms: Optional[List[str]],
                         loras: Optional[List[str]],
                         offset: int,
                         limit: int) -> List[Dict[str, Any]]:
    """Apply in-memory post-filtering for exact matching."""
    if not prompt_terms and not loras:
        return results[offset:offset + limit] if limit else results[offset:]

    filtered_results = []
    normalized_prompt_terms = [normalize_prompt_token(t) for t in (prompt_terms or [])]
    normalized_loras = [normalize_lora_name(l) for l in (loras or [])]
    early_stop_count = offset + limit if limit else None

    for img in results:
        if _matches_exact_post_filters(
            img.get("prompt"),
            img.get("loras"),
            normalized_prompt_terms,
            normalized_loras,
        ):
            filtered_results.append(img)

        if early_stop_count and len(filtered_results) >= early_stop_count:
            break

    return filtered_results[offset:offset + limit] if limit else filtered_results[offset:]


def get_images(
    generators: Optional[List[str]] = None,
    tags: Optional[List[str]] = None,
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
    aspect_ratio: Optional[str] = None,  # 'square', 'landscape', 'portrait'
    artist: Optional[str] = None,  # Artist filter
    image_ids: Optional[List[int]] = None,
    min_aesthetic: Optional[float] = None,
    max_aesthetic: Optional[float] = None,
    include_unreadable: bool = False,
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
        needs_post_filter = bool(prompt_terms) or bool(loras)
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
        query, params = _apply_tag_filter(query, tags, params)

        # Apply image IDs filter
        conditions, params = _apply_image_ids_filter(conditions, params, image_ids)

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
        conditions, params = _apply_prompt_terms_filter(conditions, params, prompt_terms)

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
    ratings: Optional[List[str]] = None,
    checkpoints: Optional[List[str]] = None,
    loras: Optional[List[str]] = None,
    search_query: Optional[str] = None,
    min_width: Optional[int] = None,
    max_width: Optional[int] = None,
    min_height: Optional[int] = None,
    max_height: Optional[int] = None,
    prompt_terms: Optional[List[str]] = None,
    aspect_ratio: Optional[str] = None,
    artist: Optional[str] = None,
    image_ids: Optional[List[int]] = None,
    min_aesthetic: Optional[float] = None,
    max_aesthetic: Optional[float] = None,
    include_unreadable: bool = False,
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
            for i, tag in enumerate(tags):
                alias = f"t{i}"
                query += f" INNER JOIN tags {alias} ON i.id = {alias}.image_id AND {alias}.tag = ?"
                params.append(tag)


        # Apply image IDs filter
        conditions, params = _apply_image_ids_filter(conditions, params, image_ids)

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
        conditions, params = _apply_prompt_terms_filter(conditions, params, prompt_terms)

        # Apply dimension filters
        conditions, params = _apply_dimension_filters(
            conditions, params,
            min_width, max_width, min_height, max_height, aspect_ratio
        )

        conditions, params = _apply_aesthetic_filter(
            conditions, params, min_aesthetic, max_aesthetic
        )

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
    aspect_ratio: Optional[str] = None,
    artist: Optional[str] = None,
    image_ids: Optional[List[int]] = None,
    min_aesthetic: Optional[float] = None,
    max_aesthetic: Optional[float] = None,
    include_unreadable: bool = False,
    fetch_chunk_size: int = 5000,
    max_results: Optional[int] = None,
    offset: int = 0,
    limit: Optional[int] = None,
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

        # Determine if post-filtering is needed
        needs_post_filter = bool(prompt_terms) or bool(loras)

        select_cols = "i.id, i.prompt, i.loras" if needs_post_filter else "i.id"
        query = _build_base_query(sort_by, select_cols)

        conditions: List[str] = []
        params: List[Any] = []

        # Apply tag filter (JOIN)
        query, params = _apply_tag_filter(query, tags, params)

        # Apply image IDs filter
        conditions, params = _apply_image_ids_filter(conditions, params, image_ids)

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
        conditions, params = _apply_prompt_terms_filter(conditions, params, prompt_terms)

        # Apply dimension filters
        conditions, params = _apply_dimension_filters(
            conditions, params,
            min_width, max_width, min_height, max_height, aspect_ratio
        )

        conditions, params = _apply_aesthetic_filter(
            conditions, params, min_aesthetic, max_aesthetic
        )

        # Apply artist filter (JOIN)
        query, conditions, params = _apply_artist_filter(query, conditions, params, artist)

        # Build WHERE clause
        if conditions:
            query += " WHERE " + " AND ".join(conditions)

        # Get order clause
        order_clause = _get_order_clause(sort_by)
        query += f" ORDER BY {order_clause}"

        if not needs_post_filter:
            if result_limit is not None:
                query += " LIMIT ? OFFSET ?"
                params.extend([result_limit, normalized_offset])
            elif normalized_offset > 0:
                query += " LIMIT -1 OFFSET ?"
                params.append(normalized_offset)

        cursor.execute(query, params)

        ids: List[int] = []
        chunk_size = max(1, int(fetch_chunk_size))
        normalized_prompt_terms = [normalize_prompt_token(t) for t in (prompt_terms or [])]
        normalized_loras = [normalize_lora_name(l) for l in (loras or [])]
        matched_count = 0

        while True:
            rows = cursor.fetchmany(chunk_size)
            if not rows:
                break
            if needs_post_filter:
                for row in rows:
                    row_id = int(row["id"])
                    if _matches_exact_post_filters(
                        row["prompt"],
                        row["loras"],
                        normalized_prompt_terms,
                        normalized_loras,
                    ):
                        if matched_count >= normalized_offset:
                            ids.append(row_id)
                            if result_limit is not None and len(ids) >= result_limit:
                                return ids
                        matched_count += 1
            else:
                ids.extend(int(row["id"]) for row in rows)
                if result_limit is not None and len(ids) >= result_limit:
                    return ids[:result_limit]

        return ids


def get_images_paginated(
    generators: Optional[List[str]] = None,
    tags: Optional[List[str]] = None,
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
    aspect_ratio: Optional[str] = None,
    artist: Optional[str] = None,
    skip_count: bool = False,  # Option to skip expensive COUNT query
    min_aesthetic: Optional[float] = None,
    max_aesthetic: Optional[float] = None,
    include_unreadable: bool = False,
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
        needs_post_filter = bool(prompt_terms) or bool(loras)
        select_cols = _IMAGE_COLUMNS_FULL if needs_post_filter else _IMAGE_COLUMNS_LIGHTWEIGHT

        # Build base query with sorting subqueries
        query = _build_base_query(sort_by, select_cols)

        # Initialize conditions and params
        conditions: List[str] = []
        params: List[Any] = []

        # Apply tag filter (JOIN)
        query, params = _apply_tag_filter(query, tags, params)

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
        conditions, params = _apply_prompt_terms_filter(conditions, params, prompt_terms)

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
        if skip_count:
            total_count = -1  # Indicate count was skipped
        else:
            total_count = _get_filtered_count(
                conn, generators, tags, ratings, checkpoints, loras,
                search_query, prompt_terms, artist, min_width, max_width,
                min_height, max_height, aspect_ratio, include_unreadable
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
) -> int:
    """Get total count for filtered images.

    Uses simplified query for performance on large datasets.
    """
    cursor = conn.cursor()

    query = "SELECT COUNT(DISTINCT i.id) FROM images i"
    conditions: List[str] = []
    params: List[Any] = []

    # Apply tag filter (JOIN)
    query, params = _apply_tag_filter(query, tags, params)

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
    conditions, params = _apply_prompt_terms_filter(conditions, params, prompt_terms)

    # Apply dimension filters
    conditions, params = _apply_dimension_filters(
        conditions, params,
        min_width, max_width, min_height, max_height, aspect_ratio
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


def copy_image_derived_state(source_image_id: int, target_image_id: int) -> None:
    """Copy cached derived fields that remain valid for file duplicates."""
    if source_image_id == target_image_id:
        return

    with get_db() as conn:
        cursor = conn.cursor()
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
    global _tags_cache_data, _tags_cache_timestamp
    
    current_time = time.time()
    
    # Check cache
    with _tags_cache_lock:
        if _tags_cache_data is not None and (current_time - _tags_cache_timestamp) < _TAGS_CACHE_TTL:
            return _tags_cache_data
    
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
        _tags_cache_data = result
        _tags_cache_timestamp = current_time
    
    return result


def _query_indexed_facet(
    *,
    table: str,
    value_column: str,
    output_key: str,
    limit: Optional[int] = None,
) -> Dict[str, Any]:
    normalized_limit = max(0, int(limit or 0))

    with get_db() as conn:
        cursor = conn.cursor()
        total_row = cursor.execute(f"SELECT COUNT(DISTINCT {value_column}) FROM {table}").fetchone()
        total = int(total_row[0] or 0) if total_row else 0

        query = f"""
            SELECT {value_column} AS {output_key}, COUNT(*) AS count
            FROM {table}
            GROUP BY {value_column}
            ORDER BY count DESC, {value_column} ASC
        """
        params: list[Any] = []
        if normalized_limit > 0:
            query += " LIMIT ?"
            params.append(normalized_limit)

        cursor.execute(query, params)
        rows = _rows_to_dicts(cursor.fetchall())

    return {output_key + "s": rows, "total": total}


def get_all_prompt_tokens(*, limit: Optional[int] = None) -> Dict[str, Any]:
    """Get unique normalized prompt tokens from the indexed prompt-token table."""
    return _query_indexed_facet(
        table="image_prompt_tokens",
        value_column="token",
        output_key="prompt",
        limit=limit,
    )


def get_all_loras(*, limit: Optional[int] = None) -> Dict[str, Any]:
    """Get unique normalized LoRAs from the indexed image_loras table."""
    return _query_indexed_facet(
        table="image_loras",
        value_column="lora_name",
        output_key="lora",
        limit=limit,
    )


def get_all_generators() -> List[Dict[str, Any]]:
    """Get all generators with their counts."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT generator, COUNT(*) as count 
            FROM images 
            WHERE COALESCE(is_readable, 1) = 1
            GROUP BY generator 
            ORDER BY count DESC
        """)
        return _rows_to_dicts(cursor.fetchall())


def get_all_checkpoints() -> List[Dict[str, Any]]:
    """Get normalized checkpoint facets with counts for filtering and analytics."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT checkpoint_normalized, COUNT(*) as count
            FROM images
            WHERE checkpoint_normalized IS NOT NULL AND TRIM(checkpoint_normalized) != ''
            GROUP BY checkpoint_normalized
            ORDER BY count DESC, checkpoint_normalized COLLATE NOCASE ASC
            """
        )
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
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id FROM images WHERE COALESCE(is_readable, 1) = 1 ORDER BY id")
        return [row[0] for row in cursor.fetchall()]


def get_untagged_image_ids() -> List[int]:
    """Return IDs of images that have not been tagged yet.

    Lightweight counterpart to get_untagged_images(); callers fetch
    full rows in small batches to avoid OOM on large libraries.
    """
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id FROM images WHERE tagged_at IS NULL AND COALESCE(is_readable, 1) = 1 ORDER BY id")
        return [row[0] for row in cursor.fetchall()]


def update_image_path(image_id: int, new_path: str):
    """Update the path of an image (after moving)."""
    with get_db() as conn:
        cursor = conn.cursor()
        normalized_path = _normalize_indexed_image_path(new_path)
        new_filename = os.path.basename(normalized_path)
        cursor.execute(
            "UPDATE images SET path = ?, filename = ? WHERE id = ?",
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


def get_image_count() -> int:
    """Get total number of images in database."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) FROM images")
        return cursor.fetchone()[0]


# NOTE: init_db() is called by the lifespan handler in main.py.
# Do not call it at module import time to avoid side effects.
