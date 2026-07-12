"""Tag write/read and indexed-facet query operations.

Extracted from ``database.py`` as part of the database module split. This module
holds tag replacement (add_tags / add_tags_batch), tag/facet reads, and the
shared facet-search ranking helpers.

Imports only from db_core / db_helpers / db_images_write / utils / stdlib to
avoid an import cycle with the ``database`` facade.
"""
import time
from typing import Optional, List, Dict, Any, Tuple

import db_core
from db_core import (
    _tags_cache_lock,
    _TAGS_CACHE_TTL,
    _generators_cache_lock,
    _invalidate_tags_cache,
    get_db,
)
from db_helpers import (
    _ensure_content_fingerprint_value,
    normalize_prompt_token,
    escape_like_pattern,
    _rows_to_dicts,
)
from db_images_write import _mark_image_tagged
from db_tag_scores import replace_scores_in_cursor


def _dedupe_tags(tags: List[Tuple[str, float]]) -> List[Tuple[str, float]]:
    """Deduplicate tags (case-insensitive), keeping the one with highest confidence.

    Args:
        tags: List of (tag, confidence) tuples

    Returns:
        Deduplicated list, preserving order of first occurrence
    """
    seen = {}
    result = []

    for tag, conf in tags:
        tag_lower = tag.lower()
        if tag_lower not in seen or conf > seen[tag_lower][1]:
            if tag_lower in seen:
                # Remove old entry
                result = [(t, c) for t, c in result if t.lower() != tag_lower]
            seen[tag_lower] = (tag, conf)
            result.append((tag, conf))

    return result


# Provenance values a pipeline re-tag OWNS and may replace. Rows written by
# a user ('manual') survive tagger/Smart-Tag re-runs; NULL covers every
# pre-migration-024 row (all of which came from tagger pipelines).
PIPELINE_TAG_SOURCES: Tuple[str, ...] = ("tagger", "vlm", "trigger")

# The four WD14 rating verdicts. images.ai_rating (migration 026) denormalizes
# the winning row so rating filter/sort never probes the tags table (BE-3).
RATING_TAG_NAMES: Tuple[str, ...] = ("general", "sensitive", "questionable", "explicit")

_RATING_PRIORITY_SQL = (
    "CASE tag WHEN 'explicit' THEN 0 WHEN 'questionable' THEN 1 "
    "WHEN 'sensitive' THEN 2 ELSE 3 END"
)


def _sync_ai_rating(cursor, image_id: int) -> None:
    """Re-derive images.ai_rating(+confidence) from the image's tag rows.

    Called after EVERY tag replace (add_tags / add_tags_batch — which is also
    every bulk op and bulk-undo, since those route through add_tags), so the
    denormalized column can never drift from the rows. Highest confidence
    wins; severity (explicit > questionable > sensitive > general) breaks
    ties — the same rule migration 026 used for the backfill.
    """
    placeholders = ",".join("?" * len(RATING_TAG_NAMES))
    row = cursor.execute(
        f"""
        SELECT tag, confidence FROM tags
        WHERE image_id = ? AND tag IN ({placeholders})
        ORDER BY confidence DESC, {_RATING_PRIORITY_SQL}
        LIMIT 1
        """,
        (image_id, *RATING_TAG_NAMES),
    ).fetchone()
    if row is not None:
        cursor.execute(
            "UPDATE images SET ai_rating = ?, ai_rating_confidence = ? WHERE id = ?",
            (row[0], row[1], image_id),
        )
    else:
        cursor.execute(
            "UPDATE images SET ai_rating = NULL, ai_rating_confidence = NULL WHERE id = ?",
            (image_id,),
        )


def _dedupe_tag_rows(tags: List[Dict[str, Any]], default_source: Optional[str]) -> List[Tuple[str, float, Optional[str], Optional[str]]]:
    """Normalize tag dicts to (tag, confidence, source, category) rows,
    deduplicating case-insensitively with highest confidence winning
    (same semantics as ``_dedupe_tags``, plus provenance columns)."""
    seen: Dict[str, Tuple[str, float, Optional[str], Optional[str]]] = {}
    order: List[str] = []
    for tag_data in tags:
        tag = str(tag_data.get("tag") or "")
        if not tag:
            continue
        try:
            conf = float(tag_data.get("confidence", 1.0))
        except (TypeError, ValueError):
            conf = 1.0
        source = tag_data.get("source") or default_source
        category = tag_data.get("category") or None
        key = tag.lower()
        if key not in seen:
            order.append(key)
            seen[key] = (tag, conf, source, category)
        elif conf > seen[key][1]:
            seen[key] = (tag, conf, source, category)
    return [seen[key] for key in order]


def _replace_tag_rows(
    cursor,
    image_id: int,
    tags: List[Dict[str, Any]],
    *,
    default_source: Optional[str],
    replace_scope: str,
) -> None:
    """Shared DELETE+INSERT body for add_tags / add_tags_batch.

    ``replace_scope``:
      * ``"all"`` — historical behavior: every existing row is replaced.
        Used by user-driven writes (bulk editor merges, tag import, VLM
        merge routes) where the caller passes the full authoritative list.
      * ``"pipeline"`` — replace only rows owned by pipelines
        (source in PIPELINE_TAG_SOURCES or NULL). Manual rows survive, and
        incoming rows that would duplicate a surviving manual tag are
        dropped (the user's row wins). This is the F5 fix: re-tagging no
        longer destroys manually added tags.
    """
    if replace_scope == "pipeline":
        placeholders = ",".join("?" * len(PIPELINE_TAG_SOURCES))
        cursor.execute(
            f"DELETE FROM tags WHERE image_id = ? AND (source IN ({placeholders}) OR source IS NULL)",
            (image_id, *PIPELINE_TAG_SOURCES),
        )
        surviving = {
            str(row[0]).lower()
            for row in cursor.execute(
                "SELECT tag FROM tags WHERE image_id = ?", (image_id,)
            )
        }
    else:
        cursor.execute("DELETE FROM tags WHERE image_id = ?", (image_id,))
        surviving = set()

    deduped = _dedupe_tag_rows(tags, default_source)
    tag_values = [
        (image_id, tag, conf, source, category)
        for tag, conf, source, category in deduped
        if tag.lower() not in surviving
    ]
    if tag_values:
        cursor.executemany(
            "INSERT INTO tags (image_id, tag, confidence, source, category) VALUES (?, ?, ?, ?, ?)",
            tag_values,
        )


def add_tags(
    image_id: int,
    tags: List[Dict[str, Any]],
    content_fingerprint: Optional[str] = None,
    *,
    default_source: Optional[str] = None,
    replace_scope: str = "all",
) -> None:
    """REPLACE tags for an image. Each tag dict has 'tag' and optionally
    'confidence' / 'source' / 'category'.

    .. warning::
        The name is historical. With the default ``replace_scope="all"`` this
        is a **DELETE + INSERT** — every existing tag row for ``image_id`` is
        removed before ``tags`` is inserted. To append a single tag, fetch the
        existing list first, append in memory, and pass the merged list. See
        ``backend/routers/tags_bulk.py`` for the canonical merge pattern.
        Tagger/Smart-Tag pipelines pass ``replace_scope="pipeline"`` so
        manually added rows (source='manual') survive re-tagging (F5 fix).

    Uses executemany for batch insert performance.
    """
    with get_db() as conn:
        cursor = conn.cursor()
        content_fingerprint = _ensure_content_fingerprint_value(cursor, image_id, content_fingerprint)
        _replace_tag_rows(
            cursor, image_id, tags,
            default_source=default_source, replace_scope=replace_scope,
        )
        _sync_ai_rating(cursor, image_id)
        _mark_image_tagged(cursor, image_id, content_fingerprint)
    _invalidate_tags_cache()


def add_tags_batch(
    image_tags_list: List[Dict[str, Any]],
    *,
    default_source: Optional[str] = None,
    replace_scope: str = "all",
) -> None:
    """Add tags for multiple images in a single transaction.

    More efficient than calling add_tags() repeatedly for batch tagging operations.
    Uses a single database connection and commits once at the end.

    Args:
        image_tags_list: List of dicts, each with:
            - image_id: int
            - tags: List[Dict] with 'tag', optional 'confidence'/'source'/'category'
            - ai_caption: Optional[str] - composed display caption (may include tags)
            - nl_caption: Optional[str] - pure natural-language caption from a VLM
            - content_fingerprint: Optional[str] - metadata-independent image hash
            - tag_scores: Optional - {"model", "scores"} dict (or list of them)
              of raw tagger scores >= config.TAG_SCORES_FLOOR, persisted to the
              tag_scores table in the same transaction (BE-1). Absent = no
              score write (leaves any previously stored scores untouched).
        default_source: provenance for rows that carry no 'source' key
            ('tagger' | 'vlm' | 'manual' | 'trigger'); None keeps legacy NULL.
        replace_scope: "all" (historical full replace) or "pipeline"
            (manual rows survive — see ``_replace_tag_rows``).
    """
    if not image_tags_list:
        return

    with get_db() as conn:
        cursor = conn.cursor()

        for item in image_tags_list:
            image_id = item["image_id"]
            tags = item["tags"]
            ai_caption = item.get("ai_caption") or None
            nl_caption = item.get("nl_caption") or None
            content_fingerprint = _ensure_content_fingerprint_value(cursor, image_id, item.get("content_fingerprint"))

            _replace_tag_rows(
                cursor, image_id, tags,
                default_source=default_source, replace_scope=replace_scope,
            )
            _sync_ai_rating(cursor, image_id)

            score_sets = item.get("tag_scores")
            if score_sets:
                replace_scores_in_cursor(cursor, image_id, score_sets)

            # Update tagged timestamp and captions. COALESCE preserves an
            # existing value when the caller passes None (a tag-only run, or a
            # VLM-only run), so ai_caption (composed display caption) and
            # nl_caption (pure natural-language) are written independently.
            cursor.execute(
                "UPDATE images SET tagged_at = CURRENT_TIMESTAMP, ai_caption = COALESCE(?, ai_caption), nl_caption = COALESCE(?, nl_caption), content_fingerprint = COALESCE(?, content_fingerprint) WHERE id = ?",
                (ai_caption, nl_caption, content_fingerprint, image_id)
            )

        # Single commit at the end (automatic with context manager)
    _invalidate_tags_cache()


def get_image_tags(image_id: int) -> List[Dict[str, Any]]:
    """Get all tags for an image (incl. provenance columns so merge-style
    callers can pass rows back through add_tags without losing source)."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT tag, confidence, source, category FROM tags WHERE image_id = ? ORDER BY confidence DESC",
            (image_id,)
        )
        return _rows_to_dicts(cursor.fetchall())


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
                SELECT image_id, tag, confidence, source, category
                FROM tags
                WHERE image_id IN ({placeholders})
                ORDER BY image_id ASC, confidence DESC, tag ASC
                """,
                batch,
            )
            for row in cursor.fetchall():
                result.setdefault(row["image_id"], []).append(
                    {
                        "tag": row["tag"],
                        "confidence": row["confidence"],
                        "source": row["source"],
                        "category": row["category"],
                    }
                )

    return result


def get_image_ids_already_tagged(image_ids: List[int]) -> set:
    """Return the subset of ``image_ids`` whose images are already AI-tagged.

    "Tagged" means ``images.tagged_at IS NOT NULL`` — the same marker
    ``_mark_image_tagged`` stamps on every tag write, and the same definition
    the gallery's untagged filter uses (``get_untagged_image_ids``). An image
    that was tagged but matched zero tags still counts as tagged.
    """
    ids = [int(image_id) for image_id in (image_ids or []) if int(image_id) > 0]
    if not ids:
        return set()

    tagged: set = set()
    batch_size = 500
    with get_db() as conn:
        cursor = conn.cursor()
        for i in range(0, len(ids), batch_size):
            batch = ids[i:i + batch_size]
            placeholders = ",".join("?" * len(batch))
            cursor.execute(
                f"SELECT id FROM images WHERE id IN ({placeholders}) AND tagged_at IS NOT NULL",
                batch,
            )
            tagged.update(int(row[0]) for row in cursor.fetchall())
    return tagged


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
