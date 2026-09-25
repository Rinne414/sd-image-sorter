"""Dataset batches: a V4 batch that is a view of a Dataset Maker project (D26).

Creating a dataset batch creates a project V3.5 can open (strict V1 settings);
linking a V3.5 project creates its batch once and returns it after that.
"""

from __future__ import annotations

from typing import Any

import db_batch_datasets as dataset_db
from services.batch_models import BatchCreateRequest
from services.dataset_export.trainer_contracts import get_trainer_contracts_response
from services.dataset_project_models import DatasetProjectSettingsV1

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
