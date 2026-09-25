"""V4 batches: saved, ordered, per-library groups of images with steps.

Every route is scoped by the request's library (``X-SD-Library-Id``). The
Pixiv export uses censored copies automatically, strips generation data by
default and refuses (409) instead of silently exporting an uncensored original.
"""

from __future__ import annotations

from typing import Any, Literal, NoReturn, Optional

from fastapi import APIRouter, Body, HTTPException, Query
from fastapi.responses import FileResponse

import db_batches as batch_db
from services import batch_export_service, batch_service
from services.batch_models import (
    BatchCensoredCopyRequest,
    BatchCensoredDiscardRequest,
    BatchCreateRequest,
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


def _raise_http_error(error: batch_db.BatchError) -> NoReturn:
    http_error = _not_found(error) or _conflict(error) or _export_error(error)
    if http_error is None:
        raise RuntimeError(f"Unhandled batch error: {error}") from error
    raise http_error from error


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
def post_batch(request: BatchCreateRequest) -> dict[str, Any]:
    try:
        return batch_service.create_batch(request)
    except batch_db.BatchError as error:
        _raise_http_error(error)


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
def delete_batch(batch_id: int) -> dict[str, Any]:
    try:
        return batch_service.delete_batch(batch_id)
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
