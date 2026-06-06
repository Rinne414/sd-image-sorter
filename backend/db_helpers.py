"""
Pure helper functions for the database layer.

These functions perform path normalization, prompt/LoRA token extraction,
row coercion, and source-fingerprint/derived-state predicates. They never open
a database connection (``get_db``) themselves; cursor-taking mutators that issue
SQL live in the write module instead.

Depends only on :mod:`db_core` (for the prompt-mode constants) plus stdlib and
``utils`` helpers, keeping it low in the dependency graph.
"""
import sqlite3
import json
import logging
import re
from typing import Optional, List, Dict, Any, Tuple

from utils.source_paths import (
    build_indexed_folder_scope_query_patterns,
    build_indexed_image_lookup_candidates,
    indexed_image_path_match_key,
    is_case_insensitive_indexed_path,
    normalize_indexed_image_path,
)
from utils.model_names import (
    normalize_checkpoint_name as _normalize_checkpoint_name,
)
from db_core import (
    PROMPT_MATCH_MODE_EXACT,
    VALID_PROMPT_MATCH_MODES,
)


logger = logging.getLogger(__name__)


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


def _folder_scope_query_match_clause(
    folder_path: str, column: str = "path"
) -> Tuple[str, List[str]]:
    """Build a SQL clause plus patterns for equivalent indexed folder scopes.

    ``column`` lets callers qualify the path column (e.g. ``i.path`` for the
    aliased gallery list/count queries); it defaults to a bare ``path`` so the
    existing reconnect-missing-files callers are unchanged.
    """
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
        clauses.append(f"{column} IN ({placeholders})")
        params.extend(exact_candidates)
    if prefix_candidates:
        like_clause = " OR ".join(f"{column} LIKE ?" for _ in prefix_candidates)
        clauses.append(f"({like_clause})")
        params.extend(prefix_candidates)
    if exact_casefold_candidates:
        placeholders = ",".join("?" * len(exact_casefold_candidates))
        clauses.append(f"LOWER({column}) IN ({placeholders})")
        params.extend(exact_casefold_candidates)
    if prefix_casefold_candidates:
        like_clause = " OR ".join(f"LOWER({column}) LIKE ?" for _ in prefix_casefold_candidates)
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
    except Exception as exc:
        # Log so a recurring fingerprint failure (e.g., corrupt image, missing PIL backend)
        # is visible to operators. Returning None keeps callers' contract intact, but the
        # warning ensures stale derived-state caches do not get masked silently.
        logger.warning(
            "Could not compute content fingerprint for image_id=%s: %s",
            image_id,
            exc,
        )
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


def normalize_prompt_match_mode(mode: Optional[str]) -> str:
    """Normalize prompt filter matching mode, preserving exact matching as the default."""
    normalized = str(mode or PROMPT_MATCH_MODE_EXACT).strip().lower()
    return normalized if normalized in VALID_PROMPT_MATCH_MODES else PROMPT_MATCH_MODE_EXACT


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
            logger.debug("Skipping unparseable loras_json in extract_lora_names: %s", e)

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
