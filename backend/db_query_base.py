"""Base-query / GROUP BY / ORDER BY / cursor-support resolvers (split from db_query.py).

``_build_base_query``, ``_group_by_clause``, ``_get_order_clause``, and
``_supports_cursor_sort`` moved here verbatim in the 2026-07 db_query split.
The sort-key set and order-SQL constants they interpolate stay in
``db_query_columns`` and are imported by reference. Consumers keep importing
through the ``db_query`` facade; do not import this module directly from
feature code.

Imports only from db_query_columns / stdlib to avoid an import cycle with
the ``database`` facade.
"""
from db_query_columns import (
    VALID_SORT_OPTIONS,
    _LIBRARY_ORDER_SQL,
    _STABLE_RANDOM_ORDER_SQL,
    _DEFAULT_ORDER_CLAUSE,
)


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
        # Priority: explicit > questionable > sensitive > general > unrated.
        # BE-3: reads the denormalized images.ai_rating column (migration 026,
        # kept in sync by db_tags._sync_ai_rating) instead of 4 correlated
        # EXISTS probes per row. DISTINCT retained: tag-filter INNER JOINs can
        # still multiply rows in this sort mode.
        return f"""SELECT DISTINCT {select_cols},
                   CASE i.ai_rating
                       WHEN 'explicit' THEN 1
                       WHEN 'questionable' THEN 2
                       WHEN 'sensitive' THEN 3
                       WHEN 'general' THEN 4
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
    ``rating`` modes, which still use ``SELECT DISTINCT`` over ai_rating) return
    an empty string so the emitted SQL is unchanged from before this rewrite.
    """
    if sort_by in ("tag_count", "tag_count_asc", "character_count", "character_count_asc"):
        return " GROUP BY i.id"
    return ""

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
