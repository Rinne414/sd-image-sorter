"""Request models for the V4 batch API (``/api/batches``)."""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from routers.publish import PublishWatermarkSettings

BatchKind = Literal["pixiv", "dataset", "custom"]
PositiveId = Annotated[int, Field(strict=True, gt=0)]
BatchName = Annotated[str, Field(min_length=1, max_length=200, pattern=r".*\S.*")]
StepId = Annotated[str, Field(pattern=r"^[a-z][a-z0-9_-]{0,39}$")]


class BatchStep(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: StepId
    enabled: bool = True


def _unique_step_ids(steps: list[BatchStep]) -> list[BatchStep]:
    ids = [step.id for step in steps]
    if len(ids) != len(set(ids)):
        raise ValueError("step ids must be unique")
    return steps


class BatchCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: BatchKind
    name: BatchName
    template_id: PositiveId | None = None
    image_ids: list[PositiveId] = Field(default_factory=list)


class BatchPatchRequest(BaseModel):
    """Only the fields present are changed; ``current_step: null`` clears it."""

    model_config = ConfigDict(extra="forbid")

    revision: Annotated[int, Field(strict=True, ge=1)]
    name: BatchName | None = None
    steps: list[BatchStep] | None = Field(default=None, min_length=1)
    settings: dict[str, Any] | None = None
    current_step: StepId | None = None
    archived: bool | None = None

    @field_validator("steps")
    @classmethod
    def _steps_unique(cls, value: list[BatchStep] | None) -> list[BatchStep] | None:
        return None if value is None else _unique_step_ids(value)


class BatchImageIdsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    image_ids: list[PositiveId] = Field(min_length=1)


class BatchReorderRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    image_ids: list[PositiveId]

    @field_validator("image_ids")
    @classmethod
    def _no_repeats(cls, value: list[int]) -> list[int]:
        if len(value) != len(set(value)):
            raise ValueError("image_ids must not repeat")
        return value


class BatchItemPatchRequest(BaseModel):
    """Only the fields present are changed; ``output_name: null`` clears it."""

    model_config = ConfigDict(extra="forbid")

    output_name: Annotated[str, Field(max_length=200)] | None = None
    item_state: dict[str, Any] | None = None


class BatchCensoredCopyRequest(BaseModel):
    """``item_state``, when sent, is written together with the copy: both or neither."""

    model_config = ConfigDict(extra="forbid")

    # Same bound as the censor editor's canvas save (CensorSaveDataRequest).
    image_data: str = Field(min_length=1, max_length=100_000_000)
    # Same as the item PATCH: absent keeps the state, null clears it.
    item_state: dict[str, Any] | None = None


class BatchCensoredDiscardRequest(BaseModel):
    """Optional body of a discard: the item's new state, written with the discard."""

    model_config = ConfigDict(extra="forbid")

    item_state: dict[str, Any] | None = None


class BatchTemplateCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: BatchKind
    name: BatchName
    steps: list[BatchStep] = Field(min_length=1)
    settings: dict[str, Any] = Field(default_factory=dict)

    @field_validator("steps")
    @classmethod
    def _steps_unique(cls, value: list[BatchStep]) -> list[BatchStep]:
        return _unique_step_ids(value)


class BatchExportNamesRequest(BaseModel):
    """What decides an export's file names; also the body of the name preview."""

    model_config = ConfigDict(extra="forbid")

    name_template: str = Field(default="{batch}_{n:02}", min_length=1, max_length=200)
    start_number: int = Field(default=1, ge=0)
    output_format: Literal["original", "png", "jpg", "webp"] = "original"
    missing_censored: Literal["block", "skip", "original"] = "block"


class BatchExportRequest(BatchExportNamesRequest):
    output_folder: str = Field(min_length=1)
    metadata_option: Literal["strip", "keep", "minimal"] = "strip"
    overwrite: bool = False
    caption_text: str = ""
    watermark: PublishWatermarkSettings = Field(
        default_factory=PublishWatermarkSettings
    )
