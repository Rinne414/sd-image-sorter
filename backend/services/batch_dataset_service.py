"""Dataset batches: a V4 batch that is a view of a Dataset Maker project (D26).

Creating a dataset batch creates a project V3.5 can open (strict V1 settings);
linking a V3.5 project creates its batch once and returns it after that.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import db_batch_datasets as dataset_db
import db_batches as batch_db
from services import batch_workdir
from services.batch_models import BatchCreateRequest
from services.dataset_export.trainer_contracts import get_trainer_contracts_response
from services.dataset_project_models import (
    DatasetProjectLocalItemResponse,
    DatasetProjectSettingsV1,
)
from services.dataset_project_service import (
    DatasetProjectNotFoundError,
    get_dataset_project,
)

DEFAULT_TRAINER = "kohya_toml"


def _default_trainer() -> dict[str, Any]:
    """Kohya with the contract version and defaults ``GET /api/dataset/trainers`` serves."""
    contract = next(
        trainer
        for trainer in get_trainer_contracts_response().trainers
        if trainer.wire_value == DEFAULT_TRAINER
    )
    bounds = contract.option_bounds
    return {
        "config": DEFAULT_TRAINER,
        "contract_version": contract.contract_version,
        "mask_export": "none",
        "repeats": bounds.repeats.default,
        "batch": bounds.batch_size.default,
        "resolution": bounds.resolution.default,
        "keep_tokens": bounds.keep_tokens.default,
    }


def default_dataset_project_settings() -> DatasetProjectSettingsV1:
    """V3.5's project defaults with the Kohya trainer selected.

    Validated with the same strict model V3.5 reads projects with, so a
    project V4 creates always opens in V3.5.
    """
    return DatasetProjectSettingsV1.model_validate(
        {
            "settings_version": 1,
            "target_model": "",
            "caption_render": {
                "trigger": "",
                "common_tags": [],
                "blacklist": [],
                "normalize_tag_underscores": True,
                "content_mode": "template",
                "prefix": "",
                "template": {
                    "template_override": "{trigger}, {tags:filtered}, {append}",
                    "replace_rules": {},
                    "max_tags": 0,
                },
            },
            "naming": {"preset": "keep", "custom_pattern": "{trigger}_{index:03d}"},
            "output": {
                "mode": "folder",
                "folder": "",
                "image_op": "copy",
                "overwrite_policy": "unique",
            },
            "trainer": _default_trainer(),
            "planning": {"epochs": 10},
        },
        strict=True,
    )


def create_dataset_batch(
    request: BatchCreateRequest, shell: dict[str, Any]
) -> tuple[int, list[int], bool]:
    """Return ``(batch_id, skipped_image_ids, created)``."""
    if request.dataset_project_id is not None:
        batch_id, created = dataset_db.link_dataset_project(
            request.dataset_project_id, shell
        )
        return batch_id, [], created
    if request.name is None:
        raise ValueError("A new dataset batch needs a name")
    batch_id, skipped = dataset_db.create_dataset_batch(
        request.name.strip(),
        shell,
        list(request.image_ids),
        default_dataset_project_settings().model_dump_json(),
    )
    return batch_id, skipped, True


def _linked_project_id(batch_id: int) -> int:
    """The project of a dataset batch of this library; refuses other kinds and orphans."""
    row, _items = batch_db.read_batch(batch_id)
    if row["kind"] != "dataset":
        raise dataset_db.BatchNotDatasetError(batch_id)
    if row["dataset_project_id"] is None:
        raise dataset_db.BatchDatasetOrphanedError(batch_id)
    return int(row["dataset_project_id"])


def upload_folder_for(batch_id: int) -> Path:
    """Where files uploaded into this dataset batch go (removed with the batch)."""
    _linked_project_id(batch_id)
    return batch_workdir.uploads_folder(batch_id)


def _inside(path: str, folder: Path) -> bool:
    try:
        return Path(path).resolve().is_relative_to(folder)
    except (OSError, ValueError):
        return False


def project_view(batch_id: int) -> dict[str, Any]:
    """The project exactly as V3.5 reads it, plus what the batch tiles need.

    ``library_images`` gives the file name and size of its Library images
    (the project stores ids only); ``uploaded_count`` counts its folder images
    that live in this batch's uploads folder, which go when the batch is
    deleted. Reading the project also lets its available folder images'
    thumbnails be served, as V3.5's project read does.
    """
    project_id = _linked_project_id(batch_id)
    try:
        project = get_dataset_project(project_id)
    except DatasetProjectNotFoundError as error:
        raise dataset_db.BatchDatasetOrphanedError(batch_id) from error
    library_ids = [
        item.image_id
        for item in project.items
        if not isinstance(item, DatasetProjectLocalItemResponse)
        and item.image_id is not None
    ]
    uploads = batch_workdir.uploads_folder(batch_id).resolve()
    uploaded = [
        item
        for item in project.items
        if isinstance(item, DatasetProjectLocalItemResponse)
        and _inside(item.path, uploads)
    ]
    return {
        "project": project.model_dump(mode="json"),
        "library_images": dataset_db.library_image_info(library_ids),
        "uploaded_count": len(uploaded),
    }
