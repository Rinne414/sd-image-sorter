"""
Shared helpers for file writes that may overwrite already-indexed library paths.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Callable, List, Tuple, TypeVar

import database as db
from image_manager import reparse_image_metadata
from utils.source_paths import resolve_existing_indexed_image_path


logger = logging.getLogger(__name__)

T = TypeVar("T")

RECONCILE_WARNING = (
    "Saved file, but the library entry did not refresh. "
    "Use Reparse if metadata looks stale."
)


def reconcile_indexed_output(
    output_path: str,
    *,
    backend_file: str,
    preserve_derived_state: bool = False,
) -> List[str]:
    """Refresh the indexed row when a write target already exists in the library."""
    indexed_output_row = db.get_image_by_path(output_path)
    if not indexed_output_row:
        return []

    resolved_output = resolve_existing_indexed_image_path(
        output_path,
        backend_file=backend_file,
    )
    if not resolved_output:
        logger.warning("Indexed output path exists in SQLite but could not be resolved on disk: %s", output_path)
        return [RECONCILE_WARNING]

    try:
        reparse_image_metadata(
            int(indexed_output_row["id"]),
            resolved_output,
            preserve_derived_state=preserve_derived_state,
        )
    except Exception:
        logger.warning("Failed to refresh indexed metadata after saving %s", resolved_output, exc_info=True)
        return [RECONCILE_WARNING]

    return []


def save_and_reconcile(
    output_path: str,
    writer_fn: Callable[[str, bool], T],
    *,
    allow_overwrite: bool = False,
    preserve_derived_state: bool = False,
    backend_file: str,
) -> Tuple[T, List[str]]:
    """
    Execute a write function, then refresh the indexed library row if needed.

    The writer callback receives the resolved output path and the caller's
    overwrite intent so save workflows can standardize around one entry point.
    """
    final_output_path = str(Path(output_path).resolve(strict=False))
    writer_result = writer_fn(final_output_path, allow_overwrite)
    warnings = reconcile_indexed_output(
        final_output_path,
        backend_file=backend_file,
        preserve_derived_state=preserve_derived_state,
    )
    return writer_result, warnings
