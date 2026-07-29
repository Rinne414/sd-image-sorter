"""REST API for immutable annotation revisions."""
from __future__ import annotations

from typing import Annotated, NoReturn

from fastapi import APIRouter, HTTPException, Query

from services.annotation_models import (
    ProjectTrainingCaptionHeadsQuery,
    ProjectTrainingCaptionHeadsResponse,
    TrainingCaptionHeadRequest,
    TrainingCaptionHeadResponse,
    TrainingCaptionHistoryQuery,
    TrainingCaptionHistoryResponse,
    TrainingCaptionRevisionCreateRequest,
    TrainingCaptionRestoreRequest,
)
from services.annotation_revision_service import (
    AnnotationContentValidationError,
    AnnotationHeadConflictError,
    AnnotationProjectNotFoundError,
    AnnotationProjectRevisionConflictError,
    AnnotationProjectStateConflictError,
    AnnotationRevisionError,
    AnnotationRevisionNotFoundError,
    AnnotationRevisionSubjectConflictError,
    AnnotationSubjectIdentityConflictError,
    AnnotationSubjectNotFoundError,
    AnnotationSubjectNotInProjectError,
    AnnotationSubjectProjectConflictError,
    create_project_training_caption_revision,
    list_project_training_caption_heads,
    list_project_training_caption_history,
    resolve_project_training_caption_head,
    restore_project_training_caption_revision,
)


router = APIRouter(prefix="/api/annotations", tags=["annotations"])


def _raise_http_error(error: AnnotationRevisionError) -> NoReturn:
    if isinstance(error, AnnotationContentValidationError):
        raise HTTPException(
            status_code=400,
            detail={
                "code": "annotation_content_invalid",
                "message": str(error),
                "field": error.field,
                "reason": error.reason,
            },
        ) from error
    if isinstance(error, AnnotationProjectNotFoundError):
        raise HTTPException(
            status_code=404,
            detail={
                "code": "annotation_project_not_found",
                "message": "Dataset project was not found.",
                "project_id": error.project_id,
            },
        ) from error
    if isinstance(error, AnnotationProjectRevisionConflictError):
        raise HTTPException(
            status_code=409,
            detail={
                "code": "annotation_project_revision_conflict",
                "message": (
                    "The Dataset project changed since it was loaded. "
                    "Reload it before changing annotations."
                ),
                "project_id": error.project_id,
                "expected_revision": error.expected_revision,
                "current_revision": error.current_revision,
            },
        ) from error
    if isinstance(error, AnnotationProjectStateConflictError):
        raise HTTPException(
            status_code=409,
            detail={
                "code": "annotation_project_state_conflict",
                "message": str(error),
                "project_id": error.project_id,
                "state": error.state,
            },
        ) from error
    if isinstance(error, AnnotationSubjectNotInProjectError):
        raise HTTPException(
            status_code=409,
            detail={
                "code": "annotation_subject_not_in_project",
                "message": str(error),
                "project_id": error.project_id,
                "subject_kind": error.subject_kind,
                "identifier": error.identifier,
            },
        ) from error
    if isinstance(error, AnnotationSubjectNotFoundError):
        raise HTTPException(
            status_code=404,
            detail={
                "code": "annotation_subject_not_found",
                "message": "Annotation subject was not found.",
                "subject_id": error.subject_id,
            },
        ) from error
    if isinstance(error, AnnotationSubjectProjectConflictError):
        raise HTTPException(
            status_code=409,
            detail={
                "code": "annotation_subject_project_conflict",
                "message": str(error),
                "project_id": error.project_id,
                "subject_id": error.subject_id,
                "actual_project_id": error.actual_project_id,
            },
        ) from error
    if isinstance(error, AnnotationSubjectIdentityConflictError):
        detail: dict[str, object] = {
            "code": "annotation_subject_identity_conflict",
            "message": str(error),
            "project_id": error.project_id,
            "path": error.path,
            "reason": error.reason,
        }
        if error.subject_id is not None:
            detail["subject_id"] = error.subject_id
        raise HTTPException(status_code=409, detail=detail) from error
    if isinstance(error, AnnotationHeadConflictError):
        raise HTTPException(
            status_code=409,
            detail={
                "code": "annotation_head_conflict",
                "message": (
                    "The annotation changed since it was loaded. "
                    "Reload it before saving."
                ),
                "subject_id": error.subject_id,
                "expected_generation": error.expected_generation,
                "current_generation": error.current_generation,
            },
        ) from error
    if isinstance(error, AnnotationRevisionNotFoundError):
        raise HTTPException(
            status_code=404,
            detail={
                "code": "annotation_revision_not_found",
                "message": "Annotation revision was not found.",
                "revision_id": error.revision_id,
            },
        ) from error
    if isinstance(error, AnnotationRevisionSubjectConflictError):
        raise HTTPException(
            status_code=409,
            detail={
                "code": "annotation_revision_subject_conflict",
                "message": str(error),
                "subject_id": error.subject_id,
                "revision_id": error.revision_id,
                "actual_subject_id": error.actual_subject_id,
            },
        ) from error
    raise RuntimeError(f"Unhandled annotation revision error: {error}") from error


@router.post(
    "/projects/{project_id}/training-captions/head",
    response_model=TrainingCaptionHeadResponse,
)
def post_resolve_training_caption_head(
    project_id: int,
    request: TrainingCaptionHeadRequest,
) -> TrainingCaptionHeadResponse:
    try:
        return resolve_project_training_caption_head(project_id, request)
    except AnnotationRevisionError as error:
        _raise_http_error(error)


@router.get(
    "/projects/{project_id}/training-captions/heads",
    response_model=ProjectTrainingCaptionHeadsResponse,
)
def get_project_training_caption_heads(
    project_id: int,
    query: Annotated[ProjectTrainingCaptionHeadsQuery, Query()],
) -> ProjectTrainingCaptionHeadsResponse:
    try:
        return list_project_training_caption_heads(
            project_id,
            query.expected_project_revision,
            query.after_subject_id,
            query.limit,
        )
    except AnnotationRevisionError as error:
        _raise_http_error(error)


@router.post(
    "/projects/{project_id}/training-captions/revisions",
    response_model=TrainingCaptionHeadResponse,
    status_code=201,
)
def post_training_caption_revision(
    project_id: int,
    request: TrainingCaptionRevisionCreateRequest,
) -> TrainingCaptionHeadResponse:
    try:
        return create_project_training_caption_revision(project_id, request)
    except AnnotationRevisionError as error:
        _raise_http_error(error)


@router.get(
    "/projects/{project_id}/subjects/{subject_id}/training-captions/revisions",
    response_model=TrainingCaptionHistoryResponse,
)
def get_training_caption_history(
    project_id: int,
    subject_id: int,
    query: Annotated[TrainingCaptionHistoryQuery, Query()],
) -> TrainingCaptionHistoryResponse:
    try:
        return list_project_training_caption_history(project_id, subject_id, query)
    except AnnotationRevisionError as error:
        _raise_http_error(error)


@router.post(
    "/projects/{project_id}/subjects/{subject_id}/training-captions/restore",
    response_model=TrainingCaptionHeadResponse,
    status_code=201,
)
def post_restore_training_caption_revision(
    project_id: int,
    subject_id: int,
    request: TrainingCaptionRestoreRequest,
) -> TrainingCaptionHeadResponse:
    try:
        return restore_project_training_caption_revision(
            project_id,
            subject_id,
            request,
        )
    except AnnotationRevisionError as error:
        _raise_http_error(error)
