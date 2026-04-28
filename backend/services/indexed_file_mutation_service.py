"""
Shared helpers for file writes that may overwrite already-indexed library paths.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, List, Optional, Tuple, TypeVar

import database as db
from image_manager import reparse_image_metadata
from utils.source_paths import resolve_existing_indexed_image_path


logger = logging.getLogger(__name__)

T = TypeVar("T")

RECONCILE_WARNING = (
    "Saved file, but the library entry did not refresh. "
    "Use Reparse if metadata looks stale."
)


@dataclass(frozen=True)
class SaveAndReconcileResult:
    """Result for a checked save plus indexed-row reconciliation."""

    writer_result: T
    warnings: List[str]
    target_existed: bool
    reconciled_image_id: Optional[int] = None


def _raise_from_factory(factory: Callable[[str], BaseException], message: str) -> None:
    raise factory(message)


def _default_validation_error(message: str) -> ValueError:
    return ValueError(message)


def _default_conflict_error(message: str) -> FileExistsError:
    return FileExistsError(message)


def preflight_output_write(
    output_path: str,
    *,
    allow_overwrite: bool = False,
    source_path: str | None = None,
    validation_error_factory: Callable[[str], BaseException] = _default_validation_error,
    conflict_error_factory: Callable[[str], BaseException] = _default_conflict_error,
) -> bool:
    """Validate overwrite intent for all save workflows before writing bytes."""
    target = Path(output_path).resolve(strict=False)
    if source_path:
        source = Path(source_path).resolve(strict=False)
        if source == target and not allow_overwrite:
            _raise_from_factory(
                conflict_error_factory,
                "Output path is the same as the source image. Confirm overwrite before saving.",
            )

    if not target.exists():
        return False
    if target.is_dir():
        _raise_from_factory(validation_error_factory, "Output path points to a directory, not a file")
    if target.is_symlink():
        _raise_from_factory(validation_error_factory, "Output file cannot be a symlink")
    if not allow_overwrite:
        _raise_from_factory(conflict_error_factory, "Output file already exists. Confirm overwrite before saving.")
    return True


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


def save_and_reconcile_checked(
    output_path: str,
    writer_fn: Callable[[str, bool], T],
    *,
    allow_overwrite: bool = False,
    preserve_derived_state: bool = False,
    backend_file: str,
    source_path: str | None = None,
    validation_error_factory: Callable[[str], BaseException] = _default_validation_error,
    conflict_error_factory: Callable[[str], BaseException] = _default_conflict_error,
) -> SaveAndReconcileResult:
    """Execute a checked write, then refresh the indexed library row if needed."""
    final_output_path = str(Path(output_path).resolve(strict=False))
    target_existed = preflight_output_write(
        final_output_path,
        allow_overwrite=allow_overwrite,
        source_path=source_path,
        validation_error_factory=validation_error_factory,
        conflict_error_factory=conflict_error_factory,
    )
    writer_result = writer_fn(final_output_path, allow_overwrite)
    warnings = reconcile_indexed_output(
        final_output_path,
        backend_file=backend_file,
        preserve_derived_state=preserve_derived_state,
    )
    indexed_output = db.get_image_by_path(final_output_path)
    return SaveAndReconcileResult(
        writer_result=writer_result,
        warnings=warnings,
        target_existed=target_existed,
        reconciled_image_id=int(indexed_output["id"]) if indexed_output else None,
    )


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
    result = save_and_reconcile_checked(
        output_path,
        writer_fn,
        allow_overwrite=allow_overwrite,
        preserve_derived_state=preserve_derived_state,
        backend_file=backend_file,
    )
    return result.writer_result, result.warnings
