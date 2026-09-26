"""Many training-caption revisions for one Dataset Project in one transaction.

V4's bulk caption edits (and their undo) write every image's new revision at
once: each entry names the head generation it was made on, and either every
entry is written or none is. A stale generation, an image that is no longer in
the project (or whose file changed), or a restore that names another image's
revision is collected, and the whole batch is refused with the full list.
"""

from __future__ import annotations

import sqlite3
from collections.abc import Mapping, Sequence
from typing import Literal, TypedDict

from db_annotation_revisions import (
    AnnotationContentValidationError,
    AnnotationMutationRecord,
    AnnotationRevisionError,
    AnnotationRevisionNotFoundError,
    AnnotationRevisionSubjectConflictError,
    AnnotationSubjectIdentityConflictError,
    AnnotationSubjectNotInProjectError,
    _begin_write,
    _canonical_training_caption_content,
    _ensure_head_row,
    _get_or_create_library_subject,
    _get_or_create_local_subject,
    _head_record,
    _insert_revision,
    _read_head_row,
    _require_project_for_write,
    _require_revision_for_subject,
    _require_strict_non_negative_int,
    _revision_record,
    _subject_record,
    _update_active_head,
)
from db_core import get_db

# One request's size, not a limit on what a user may change: callers split
# larger changes into requests of at most this many entries.
MAX_BATCH_ENTRIES = 5000

BatchProblemReason = Literal["generation", "not_in_project", "identity", "revision"]


class TrainingCaptionBatchEntry(TypedDict):
    item_type: Literal["library", "local"]
    image_id: int | None
    path: str | None
    expected_head_generation: int
    content: Mapping[str, object] | None
    restore_revision_id: int | None
    # The content is what the batch's template made for an image nobody had
    # edited (an undo putting such an image back): recorded as a system
    # snapshot, not as the user's writing.
    template_snapshot: bool


class TrainingCaptionBatchProblem(TypedDict):
    index: int
    reason: BatchProblemReason
    expected_generation: int
    current_generation: int | None
    message: str


class AnnotationBatchConflictError(AnnotationRevisionError):
    def __init__(self, project_id: int, problems: list[TrainingCaptionBatchProblem]):
        self.project_id = project_id
        self.problems = problems
        super().__init__(
            f"Dataset project {project_id}: {len(problems)} of the batch entries "
            "cannot be written; nothing was written"
        )


class _Planned(TypedDict):
    subject_row: sqlite3.Row
    head_row: sqlite3.Row
    expected_head_generation: int
    content_json: str
    content_sha256: str
    restored_from_revision_id: int | None
    source: str
    author: str
    provider: str | None
    model: str | None


def _validate_entries(
    entries: Sequence[TrainingCaptionBatchEntry],
) -> list[tuple[str, str] | None]:
    if not entries:
        raise AnnotationContentValidationError(
            "entries", "must name at least one image"
        )
    if len(entries) > MAX_BATCH_ENTRIES:
        raise AnnotationContentValidationError(
            "entries",
            f"must be at most {MAX_BATCH_ENTRIES} per request (send the rest in another request)",
        )
    canonical: list[tuple[str, str] | None] = []
    for index, entry in enumerate(entries):
        _require_strict_non_negative_int(
            entry["expected_head_generation"], "expected_head_generation"
        )
        has_content = entry["content"] is not None
        has_restore = entry["restore_revision_id"] is not None
        if has_content == has_restore:
            raise AnnotationContentValidationError(
                "entries",
                f"entry {index} must have exactly one of content or restore_revision_id",
            )
        if has_restore and entry["template_snapshot"]:
            raise AnnotationContentValidationError(
                "entries",
                f"entry {index}: a template snapshot carries content, not a restore",
            )
        if has_content:
            _normalized, content_json, content_sha256 = (
                _canonical_training_caption_content(
                    entry["content"]  # type: ignore[arg-type]
                )
            )
            canonical.append((content_json, content_sha256))
        else:
            canonical.append(None)
    return canonical


def _subject_row(
    conn: sqlite3.Connection, project_id: int, entry: TrainingCaptionBatchEntry
) -> sqlite3.Row:
    if entry["item_type"] == "library":
        return _get_or_create_library_subject(
            conn, project_id, int(entry["image_id"] or 0)
        )
    return _get_or_create_local_subject(conn, project_id, str(entry["path"] or ""))


def _problem(
    index: int,
    reason: BatchProblemReason,
    entry: TrainingCaptionBatchEntry,
    current: int | None,
    message: str,
) -> TrainingCaptionBatchProblem:
    return {
        "index": index,
        "reason": reason,
        "expected_generation": entry["expected_head_generation"],
        "current_generation": current,
        "message": message,
    }


def _plan_entry(
    conn: sqlite3.Connection,
    project_id: int,
    index: int,
    entry: TrainingCaptionBatchEntry,
    canonical: tuple[str, str] | None,
    seen: dict[int, int],
) -> _Planned | TrainingCaptionBatchProblem:
    try:
        subject_row = _subject_row(conn, project_id, entry)
    except AnnotationSubjectNotInProjectError as error:
        return _problem(index, "not_in_project", entry, None, str(error))
    except AnnotationSubjectIdentityConflictError as error:
        return _problem(index, "identity", entry, None, str(error))
    subject_id = int(subject_row["id"])
    if subject_id in seen:
        raise AnnotationContentValidationError(
            "entries",
            f"entries {seen[subject_id]} and {index} name the same image",
        )
    seen[subject_id] = index
    _ensure_head_row(conn, subject_id)
    head_row = _read_head_row(conn, subject_id)
    current = int(head_row["generation"])
    if current != entry["expected_head_generation"]:
        return _problem(
            index, "generation", entry, current, "the caption changed since it was read"
        )
    if canonical is not None:
        content_json, content_sha256 = canonical
        snapshot = entry["template_snapshot"]
        provenance = ("legacy_snapshot", "system", None, None) if snapshot else ("manual", "user", None, None)
        restored_from = None
    else:
        restore_id = int(entry["restore_revision_id"] or 0)
        try:
            target = _require_revision_for_subject(conn, subject_id, restore_id)
        except (AnnotationRevisionNotFoundError, AnnotationRevisionSubjectConflictError) as error:
            return _problem(index, "revision", entry, current, str(error))
        content_json, content_sha256 = str(target["content_json"]), str(target["content_sha256"])
        # An undo puts the earlier revision back as it was: whoever wrote it stays its author.
        provenance = ("restore", str(target["author_class"]), target["provider"], target["model"])
        restored_from = restore_id
    return {
        "subject_row": subject_row,
        "head_row": head_row,
        "expected_head_generation": current,
        "content_json": content_json,
        "content_sha256": content_sha256,
        "restored_from_revision_id": restored_from,
        "source": provenance[0],
        "author": provenance[1],
        "provider": provenance[2],
        "model": provenance[3],
    }


def _apply(conn: sqlite3.Connection, plan: _Planned) -> AnnotationMutationRecord:
    subject_id = int(plan["subject_row"]["id"])
    active = plan["head_row"]["active_revision_id"]
    restored_from = plan["restored_from_revision_id"]
    revision_row = _insert_revision(
        conn,
        subject_id,
        int(active) if active is not None else None,
        restored_from,
        plan["content_json"],
        plan["content_sha256"],
        plan["source"],  # type: ignore[arg-type]
        plan["author"],  # type: ignore[arg-type]
        plan["provider"],
        plan["model"],
    )
    head = _update_active_head(
        conn, subject_id, int(revision_row["id"]), plan["expected_head_generation"]
    )
    return {
        "subject": _subject_record(plan["subject_row"]),
        "revision": _revision_record(revision_row),
        "head": _head_record(head),
    }


def write_project_training_caption_batch(
    project_id: int,
    expected_project_revision: int,
    entries: Sequence[TrainingCaptionBatchEntry],
) -> list[AnnotationMutationRecord]:
    """Write every entry's new revision (the user's content, or a restored revision), or none of them."""
    canonical = _validate_entries(entries)
    with get_db() as conn:
        _begin_write(conn)
        _require_project_for_write(conn, project_id, expected_project_revision)
        seen: dict[int, int] = {}
        plans: list[_Planned] = []
        problems: list[TrainingCaptionBatchProblem] = []
        for index, entry in enumerate(entries):
            planned = _plan_entry(
                conn, project_id, index, entry, canonical[index], seen
            )
            if "reason" in planned:
                problems.append(planned)  # type: ignore[arg-type]
            else:
                plans.append(planned)  # type: ignore[arg-type]
        if problems:
            # Raising rolls back the subjects and heads created while checking.
            raise AnnotationBatchConflictError(project_id, problems)
        return [_apply(conn, plan) for plan in plans]


__all__ = [
    "MAX_BATCH_ENTRIES",
    "AnnotationBatchConflictError",
    "TrainingCaptionBatchEntry",
    "TrainingCaptionBatchProblem",
    "write_project_training_caption_batch",
]
