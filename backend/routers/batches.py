"""V4 batches: saved, ordered, per-library groups of images with steps.

Every route is scoped by the request's library (``X-SD-Library-Id``). The
Pixiv export uses censored copies automatically, strips generation data by
default and refuses (409) instead of silently exporting an uncensored original.
A dataset batch is a view of its Dataset Maker project: its name and archive
state are the project's, and its images are edited through the project.
"""

from __future__ import annotations

from typing import Any, Literal, NoReturn, Optional

from fastapi import APIRouter, Body, HTTPException, Query, Response
from fastapi.responses import FileResponse

import db_batch_datasets as batch_dataset_db
import db_batches as batch_db
from services import (
    batch_dataset_copy,
    batch_dataset_service,
    batch_export_service,
    batch_service,
)
from services.batch_models import (
    BatchCensoredCopyRequest,
    BatchCensoredDiscardRequest,
    BatchCopyRequest,
    BatchCreateRequest,
    BatchExportNamesRequest,
    BatchExportRequest,
    BatchImageIdsRequest,
    BatchItemPatchRequest,
    BatchPatchRequest,
    BatchReorderRequest,
    BatchTemplateCreateRequest,
)
from services.batch_naming import BatchNameTemplateError

router = APIRouter(prefix="/api/batches", tags=["batches"])

KindFilter = Optional[Literal["pixiv", "dataset", "custom"]]


def _not_found(error: batch_db.BatchError) -> Optional[HTTPException]:
    if isinstance(error, batch_db.BatchNotFoundError):
        return HTTPException(
            404,
            {
                "code": "batch_not_found",
                "message": str(error),
                "batch_id": error.batch_id,
            },
        )
    if isinstance(error, batch_db.BatchImagesNotFoundError):
        return HTTPException(
            404,
            {
                "code": "batch_images_not_found",
                "message": "One or more Library images were not found.",
                "image_ids": error.image_ids,
            },
        )
    if isinstance(error, batch_db.BatchItemNotFoundError):
        return HTTPException(
            404,
            {
                "code": "batch_item_not_found",
                "message": str(error),
                "batch_id": error.batch_id,
                "image_id": error.image_id,
            },
        )
    if isinstance(error, batch_db.BatchTemplateNotFoundError):
        return HTTPException(
            404,
            {
                "code": "batch_template_not_found",
                "message": str(error),
                "template_id": error.template_id,
            },
        )
    if isinstance(error, batch_service.BatchCensoredCopyNotFoundError):
        return HTTPException(
            404,
            {
                "code": "batch_censored_copy_not_found",
                "message": str(error),
                "image_id": error.image_id,
            },
        )
    if isinstance(error, batch_dataset_db.BatchDatasetProjectNotFoundError):
        return HTTPException(
            404,
            {
                "code": "dataset_project_not_found",
                "message": "Dataset project was not found.",
                "project_id": error.project_id,
            },
        )
    return None


def _conflict(error: batch_db.BatchError) -> Optional[HTTPException]:
    if isinstance(error, batch_db.BatchRevisionConflictError):
        return HTTPException(
            409,
            {
                "code": "batch_revision_conflict",
                "message": "The batch changed since it was loaded. Reload it before saving.",
                "batch_id": error.batch_id,
                "expected_revision": error.expected_revision,
                "current_revision": error.current_revision,
            },
        )
    if isinstance(error, batch_db.BatchItemsMismatchError):
        return HTTPException(
            409,
            {
                "code": "batch_items_mismatch",
                "message": str(error),
                "missing_image_ids": error.missing_image_ids,
                "unexpected_image_ids": error.unexpected_image_ids,
            },
        )
    if isinstance(error, batch_service.BatchValidationError):
        return HTTPException(422, {"code": "batch_invalid", "message": str(error)})
    return _dataset_conflict(error)


def _dataset_conflict(error: batch_db.BatchError) -> Optional[HTTPException]:
    if isinstance(error, batch_db.BatchDatasetItemsInProjectError):
        return HTTPException(
            409,
            {
                "code": "dataset_batch_items_in_project",
                "message": "A dataset batch's images are edited through its dataset "
                "project (PUT /api/dataset/projects/{id}).",
                "batch_id": error.batch_id,
            },
        )
    if isinstance(error, batch_dataset_db.BatchDatasetNameConflictError):
        return HTTPException(
            409,
            {
                "code": "dataset_project_name_conflict",
                "message": "An active Dataset project already uses this name.",
                "name": error.name,
            },
        )
    if isinstance(error, batch_dataset_db.BatchDatasetOrphanedError):
        return HTTPException(
            409,
            {
                "code": "dataset_batch_orphaned",
                "message": str(error),
                "batch_id": error.batch_id,
            },
        )
    if isinstance(error, batch_dataset_db.BatchNotDatasetError):
        return HTTPException(
            409,
            {
                "code": "batch_not_dataset",
                "message": str(error),
                "batch_id": error.batch_id,
            },
        )
    if isinstance(error, batch_dataset_copy.BatchCopySourceChangedError):
        return HTTPException(
            409,
            {
                "code": "dataset_batch_copy_source_changed",
                "message": str(error),
                "batch_id": error.batch_id,
            },
        )
    if isinstance(error, batch_db.BatchProjectRevisionRequiredError):
        return HTTPException(
            400,
            {
                "code": "dataset_project_revision_required",
                "message": "Deleting a dataset batch deletes its project: send the "
                "expected_project_revision the user confirmed.",
                "batch_id": error.batch_id,
                "project_id": error.project_id,
            },
        )
    if isinstance(error, batch_db.BatchProjectRevisionConflictError):
        return HTTPException(
            409,
            {
                "code": "dataset_project_revision_conflict",
                "message": "Dataset project changed since it was loaded. "
                "Reload it before deleting.",
                "project_id": error.project_id,
                "expected_revision": error.expected_revision,
                "current_revision": error.current_revision,
            },
        )
    return None


def _export_error(error: batch_db.BatchError) -> Optional[HTTPException]:
    if isinstance(error, batch_export_service.BatchExportMissingCensoredError):
        return HTTPException(
            409,
            {
                "code": "batch_export_missing_censored",
                "message": "Some images have no censored copy. Censor them, or choose "
                "to skip them or to export their originals.",
                "missing": error.missing,
            },
        )
    if isinstance(error, batch_export_service.BatchExportSourcesMissingError):
        return HTTPException(
            409,
            {
                "code": "batch_export_sources_missing",
                "message": str(error),
                "missing": error.missing,
            },
        )
    if isinstance(error, batch_export_service.BatchExportDuplicateNamesError):
        return HTTPException(
            422,
            {
                "code": "batch_export_duplicate_names",
                "message": str(error),
                "duplicates": error.duplicates,
            },
        )
    if isinstance(error, batch_export_service.BatchExportFilesExistError):
        return HTTPException(
            409,
            {
                "code": "batch_export_files_exist",
                "message": str(error),
                "existing": error.existing,
            },
        )
    return None


def batch_http_error(error: batch_db.BatchError) -> HTTPException:
    """The HTTP answer for an expected batch error (other routers use it too)."""
    http_error = _not_found(error) or _conflict(error) or _export_error(error)
    if http_error is None:
        raise RuntimeError(f"Unhandled batch error: {error}") from error
    return http_error


def _raise_http_error(error: batch_db.BatchError) -> NoReturn:
    raise batch_http_error(error) from error


@router.get(
    "/templates", summary="List saved batch templates and the built-in step sets"
)
def get_batch_templates(kind: KindFilter = None) -> dict[str, Any]:
    return batch_service.list_templates(kind)


@router.post("/templates", status_code=201, summary="Save a batch template")
def post_batch_template(request: BatchTemplateCreateRequest) -> dict[str, Any]:
    return batch_service.create_template(request)


@router.delete("/templates/{template_id}", summary="Delete a batch template")
def delete_batch_template(template_id: int) -> dict[str, Any]:
    try:
        return batch_service.delete_template(template_id)
    except batch_db.BatchError as error:
        _raise_http_error(error)


@router.get("", summary="List batches of the current library")
def get_batches(
    include_archived: bool = Query(False),
    kind: KindFilter = None,
) -> dict[str, Any]:
    return batch_service.list_batches(include_archived, kind)


@router.post("", status_code=201, summary="Create a batch")
def post_batch(request: BatchCreateRequest, response: Response) -> dict[str, Any]:
    try:
        body, created = batch_service.create_batch(request)
    except batch_db.BatchError as error:
        _raise_http_error(error)
    if not created:
        # Linking a dataset project again returns its existing batch.
        response.status_code = 200
    return body


@router.get("/{batch_id}", summary="Get a batch with its items in order")
def get_batch(batch_id: int) -> dict[str, Any]:
    try:
        return batch_service.get_batch(batch_id)
    except batch_db.BatchError as error:
        _raise_http_error(error)


@router.patch(
    "/{batch_id}", summary="Change a batch's name, steps, settings or current step"
)
def patch_batch(batch_id: int, request: BatchPatchRequest) -> dict[str, Any]:
    try:
        return batch_service.patch_batch(batch_id, request)
    except batch_db.BatchError as error:
        _raise_http_error(error)


@router.delete("/{batch_id}", summary="Delete a batch and its working folder")
def delete_batch(
    batch_id: int,
    expected_project_revision: Optional[int] = Query(None, ge=1),
) -> dict[str, Any]:
    try:
        return batch_service.delete_batch(batch_id, expected_project_revision)
    except batch_db.BatchError as error:
        _raise_http_error(error)


@router.post(
    "/{batch_id}/copy",
    status_code=201,
    summary="Copy a dataset batch under a new name (Save as…)",
)
def post_batch_copy(batch_id: int, request: BatchCopyRequest) -> dict[str, Any]:
    """A new dataset batch and project: same items, order, settings and captions
    (as new rows that keep who wrote them); uploaded files are copied."""
    try:
        return batch_dataset_copy.copy_dataset_batch(batch_id, request.name)
    except batch_db.BatchError as error:
        _raise_http_error(error)


@router.get(
    "/{batch_id}/project",
    summary="Get a dataset batch's project with its Library image names",
)
def get_batch_project(batch_id: int) -> dict[str, Any]:
    try:
        return batch_dataset_service.project_view(batch_id)
    except batch_db.BatchError as error:
        _raise_http_error(error)


@router.post("/{batch_id}/items", summary="Append images to a batch")
def post_batch_items(batch_id: int, request: BatchImageIdsRequest) -> dict[str, Any]:
    try:
        return batch_service.add_items(batch_id, request)
    except batch_db.BatchError as error:
        _raise_http_error(error)


@router.delete("/{batch_id}/items", summary="Remove images from a batch")
def delete_batch_items(batch_id: int, request: BatchImageIdsRequest) -> dict[str, Any]:
    try:
        return batch_service.remove_items(batch_id, request)
    except batch_db.BatchError as error:
        _raise_http_error(error)


@router.put("/{batch_id}/items/order", summary="Reorder a batch's items")
def put_batch_item_order(batch_id: int, request: BatchReorderRequest) -> dict[str, Any]:
    try:
        return batch_service.reorder_items(batch_id, request)
    except batch_db.BatchError as error:
        _raise_http_error(error)


@router.patch(
    "/{batch_id}/items/{image_id}", summary="Set one item's output name or state"
)
def patch_batch_item(
    batch_id: int, image_id: int, request: BatchItemPatchRequest
) -> dict[str, Any]:
    try:
        return batch_service.patch_item(batch_id, image_id, request)
    except batch_db.BatchError as error:
        _raise_http_error(error)


@router.put(
    "/{batch_id}/items/{image_id}/censored", summary="Save an item's censored copy"
)
def put_batch_item_censored(
    batch_id: int, image_id: int, request: BatchCensoredCopyRequest
) -> dict[str, Any]:
    try:
        return batch_service.save_censored_copy(batch_id, image_id, request)
    except batch_db.BatchError as error:
        _raise_http_error(error)


@router.get(
    "/{batch_id}/items/{image_id}/censored", summary="Get an item's censored copy"
)
def get_batch_item_censored(batch_id: int, image_id: int) -> FileResponse:
    try:
        path = batch_service.censored_copy_file(batch_id, image_id)
    except batch_db.BatchError as error:
        _raise_http_error(error)
    return FileResponse(
        path, media_type="image/png", headers={"Cache-Control": "no-store"}
    )


@router.delete(
    "/{batch_id}/items/{image_id}/censored", summary="Discard an item's censored copy"
)
def delete_batch_item_censored(
    batch_id: int,
    image_id: int,
    request: Optional[BatchCensoredDiscardRequest] = Body(default=None),
) -> dict[str, Any]:
    try:
        return batch_service.discard_censored_copy(batch_id, image_id, request)
    except batch_db.BatchError as error:
        _raise_http_error(error)


@router.post(
    "/{batch_id}/export/names", summary="Preview the file names of a batch export"
)
def post_batch_export_names(
    batch_id: int, request: BatchExportNamesRequest
) -> dict[str, Any]:
    try:
        return batch_export_service.preview_names(batch_id, request)
    except batch_db.BatchError as error:
        _raise_http_error(error)


@router.post("/{batch_id}/export", summary="Export a batch for posting (Pixiv)")
def post_batch_export(batch_id: int, request: BatchExportRequest) -> dict[str, Any]:
    try:
        return batch_export_service.export_batch(batch_id, request)
    except batch_db.BatchError as error:
        _raise_http_error(error)
    except BatchNameTemplateError as error:
        raise HTTPException(
            422,
            {
                "code": "batch_export_name_template_invalid",
                "message": str(error),
                "token": error.token,
            },
        ) from error
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
