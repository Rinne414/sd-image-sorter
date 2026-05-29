"""Image read/query operations.

Extracted from ``database.py`` as part of the database module split. This module
holds image listing, filtered counts/IDs, pagination, single-image lookups,
ID-chunk iterators, and folder-scope/reconnect candidate reads.

Imports only from db_core / db_helpers / db_query / utils / stdlib to avoid an
import cycle with the ``database`` facade.
"""
from typing import Optional, List, Dict, Any, Iterator

from db_core import (
    PROMPT_MATCH_MODE_EXACT,
    get_db,
)
from db_helpers import (
    _path_query_match_clause,
    _folder_scope_query_match_clause,
    normalize_prompt_match_mode,
    _row_to_dict,
    _rows_to_dicts,
)
from db_query import (
    _IMAGE_COLUMNS_FULL,
    _IMAGE_COLUMNS_WITH_PROMPT,
    _IMAGE_COLUMNS_LIGHTWEIGHT,
    _IMAGE_COLUMNS_BARE,
    _RECONNECT_CANDIDATE_COLUMNS,
    _LIBRARY_ORDER_SQL_UNQUALIFIED,
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
    _apply_image_ids_filter,
    _apply_excluded_image_ids_filter,
    _apply_readable_filter,
    _get_order_clause,
    _supports_cursor_sort,
    _fetch_post_filtered_page,
    _fetch_post_filtered_ids,
)
from utils.source_paths import (
    build_indexed_image_lookup_candidates,
    indexed_image_path_match_key,
    is_indexed_image_path_in_folder_scope,
)
from utils.pagination_cursor import encode_image_cursor_from_image


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


def get_image_count() -> int:
    """Get total number of images in database."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) FROM images")
        return cursor.fetchone()[0]
