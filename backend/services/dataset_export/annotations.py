"""Resolve strict Dataset annotation selections to one atomic caption source."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Literal, TypedDict

from pydantic import ValidationError

import database as db
from services.annotation_models import (
    AnnotationRevisionProvenance,
    TrainingCaptionContentV1,
)
from services.dataset_export.models import (
    DatasetAnnotationAuthorClass,
    DatasetAnnotationRevisionSource,
    DatasetDynamicSourceAnnotationSelection,
    DatasetExportPreviewRequest,
    DatasetExportRequest,
    DatasetFrozenDraftAnnotationSelection,
    DatasetRevisionAnnotationSelection,
)
from utils.path_validation import normalize_user_path


class AnnotationSelectionResolutionError(RuntimeError):
    """Raised when a strict annotation selection cannot be resolved exactly."""


class AnnotationSelectionCoverageError(RuntimeError):
    """Raised when strict selections do not match the requested export items."""


class RevisionAnnotationProvenance(TypedDict):
    kind: Literal["revision_ref"]
    revision_id: int
    content_sha256: str
    source: DatasetAnnotationRevisionSource
    author_class: DatasetAnnotationAuthorClass
    provider: str | None
    model: str | None
    restored_from_revision_id: int | None


class FrozenDraftAnnotationProvenance(TypedDict):
    kind: Literal["frozen_draft"]
    revision_id: None
    content_sha256: str


AnnotationProvenance = (
    RevisionAnnotationProvenance | FrozenDraftAnnotationProvenance
)


class ResolvedAnnotationSelection(TypedDict):
    content: TrainingCaptionContentV1 | None
    provenance: AnnotationProvenance | None


def training_caption_content_sha256(content: TrainingCaptionContentV1) -> str:
    """Hash canonical UTF-8 JSON using the immutable ledger contract."""
    encoded = json.dumps(
        content.model_dump(mode="python"),
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def annotation_selection_key(image_id: int, source_path: str) -> str:
    """Return the canonical dual-source key used by strict selections."""
    if image_id > 0:
        return str(image_id)
    try:
        return str(Path(normalize_user_path(source_path)).resolve())
    except (OSError, ValueError) as exc:
        raise AnnotationSelectionCoverageError(
            f"Annotation selection path cannot be normalized: path={source_path!r}, "
            f"error_type={type(exc).__name__}, error={exc}"
        ) from exc


def _canonical_request_selection_key(key: str) -> str:
    try:
        image_id = int(key)
    except ValueError:
        return annotation_selection_key(0, key)
    if image_id <= 0 or str(image_id) != key:
        raise AnnotationSelectionResolutionError(
            "Annotation selection key does not match a Library image ID or local "
            f"path: key={key!r}"
        )
    return str(image_id)


def _resolve_project_head(
    key: str,
    project_id: int,
    project_revision: int,
) -> db.ResolvedAnnotationHeadRecord:
    try:
        image_id = int(key)
    except ValueError:
        return db.resolve_project_local_training_caption_head(
            project_id,
            project_revision,
            key,
        )
    if image_id <= 0 or str(image_id) != key:
        raise AnnotationSelectionResolutionError(
            f"Annotation selection key does not match a Library image ID or local path: "
            f"key={key!r}"
        )
    return db.resolve_project_library_training_caption_head(
        project_id,
        project_revision,
        image_id,
    )


def _requested_annotation_keys(
    request: DatasetExportRequest | DatasetExportPreviewRequest,
) -> set[str]:
    from services.dataset_export.planning import (
        _iter_requested_scan_paths,
        _iter_unique_image_ids,
    )

    keys = {str(image_id) for image_id in _iter_unique_image_ids(request.image_ids)}
    keys.update(annotation_selection_key(0, path) for path in request.image_paths)
    keys.update(
        annotation_selection_key(0, path)
        for path in _iter_requested_scan_paths(request)  # type: ignore[arg-type]
    )
    return keys


def validate_annotation_selection_coverage(
    request: DatasetExportRequest | DatasetExportPreviewRequest,
    resolved: dict[str, ResolvedAnnotationSelection],
) -> None:
    """Require one strict selection per requested item before any export writes."""
    if not request.annotation_selections:
        return
    expected = _requested_annotation_keys(request)
    observed = set(resolved)
    missing = sorted(expected - observed)
    extra = sorted(observed - expected)
    if missing or extra:
        raise AnnotationSelectionCoverageError(
            "Strict annotation selections must match requested export items exactly: "
            f"missing={missing}, extra={extra}"
        )


def _resolve_revision_selection(
    key: str,
    selection: DatasetRevisionAnnotationSelection,
    project_id: int,
    project_revision: int,
) -> ResolvedAnnotationSelection:
    try:
        head = _resolve_project_head(key, project_id, project_revision)
    except db.AnnotationRevisionError as exc:
        raise AnnotationSelectionResolutionError(
            "Annotation revision selection does not match current Dataset Project "
            f"membership: key={key!r}, project_id={project_id}, "
            f"project_revision={project_revision}, revision_id={selection.revision_id}, "
            f"reason={exc}"
        ) from exc
    active_revision = head["active_revision"]
    if active_revision is None or active_revision["id"] != selection.revision_id:
        active_revision_id = (
            active_revision["id"] if active_revision is not None else None
        )
        raise AnnotationSelectionResolutionError(
            "Annotation revision selection does not match the current subject head: "
            f"key={key!r}, project_id={project_id}, "
            f"requested_revision_id={selection.revision_id}, "
            f"active_revision_id={active_revision_id}"
        )
    content = TrainingCaptionContentV1.model_validate(
        active_revision["content"],
        strict=True,
    )
    content_sha256 = training_caption_content_sha256(content)
    if content_sha256 != active_revision["content_sha256"]:
        raise AnnotationSelectionResolutionError(
            "Annotation revision content hash does not match persisted content: "
            f"key={key!r}, revision_id={selection.revision_id}, "
            f"expected_sha256={active_revision['content_sha256']}, "
            f"observed_sha256={content_sha256}"
        )
    try:
        provenance = AnnotationRevisionProvenance.model_validate(
            {
                "source": active_revision["source_kind"],
                "author_class": active_revision["author_class"],
                "provider": active_revision["provider"],
                "model": active_revision["model"],
                "restored_from_revision_id": active_revision[
                    "restored_from_revision_id"
                ],
            },
            strict=True,
        )
    except ValidationError as exc:
        raise AnnotationSelectionResolutionError(
            "Persisted annotation provenance is invalid: "
            f"key={key!r}, revision_id={selection.revision_id}, "
            f"source={active_revision['source_kind']!r}, "
            f"author_class={active_revision['author_class']!r}, "
            f"provider={active_revision['provider']!r}, "
            f"model={active_revision['model']!r}, "
            "restored_from_revision_id="
            f"{active_revision['restored_from_revision_id']!r}, reason={exc}"
        ) from exc
    return {
        "content": content,
        "provenance": {
            "kind": "revision_ref",
            "revision_id": active_revision["id"],
            "content_sha256": active_revision["content_sha256"],
            "source": provenance.source,
            "author_class": provenance.author_class,
            "provider": provenance.provider,
            "model": provenance.model,
            "restored_from_revision_id": provenance.restored_from_revision_id,
        },
    }


def _validate_frozen_project_selection(
    key: str,
    project_id: int,
    project_revision: int,
) -> None:
    try:
        _resolve_project_head(key, project_id, project_revision)
    except db.AnnotationRevisionError as exc:
        raise AnnotationSelectionResolutionError(
            "Frozen annotation selection does not match current Dataset Project "
            f"membership: key={key!r}, project_id={project_id}, "
            f"project_revision={project_revision}, reason={exc}"
        ) from exc


def resolve_annotation_selections(
    request: DatasetExportRequest | DatasetExportPreviewRequest,
) -> dict[str, ResolvedAnnotationSelection]:
    """Resolve every strict selection without legacy caption fallback."""
    resolved: dict[str, ResolvedAnnotationSelection] = {}
    project_id = request.dataset_project_id
    project_revision = request.dataset_project_revision
    for raw_key, selection in request.annotation_selections.items():
        key = _canonical_request_selection_key(raw_key)
        if key in resolved:
            raise AnnotationSelectionResolutionError(
                "Annotation selection keys collide after canonical normalization: "
                f"raw_key={raw_key!r}, canonical_key={key!r}"
            )
        if isinstance(selection, DatasetRevisionAnnotationSelection):
            if project_id is None or project_revision is None:
                raise AnnotationSelectionResolutionError(
                    "revision_ref requires dataset_project_id and "
                    f"dataset_project_revision: key={key!r}"
                )
            resolved[key] = _resolve_revision_selection(
                key,
                selection,
                project_id,
                project_revision,
            )
            continue
        if isinstance(selection, DatasetDynamicSourceAnnotationSelection):
            if project_id is None or project_revision is None:
                raise AnnotationSelectionResolutionError(
                    "dynamic_source requires dataset_project_id and "
                    f"dataset_project_revision: key={key!r}"
                )
            try:
                head = _resolve_project_head(key, project_id, project_revision)
            except db.AnnotationRevisionError as exc:
                raise AnnotationSelectionResolutionError(
                    "Dynamic source selection does not match current Dataset "
                    f"Project membership: key={key!r}, project_id={project_id}, "
                    f"project_revision={project_revision}, reason={exc}"
                ) from exc
            if head["active_revision"] is not None:
                raise AnnotationSelectionResolutionError(
                    "dynamic_source cannot replace an active caption revision: "
                    f"key={key!r}, project_id={project_id}, "
                    f"revision_id={head['active_revision']['id']}"
                )
            resolved[key] = {"content": None, "provenance": None}
            continue
        if not isinstance(selection, DatasetFrozenDraftAnnotationSelection):
            raise TypeError(
                f"Unsupported annotation selection model: {type(selection).__name__}"
            )
        if project_id is not None and project_revision is not None:
            _validate_frozen_project_selection(
                key,
                project_id,
                project_revision,
            )
        content = selection.content
        resolved[key] = {
            "content": content,
            "provenance": {
                "kind": "frozen_draft",
                "revision_id": None,
                "content_sha256": training_caption_content_sha256(content),
            },
        }
    return resolved


__all__ = [
    "AnnotationProvenance",
    "AnnotationSelectionCoverageError",
    "AnnotationSelectionResolutionError",
    "FrozenDraftAnnotationProvenance",
    "ResolvedAnnotationSelection",
    "RevisionAnnotationProvenance",
    "annotation_selection_key",
    "resolve_annotation_selections",
    "training_caption_content_sha256",
    "validate_annotation_selection_coverage",
]
