"""Re-read the files of images whose generation details failed to read.

Companion to ``services.metadata_repair_service`` (the "recover missing text"
job): it runs under the same one-at-a-time slot and bulk-job machinery, started
by ``POST /api/metadata/reparse`` with ``scope: "metadata_error"``.

The population is the readable rows of the current library whose
``metadata_status`` is ``error`` — the file opened but its generation details
did not parse. Each file is parsed again with today's parser, exactly like the
per-image "re-read" (``POST /api/images/{id}/reparse``). Unreadable rows are
left to the missing-files flow: their file is gone or out of reach, so there is
nothing to read. A row whose file vanished since it was listed is counted as
``gone`` and left untouched.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Dict, List

from database import get_db
from image_manager import reparse_image_metadata
from services.bulk_job_service import BulkJobHandle, BulkJobService

logger = logging.getLogger(__name__)

SCOPE = "metadata_error"

# Chunks stay small: every row is a full file parse, and cancellation is only
# observed between chunks.
REREAD_CHUNK_SIZE = 50

# Same spellings db_facets uses for the ``metadata_error`` issue count, so the
# job walks exactly the rows the library status reports.
_READABLE_WHERE = "COALESCE(is_readable, 1) = 1"
_ERROR_WHERE = (
    f"{_READABLE_WHERE} AND LOWER(COALESCE(metadata_status, 'complete')) = 'error'"
)


def snapshot_metadata_error_ids() -> List[int]:
    """Materialize the ids to re-read before any mutation (bulk-job contract)."""
    from library_context import current_library_sql

    lib_sql, lib_params = current_library_sql()
    with get_db() as conn:
        rows = conn.execute(
            f"SELECT id FROM images WHERE {_ERROR_WHERE} AND {lib_sql} ORDER BY id",
            lib_params,
        ).fetchall()
    return [int(row["id"]) for row in rows]


def _state_after(image_id: int) -> str:
    """Name what the re-read left the row as."""
    with get_db() as conn:
        row = conn.execute(
            "SELECT COALESCE(is_readable, 1) AS readable, "
            "LOWER(COALESCE(metadata_status, 'complete')) AS status FROM images WHERE id = ?",
            (image_id,),
        ).fetchone()
    if row is None or not row["readable"]:
        return "unreadable"
    return "still_error" if row["status"] == "error" else "fixed"


def _process_chunk(chunk_ids: List[int]) -> Dict[str, Any]:
    """Bulk-job chunk: re-parse each listed file that still exists."""
    placeholders = ",".join("?" for _ in chunk_ids)
    with get_db() as conn:
        rows = [
            dict(row)
            for row in conn.execute(
                f"SELECT id, path FROM images WHERE id IN ({placeholders}) AND {_ERROR_WHERE}",
                chunk_ids,
            ).fetchall()
        ]

    counts = {"fixed": 0, "still_error": 0, "unreadable": 0, "gone": 0}
    errors: List[str] = []
    for row in rows:
        image_id = int(row["id"])
        path = row.get("path")
        if not path or not os.path.isfile(path):
            counts["gone"] += 1
            continue
        try:
            reparse_image_metadata(image_id, path, preserve_derived_state=True)
        except Exception as exc:
            logger.debug("re-read failed for image %s: %s", image_id, exc)
            counts["still_error"] += 1
            errors.append(f"image {image_id}: {exc}")
            continue
        counts[_state_after(image_id)] += 1

    from services.sorting_service import invalidate_library_health_cache

    invalidate_library_health_cache()
    return {
        "processed": len(chunk_ids),
        "errors": errors,
        "result_delta": {"scope": SCOPE, **counts},
    }


def run_reread_job(handle: BulkJobHandle) -> None:
    """Worker body for the re-read-failed-details bulk job."""
    worker = BulkJobService.chunked_worker(
        snapshot_metadata_error_ids,
        _process_chunk,
        chunk_size=REREAD_CHUNK_SIZE,
    )
    worker(handle)
