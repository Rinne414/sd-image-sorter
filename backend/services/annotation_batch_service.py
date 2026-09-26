"""Bulk training-caption writes for one Dataset Project (V4 bulk edits and their undo)."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

import db_annotation_batch as batch_db
from services.annotation_models import (
    NonNegativeStrictInt,
    PositiveStrictInt,
    ProjectAnnotationSubject,
    ProjectLibraryAnnotationSubject,
    TrainingCaptionContentV1,
)
from services.annotation_revision_service import _subject_item_from_record

MAX_BATCH_ENTRIES = batch_db.MAX_BATCH_ENTRIES
AnnotationBatchConflictError = batch_db.AnnotationBatchConflictError


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class TrainingCaptionBatchEntryRequest(_StrictModel):
    subject: ProjectAnnotationSubject
    expected_head_generation: NonNegativeStrictInt
    # Exactly one: the new content (a manual revision), or an earlier
    # revision of this image to make current again (source "restore").
    content: TrainingCaptionContentV1 | None = None
    restore_revision_id: PositiveStrictInt | None = None
    # With content: the batch template's caption for an image nobody had
    # edited (an undo putting it back), recorded as a system snapshot.
    # Client-asserted: trusted only because the app is local and single-user.
    template_snapshot: bool = False

    @model_validator(mode="after")
    def exactly_one_change(self) -> "TrainingCaptionBatchEntryRequest":
        if (self.content is None) == (self.restore_revision_id is None):
            raise ValueError("give exactly one of content or restore_revision_id")
        if self.template_snapshot and self.content is None:
            raise ValueError("template_snapshot goes with content")
        return self


class TrainingCaptionBatchRequest(_StrictModel):
    expected_project_revision: PositiveStrictInt
    entries: list[TrainingCaptionBatchEntryRequest] = Field(
        min_length=1, max_length=MAX_BATCH_ENTRIES
    )


class TrainingCaptionBatchItem(_StrictModel):
    """What changed for one entry (same order as the request)."""

    subject_id: PositiveStrictInt
    item: ProjectAnnotationSubject
    generation: NonNegativeStrictInt
    revision_id: PositiveStrictInt
    source: Literal["manual", "restore", "legacy_snapshot"]
    author_class: Literal["user", "ai", "system", "import"]
    restored_from_revision_id: PositiveStrictInt | None


class TrainingCaptionBatchResponse(_StrictModel):
    project_id: PositiveStrictInt
    written: NonNegativeStrictInt
    items: list[TrainingCaptionBatchItem]


def _db_entry(
    entry: TrainingCaptionBatchEntryRequest,
) -> batch_db.TrainingCaptionBatchEntry:
    subject = entry.subject
    library = isinstance(subject, ProjectLibraryAnnotationSubject)
    return {
        "item_type": "library" if library else "local",
        "image_id": subject.image_id if library else None,
        "path": None if library else subject.path,  # type: ignore[union-attr]
        "expected_head_generation": entry.expected_head_generation,
        "content": entry.content.model_dump(mode="python")
        if entry.content is not None
        else None,
        "restore_revision_id": entry.restore_revision_id,
        "template_snapshot": entry.template_snapshot,
    }


def write_training_caption_batch(
    project_id: int, request: TrainingCaptionBatchRequest
) -> TrainingCaptionBatchResponse:
    records = batch_db.write_project_training_caption_batch(
        project_id,
        request.expected_project_revision,
        [_db_entry(entry) for entry in request.entries],
    )
    items = [
        TrainingCaptionBatchItem(
            subject_id=record["subject"]["id"],
            item=_subject_item_from_record(record["subject"]),
            generation=record["head"]["generation"],
            revision_id=record["revision"]["id"],
            source=record["revision"]["source_kind"],  # type: ignore[arg-type]
            author_class=record["revision"]["author_class"],
            restored_from_revision_id=record["revision"]["restored_from_revision_id"],
        )
        for record in records
    ]
    return TrainingCaptionBatchResponse(project_id=project_id, written=len(items), items=items)
