"""Cursor pagination for the image gallery (split from db_images_read.py).

``get_images_paginated`` and its private first-page COUNT moved here verbatim
in the 2026-07 db_images_read split. ``_get_filtered_count`` MUST stay
co-located in this module: ``get_images_paginated`` calls it as a
module-local name, and tests patch behavior via the ``database.X`` aliases,
which never reach origin-module bindings — the intra-module direct call is
the only patch-safe shape (tests/test_db_images_read_pins.py). Consumers keep
importing through the ``database`` facade; do not import this module directly
from feature code.

Imports only from db_core / db_helpers / db_query / utils / stdlib to avoid
an import cycle with the ``database`` facade.
"""
from typing import Optional, List, Dict, Any

from db_core import (
    PROMPT_MATCH_MODE_EXACT,
    get_db,
)
from db_helpers import (
    normalize_prompt_match_mode,
    _rows_to_dicts,
)
from db_query import (
    _IMAGE_COLUMNS_FULL,
    _IMAGE_COLUMNS_LIGHTWEIGHT,
    _LIBRARY_ORDER_SQL_UNQUALIFIED,
    _apply_date_filter,
    _build_base_query,
    _group_by_clause,
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
    _apply_exclude_prompts_filter,
    _apply_exclude_colors_filter,
    _apply_color_hues_filter,
    _apply_search_filter,
    _apply_prompt_terms_filter,
    _apply_dimension_filters,
    _apply_aesthetic_filter,
    _apply_saturation_filter,
    _apply_no_caption_filter,
    _apply_seed_filter,
    _apply_user_rating_filter,
    _apply_color_filter,
    _apply_artist_filter,
    _apply_collection_filter,
    _apply_folder_filter,
    _apply_metadata_presence_filter,
    _apply_readable_filter,
    _get_order_clause,
    _supports_cursor_sort,
    _fetch_post_filtered_page,
)
from utils.pagination_cursor import encode_image_cursor_from_image


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
    date_from: Optional[str] = None,  # inclusive YYYY-MM-DD (file time)
    date_to: Optional[str] = None,  # inclusive YYYY-MM-DD (file time)
    min_user_rating: Optional[int] = None,  # v3.3.2 FF-2: gallery "★≥N" filter
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
    exclude_prompts: Optional[List[str]] = None,
    exclude_colors: Optional[List[str]] = None,
    color_hues: Optional[List[str]] = None,  # v3.5.0 dominant-hue include
    exclude_color_hues: Optional[List[str]] = None,  # v3.5.0 dominant-hue exclude
    collection_id: Optional[int] = None,
    folder: Optional[str] = None,  # v3.3.2 Library Navigation: recursive folder-subtree scope
    has_metadata: Optional[bool] = None,  # v3.3.2 small-opt: "has SD generation parameters" filter
    # Aurora Phase 3 gallery filters
    no_caption: Optional[bool] = None,
    aesthetic_unscored: Optional[bool] = None,
    min_saturation: Optional[float] = None,
    max_saturation: Optional[float] = None,
    seed: Optional[int] = None,
) ->Dict[str, Any]:
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
            conditions, params, min_aesthetic, max_aesthetic, aesthetic_unscored
        )
        conditions, params = _apply_date_filter(
            conditions, params, date_from, date_to
        )
        conditions, params = _apply_user_rating_filter(
            conditions, params, min_user_rating
        )
        # Aurora Phase 3 gallery filters (saturation range, caption presence, seed)
        conditions, params = _apply_saturation_filter(
            conditions, params, min_saturation, max_saturation
        )
        conditions, params = _apply_no_caption_filter(conditions, params, no_caption)
        conditions, params = _apply_seed_filter(conditions, params, seed)

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
        conditions, params = _apply_exclude_prompts_filter(conditions, params, exclude_prompts, prompt_match_mode)
        conditions, params = _apply_exclude_colors_filter(conditions, params, exclude_colors)
        conditions, params = _apply_color_hues_filter(conditions, params, color_hues, exclude_color_hues)
        conditions, params = _apply_collection_filter(conditions, params, collection_id)

        # Apply artist filter (JOIN)
        query, conditions, params = _apply_artist_filter(query, conditions, params, artist)

        # Apply folder-subtree scope (v3.3.2 Library Navigation)
        conditions, params = _apply_folder_filter(conditions, params, folder)
        # Apply "has SD generation parameters" scope (v3.3.2 small-opt)
        conditions, params = _apply_metadata_presence_filter(conditions, params, has_metadata)

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

        # Aggregate sorts (tag_count/character_count) need GROUP BY after WHERE.
        query += _group_by_clause(sort_by)

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
                min_user_rating=min_user_rating,
                prompt_match_mode=normalized_prompt_match_mode,
                collection_id=collection_id,
                folder=folder,
                has_metadata=has_metadata,
                no_caption=no_caption,
                aesthetic_unscored=aesthetic_unscored,
                date_from=date_from,
                date_to=date_to,
                min_saturation=min_saturation,
                max_saturation=max_saturation,
                seed=seed,
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
            color_hues=color_hues,
            exclude_color_hues=exclude_color_hues,
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
    date_from: Optional[str] = None,  # inclusive YYYY-MM-DD (file time)
    date_to: Optional[str] = None,  # inclusive YYYY-MM-DD (file time)
    min_user_rating: Optional[int] = None,  # v3.3.2 FF-2: gallery "★≥N" filter
    prompt_match_mode: str = PROMPT_MATCH_MODE_EXACT,
    collection_id: Optional[int] = None,
    folder: Optional[str] = None,  # v3.3.2 Library Navigation: recursive folder-subtree scope
    has_metadata: Optional[bool] = None,  # v3.3.2 small-opt: "has SD generation parameters" filter
    # Aurora Phase 3 gallery filters. Mirrored here so the cursor-pagination
    # first-page COUNT matches the page query when these filters are active.
    no_caption: Optional[bool] = None,
    aesthetic_unscored: Optional[bool] = None,
    min_saturation: Optional[float] = None,
    max_saturation: Optional[float] = None,
    seed: Optional[int] = None,
    # v3.2.1 color filters + v3.2.2 per-item exclude filters. Added here so the
    # cursor-pagination first-page COUNT matches the page query (it previously
    # omitted these, so an active color/exclude filter under newest/oldest sort
    # produced an inflated "total" that looked like the filter wasn't applied).
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
    color_hues: Optional[List[str]] = None,  # v3.5.0 dominant-hue include
    exclude_color_hues: Optional[List[str]] = None,  # v3.5.0 dominant-hue exclude
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
        conditions, params, min_aesthetic, max_aesthetic, aesthetic_unscored
    )
    conditions, params = _apply_date_filter(
        conditions, params, date_from, date_to
    )
    conditions, params = _apply_user_rating_filter(
        conditions, params, min_user_rating
    )
    # Aurora Phase 3 gallery filters (saturation range, caption presence, seed)
    conditions, params = _apply_saturation_filter(
        conditions, params, min_saturation, max_saturation
    )
    conditions, params = _apply_no_caption_filter(conditions, params, no_caption)
    conditions, params = _apply_seed_filter(conditions, params, seed)

    # Apply v3.2.1 color filters (mirror get_filtered_image_count so the
    # cursor-path total matches the page query).
    conditions, params = _apply_color_filter(
        conditions, params,
        brightness_min, brightness_max, color_temperature, brightness_distribution,
    )

    # Apply v3.2.2 per-item exclude filters.
    conditions, params = _apply_exclude_tags_filter(conditions, params, exclude_tags)
    conditions, params = _apply_exclude_generators_filter(conditions, params, exclude_generators)
    conditions, params = _apply_exclude_ratings_filter(conditions, params, exclude_ratings)
    conditions, params = _apply_exclude_checkpoints_filter(conditions, params, exclude_checkpoints)
    conditions, params = _apply_exclude_loras_filter(conditions, params, exclude_loras)
    conditions, params = _apply_exclude_prompts_filter(conditions, params, exclude_prompts, prompt_match_mode)
    conditions, params = _apply_exclude_colors_filter(conditions, params, exclude_colors)

    # Apply v3.5.0 dominant-hue filters (mirror get_filtered_image_count so the
    # cursor-path total matches the page query; previously omitted, so an active
    # hue filter under newest/oldest sort returned an inflated total).
    conditions, params = _apply_color_hues_filter(conditions, params, color_hues, exclude_color_hues)

    # Apply artist filter (JOIN)
    query, conditions, params = _apply_artist_filter(query, conditions, params, artist)

    # v3.3.1: restrict the count to a collection's members so the gallery's
    # "total" matches the collection-scoped page query (mirrors get_images_paginated).
    conditions, params = _apply_collection_filter(conditions, params, collection_id)

    # Apply folder-subtree scope (v3.3.2 Library Navigation)
    conditions, params = _apply_folder_filter(conditions, params, folder)
    # Apply "has SD generation parameters" scope (v3.3.2 small-opt)
    conditions, params = _apply_metadata_presence_filter(conditions, params, has_metadata)

    if conditions:
        query += " WHERE " + " AND ".join(conditions)

    cursor.execute(query, params)
    result = cursor.fetchone()
    return result[0] if result else 0
