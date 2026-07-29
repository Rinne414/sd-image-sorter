"""REST API for persistent named Dataset Maker projects."""
from __future__ import annotations

from typing import NoReturn

from fastapi import APIRouter, HTTPException

from services.dataset_project_models import (
    DatasetProjectCreateRequest,
    DatasetProjectDeleteResponse,
    DatasetProjectListResponse,
    DatasetProjectResponse,
    DatasetProjectRevisionRequest,
    DatasetProjectUpdateRequest,
)
from services.dataset_project_service import (
    DatasetProjectError,
    DatasetProjectImageNotFoundError,
    DatasetProjectNameConflictError,
    DatasetProjectNotFoundError,
    DatasetProjectRevisionConflictError,
    DatasetProjectSourceIdentityConflictError,
    DatasetProjectSourceValidationError,
    DatasetProjectStateConflictError,
    archive_dataset_project,
    create_dataset_project,
    delete_dataset_project,
    get_dataset_project,
    list_active_dataset_projects,
    list_archived_dataset_projects,
    restore_dataset_project,
    update_dataset_project,
)


router = APIRouter(prefix="/api/dataset/projects", tags=["dataset-projects"])


def _raise_http_error(error: DatasetProjectError) -> NoReturn:
    if isinstance(error, DatasetProjectNotFoundError):
        raise HTTPException(
            status_code=404,
            detail={
                "code": "dataset_project_not_found",
                "message": "Dataset project was not found.",
                "project_id": error.project_id,
            },
        ) from error
    if isinstance(error, DatasetProjectImageNotFoundError):
        raise HTTPException(
            status_code=404,
            detail={
                "code": "dataset_project_images_not_found",
                "message": "One or more Library images were not found.",
                "image_ids": error.image_ids,
            },
        ) from error
    if isinstance(error, DatasetProjectSourceValidationError):
        raise HTTPException(
            status_code=400,
            detail={
                "code": "dataset_project_local_source_invalid",
                "message": (
                    f"Local project source {error.path!r} is invalid: "
                    f"{error.reason}."
                ),
                "path": error.path,
                "reason": error.reason,
            },
        ) from error
    if isinstance(error, DatasetProjectSourceIdentityConflictError):
        detail: dict[str, object] = {
            "code": "dataset_project_local_source_identity_conflict",
            "message": "A local project source changed after it was imported.",
            "path": error.path,
            "reason": error.reason,
        }
        if error.project_id is not None:
            detail["project_id"] = error.project_id
        raise HTTPException(status_code=409, detail=detail) from error
    if isinstance(error, DatasetProjectRevisionConflictError):
        raise HTTPException(
            status_code=409,
            detail={
                "code": "dataset_project_revision_conflict",
                "message": (
                    "Dataset project changed since it was loaded. "
                    "Reload it before saving."
                ),
                "project_id": error.project_id,
                "expected_revision": error.expected_revision,
                "current_revision": error.current_revision,
            },
        ) from error
    if isinstance(error, DatasetProjectNameConflictError):
        raise HTTPException(
            status_code=409,
            detail={
                "code": "dataset_project_name_conflict",
                "message": "An active Dataset project already uses this name.",
                "name": error.name,
            },
        ) from error
    if isinstance(error, DatasetProjectStateConflictError):
        raise HTTPException(
            status_code=409,
            detail={
                "code": "dataset_project_state_conflict",
                "message": str(error),
                "project_id": error.project_id,
                "state": error.state,
                "action": error.action,
            },
        ) from error
    raise RuntimeError(f"Unhandled Dataset project error: {error}") from error


@router.get("", response_model=DatasetProjectListResponse)
def get_active_dataset_projects() -> DatasetProjectListResponse:
    return list_active_dataset_projects()


@router.get("/archived", response_model=DatasetProjectListResponse)
def get_archived_dataset_projects() -> DatasetProjectListResponse:
    return list_archived_dataset_projects()


@router.post("", response_model=DatasetProjectResponse, status_code=201)
def post_dataset_project(
    request: DatasetProjectCreateRequest,
) -> DatasetProjectResponse:
    try:
        return create_dataset_project(request)
    except DatasetProjectError as error:
        _raise_http_error(error)


@router.get("/{project_id}", response_model=DatasetProjectResponse)
def get_dataset_project_by_id(project_id: int) -> DatasetProjectResponse:
    try:
        return get_dataset_project(project_id)
    except DatasetProjectError as error:
        _raise_http_error(error)


@router.put("/{project_id}", response_model=DatasetProjectResponse)
def put_dataset_project(
    project_id: int,
    request: DatasetProjectUpdateRequest,
) -> DatasetProjectResponse:
    try:
        return update_dataset_project(project_id, request)
    except DatasetProjectError as error:
        _raise_http_error(error)


@router.post("/{project_id}/archive", response_model=DatasetProjectResponse)
def post_archive_dataset_project(
    project_id: int,
    request: DatasetProjectRevisionRequest,
) -> DatasetProjectResponse:
    try:
        return archive_dataset_project(project_id, request)
    except DatasetProjectError as error:
        _raise_http_error(error)


@router.post("/{project_id}/restore", response_model=DatasetProjectResponse)
def post_restore_dataset_project(
    project_id: int,
    request: DatasetProjectRevisionRequest,
) -> DatasetProjectResponse:
    try:
        return restore_dataset_project(project_id, request)
    except DatasetProjectError as error:
        _raise_http_error(error)


@router.delete("/{project_id}", response_model=DatasetProjectDeleteResponse)
def delete_dataset_project_by_id(
    project_id: int,
    request: DatasetProjectRevisionRequest,
) -> DatasetProjectDeleteResponse:
    try:
        return delete_dataset_project(project_id, request)
    except DatasetProjectError as error:
        _raise_http_error(error)
