"""
Query and filter builders for image SELECT statements.

Pure SQL-construction helpers: column-list constants, the base-query builder,
all ``_apply_*_filter`` functions, order-clause resolution, and the
post-filter/exact-match helpers. None of these open a database connection; the
cursor/connection-bearing read functions in ``db_images_read`` pass a live
connection into the few functions here that scan rows.

Depends on :mod:`db_core` (prompt-mode constants) and :mod:`db_helpers`
(normalization helpers); it must not import from ``database``.
"""
from typing import Optional, List, Dict, Any, Tuple

from utils.model_names import checkpoint_identity_key
from db_core import (
    PROMPT_MATCH_MODE_EXACT,
    PROMPT_MATCH_MODE_CONTAINS,
)
from db_helpers import (
    normalize_prompt_token,
    normalize_prompt_match_mode,
    escape_like_pattern,
    normalize_lora_name,
    normalize_checkpoint_name,
    extract_prompt_tokens,
    extract_lora_names,
    _rows_to_dicts,
)


VALID_SORT_OPTIONS = {
    "newest", "oldest", "name_asc", "name_desc", "generator", "generator_desc",
    "prompt_length", "prompt_length_asc", "tag_count", "tag_count_asc",
    "rating", "rating_desc", "character_count", "character_count_asc",
    "random", "file_size", "file_size_asc", "aesthetic", "aesthetic_asc",
    # v3.3.2 user star rating (FF-2)
    "user_rating", "user_rating_asc",
    # v3.2.1 color sorts
    "brightness", "brightness_asc",
    "saturation", "saturation_asc",
    "brightness_skew", "brightness_skew_asc",
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
    # v3.3.2 user star rating (FF-2): INTEGER 0-5, NOT NULL DEFAULT 0 (0 = unrated).
    "user_rating",
    # Color analysis (migration 010, v3.2.1). All nullable until backfill.
    "dominant_colors",
    "avg_brightness",
    "color_temperature",
    "color_saturation",
    "brightness_histogram",
    "brightness_skew",
    "brightness_distribution",
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
    # v3.3.2 user star rating (FF-2): 0-5, 0 = unrated.
    "user_rating",
    # Color summary for gallery list (v3.2.1). Histogram/skew skipped to keep row light.
    "dominant_colors",
    "avg_brightness",
    "color_temperature",
    "color_saturation",
    "brightness_distribution",
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
    # v3.3.2 user star rating (FF-2): 0-5, 0 = unrated.
    "user_rating",
    # Color summary for gallery list (v3.2.1). Histogram/skew skipped to keep row light.
    "dominant_colors",
    "avg_brightness",
    "color_temperature",
    "color_saturation",
    "brightness_distribution",
)


def _format_image_column_list(columns: Tuple[str, ...], *, alias: Optional[str] = None) -> str:
    """Return a comma-joined image column list, optionally qualified by an alias."""
    prefix = f"{alias}." if alias else ""
    return ", ".join(f"{prefix}{column}" for column in columns)


_IMAGE_COLUMNS_FULL = _format_image_column_list(_IMAGE_COLUMNS_BASE_FIELDS, alias="i")
_IMAGE_COLUMNS_WITH_PROMPT = _format_image_column_list(_IMAGE_COLUMNS_WITH_PROMPT_FIELDS, alias="i")
_IMAGE_COLUMNS_LIGHTWEIGHT = _format_image_column_list(_IMAGE_COLUMNS_LIGHTWEIGHT_FIELDS, alias="i")
_IMAGE_COLUMNS_BARE = _format_image_column_list(_IMAGE_COLUMNS_BASE_FIELDS)

# Minimal columns the missing-file reconnect flow consumes per candidate
# (id/path/filename plus the size + mtime fields used by image_service
# match logic). Kept narrow so large libraries do not load full rows.
_RECONNECT_CANDIDATE_FIELDS = (
    "id",
    "path",
    "filename",
    "file_size",
    "source_size",
    "source_mtime_ns",
    "source_file_mtime",
)
_RECONNECT_CANDIDATE_COLUMNS = _format_image_column_list(_RECONNECT_CANDIDATE_FIELDS)

_LIBRARY_ORDER_SQL_UNQUALIFIED = "COALESCE(library_order_time, created_at)"
_LIBRARY_ORDER_SQL = "COALESCE(i.library_order_time, i.created_at)"
_STABLE_RANDOM_ORDER_SQL = "((i.id * 1103515245 + 12345) & 2147483647)"
# Default ORDER BY clause; also the fallback for unknown sort keys. Defined
# once so the fallback stays a fixed constant rather than a per-call f-string.
_DEFAULT_ORDER_CLAUSE = f"{_LIBRARY_ORDER_SQL} DESC, i.id DESC"


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
        # LEFT JOIN + GROUP BY (COUNT DISTINCT) instead of a per-row correlated
        # subquery. COUNT(DISTINCT ...) keeps the count correct even when other
        # filters (tag-filter OR/AND joins, artist join) multiply rows; the
        # caller appends "GROUP BY i.id" after the WHERE clause (see
        # _group_by_clause). Zero-tag images keep tag_count = 0 via LEFT JOIN.
        return f"""SELECT {select_cols},
                   COUNT(DISTINCT _agg_tag.id) as tag_count
                   FROM images i
                   LEFT JOIN tags _agg_tag ON _agg_tag.image_id = i.id"""
    elif sort_by in ("character_count", "character_count_asc"):
        return f"""SELECT {select_cols},
                   COUNT(DISTINCT CASE WHEN _agg_char.tag LIKE '%character%' THEN _agg_char.id END) as char_count
                   FROM images i
                   LEFT JOIN tags _agg_char ON _agg_char.image_id = i.id"""
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
        return f"SELECT {select_cols} FROM images i"


def _group_by_clause(sort_by: str) -> str:
    """Return the GROUP BY fragment required by the base query, if any.

    Only the aggregate sort modes (``tag_count`` / ``character_count``) need a
    GROUP BY because they were rewritten from per-row correlated subqueries to a
    ``LEFT JOIN tags ... COUNT(DISTINCT ...)``. It must be appended *after* the
    WHERE clause and *before* ORDER BY/LIMIT. Every other sort (including the
    ``rating`` modes, which still use ``SELECT DISTINCT`` + ``EXISTS``) returns
    an empty string so the emitted SQL is unchanged from before this rewrite.
    """
    if sort_by in ("tag_count", "tag_count_asc", "character_count", "character_count_asc"):
        return " GROUP BY i.id"
    return ""


def _apply_tag_filter(query: str, tags: Optional[List[str]], params: List[Any],
                      tag_mode: str = "and") -> tuple:
    """Apply tag filtering with JOINs (AND logic) or subquery (OR logic).

    Args:
        query: Current query string
        tags: List of tags to filter by
        params: Current parameter list
        tag_mode: 'and' (image must have ALL tags) or 'or' (image must have ANY tag)

    Returns:
        Tuple of (modified query, modified params)
    """
    if not tags:
        return query, params

    if tag_mode == "or":
        placeholders = ",".join("?" * len(tags))
        query += f" INNER JOIN tags _tor ON i.id = _tor.image_id AND _tor.tag IN ({placeholders})"
        params.extend(tags)
    else:
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


def _apply_exclude_tags_filter(conditions: List[str], params: List[Any],
                               exclude_tags: Optional[List[str]]) -> tuple:
    """Exclude images that have ANY of the specified tags."""
    if not exclude_tags:
        return conditions, params
    placeholders = ",".join("?" * len(exclude_tags))
    # NOT EXISTS (instead of NOT IN) so the engine can use an index on
    # LOWER(tag) (idx_tags_lower_tag) instead of full-scanning tags. tags.image_id
    # is NOT NULL, so NOT EXISTS and the old NOT IN exclude exactly the same rows.
    conditions.append(
        f"NOT EXISTS (SELECT 1 FROM tags _ex_tag WHERE _ex_tag.image_id = i.id "
        f"AND LOWER(_ex_tag.tag) IN ({placeholders}))"
    )
    params.extend([t.lower() for t in exclude_tags])
    return conditions, params


def _apply_exclude_generators_filter(conditions: List[str], params: List[Any],
                                     exclude_generators: Optional[List[str]]) -> tuple:
    """Exclude images matching any of the specified generators."""
    if not exclude_generators:
        return conditions, params
    placeholders = ",".join("?" * len(exclude_generators))
    conditions.append(f"LOWER(i.generator) NOT IN ({placeholders})")
    params.extend([g.lower() for g in exclude_generators])
    return conditions, params


def _apply_exclude_ratings_filter(conditions: List[str], params: List[Any],
                                  exclude_ratings: Optional[List[str]]) -> tuple:
    """Exclude images that have ANY of the specified rating tags."""
    if not exclude_ratings:
        return conditions, params
    placeholders = ",".join("?" * len(exclude_ratings))
    # NOT EXISTS (instead of NOT IN) so the engine can use an index on
    # LOWER(tag) (idx_tags_lower_tag) instead of full-scanning tags. tags.image_id
    # is NOT NULL, so NOT EXISTS and the old NOT IN exclude exactly the same rows.
    conditions.append(
        f"NOT EXISTS (SELECT 1 FROM tags _ex_rating WHERE _ex_rating.image_id = i.id "
        f"AND LOWER(_ex_rating.tag) IN ({placeholders}))"
    )
    params.extend([r.lower() for r in exclude_ratings])
    return conditions, params


def _apply_exclude_checkpoints_filter(conditions: List[str], params: List[Any],
                                      exclude_checkpoints: Optional[List[str]]) -> tuple:
    """Exclude images matching any of the specified checkpoints."""
    if not exclude_checkpoints:
        return conditions, params
    normalized = []
    seen: set = set()
    for cp in exclude_checkpoints:
        n = normalize_checkpoint_name(cp)
        identity = checkpoint_identity_key(n)
        if not n or identity in seen:
            continue
        seen.add(identity)
        normalized.append(n)
    if not normalized:
        return conditions, params
    placeholders = ",".join("?" * len(normalized))
    conditions.append(f"i.checkpoint_normalized COLLATE NOCASE NOT IN ({placeholders})")
    params.extend(normalized)
    return conditions, params


def _apply_exclude_loras_filter(conditions: List[str], params: List[Any],
                                exclude_loras: Optional[List[str]]) -> tuple:
    """Exclude images that have ANY of the specified LoRAs."""
    if not exclude_loras:
        return conditions, params
    for lora in exclude_loras:
        lora_normalized = normalize_lora_name(lora)
        conditions.append(
            "NOT EXISTS (SELECT 1 FROM image_loras il WHERE il.image_id = i.id AND LOWER(il.lora_name) = ?)"
        )
        params.append(lora_normalized)
    return conditions, params


def _apply_exclude_prompts_filter(conditions: List[str], params: List[Any],
                                  exclude_prompts: Optional[List[str]],
                                  prompt_match_mode: str = PROMPT_MATCH_MODE_EXACT) -> tuple:
    """Exclude images whose prompt matches ANY of the specified terms.

    v3.3.0 FEAT-EXCLUDE-EXTRA: the negation of _apply_prompt_terms_filter.
    'contains' mode does a normalized substring NOT LIKE on the raw prompt;
    'exact' mode excludes any image with a matching prompt token.
    """
    if not exclude_prompts:
        return conditions, params
    match_mode = normalize_prompt_match_mode(prompt_match_mode)
    for term in exclude_prompts:
        normalized_term = normalize_prompt_token(term)
        if not normalized_term:
            continue
        if match_mode == PROMPT_MATCH_MODE_CONTAINS:
            conditions.append(
                "LOWER(REPLACE(COALESCE(i.prompt, ''), '_', ' ')) NOT LIKE ? ESCAPE '\\'"
            )
            params.append(f"%{escape_like_pattern(normalized_term)}%")
        else:
            conditions.append(
                "NOT EXISTS (SELECT 1 FROM image_prompt_tokens ipt "
                "WHERE ipt.image_id = i.id AND ipt.token LIKE ? ESCAPE '\\')"
            )
            params.append(f"%{escape_like_pattern(normalized_term)}%")
    return conditions, params


def _apply_exclude_colors_filter(conditions: List[str], params: List[Any],
                                 exclude_colors: Optional[List[str]]) -> tuple:
    """Exclude images whose color_temperature is ANY of the specified values.

    v3.3.0 FEAT-EXCLUDE-EXTRA: the negation of the color_temperature side of
    _apply_color_filter. Values are warm/cool/neutral (others are ignored).
    Images with NULL color_temperature are NOT excluded (they simply lack the
    attribute, mirroring how the include filter only matches non-null rows).
    """
    if not exclude_colors:
        return conditions, params
    valid = {"warm", "cool", "neutral"}
    normalized = [c.lower() for c in exclude_colors if c and c.lower() in valid]
    if not normalized:
        return conditions, params
    placeholders = ",".join("?" * len(normalized))
    conditions.append(
        f"(i.color_temperature IS NULL OR i.color_temperature NOT IN ({placeholders}))"
    )
    params.extend(normalized)
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

    raw_search = str(search_query or "").strip()
    normalized_search = normalize_prompt_token(raw_search)
    checkpoint_search = checkpoint_identity_key(raw_search) or raw_search.lower()
    prompt_tokens = sorted(extract_prompt_tokens(raw_search) or [])
    if not prompt_tokens and normalized_search:
        prompt_tokens = [normalized_search]

    token_conditions: List[str] = []
    token_params: List[Any] = []
    for token in prompt_tokens[:8]:
        token_like = f"%{escape_like_pattern(token)}%"
        token_conditions.append(
            "EXISTS (SELECT 1 FROM image_prompt_tokens ipt "
            "WHERE ipt.image_id = i.id AND ipt.token LIKE ? ESCAPE '\\')"
        )
        token_params.append(token_like)

    prompt_clause = " OR ".join(token_conditions)
    if prompt_clause:
        prompt_clause = f" OR ({prompt_clause})"

    conditions.append(
        "("
        "LOWER(i.filename) LIKE ? ESCAPE '\\' "
        "OR LOWER(COALESCE(i.checkpoint_normalized, '')) LIKE ? ESCAPE '\\'"
        f"{prompt_clause}"
        ")"
    )
    params.extend(
        [
            f"%{escape_like_pattern(raw_search.lower())}%",
            f"%{escape_like_pattern(checkpoint_search)}%",
        ]
    )
    params.extend(token_params)

    return conditions, params


def _apply_prompt_terms_filter(conditions: List[str], params: List[Any],
                               prompt_terms: Optional[List[str]],
                               prompt_match_mode: str = PROMPT_MATCH_MODE_EXACT) -> tuple:
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

    match_mode = normalize_prompt_match_mode(prompt_match_mode)
    for term in prompt_terms:
        normalized_term = normalize_prompt_token(term)
        if not normalized_term:
            continue
        if match_mode == PROMPT_MATCH_MODE_CONTAINS:
            conditions.append("LOWER(REPLACE(COALESCE(i.prompt, ''), '_', ' ')) LIKE ? ESCAPE '\\'")
            params.append(f"%{escape_like_pattern(normalized_term)}%")
        else:
            conditions.append(
                "EXISTS (SELECT 1 FROM image_prompt_tokens ipt "
                "WHERE ipt.image_id = i.id AND ipt.token LIKE ? ESCAPE '\\')"
            )
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


def _apply_user_rating_filter(conditions: List[str], params: List[Any],
                              min_user_rating: Optional[int]) -> tuple:
    """Apply the gallery "★≥N" user-rating filter (v3.3.2, FF-2).

    ``user_rating`` is NOT NULL DEFAULT 0, so no NULL guard is needed. A
    ``min_user_rating`` of None or 0 is a no-op that keeps unrated images in;
    only a value >= 1 narrows results to images rated at least that many stars.
    """
    if min_user_rating is not None and int(min_user_rating) > 0:
        conditions.append("i.user_rating >= ?")
        params.append(int(min_user_rating))
    return conditions, params


def _apply_color_filter(conditions: List[str], params: List[Any],
                        brightness_min: Optional[float] = None,
                        brightness_max: Optional[float] = None,
                        color_temperature: Optional[str] = None,
                        brightness_distribution: Optional[str] = None) -> tuple:
    """Apply v3.2.1 color-based filters (brightness range, temperature, distribution shape)."""
    if brightness_min is not None:
        conditions.append("i.avg_brightness IS NOT NULL AND i.avg_brightness >= ?")
        params.append(float(brightness_min))
    if brightness_max is not None:
        conditions.append("i.avg_brightness IS NOT NULL AND i.avg_brightness <= ?")
        params.append(float(brightness_max))
    if color_temperature:
        valid = {"warm", "cool", "neutral"}
        if color_temperature.lower() in valid:
            conditions.append("i.color_temperature = ?")
            params.append(color_temperature.lower())
    if brightness_distribution:
        valid_dist = {"left_heavy", "right_heavy", "middle_heavy", "edge_heavy", "balanced"}
        if brightness_distribution.lower() in valid_dist:
            conditions.append("i.brightness_distribution = ?")
            params.append(brightness_distribution.lower())
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

    if "SELECT DISTINCT" not in query:
        query = query.replace("SELECT ", "SELECT DISTINCT ", 1)
    query += " INNER JOIN artist_predictions ap ON i.id = ap.image_id"
    conditions.append("ap.artist = ?")
    params.append(artist)

    return query, conditions, params


def _normalize_filter_id_list(values: Optional[List[int]]) -> List[int]:
    if values is None:
        return []

    normalized: List[int] = []
    seen: set[int] = set()
    for value in values:
        try:
            image_id = int(value)
        except (TypeError, ValueError):
            continue
        if image_id <= 0 or image_id in seen:
            continue
        seen.add(image_id)
        normalized.append(image_id)
    return normalized


def _apply_id_list_filter(
    conditions: List[str],
    params: List[Any],
    image_ids: Optional[List[int]],
    *,
    include: bool,
) -> tuple:
    normalized_ids = _normalize_filter_id_list(image_ids)
    if not normalized_ids:
        if include and image_ids is not None:
            conditions.append("0 = 1")
        return conditions, params

    placeholders = ",".join("?" * len(normalized_ids))
    operator = "IN" if include else "NOT IN"
    conditions.append(f"i.id {operator} ({placeholders})")
    params.extend(normalized_ids)
    return conditions, params


def _apply_image_ids_filter(conditions: List[str], params: List[Any],
                            image_ids: Optional[List[int]]) -> tuple:
    """Apply image ID include filtering."""
    return _apply_id_list_filter(conditions, params, image_ids, include=True)


def _apply_excluded_image_ids_filter(conditions: List[str], params: List[Any],
                                     excluded_image_ids: Optional[List[int]]) -> tuple:
    """Apply image ID exclusion filtering."""
    return _apply_id_list_filter(conditions, params, excluded_image_ids, include=False)


def _apply_collection_filter(conditions: List[str], params: List[Any],
                             collection_id: Optional[int]) -> tuple:
    """Restrict results to images belonging to a collection (v3.3.1).

    Membership is a reference row in ``collection_items`` (see db_collections.py),
    so this composes with every other filter at the SQL level and stays correct
    under cursor pagination. ``None`` (or a non-positive id) is a no-op, leaving
    the gallery's normal unfiltered listing untouched.
    """
    if collection_id is None:
        return conditions, params
    try:
        cid = int(collection_id)
    except (TypeError, ValueError):
        return conditions, params
    if cid <= 0:
        return conditions, params
    conditions.append(
        "i.id IN (SELECT ci.source_image_id FROM collection_items ci "
        "WHERE ci.collection_id = ?)"
    )
    params.append(cid)
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
        "newest": _DEFAULT_ORDER_CLAUSE,
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
        "random": f"{_STABLE_RANDOM_ORDER_SQL} ASC, i.id ASC",
        "file_size": "i.file_size DESC, i.id DESC",
        "file_size_asc": "i.file_size ASC, i.id ASC",
        "aesthetic": "COALESCE(i.aesthetic_score, 0) DESC, i.id DESC",
        "aesthetic_asc": "COALESCE(i.aesthetic_score, 0) ASC, i.id ASC",
        # v3.3.2 user star rating (FF-2). user_rating is NOT NULL DEFAULT 0.
        "user_rating": "i.user_rating DESC, i.id DESC",
        "user_rating_asc": "i.user_rating ASC, i.id ASC",
        # v3.2.1 color sorts
        "brightness": "COALESCE(i.avg_brightness, -1) DESC, i.id DESC",
        "brightness_asc": "COALESCE(i.avg_brightness, 999) ASC, i.id ASC",
        "saturation": "COALESCE(i.color_saturation, -1) DESC, i.id DESC",
        "saturation_asc": "COALESCE(i.color_saturation, 999) ASC, i.id ASC",
        "brightness_skew": "COALESCE(i.brightness_skew, -999) DESC, i.id DESC",
        "brightness_skew_asc": "COALESCE(i.brightness_skew, 999) ASC, i.id ASC",
    }
    return sort_options.get(sort_by, _DEFAULT_ORDER_CLAUSE)


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
    prompt_match_mode: str = PROMPT_MATCH_MODE_EXACT,
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

        batch = _post_filter_results(
            _rows_to_dicts(rows),
            prompt_terms,
            loras,
            0,
            0,
            prompt_match_mode=prompt_match_mode,
        )
        collected.extend(batch)
        if target_count is not None and len(collected) >= target_count:
            break

        if len(rows) < effective_fetch_size:
            break
        raw_offset += effective_fetch_size

    if normalized_limit == 0:
        return collected[normalized_offset:]
    return collected[normalized_offset:normalized_offset + normalized_limit]


def _fetch_post_filtered_ids(
    conn,
    base_query: str,
    base_params: List[Any],
    order_clause: str,
    prompt_terms: Optional[List[str]],
    loras: Optional[List[str]],
    *,
    prompt_match_mode: str = PROMPT_MATCH_MODE_EXACT,
    post_offset: int = 0,
    limit: Optional[int] = None,
    fetch_size: int = 5000,
) -> List[int]:
    """Fetch exact post-filtered IDs without materializing full image rows."""
    normalized_offset = max(0, int(post_offset or 0))
    normalized_limit = None if limit is None else max(0, int(limit))
    if normalized_limit == 0:
        return []

    target_count = None if normalized_limit is None else normalized_offset + normalized_limit
    effective_fetch_size = max(1, int(fetch_size or 5000))
    normalized_prompt_terms = [normalize_prompt_token(t) for t in (prompt_terms or [])]
    normalized_loras = [normalize_lora_name(l) for l in (loras or [])]

    cursor = conn.cursor()
    raw_offset = 0
    matched_ids: List[int] = []

    while True:
        query = f"{base_query} ORDER BY {order_clause} LIMIT ? OFFSET ?"
        params = list(base_params) + [effective_fetch_size, raw_offset]
        cursor.execute(query, params)
        rows = cursor.fetchall()
        if not rows:
            break

        for row in rows:
            if _matches_exact_post_filters(
                row["prompt"],
                row["loras"],
                normalized_prompt_terms,
                normalized_loras,
                prompt_match_mode=prompt_match_mode,
            ):
                matched_ids.append(int(row["id"]))
                if target_count is not None and len(matched_ids) >= target_count:
                    return matched_ids[normalized_offset:]

        if len(rows) < effective_fetch_size:
            break
        raw_offset += effective_fetch_size

    if normalized_limit is None:
        return matched_ids[normalized_offset:]
    return matched_ids[normalized_offset:normalized_offset + normalized_limit]


def _matches_exact_post_filters(
    prompt: Optional[str],
    lora_text: Optional[str],
    normalized_prompt_terms: List[str],
    normalized_loras: List[str],
    *,
    prompt_match_mode: str = PROMPT_MATCH_MODE_EXACT,
) -> bool:
    """Apply the exact prompt/LORA matching semantics used by post-filter paths."""
    if normalized_prompt_terms:
        if normalize_prompt_match_mode(prompt_match_mode) == PROMPT_MATCH_MODE_CONTAINS:
            normalized_prompt = normalize_prompt_token(prompt or "")
            if not all(term in normalized_prompt for term in normalized_prompt_terms):
                return False
        else:
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
                         limit: int,
                         *,
                         prompt_match_mode: str = PROMPT_MATCH_MODE_EXACT) -> List[Dict[str, Any]]:
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
            prompt_match_mode=prompt_match_mode,
        ):
            filtered_results.append(img)

        if early_stop_count and len(filtered_results) >= early_stop_count:
            break

    return filtered_results[offset:offset + limit] if limit else filtered_results[offset:]
