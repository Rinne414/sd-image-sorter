"""Strict API models for immutable annotation revisions."""
from __future__ import annotations

from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, model_validator


PositiveStrictInt = Annotated[int, Field(strict=True, ge=1)]
NonNegativeStrictInt = Annotated[int, Field(strict=True, ge=0)]
AnnotationRevisionSource = Literal[
    "legacy_snapshot",
    "manual",
    "restore",
    "metadata",
    "wd14",
    "vlm",
    "translation",
    "sidecar_import",
]
AnnotationAuthorClass = Literal["user", "ai", "system", "import"]


def _validate_trimmed_provenance_identity(value: str) -> str:
    if value != value.strip():
        raise ValueError("must not have leading or trailing whitespace")
    return value


AnnotationProvenanceIdentity = Annotated[
    str,
    Field(min_length=1, max_length=512),
    AfterValidator(_validate_trimmed_provenance_identity),
]


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class ProjectLibraryAnnotationSubject(_StrictModel):
    item_type: Literal["library"]
    image_id: PositiveStrictInt


class ProjectLocalAnnotationSubject(_StrictModel):
    item_type: Literal["local"]
    path: str = Field(min_length=1, max_length=4096)


ProjectAnnotationSubject = Annotated[
    ProjectLibraryAnnotationSubject | ProjectLocalAnnotationSubject,
    Field(discriminator="item_type"),
]


class TrainingCaptionContentV1(_StrictModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)

    content_version: Literal[1]
    booru_caption: str = Field(max_length=20000)
    nl_caption: str = Field(max_length=20000)
    caption_type: Literal["booru", "nl", "both"]


class TrainingCaptionHeadRequest(_StrictModel):
    expected_project_revision: PositiveStrictInt
    subject: ProjectAnnotationSubject


class TrainingCaptionRevisionCreateRequest(TrainingCaptionHeadRequest):
    expected_head_generation: NonNegativeStrictInt
    content: TrainingCaptionContentV1


class TrainingCaptionRestoreRequest(_StrictModel):
    expected_project_revision: PositiveStrictInt
    revision_id: PositiveStrictInt
    expected_head_generation: NonNegativeStrictInt


class TrainingCaptionHistoryQuery(_StrictModel):
    expected_project_revision: int = Field(strict=False, ge=1)
    limit: int = Field(default=50, strict=False, ge=1, le=100)
    before_revision_id: int | None = Field(default=None, strict=False, ge=1)


class ProjectTrainingCaptionHeadsQuery(_StrictModel):
    expected_project_revision: int = Field(strict=False, ge=1)
    limit: int = Field(default=200, strict=False, ge=1, le=200)
    after_subject_id: int | None = Field(default=None, strict=False, ge=1)


class AnnotationRevisionProvenance(_StrictModel):
    source: AnnotationRevisionSource
    provider: AnnotationProvenanceIdentity | None
    model: AnnotationProvenanceIdentity | None
    author_class: AnnotationAuthorClass
    restored_from_revision_id: PositiveStrictInt | None

    @model_validator(mode="after")
    def validate_restore_lineage(self) -> "AnnotationRevisionProvenance":
        has_restore_source = self.source == "restore"
        has_restore_lineage = self.restored_from_revision_id is not None
        if has_restore_source != has_restore_lineage:
            raise ValueError(
                "source must be 'restore' if and only if "
                "restored_from_revision_id is present"
            )
        return self


class AnnotationRevisionResponse(AnnotationRevisionProvenance):
    id: PositiveStrictInt
    subject_id: PositiveStrictInt
    annotation_kind: Literal["training_caption"]
    parent_revision_id: PositiveStrictInt | None
    content: TrainingCaptionContentV1
    content_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    created_at: str


class TrainingCaptionHeadResponse(_StrictModel):
    subject_id: PositiveStrictInt | None
    subject_key: str = Field(min_length=1, max_length=1024)
    item: ProjectAnnotationSubject
    generation: NonNegativeStrictInt
    active_revision: AnnotationRevisionResponse | None
    reviewed_revision_id: PositiveStrictInt | None
    export_revision_id: PositiveStrictInt | None


class TrainingCaptionHistoryResponse(_StrictModel):
    subject_id: PositiveStrictInt
    revisions: list[AnnotationRevisionResponse]
    has_more: bool
    next_before_revision_id: PositiveStrictInt | None


class ProjectTrainingCaptionHeadsResponse(_StrictModel):
    project_id: PositiveStrictInt
    items: list[TrainingCaptionHeadResponse]
    has_more: bool
    next_after_subject_id: PositiveStrictInt | None
