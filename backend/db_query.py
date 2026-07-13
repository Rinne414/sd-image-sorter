"""Query and filter builder facade. Split (2026-07) into five sibling modules:

* ``db_query_columns``         — ``VALID_SORT_OPTIONS``, the column field
  tuples, ``_format_image_column_list`` and the derived column-list strings,
  the reconnect-candidate columns, and the order-SQL constants
* ``db_query_base``            — ``_build_base_query`` / ``_group_by_clause``
  / ``_get_order_clause`` / ``_supports_cursor_sort``
* ``db_query_filters``         — the include-side ``_apply_*`` filters,
  ``_HAS_METADATA_CLAUSE``, and the id-list core
* ``db_query_filters_exclude`` — the seven ``_apply_exclude_*`` filters
* ``db_query_post``            — the ``_fetch_post_filtered_*`` scanners and
  the exact prompt/LoRA post-filter matchers

This file stays the import surface: ``db_images_query`` (38 names),
``db_images_paginate`` (36), ``db_images_lookup`` (2), and ``database.py``
(43) all origin-import from here BY REFERENCE — a 55-name identity union —
and the contract ``consumer.X is db_query.X`` for every one of those names
is locked by tests/test_db_query_pins.py (TestReExportIdentityUnion).
"""
from db_query_columns import (
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
)
from db_query_base import (
    _build_base_query,
    _group_by_clause,
    _get_order_clause,
    _supports_cursor_sort,
)
from db_query_filters import (
    _apply_tag_filter,
    _apply_generator_filter,
    _apply_rating_filter,
    _apply_checkpoint_filter,
    _apply_lora_filter,
    _apply_search_filter,
    _apply_folder_filter,
    _apply_prompt_terms_filter,
    _apply_dimension_filters,
    _apply_aesthetic_filter,
    _apply_date_filter,
    _apply_saturation_filter,
    _apply_no_caption_filter,
    _apply_seed_filter,
    _apply_user_rating_filter,
    _HAS_METADATA_CLAUSE,
    _apply_metadata_presence_filter,
    _apply_color_filter,
    _apply_color_hues_filter,
    _apply_artist_filter,
    _normalize_filter_id_list,
    _apply_id_list_filter,
    _apply_image_ids_filter,
    _apply_excluded_image_ids_filter,
    _apply_collection_filter,
    _apply_readable_filter,
)
from db_query_filters_exclude import (
    _apply_exclude_tags_filter,
    _apply_exclude_generators_filter,
    _apply_exclude_ratings_filter,
    _apply_exclude_checkpoints_filter,
    _apply_exclude_loras_filter,
    _apply_exclude_prompts_filter,
    _apply_exclude_colors_filter,
)
from db_query_post import (
    _fetch_post_filtered_page,
    _fetch_post_filtered_ids,
    _matches_exact_post_filters,
    _post_filter_results,
)
