"""Strict request contracts for revision-backed Dataset exports."""
from __future__ import annotations

import importlib
import hashlib
import json
from pathlib import Path

import pytest
from PIL import Image
from pydantic import ValidationError

from services.annotation_models import TrainingCaptionContentV1
from services.dataset_export.models import (
    DatasetExportPreviewRequest,
    DatasetExportRequest,
    DatasetPackageRevisionAnnotation,
    DatasetReadinessRequest,
)
from services.dataset_export.annotations import AnnotationSelectionResolutionError


DEFAULT_SETTINGS_JSON_V1 = importlib.import_module(
    "migrations.033_dataset_project_settings"
).DEFAULT_SETTINGS_JSON_V1


def _content(booru_caption: str) -> dict[str, object]:
    return {
        "content_version": 1,
        "booru_caption": booru_caption,
        "nl_caption": "A person looks at the camera.",
        "caption_type": "both",
    }


@pytest.mark.parametrize(
    "updates",
    (
        {"source": "restore", "restored_from_revision_id": None},
        {"source": "manual", "restored_from_revision_id": 3},
        {"provider": " SmilingWolf"},
        {"model": ""},
    ),
)
def test_package_revision_annotation_rejects_malformed_provenance(
    updates: dict[str, object],
) -> None:
    payload: dict[str, object] = {
        "kind": "revision_ref",
        "revision_id": 5,
        "content_sha256": "a" * 64,
        "rendered_caption_sha256": "b" * 64,
        "source": "manual",
        "author_class": "user",
        "provider": None,
        "model": None,
        "restored_from_revision_id": None,
    }

    with pytest.raises(ValidationError):
        DatasetPackageRevisionAnnotation.model_validate(
            {**payload, **updates},
            strict=True,
        )


@pytest.mark.parametrize(
    "updates",
    (
        {"source_kind": "restore", "restored_from_revision_id": None},
        {"source_kind": "manual", "restored_from_revision_id": 3},
        {"provider": " SmilingWolf"},
        {"model": ""},
    ),
)
def test_revision_resolver_rejects_malformed_persisted_provenance(
    monkeypatch: pytest.MonkeyPatch,
    updates: dict[str, object],
) -> None:
    from services.dataset_export import annotations

    content = TrainingCaptionContentV1.model_validate(
        _content("saved, caption"),
        strict=True,
    )
    revision = {
        "id": 5,
        "content": content.model_dump(mode="python"),
        "content_sha256": annotations.training_caption_content_sha256(content),
        "source_kind": "manual",
        "author_class": "user",
        "provider": None,
        "model": None,
        "restored_from_revision_id": None,
    }
    monkeypatch.setattr(
        annotations,
        "_resolve_project_head",
        lambda _key, _project_id, _project_revision: {
            "active_revision": {**revision, **updates}
        },
    )
    request = DatasetExportRequest.model_validate(
        {
            "image_ids": [11],
            "dataset_project_id": 7,
            "dataset_project_revision": 3,
            "annotation_selections": {
                "11": {"kind": "revision_ref", "revision_id": 5},
            },
        },
        strict=True,
    )

    with pytest.raises(
        annotations.AnnotationSelectionResolutionError,
        match="Persisted annotation provenance",
    ):
        annotations.resolve_annotation_selections(request)


def test_annotation_selections_accept_strict_revision_or_frozen_draft() -> None:
    request = DatasetExportRequest.model_validate(
        {
            "image_ids": [11, 12],
            "dataset_project_id": 7,
            "dataset_project_revision": 3,
            "annotation_selections": {
                "11": {"kind": "revision_ref", "revision_id": 101},
                "12": {"kind": "frozen_draft", "content": _content("solo")},
            },
        },
        strict=True,
    )

    assert request.dataset_project_id == 7
    assert request.dataset_project_revision == 3
    assert request.annotation_selections["11"].kind == "revision_ref"
    assert request.annotation_selections["12"].kind == "frozen_draft"
    assert request.image_overrides == {}
    assert request.image_types == {}
    assert request.image_nl_overrides == {}


@pytest.mark.parametrize(
    "request_type",
    (DatasetExportRequest, DatasetExportPreviewRequest, DatasetReadinessRequest),
)
@pytest.mark.parametrize("content_mode", ("json", "prompt", "a1111"))
def test_annotation_selections_reject_non_training_caption_modes(
    request_type,
    content_mode: str,
) -> None:
    with pytest.raises(ValidationError, match="training caption content_mode"):
        request_type.model_validate(
            {
                "image_ids": [11],
                "content_mode": content_mode,
                "annotation_selections": {
                    "11": {
                        "kind": "frozen_draft",
                        "content": _content("saved, caption"),
                    },
                },
            },
            strict=True,
        )


@pytest.mark.parametrize(
    "legacy_field",
    ("image_overrides", "image_types", "image_nl_overrides"),
)
def test_annotation_selections_reject_every_legacy_override_map(
    legacy_field: str,
) -> None:
    with pytest.raises(ValidationError, match="annotation_selections"):
        DatasetExportRequest.model_validate(
            {
                "image_ids": [11],
                "dataset_project_id": 7,
                "dataset_project_revision": 3,
                "annotation_selections": {
                    "11": {"kind": "frozen_draft", "content": _content("solo")},
                },
                legacy_field: {"11": "legacy"},
            },
            strict=True,
        )


def test_revision_selection_requires_complete_project_identity() -> None:
    with pytest.raises(ValidationError, match="dataset_project_id"):
        DatasetExportRequest.model_validate(
            {
                "image_ids": [11],
                "annotation_selections": {
                    "11": {"kind": "revision_ref", "revision_id": 101},
                },
            },
            strict=True,
        )

    with pytest.raises(ValidationError, match="dataset_project_revision"):
        DatasetExportRequest.model_validate(
            {
                "image_ids": [11],
                "dataset_project_id": 7,
                "annotation_selections": {
                    "11": {"kind": "revision_ref", "revision_id": 101},
                },
            },
            strict=True,
        )


def test_project_identity_fields_must_be_paired_without_selections() -> None:
    with pytest.raises(ValidationError, match="must be provided together"):
        DatasetExportRequest.model_validate(
            {"dataset_project_id": 7},
            strict=True,
        )


def test_named_project_requires_strict_annotation_selections() -> None:
    with pytest.raises(ValidationError, match="annotation_selections"):
        DatasetExportRequest.model_validate(
            {
                "image_ids": [11],
                "dataset_project_id": 7,
                "dataset_project_revision": 3,
            },
            strict=True,
        )


def test_annotation_selection_content_is_strict_and_complete() -> None:
    with pytest.raises(ValidationError):
        DatasetExportRequest.model_validate(
            {
                "annotation_selections": {
                    "11": {
                        "kind": "frozen_draft",
                        "content": {
                            "content_version": 1,
                            "booru_caption": "solo",
                            "nl_caption": "A person.",
                            "caption_type": "automatic",
                        },
                    },
                },
            },
            strict=True,
        )


def test_revision_and_frozen_draft_resolve_to_one_atomic_content_contract(
    test_client,
    test_db,
    tmp_path: Path,
) -> None:
    from services.dataset_export.annotations import resolve_annotation_selections

    image_path = tmp_path / "revision-export.png"
    image_path.write_bytes(b"revision-export-fixture")
    image_id = int(test_db.add_image(path=str(image_path), filename=image_path.name))
    project_response = test_client.post(
        "/api/dataset/projects",
        json={
            "name": "Revision export",
            "items": [{"item_type": "library", "image_id": image_id}],
            "settings": json.loads(DEFAULT_SETTINGS_JSON_V1),
        },
    )
    assert project_response.status_code == 201
    project_id = int(project_response.json()["id"])
    revision_response = test_client.post(
        f"/api/annotations/projects/{project_id}/training-captions/revisions",
        json={
            "expected_project_revision": 1,
            "expected_head_generation": 0,
            "subject": {"item_type": "library", "image_id": image_id},
            "content": _content("saved, caption"),
        },
    )
    assert revision_response.status_code == 201
    revision = revision_response.json()["active_revision"]

    revision_request = DatasetExportRequest.model_validate(
        {
            "image_ids": [image_id],
            "dataset_project_id": project_id,
            "dataset_project_revision": 1,
            "annotation_selections": {
                str(image_id): {
                    "kind": "revision_ref",
                    "revision_id": revision["id"],
                },
            },
        },
        strict=True,
    )
    revision_resolved = resolve_annotation_selections(revision_request)
    assert revision_resolved[str(image_id)]["content"].model_dump(mode="python") == _content(
        "saved, caption"
    )
    assert revision_resolved[str(image_id)]["provenance"] == {
        "kind": "revision_ref",
        "revision_id": revision["id"],
        "content_sha256": revision["content_sha256"],
        "source": "manual",
        "author_class": "user",
        "provider": None,
        "model": None,
        "restored_from_revision_id": None,
    }

    frozen_request = DatasetExportRequest.model_validate(
        {
            "image_ids": [image_id],
            "annotation_selections": {
                str(image_id): {
                    "kind": "frozen_draft",
                    "content": _content("draft, caption"),
                },
            },
        },
        strict=True,
    )
    frozen_resolved = resolve_annotation_selections(frozen_request)
    assert frozen_resolved[str(image_id)]["content"].booru_caption == "draft, caption"
    assert frozen_resolved[str(image_id)]["provenance"]["kind"] == "frozen_draft"
    assert frozen_resolved[str(image_id)]["provenance"]["revision_id"] is None
    assert len(frozen_resolved[str(image_id)]["provenance"]["content_sha256"]) == 64


def test_revision_selection_rejects_wrong_subject_key(
    test_client,
    test_db,
    tmp_path: Path,
) -> None:
    from services.dataset_export.annotations import (
        AnnotationSelectionResolutionError,
        resolve_annotation_selections,
    )

    image_path = tmp_path / "wrong-subject.png"
    image_path.write_bytes(b"wrong-subject-fixture")
    image_id = int(test_db.add_image(path=str(image_path), filename=image_path.name))
    project_response = test_client.post(
        "/api/dataset/projects",
        json={
            "name": "Wrong subject",
            "items": [{"item_type": "library", "image_id": image_id}],
            "settings": json.loads(DEFAULT_SETTINGS_JSON_V1),
        },
    )
    project_id = int(project_response.json()["id"])
    revision_response = test_client.post(
        f"/api/annotations/projects/{project_id}/training-captions/revisions",
        json={
            "expected_project_revision": 1,
            "expected_head_generation": 0,
            "subject": {"item_type": "library", "image_id": image_id},
            "content": _content("saved"),
        },
    )
    revision_id = int(revision_response.json()["active_revision"]["id"])
    request = DatasetExportRequest.model_validate(
        {
            "image_ids": [image_id],
            "dataset_project_id": project_id,
            "dataset_project_revision": 1,
            "annotation_selections": {
                str(image_id + 1): {
                    "kind": "revision_ref",
                    "revision_id": revision_id,
                },
            },
        },
        strict=True,
    )

    with pytest.raises(AnnotationSelectionResolutionError, match="does not match"):
        resolve_annotation_selections(request)


@pytest.mark.parametrize(
    ("caption_type", "expected"),
    (
        ("booru", "saved, caption"),
        ("nl", "A person looks at the camera."),
        ("both", "saved, caption, A person looks at the camera."),
    ),
)
def test_atomic_annotation_renderer_uses_one_content_object(
    caption_type: str,
    expected: str,
) -> None:
    from services.dataset_export.captions import render_training_caption_content

    content = TrainingCaptionContentV1.model_validate(
        {
            **_content("saved, caption"),
            "caption_type": caption_type,
        },
        strict=True,
    )

    assert render_training_caption_content(content, {}, "", ()) == expected


@pytest.mark.parametrize(
    ("selections", "expected_code"),
    (
        (
            {
                "FIRST": {
                    "kind": "frozen_draft",
                    "content": _content("first, caption"),
                },
            },
            "annotation_selection_missing",
        ),
        (
            {
                "FIRST": {
                    "kind": "frozen_draft",
                    "content": _content("first, caption"),
                },
                "EXTRA": {
                    "kind": "frozen_draft",
                    "content": _content("extra, caption"),
                },
            },
            "annotation_selection_extra",
        ),
    ),
)
def test_readiness_requires_exact_annotation_selection_coverage(
    test_db,
    tmp_path: Path,
    selections: dict[str, dict[str, object]],
    expected_code: str,
) -> None:
    from services.dataset_export.readiness import run_dataset_readiness

    first_path = tmp_path / "first.png"
    second_path = tmp_path / "second.png"
    Image.new("RGB", (8, 8), color=(1, 2, 3)).save(first_path)
    Image.new("RGB", (8, 8), color=(4, 5, 6)).save(second_path)
    first_id = int(test_db.add_image(path=str(first_path), filename=first_path.name))
    second_id = int(test_db.add_image(path=str(second_path), filename=second_path.name))
    keyed_selections = {
        (str(first_id) if key == "FIRST" else str(second_id + 100)): value
        for key, value in selections.items()
    }
    request = DatasetReadinessRequest.model_validate(
        {
            "image_ids": [first_id, second_id],
            "output_folder": str(tmp_path / "output"),
            "content_mode": "tags",
            "annotation_selections": keyed_selections,
        },
        strict=True,
    )

    report = run_dataset_readiness(
        request,
        readiness_report_id="annotation-coverage",
        progress_callback=lambda _processed, _total, _message: None,
        cancellation_requested=lambda: False,
    )

    assert report.summary.status == "blocked"
    assert expected_code in {issue.code for issue in report.issues}


def test_strict_export_rejects_incomplete_selections_before_writes(
    tmp_path: Path,
) -> None:
    from services.dataset_export.annotations import AnnotationSelectionCoverageError
    from services.dataset_export.engine import export_dataset

    first_path = tmp_path / "strict-first.png"
    second_path = tmp_path / "strict-second.png"
    Image.new("RGB", (8, 8), color=(10, 20, 30)).save(first_path)
    Image.new("RGB", (8, 8), color=(40, 50, 60)).save(second_path)
    output_folder = tmp_path / "strict-output"
    request = DatasetExportRequest.model_validate(
        {
            "image_paths": [str(first_path), str(second_path)],
            "output_folder": str(output_folder),
            "content_mode": "tags",
            "annotation_selections": {
                str(first_path.resolve()): {
                    "kind": "frozen_draft",
                    "content": _content("first, caption"),
                },
            },
        },
        strict=True,
    )

    with pytest.raises(AnnotationSelectionCoverageError, match="missing"):
        export_dataset(request)

    assert output_folder.exists() is False


def test_frozen_draft_preview_readiness_export_and_package_provenance_agree(
    tmp_path: Path,
) -> None:
    from services.dataset_export.annotations import training_caption_content_sha256
    from services.dataset_export.engine import export_dataset, preview_dataset_export
    from services.dataset_export.readiness import run_dataset_readiness

    source = tmp_path / "frozen-source.png"
    Image.new("RGB", (12, 12), color=(70, 80, 90)).save(source)
    output_folder = tmp_path / "frozen-package"
    selection = {
        "kind": "frozen_draft",
        "content": _content("frozen, caption"),
    }
    payload = {
        "image_paths": [str(source)],
        "output_folder": str(output_folder),
        "naming_pattern": "sample",
        "content_mode": "tags",
        "trainer_config": "anima_lora_toml",
        "annotation_selections": {str(source.resolve()): selection},
    }
    preview = preview_dataset_export(
        DatasetExportPreviewRequest.model_validate(payload, strict=True)
    )
    readiness = run_dataset_readiness(
        DatasetReadinessRequest.model_validate(payload, strict=True),
        readiness_report_id="annotation-shared-render",
        progress_callback=lambda _processed, _total, _message: None,
        cancellation_requested=lambda: False,
    )
    exported = export_dataset(DatasetExportRequest.model_validate(payload, strict=True))

    expected_caption = "frozen, caption, A person looks at the camera."
    caption_path = output_folder / "sample.txt"
    assert preview["items"][0]["caption"] == expected_caption
    assert readiness.summary.status == "ready"
    assert exported.status == "ok"
    assert caption_path.read_text(encoding="utf-8") == expected_caption

    inventory = json.loads(
        (output_folder / "export_inventory.jsonl")
        .read_text(encoding="utf-8")
        .strip()
    )
    content = TrainingCaptionContentV1.model_validate(selection["content"], strict=True)
    assert inventory["annotation"] == {
        "kind": "frozen_draft",
        "content_sha256": training_caption_content_sha256(content),
        "rendered_caption_sha256": hashlib.sha256(
            expected_caption.encode("utf-8")
        ).hexdigest(),
    }


def test_frozen_nl_caption_keeps_quickfilled_trigger_in_final_sidecar(
    tmp_path: Path,
) -> None:
    from services.dataset_export.engine import export_dataset, preview_dataset_export
    from services.dataset_export.readiness import run_dataset_readiness

    source = tmp_path / "frozen-nl-source.png"
    Image.new("RGB", (12, 12), color=(71, 81, 91)).save(source)
    output_folder = tmp_path / "frozen-nl-output"
    selection = {
        "kind": "frozen_draft",
        "content": {
            "content_version": 1,
            "booru_caption": "Hero_Token, 1girl",
            "nl_caption": "A person looks at the camera.",
            "caption_type": "nl",
        },
    }
    payload = {
        "image_paths": [str(source)],
        "output_folder": str(output_folder),
        "naming_pattern": "frozen_nl",
        "content_mode": "tags",
        "trigger": "Hero_Token",
        "common_tags": ["hero token"],
        "annotation_selections": {str(source.resolve()): selection},
    }

    preview = preview_dataset_export(
        DatasetExportPreviewRequest.model_validate(payload, strict=True)
    )
    readiness = run_dataset_readiness(
        DatasetReadinessRequest.model_validate(payload, strict=True),
        readiness_report_id="frozen-nl-trigger",
        progress_callback=lambda _processed, _total, _message: None,
        cancellation_requested=lambda: False,
    )
    exported = export_dataset(DatasetExportRequest.model_validate(payload, strict=True))

    expected = "Hero_Token, A person looks at the camera."
    assert preview["items"][0]["caption"] == expected
    assert readiness.summary.status == "ready"
    assert exported.status == "ok"
    assert (output_folder / "frozen_nl.txt").read_text(encoding="utf-8") == expected


def test_frozen_booru_caption_keeps_one_quickfilled_trigger_end_to_end(
    tmp_path: Path,
) -> None:
    from services.dataset_export.engine import export_dataset, preview_dataset_export
    from services.dataset_export.readiness import run_dataset_readiness

    source = tmp_path / "frozen-booru-source.png"
    Image.new("RGB", (12, 12), color=(72, 82, 92)).save(source)
    output_folder = tmp_path / "frozen-booru-output"
    selection = {
        "kind": "frozen_draft",
        "content": {
            "content_version": 1,
            "booru_caption": "Hero_Token, 1girl, red_hair",
            "nl_caption": "",
            "caption_type": "booru",
        },
    }
    payload = {
        "image_paths": [str(source)],
        "output_folder": str(output_folder),
        "naming_pattern": "frozen_booru",
        "content_mode": "template",
        "trigger": "Hero_Token",
        "common_tags": ["hero token"],
        "annotation_selections": {str(source.resolve()): selection},
    }

    preview = preview_dataset_export(
        DatasetExportPreviewRequest.model_validate(payload, strict=True)
    )
    readiness = run_dataset_readiness(
        DatasetReadinessRequest.model_validate(payload, strict=True),
        readiness_report_id="frozen-booru-trigger",
        progress_callback=lambda _processed, _total, _message: None,
        cancellation_requested=lambda: False,
    )
    exported = export_dataset(DatasetExportRequest.model_validate(payload, strict=True))

    expected = "Hero_Token, 1girl, red_hair"
    assert preview["items"][0]["caption"] == expected
    assert readiness.summary.status == "ready"
    assert exported.status == "ok"
    assert (output_folder / "frozen_booru.txt").read_text(encoding="utf-8") == expected


def test_named_project_dynamic_source_applies_current_caption_settings(
    test_client,
    tmp_path: Path,
) -> None:
    from services.dataset_export.engine import export_dataset, preview_dataset_export
    from services.dataset_session.allowlist import _register_session_paths

    source = tmp_path / "dynamic-source.png"
    Image.new("RGB", (12, 12), color=(90, 100, 110)).save(source)
    source.with_suffix(".txt").write_text(
        "Hero Token, 1girl, red_hair",
        encoding="utf-8",
    )
    _register_session_paths([str(source)])
    project_response = test_client.post(
        "/api/dataset/projects",
        json={
            "name": "Dynamic local source",
            "items": [{"item_type": "local", "path": str(source)}],
            "settings": json.loads(DEFAULT_SETTINGS_JSON_V1),
        },
    )
    assert project_response.status_code == 201, project_response.text
    project = project_response.json()
    output_folder = tmp_path / "dynamic-output"
    payload = {
        "image_paths": [str(source)],
        "output_folder": str(output_folder),
        "naming_pattern": "dynamic",
        "content_mode": "tags",
        "trigger": "Hero_Token",
        "common_tags": ["Hero_Token", "masterpiece"],
        "blacklist": ["red_hair"],
        "normalize_tag_underscores": False,
        "dataset_project_id": project["id"],
        "dataset_project_revision": project["revision"],
        "annotation_selections": {
            str(source.resolve()): {"kind": "dynamic_source"},
        },
    }

    preview = preview_dataset_export(
        DatasetExportPreviewRequest.model_validate(payload, strict=True)
    )
    exported = export_dataset(
        DatasetExportRequest.model_validate(payload, strict=True)
    )

    expected = "Hero_Token, 1girl, masterpiece"
    assert preview["items"][0]["caption"] == expected
    assert exported.status == "ok"
    assert (output_folder / "dynamic.txt").read_text(encoding="utf-8") == expected


def test_local_multiline_template_deduplicates_trigger_after_final_render(
    tmp_path: Path,
) -> None:
    from services.dataset_export.engine import export_dataset, preview_dataset_export
    from services.dataset_export.readiness import run_dataset_readiness
    from services.dataset_session.allowlist import _register_session_paths

    source = tmp_path / "local-multiline.png"
    Image.new("RGB", (12, 12), color=(91, 101, 111)).save(source)
    source.with_suffix(".txt").write_text(
        "Hero Token, 1girl",
        encoding="utf-8",
    )
    _register_session_paths([str(source)])
    output_folder = tmp_path / "local-multiline-output"
    payload = {
        "image_paths": [str(source)],
        "output_folder": str(output_folder),
        "naming_pattern": "local_multiline",
        "content_mode": "template",
        "trigger": "Hero_Token",
        "common_tags": ["hero token"],
        "normalize_tag_underscores": True,
        "template_options": {
            "preset_id": "custom",
            "template_override": "{trigger},\n{tags:filtered}",
            "trigger": "Hero_Token",
            "blacklist": [],
            "replace_rules": {},
            "max_tags": 0,
            "append": ["hero token"],
        },
    }

    preview = preview_dataset_export(
        DatasetExportPreviewRequest.model_validate(payload, strict=True)
    )
    readiness = run_dataset_readiness(
        DatasetReadinessRequest.model_validate(payload, strict=True),
        readiness_report_id="local-multiline-trigger",
        progress_callback=lambda _processed, _total, _message: None,
        cancellation_requested=lambda: False,
    )
    exported = export_dataset(DatasetExportRequest.model_validate(payload, strict=True))

    expected = "Hero_Token\n1girl"
    assert preview["items"][0]["caption"] == expected
    assert readiness.summary.status == "warnings"
    assert "missing_trigger" not in {issue.code for issue in readiness.issues}
    assert exported.status == "ok"
    assert (output_folder / "local_multiline.txt").read_text(encoding="utf-8") == expected


def test_scan_manifest_multiline_template_uses_final_trigger_invariant(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import services.dataset_session_service as dataset_session_service
    from services.dataset_export.engine import export_dataset, preview_dataset_export
    from services.dataset_export.readiness import run_dataset_readiness

    source_folder = tmp_path / "manifest-source"
    source_folder.mkdir()
    source = source_folder / "manifest.png"
    Image.new("RGB", (12, 12), color=(92, 102, 112)).save(source)
    source.with_suffix(".txt").write_text(
        "Hero Token, 1girl",
        encoding="utf-8",
    )
    scan_dir = tmp_path / "scan-manifests"
    scan_dir.mkdir()
    monkeypatch.setattr(dataset_session_service, "_SCAN_DIR", scan_dir)
    scan = dataset_session_service.scan_folder_for_dataset(
        str(source_folder),
        recursive=False,
        limit=1,
    )
    output_folder = tmp_path / "manifest-output"
    payload = {
        "dataset_scan_tokens": [
            {"scan_token": scan["scan_token"], "exclude_paths": []},
        ],
        "output_folder": str(output_folder),
        "naming_pattern": "manifest",
        "content_mode": "template",
        "trigger": "Hero_Token",
        "common_tags": ["hero token"],
        "normalize_tag_underscores": False,
        "template_options": {
            "preset_id": "custom",
            "template_override": "{trigger},\n{tags:filtered}",
            "trigger": "Hero_Token",
            "blacklist": [],
            "replace_rules": {},
            "max_tags": 0,
            "append": ["hero token"],
        },
    }

    preview = preview_dataset_export(
        DatasetExportPreviewRequest.model_validate(payload, strict=True)
    )
    readiness = run_dataset_readiness(
        DatasetReadinessRequest.model_validate(payload, strict=True),
        readiness_report_id="manifest-multiline-trigger",
        progress_callback=lambda _processed, _total, _message: None,
        cancellation_requested=lambda: False,
    )
    exported = export_dataset(DatasetExportRequest.model_validate(payload, strict=True))

    expected = "Hero_Token\n1girl"
    assert preview["items"][0]["caption"] == expected
    assert readiness.summary.status == "warnings"
    assert "missing_trigger" not in {issue.code for issue in readiness.issues}
    assert exported.status == "ok"
    assert (output_folder / "manifest.txt").read_text(encoding="utf-8") == expected


def test_scan_manifest_nl_quickfill_applies_trigger_to_unhydrated_caption(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import services.dataset_session_service as dataset_session_service
    from services.dataset_export.engine import export_dataset, preview_dataset_export
    from services.dataset_export.readiness import run_dataset_readiness

    source_folder = tmp_path / "manifest-nl-source"
    source_folder.mkdir()
    source = source_folder / "manifest-nl.png"
    Image.new("RGB", (12, 12), color=(94, 104, 114)).save(source)
    scan_dir = tmp_path / "scan-manifests-nl"
    scan_dir.mkdir()
    monkeypatch.setattr(dataset_session_service, "_SCAN_DIR", scan_dir)
    scan = dataset_session_service.scan_folder_for_dataset(
        str(source_folder),
        recursive=False,
        limit=1,
    )
    output_folder = tmp_path / "manifest-nl-output"
    payload = {
        "dataset_scan_tokens": [
            {"scan_token": scan["scan_token"], "exclude_paths": []},
        ],
        "output_folder": str(output_folder),
        "naming_pattern": "manifest_nl",
        "content_mode": "nl_caption",
        "trigger": "Hero_Token",
        "common_tags": ["hero token"],
        "normalize_tag_underscores": False,
    }

    trigger_only_preview = preview_dataset_export(
        DatasetExportPreviewRequest.model_validate(
            {**payload, "common_tags": []},
            strict=True,
        )
    )
    preview = preview_dataset_export(
        DatasetExportPreviewRequest.model_validate(payload, strict=True)
    )
    readiness = run_dataset_readiness(
        DatasetReadinessRequest.model_validate(payload, strict=True),
        readiness_report_id="manifest-nl-trigger",
        progress_callback=lambda _processed, _total, _message: None,
        cancellation_requested=lambda: False,
    )
    exported = export_dataset(DatasetExportRequest.model_validate(payload, strict=True))

    assert trigger_only_preview["items"][0]["caption"] == ""
    assert preview["items"][0]["caption"] == "Hero_Token"
    assert "missing_trigger" not in {issue.code for issue in readiness.issues}
    assert exported.status == "ok"
    assert (
        output_folder / "manifest_nl.txt"
    ).read_text(encoding="utf-8") == "Hero_Token"


def test_scan_manifest_cleanup_blacklist_blocks_spaced_and_underscored_old_trigger(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import services.dataset_session_service as dataset_session_service
    from services.dataset_export.engine import export_dataset, preview_dataset_export
    from services.dataset_export.readiness import run_dataset_readiness

    source_folder = tmp_path / "manifest-cleanup-source"
    source_folder.mkdir()
    source = source_folder / "manifest-cleanup.png"
    Image.new("RGB", (12, 12), color=(96, 106, 116)).save(source)
    source.with_suffix(".txt").write_text(
        "Current_Trigger, Legacy_Trigger, 1girl",
        encoding="utf-8",
    )
    scan_dir = tmp_path / "scan-manifests-cleanup"
    scan_dir.mkdir()
    monkeypatch.setattr(dataset_session_service, "_SCAN_DIR", scan_dir)
    scan = dataset_session_service.scan_folder_for_dataset(
        str(source_folder),
        recursive=False,
        limit=1,
    )
    output_folder = tmp_path / "manifest-cleanup-output"
    cleanup_blacklist = ["legacy trigger", "legacy_trigger"]
    payload = {
        "dataset_scan_tokens": [
            {"scan_token": scan["scan_token"], "exclude_paths": []},
        ],
        "output_folder": str(output_folder),
        "naming_pattern": "manifest_cleanup",
        "content_mode": "template",
        "trigger": "Current_Trigger",
        "common_tags": ["Current_Trigger"],
        "blacklist": cleanup_blacklist,
        "normalize_tag_underscores": False,
        "template_options": {
            "preset_id": "custom",
            "template_override": "{trigger}, {tags:filtered}",
            "trigger": "Current_Trigger",
            "blacklist": cleanup_blacklist,
            "replace_rules": {},
            "max_tags": 0,
            "append": ["Current_Trigger"],
        },
    }

    preview = preview_dataset_export(
        DatasetExportPreviewRequest.model_validate(payload, strict=True)
    )
    readiness = run_dataset_readiness(
        DatasetReadinessRequest.model_validate(payload, strict=True),
        readiness_report_id="manifest-cleanup-trigger",
        progress_callback=lambda _processed, _total, _message: None,
        cancellation_requested=lambda: False,
    )
    exported = export_dataset(DatasetExportRequest.model_validate(payload, strict=True))

    expected = "Current_Trigger, 1girl"
    assert preview["items"][0]["caption"] == expected
    assert "missing_trigger" not in {issue.code for issue in readiness.issues}
    assert exported.status == "ok"
    assert (
        output_folder / "manifest_cleanup.txt"
    ).read_text(encoding="utf-8") == expected


def test_quickfill_does_not_corrupt_json_preview_readiness_or_export(
    tmp_path: Path,
) -> None:
    from services.dataset_export.engine import export_dataset, preview_dataset_export
    from services.dataset_export.readiness import run_dataset_readiness

    source = tmp_path / "json-quickfill-source.png"
    Image.new("RGB", (12, 12), color=(95, 105, 115)).save(source)
    output_folder = tmp_path / "json-quickfill-output"
    payload = {
        "image_paths": [str(source)],
        "output_folder": str(output_folder),
        "naming_pattern": "json_quickfill",
        "content_mode": "json",
        "trigger": "Hero_Token",
        "common_tags": ["hero token"],
    }

    preview = preview_dataset_export(
        DatasetExportPreviewRequest.model_validate(payload, strict=True)
    )
    readiness = run_dataset_readiness(
        DatasetReadinessRequest.model_validate(payload, strict=True),
        readiness_report_id="json-quickfill",
        progress_callback=lambda _processed, _total, _message: None,
        cancellation_requested=lambda: False,
    )
    exported = export_dataset(DatasetExportRequest.model_validate(payload, strict=True))

    preview_document = json.loads(preview["items"][0]["caption"])
    exported_document = json.loads(
        (output_folder / "json_quickfill.json").read_text(encoding="utf-8")
    )
    assert readiness.summary.blocker_count == 0
    assert exported.status == "ok"
    assert preview_document == exported_document


@pytest.mark.parametrize(
    "content_mode",
    ("prompt", "negative", "prompt_negative", "a1111", "prompt_nl"),
)
def test_quickfill_does_not_mutate_non_training_text_modes(
    content_mode: str,
) -> None:
    from services.dataset_export.captions import _render_dataset_sidecar
    from services.tag_export_service import build_sidecar_content

    record = {
        "id": 1,
        "path": "C:/isolated/quickfill.png",
        "filename": "quickfill.png",
        "prompt": "positive prompt",
        "negative_prompt": "negative prompt",
        "nl_caption": "natural language caption",
        "metadata_json": "{}",
    }
    request = DatasetExportPreviewRequest.model_validate(
        {
            "image_ids": [1],
            "content_mode": content_mode,
            "trigger": "Hero_Token",
            "common_tags": ["hero token"],
        },
        strict=True,
    )
    expected = build_sidecar_content(
        record,
        [],
        content_mode=content_mode,
        blacklist=set(),
        prefix="",
        template_options=None,
        normalize_tag_underscores=True,
    )

    actual = _render_dataset_sidecar(
        record,
        [],
        request,
        blacklist_set=set(),
        image_overrides_int={},
        image_overrides_path={},
    )

    assert actual == expected


def test_revision_nl_caption_keeps_trigger_and_package_hash(
    test_client,
    test_db,
    tmp_path: Path,
) -> None:
    from services.dataset_export.engine import export_dataset, preview_dataset_export
    from services.dataset_export.readiness import run_dataset_readiness

    source = tmp_path / "revision-nl-source.png"
    Image.new("RGB", (12, 12), color=(93, 103, 113)).save(source)
    image_id = int(test_db.add_image(path=str(source), filename=source.name))
    project_response = test_client.post(
        "/api/dataset/projects",
        json={
            "name": "Revision NL trigger",
            "items": [{"item_type": "library", "image_id": image_id}],
            "settings": json.loads(DEFAULT_SETTINGS_JSON_V1),
        },
    )
    assert project_response.status_code == 201, project_response.text
    project_id = int(project_response.json()["id"])
    content = {
        "content_version": 1,
        "booru_caption": "Hero_Token, 1girl",
        "nl_caption": "A person looks at the camera.",
        "caption_type": "nl",
    }
    mutation = test_db.create_project_library_training_caption_revision(
        project_id,
        1,
        image_id,
        0,
        content,
        "manual",
        "user",
        None,
        None,
    )
    revision = mutation["revision"]
    output_folder = tmp_path / "revision-nl-output"
    payload = {
        "image_ids": [image_id],
        "dataset_project_id": project_id,
        "dataset_project_revision": 1,
        "output_folder": str(output_folder),
        "naming_pattern": "revision_nl",
        "content_mode": "tags",
        "trigger": "Hero_Token",
        "common_tags": ["hero token"],
        "trainer_config": "anima_lora_toml",
        "annotation_selections": {
            str(image_id): {
                "kind": "revision_ref",
                "revision_id": revision["id"],
            },
        },
    }

    preview = preview_dataset_export(
        DatasetExportPreviewRequest.model_validate(payload, strict=True)
    )
    readiness = run_dataset_readiness(
        DatasetReadinessRequest.model_validate(payload, strict=True),
        readiness_report_id="revision-nl-trigger",
        progress_callback=lambda _processed, _total, _message: None,
        cancellation_requested=lambda: False,
    )
    exported = export_dataset(DatasetExportRequest.model_validate(payload, strict=True))

    expected = "Hero_Token, A person looks at the camera."
    rendered_sha256 = hashlib.sha256(expected.encode("utf-8")).hexdigest()
    inventory = json.loads(
        (output_folder / "export_inventory.jsonl").read_text(encoding="utf-8").strip()
    )
    assert preview["items"][0]["caption"] == expected
    assert readiness.summary.status == "ready"
    assert exported.status == "ok"
    assert (output_folder / "revision_nl.txt").read_text(encoding="utf-8") == expected
    assert inventory["annotation"]["rendered_caption_sha256"] == rendered_sha256


@pytest.mark.parametrize(
    ("endpoint", "service_name", "payload"),
    (
        (
            "/api/dataset/export-preview",
            "preview_dataset_export",
            {
                "image_ids": [1],
                "dataset_project_id": 7,
                "dataset_project_revision": 3,
                "annotation_selections": {"1": {"kind": "dynamic_source"}},
            },
        ),
        (
            "/api/dataset/export",
            "export_dataset",
            {
                "image_ids": [1],
                "output_folder": "C:/dataset-output",
                "dataset_project_id": 7,
                "dataset_project_revision": 3,
                "annotation_selections": {"1": {"kind": "dynamic_source"}},
            },
        ),
    ),
)
def test_annotation_selection_conflicts_return_actionable_http_errors(
    test_client,
    monkeypatch,
    endpoint: str,
    service_name: str,
    payload: dict[str, object],
) -> None:
    dataset_router = importlib.import_module("routers.dataset")

    def reject_selection(_request) -> None:
        raise AnnotationSelectionResolutionError(
            "dynamic_source project revision 3 no longer matches project 7"
        )

    monkeypatch.setattr(dataset_router, service_name, reject_selection)
    response = test_client.post(endpoint, json=payload)

    assert response.status_code == 409
    assert response.json()["error"] == (
        "Dataset annotation selection conflict: dynamic_source project revision 3 "
        "no longer matches project 7. Reload the Dataset Project and run readiness again."
    )


def test_revision_export_package_records_and_verifies_exact_provenance(
    test_client,
    test_db,
    tmp_path: Path,
) -> None:
    from services.dataset_export.engine import export_dataset

    source = tmp_path / "revision-package-source.png"
    Image.new("RGB", (12, 12), color=(100, 110, 120)).save(source)
    image_id = int(test_db.add_image(path=str(source), filename=source.name))
    project_response = test_client.post(
        "/api/dataset/projects",
        json={
            "name": "Revision package",
            "items": [{"item_type": "library", "image_id": image_id}],
            "settings": json.loads(DEFAULT_SETTINGS_JSON_V1),
        },
    )
    project_id = int(project_response.json()["id"])
    mutation = test_db.create_project_library_training_caption_revision(
        project_id,
        1,
        image_id,
        0,
        _content("revision, package"),
        "wd14",
        "ai",
        "SmilingWolf",
        "wd-swinv2-tagger-v3",
    )
    revision = mutation["revision"]
    output_folder = tmp_path / "revision-package"
    response = export_dataset(
        DatasetExportRequest.model_validate(
            {
                "image_ids": [image_id],
                "dataset_project_id": project_id,
                "dataset_project_revision": 1,
                "output_folder": str(output_folder),
                "naming_pattern": "revision_sample",
                "content_mode": "tags",
                "trainer_config": "anima_lora_toml",
                "annotation_selections": {
                    str(image_id): {
                        "kind": "revision_ref",
                        "revision_id": revision["id"],
                    },
                },
            },
            strict=True,
        )
    )

    expected_caption = "revision, package, A person looks at the camera."
    rendered_sha256 = hashlib.sha256(expected_caption.encode("utf-8")).hexdigest()
    inventory = json.loads(
        (output_folder / "export_inventory.jsonl")
        .read_text(encoding="utf-8")
        .strip()
    )
    assert inventory["annotation"] == {
        "kind": "revision_ref",
        "revision_id": revision["id"],
        "content_sha256": revision["content_sha256"],
        "rendered_caption_sha256": rendered_sha256,
        "source": "wd14",
        "author_class": "ai",
        "provider": "SmilingWolf",
        "model": "wd-swinv2-tagger-v3",
        "restored_from_revision_id": None,
    }
    verified = test_client.post(
        "/api/dataset/package-verifications",
        json={
            "output_folder": str(output_folder),
            "expected_run_id": response.package_run_id,
        },
    )
    assert verified.status_code == 200
    assert verified.json()["status"] == "complete"
    assert verified.json()["issues"] == []

    restored_response = test_client.post(
        f"/api/annotations/projects/{project_id}/subjects/"
        f"{mutation['subject']['id']}/training-captions/restore",
        json={
            "expected_project_revision": 1,
            "revision_id": revision["id"],
            "expected_head_generation": 1,
        },
    )
    assert restored_response.status_code == 201
    restored = restored_response.json()["active_revision"]
    restored_output = tmp_path / "restored-revision-package"
    restored_export = export_dataset(
        DatasetExportRequest.model_validate(
            {
                "image_ids": [image_id],
                "dataset_project_id": project_id,
                "dataset_project_revision": 1,
                "output_folder": str(restored_output),
                "naming_pattern": "restored_sample",
                "content_mode": "tags",
                "trainer_config": "anima_lora_toml",
                "annotation_selections": {
                    str(image_id): {
                        "kind": "revision_ref",
                        "revision_id": restored["id"],
                    },
                },
            },
            strict=True,
        )
    )
    restored_inventory = json.loads(
        (restored_output / "export_inventory.jsonl")
        .read_text(encoding="utf-8")
        .strip()
    )
    assert restored_inventory["annotation"] == {
        "kind": "revision_ref",
        "revision_id": restored["id"],
        "content_sha256": restored["content_sha256"],
        "rendered_caption_sha256": rendered_sha256,
        "source": "restore",
        "author_class": "user",
        "provider": None,
        "model": None,
        "restored_from_revision_id": revision["id"],
    }
    restored_verified = test_client.post(
        "/api/dataset/package-verifications",
        json={
            "output_folder": str(restored_output),
            "expected_run_id": restored_export.package_run_id,
        },
    )
    assert restored_verified.status_code == 200
    assert restored_verified.json()["status"] == "complete"
    assert restored_verified.json()["issues"] == []
