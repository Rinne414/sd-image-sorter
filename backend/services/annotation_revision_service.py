"""Business operations for immutable Dataset Project annotations."""
from __future__ import annotations

from typing import Mapping

import database as db
from services.annotation_models import (
    AnnotationRevisionResponse,
    ProjectLibraryAnnotationSubject,
    ProjectLocalAnnotationSubject,
    ProjectTrainingCaptionHeadsResponse,
    TrainingCaptionHeadRequest,
    TrainingCaptionHeadResponse,
    TrainingCaptionHistoryQuery,
    TrainingCaptionHistoryResponse,
    TrainingCaptionRevisionCreateRequest,
    TrainingCaptionRestoreRequest,
)


AnnotationRevisionError = db.AnnotationRevisionError
AnnotationContentValidationError = db.AnnotationContentValidationError
AnnotationProjectNotFoundError = db.AnnotationProjectNotFoundError
AnnotationProjectRevisionConflictError = db.AnnotationProjectRevisionConflictError
AnnotationProjectStateConflictError = db.AnnotationProjectStateConflictError
AnnotationSubjectNotInProjectError = db.AnnotationSubjectNotInProjectError
AnnotationSubjectNotFoundError = db.AnnotationSubjectNotFoundError
AnnotationSubjectProjectConflictError = db.AnnotationSubjectProjectConflictError
AnnotationSubjectIdentityConflictError = db.AnnotationSubjectIdentityConflictError
AnnotationHeadConflictError = db.AnnotationHeadConflictError
AnnotationRevisionNotFoundError = db.AnnotationRevisionNotFoundError
AnnotationRevisionSubjectConflictError = db.AnnotationRevisionSubjectConflictError


def _revision_response(
    record: Mapping[str, object],
) -> AnnotationRevisionResponse:
    return AnnotationRevisionResponse.model_validate(
        {
            "id": record["id"],
            "subject_id": record["subject_id"],
            "annotation_kind": record["annotation_kind"],
            "parent_revision_id": record["parent_revision_id"],
            "restored_from_revision_id": record["restored_from_revision_id"],
            "content": record["content"],
            "content_sha256": record["content_sha256"],
            "source": record["source_kind"],
            "provider": record["provider"],
            "model": record["model"],
            "author_class": record["author_class"],
            "created_at": record["created_at"],
        },
        strict=True,
    )


def _head_response(
    item: ProjectLibraryAnnotationSubject | ProjectLocalAnnotationSubject,
    subject_key: str,
    subject: Mapping[str, object] | None,
    head: Mapping[str, object] | None,
    active_revision: Mapping[str, object] | None,
) -> TrainingCaptionHeadResponse:
    if subject is None:
        if head is not None or active_revision is not None:
            raise RuntimeError(
                "Uncreated annotation subject returned head or revision state"
            )
        return TrainingCaptionHeadResponse.model_validate(
            {
                "subject_id": None,
                "subject_key": subject_key,
                "item": item,
                "generation": 0,
                "active_revision": None,
                "reviewed_revision_id": None,
                "export_revision_id": None,
            },
            strict=True,
        )
    if head is None or active_revision is None:
        raise RuntimeError(
            "Persisted annotation subject is missing its active head or revision"
        )
    return TrainingCaptionHeadResponse.model_validate(
        {
            "subject_id": subject["id"],
            "subject_key": subject_key,
            "item": item,
            "generation": head["generation"],
            "active_revision": _revision_response(active_revision),
            "reviewed_revision_id": head["reviewed_revision_id"],
            "export_revision_id": head["export_revision_id"],
        },
        strict=True,
    )


def _subject_item_from_record(
    subject: Mapping[str, object],
) -> ProjectLibraryAnnotationSubject | ProjectLocalAnnotationSubject:
    if subject["subject_kind"] == "project_library":
        return ProjectLibraryAnnotationSubject.model_validate(
            {
                "item_type": "library",
                "image_id": subject["library_source_image_id"],
            },
            strict=True,
        )
    if subject["subject_kind"] == "project_local":
        return ProjectLocalAnnotationSubject.model_validate(
            {
                "item_type": "local",
                "path": subject["local_path"],
            },
            strict=True,
        )
    raise RuntimeError(
        f"Unsupported persisted annotation subject kind: {subject['subject_kind']!r}"
    )


def resolve_project_training_caption_head(
    project_id: int,
    request: TrainingCaptionHeadRequest,
) -> TrainingCaptionHeadResponse:
    subject = request.subject
    if isinstance(subject, ProjectLibraryAnnotationSubject):
        record = db.resolve_project_library_training_caption_head(
            project_id,
            request.expected_project_revision,
            subject.image_id,
        )
    elif isinstance(subject, ProjectLocalAnnotationSubject):
        record = db.resolve_project_local_training_caption_head(
            project_id,
            request.expected_project_revision,
            subject.path,
        )
    else:
        raise TypeError(f"Unsupported annotation subject model: {type(subject).__name__}")
    return _head_response(
        subject,
        record["subject_key"],
        record["subject"],
        record["head"],
        record["active_revision"],
    )


def create_project_training_caption_revision(
    project_id: int,
    request: TrainingCaptionRevisionCreateRequest,
) -> TrainingCaptionHeadResponse:
    content = request.content.model_dump(mode="python")
    subject = request.subject
    if isinstance(subject, ProjectLibraryAnnotationSubject):
        mutation = db.create_project_library_training_caption_revision(
            project_id,
            request.expected_project_revision,
            subject.image_id,
            request.expected_head_generation,
            content,
            "manual",
            "user",
            None,
            None,
        )
    elif isinstance(subject, ProjectLocalAnnotationSubject):
        mutation = db.create_project_local_training_caption_revision(
            project_id,
            request.expected_project_revision,
            subject.path,
            request.expected_head_generation,
            content,
            "manual",
            "user",
            None,
            None,
        )
    else:
        raise TypeError(f"Unsupported annotation subject model: {type(subject).__name__}")
    return _head_response(
        _subject_item_from_record(mutation["subject"]),
        str(mutation["subject"]["subject_key"]),
        mutation["subject"],
        mutation["head"],
        mutation["revision"],
    )


def restore_project_training_caption_revision(
    project_id: int,
    subject_id: int,
    request: TrainingCaptionRestoreRequest,
) -> TrainingCaptionHeadResponse:
    mutation = db.restore_project_training_caption_revision(
        project_id,
        request.expected_project_revision,
        subject_id,
        request.revision_id,
        request.expected_head_generation,
    )
    return _head_response(
        _subject_item_from_record(mutation["subject"]),
        str(mutation["subject"]["subject_key"]),
        mutation["subject"],
        mutation["head"],
        mutation["revision"],
    )


def list_project_training_caption_history(
    project_id: int,
    subject_id: int,
    query: TrainingCaptionHistoryQuery,
) -> TrainingCaptionHistoryResponse:
    page = db.list_project_training_caption_revisions(
        project_id,
        query.expected_project_revision,
        subject_id,
        query.before_revision_id,
        query.limit,
    )
    return TrainingCaptionHistoryResponse.model_validate(
        {
            "subject_id": subject_id,
            "revisions": [
                _revision_response(record)
                for record in page["items"]
            ],
            "has_more": page["has_more"],
            "next_before_revision_id": page["next_before_revision_id"],
        },
        strict=True,
    )


def list_project_training_caption_heads(
    project_id: int,
    expected_project_revision: int,
    after_subject_id: int | None,
    limit: int,
) -> ProjectTrainingCaptionHeadsResponse:
    page = db.list_project_training_caption_heads(
        project_id,
        expected_project_revision,
        after_subject_id,
        limit,
    )
    items = [
        _head_response(
            _subject_item_from_record(item["subject"]),
            str(item["subject"]["subject_key"]),
            item["subject"],
            item["head"],
            item["active_revision"],
        )
        for item in page["items"]
    ]
    return ProjectTrainingCaptionHeadsResponse.model_validate(
        {
            "project_id": project_id,
            "items": items,
            "has_more": page["has_more"],
            "next_after_subject_id": page["next_after_subject_id"],
        },
        strict=True,
    )
