"""Library facet, checkpoint, and health-report read operations.

Extracted from ``database.py`` as part of the database module split. This module
holds metadata-status counts, the library health audit, and checkpoint facets.

Imports only from db_core / db_helpers / db_tags / utils / stdlib to avoid an
import cycle with the ``database`` facade.
"""
from typing import Optional, List, Dict, Any

from db_core import get_db
from db_helpers import normalize_prompt_token, escape_like_pattern
from db_tags import (
    _facet_search_rank_params,
    _facet_search_rank_sql,
    _append_optional_limit,
)
from utils.model_names import checkpoint_identity_key


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
