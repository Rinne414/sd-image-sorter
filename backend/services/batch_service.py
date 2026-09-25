"""Business operations for V4 batches: CRUD, items, templates, censored copies.

Censored working copies are written by this module only, always as PNG and
always without any metadata, so nothing a batch keeps can leak a prompt.
"""

from __future__ import annotations

import json
import logging
from io import BytesIO
from pathlib import Path
from typing import Any

from fastapi import HTTPException
from PIL import Image, UnidentifiedImageError

import db_batch_datasets as batch_dataset_db
import db_batches as batch_db
from services import batch_dataset_service, batch_workdir
from services.batch_models import (
    BatchCensoredCopyRequest,
    BatchCensoredDiscardRequest,
    BatchCreateRequest,
    BatchImageIdsRequest,
    BatchItemPatchRequest,
    BatchPatchRequest,
    BatchReorderRequest,
    BatchTemplateCreateRequest,
)
from services.censor.output_io import _normalize_censor_source

logger = logging.getLogger(__name__)

BUILTIN_STEP_IDS: dict[str, tuple[str, ...]] = {
    "pixiv": ("pick", "censor", "order", "name", "export"),
    "dataset": ("pick", "tag", "edit", "check", "export"),
    "custom": ("pick", "order", "export"),
}


class BatchValidationError(batch_db.BatchError):
    """The request is well-formed but contradicts the batch (422)."""


class BatchCensoredCopyNotFoundError(batch_db.BatchError):
    def __init__(self, batch_id: int, image_id: int):
        self.batch_id = batch_id
        self.image_id = image_id
        super().__init__(f"Image {image_id} in batch {batch_id} has no censored copy")


def builtin_steps() -> dict[str, list[dict[str, Any]]]:
    return {
        kind: [{"id": step_id, "enabled": True} for step_id in step_ids]
        for kind, step_ids in BUILTIN_STEP_IDS.items()
    }


def _item_response(batch_id: int, row: dict[str, Any]) -> dict[str, Any]:
    has_censored = (
        batch_workdir.existing_censored_path(batch_id, row["censored_path"]) is not None
    )
    return {
        "image_id": int(row["image_id"]),
        "position": int(row["position"]),
        "filename": row["filename"],
        "width": row["width"],
        "height": row["height"],
        "output_name": row["output_name"],
        "has_censored": has_censored,
        "censored_at": row["censored_at"] if has_censored else None,
        "item_state": (
            json.loads(row["item_state_json"]) if row["item_state_json"] else None
        ),
    }


def _batch_response(
    row: dict[str, Any], item_rows: list[dict[str, Any]]
) -> dict[str, Any]:
    batch_id = int(row["id"])
    items = [_item_response(batch_id, item) for item in item_rows]
    response = {
        "id": batch_id,
        "library_id": row["library_id"],
        "kind": row["kind"],
        "name": row["name"],
        "steps": json.loads(row["steps_json"]),
        "settings": json.loads(row["settings_json"]),
        "current_step": row["current_step"],
        "dataset_project_id": row["dataset_project_id"],
        "revision": int(row["revision"]),
        "archived_at": row["archived_at"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "item_count": len(items),
        "censored_count": sum(1 for item in items if item["has_censored"]),
        "cover_image_ids": row["cover_image_ids"],
        "project_revision": row["project_revision"],
        "orphaned": row["orphaned"],
        "items": items,
    }
    if row["kind"] == "dataset":
        # Its images live in the project (read with GET /api/dataset/projects/{id}).
        response["item_count"] = row["item_count"]
        response["censored_count"] = 0
    return response


def _prune_working_files(batch_id: int, item_ids: list[int]) -> None:
    batch_workdir.prune_censored_files(batch_id, set(item_ids))


def list_batches(include_archived: bool, kind: str | None) -> dict[str, Any]:
    unlinked = (
        batch_dataset_db.list_unlinked_projects(include_archived)
        if kind in (None, "dataset")
        else []
    )
    return {
        "batches": batch_db.list_batches(include_archived, kind),
        "unlinked_dataset_projects": unlinked,
    }


def get_batch(batch_id: int) -> dict[str, Any]:
    row, items = batch_db.read_batch_view(batch_id)
    return _batch_response(row, items)


def _batch_shell(request: BatchCreateRequest) -> dict[str, Any]:
    """Steps, settings and first step of a new batch row: template or built-in."""
    if request.template_id is not None:
        template = batch_db.read_template(request.template_id)
        if template["kind"] != request.kind:
            raise BatchValidationError(
                f"Template {request.template_id} is a {template['kind']} template, "
                f"not {request.kind}"
            )
        steps = json.loads(template["steps_json"])
        settings_json = template["settings_json"]
    else:
        steps = builtin_steps()[request.kind]
        settings_json = "{}"
    return {
        "steps_json": json.dumps(steps),
        "settings_json": settings_json,
        "current_step": steps[0]["id"] if steps else None,
    }


def create_batch(request: BatchCreateRequest) -> tuple[dict[str, Any], bool]:
    """Return the response and whether a batch was created.

    ``False`` only when a dataset project that already has its batch is
    linked again: that batch is returned unchanged.
    """
    shell = _batch_shell(request)
    if request.kind == "dataset":
        batch_id, skipped, created = batch_dataset_service.create_dataset_batch(
            request, shell
        )
    else:
        batch_id, skipped = batch_db.create_batch(
            request.kind,
            (request.name or "").strip(),
            shell["steps_json"],
            shell["settings_json"],
            shell["current_step"],
            list(request.image_ids),
        )
        created = True
    if created:
        # A restored older database can hand out an id whose folder is still
        # on disk. Its files are inert (no row points at them), so a failed
        # cleanup must not fail the create.
        try:
            batch_workdir.remove_batch_folder(batch_id)
        except OSError:
            logger.warning(
                "Stale working folder for new batch %s remains",
                batch_id,
                exc_info=True,
            )
    return {"batch": get_batch(batch_id), "skipped_image_ids": skipped}, created


def _patch_changes(row: dict[str, Any], request: BatchPatchRequest) -> dict[str, Any]:
    fields_set = request.model_fields_set
    changes: dict[str, Any] = {}
    if request.name is not None:
        changes["name"] = request.name.strip()
    if request.settings is not None:
        changes["settings_json"] = json.dumps(request.settings)
    if request.archived is not None:
        changes["archived"] = request.archived
    if request.steps is not None:
        steps = [step.model_dump() for step in request.steps]
        changes["steps_json"] = json.dumps(steps)
    else:
        steps = json.loads(row["steps_json"])
    step_ids = [step["id"] for step in steps]
    if "current_step" in fields_set:
        if request.current_step is not None and request.current_step not in step_ids:
            raise BatchValidationError(
                f"current_step {request.current_step!r} is not one of the batch steps"
            )
        changes["current_step"] = request.current_step
    elif request.steps is not None and row["current_step"] not in step_ids:
        changes["current_step"] = step_ids[0]
    return changes


def patch_batch(batch_id: int, request: BatchPatchRequest) -> dict[str, Any]:
    row, _items = batch_db.read_batch(batch_id)
    changes = _patch_changes(row, request)
    if row["kind"] == "dataset":
        # Name and archive state belong to the project: changed in the same
        # transaction as the batch row.
        batch_dataset_db.update_dataset_batch(batch_id, request.revision, changes)
    else:
        batch_db.update_batch(batch_id, request.revision, changes)
    return get_batch(batch_id)


def delete_batch(batch_id: int) -> dict[str, Any]:
    batch_db.delete_batch(batch_id)
    try:
        batch_workdir.remove_batch_folder(batch_id)
    except OSError:
        # The rows are gone and no batch can ever reuse this id (AUTOINCREMENT);
        # the leftover folder only holds censored copies this app derived.
        logger.warning(
            "Batch %s deleted but its working folder remains", batch_id, exc_info=True
        )
    return {"deleted": True, "batch_id": batch_id}


def add_items(batch_id: int, request: BatchImageIdsRequest) -> dict[str, Any]:
    added, skipped = batch_db.add_items(batch_id, list(request.image_ids))
    batch = get_batch(batch_id)
    _prune_working_files(batch_id, [item["image_id"] for item in batch["items"]])
    return {"batch": batch, "added_image_ids": added, "skipped_image_ids": skipped}


def remove_items(batch_id: int, request: BatchImageIdsRequest) -> dict[str, Any]:
    removed, not_found = batch_db.remove_items(batch_id, list(request.image_ids))
    batch = get_batch(batch_id)
    _prune_working_files(batch_id, [item["image_id"] for item in batch["items"]])
    return {
        "batch": batch,
        "removed_image_ids": removed,
        "not_found_image_ids": not_found,
    }


def reorder_items(batch_id: int, request: BatchReorderRequest) -> dict[str, Any]:
    batch_db.reorder_items(batch_id, list(request.image_ids))
    return get_batch(batch_id)


def _item_state_field(
    request: BatchItemPatchRequest | BatchCensoredCopyRequest | BatchCensoredDiscardRequest,
) -> dict[str, Any]:
    """The item_state column change a request asks for: none when absent, NULL for null."""
    if "item_state" not in request.model_fields_set:
        return {}
    state = request.item_state
    return {"item_state_json": None if state is None else json.dumps(state)}


def patch_item(
    batch_id: int, image_id: int, request: BatchItemPatchRequest
) -> dict[str, Any]:
    fields: dict[str, Any] = {}
    if "output_name" in request.model_fields_set:
        name = (request.output_name or "").strip()
        fields["output_name"] = name or None
    fields.update(_item_state_field(request))
    row = batch_db.update_item(batch_id, image_id, fields)
    return _item_response(batch_id, row)


def _decode_censored_image(image_data: str) -> Image.Image:
    """Decode with the censor editor's limits; return a detached RGB/RGBA raster."""
    import services.censor_service as censor_service

    image_bytes, _ = censor_service.CensorService._decode_base64_image(image_data)
    try:
        with Image.open(BytesIO(image_bytes)) as opened:
            width, height = opened.size
            if width <= 0 or height <= 0:
                raise HTTPException(status_code=400, detail="Invalid image data")
            if width * height > censor_service.MAX_SAVE_DATA_PIXELS:
                raise HTTPException(
                    status_code=413,
                    detail="Censored image is too large (max 40 megapixels)",
                )
            opened.load()
            return _normalize_censor_source(opened)
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise HTTPException(status_code=400, detail="Invalid image data") from exc


def save_censored_copy(
    batch_id: int, image_id: int, request: BatchCensoredCopyRequest
) -> dict[str, Any]:
    """Write the copy and (when sent) the item state as one change: both or neither.

    The copy is encoded to a staging file first; it replaces the previous copy
    inside the database transaction that records it, and any failure up to
    the commit (the item went away, the database refused) puts the previous
    copy back.
    """
    from services.censor_service import CensorService

    batch_db.read_item(batch_id, image_id)
    image = _decode_censored_image(request.image_data)
    relative_path = batch_workdir.censored_relative_path(image_id)
    target = batch_workdir.resolve_censored_path(batch_id, relative_path)
    if target is None:
        raise RuntimeError(
            f"Censored copy path for image {image_id} left batch {batch_id}"
        )
    copy = batch_workdir.StagedCopy(target)
    fields = {"censored_path": relative_path, **_item_state_field(request)}
    try:
        clean = CensorService._strip_all_metadata(image)
        CensorService._save_image_with_format(clean, str(copy.staged), "png", {})
        row = batch_db.update_item(batch_id, image_id, fields, before_commit=copy.swap_in)
    except BaseException:
        copy.roll_back()
        raise
    copy.finish()
    return _item_response(batch_id, row)


def discard_censored_copy(
    batch_id: int, image_id: int, request: BatchCensoredDiscardRequest | None = None
) -> dict[str, Any]:
    """Drop the copy (and, when sent, set the item state) in one database change.

    The file goes only after that change committed: a failure keeps both.
    """
    current = batch_db.read_item(batch_id, image_id)
    fields = {"censored_path": None, **(_item_state_field(request) if request else {})}
    row = batch_db.update_item(batch_id, image_id, fields)
    batch_workdir.remove_file_quietly(
        batch_workdir.resolve_censored_path(batch_id, current["censored_path"])
    )
    return _item_response(batch_id, row)


def censored_copy_file(batch_id: int, image_id: int) -> Path:
    row = batch_db.read_item(batch_id, image_id)
    path = batch_workdir.existing_censored_path(batch_id, row["censored_path"])
    if path is None:
        raise BatchCensoredCopyNotFoundError(batch_id, image_id)
    return path


def _template_response(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": int(row["id"]),
        "kind": row["kind"],
        "name": row["name"],
        "steps": json.loads(row["steps_json"]),
        "settings": json.loads(row["settings_json"]),
        "created_at": row["created_at"],
    }


def list_templates(kind: str | None) -> dict[str, Any]:
    return {
        "templates": [_template_response(row) for row in batch_db.list_templates(kind)],
        "builtin_steps": builtin_steps(),
    }


def create_template(request: BatchTemplateCreateRequest) -> dict[str, Any]:
    template_id = batch_db.create_template(
        request.kind,
        request.name.strip(),
        json.dumps([step.model_dump() for step in request.steps]),
        json.dumps(request.settings),
    )
    return _template_response(batch_db.read_template(template_id))


def delete_template(template_id: int) -> dict[str, Any]:
    batch_db.delete_template(template_id)
    return {"deleted": True, "template_id": template_id}
