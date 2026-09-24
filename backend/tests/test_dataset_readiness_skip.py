"""Export the usable items: skip per-item problems and allow empty captions."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import HTTPException
from PIL import Image

from services.dataset_export.artifacts import _validate_export_request_read_only
from services.dataset_export.engine import export_dataset
from services.dataset_export.models import (
    DatasetExportRequest,
    DatasetReadinessRequest,
)
from services.dataset_export.readiness import (
    DatasetReadinessPlan,
    plan_dataset_readiness,
    readiness_item_key,
)


def _image(path: Path) -> Path:
    Image.new("RGB", (8, 8), color=(40, 30, 20)).save(path)
    return path


def _request(
    image_paths: list[Path],
    output_folder: Path,
    overrides: dict[Path, str],
    **updates: object,
) -> DatasetReadinessRequest:
    payload: dict[str, object] = {
        "image_paths": [str(path) for path in image_paths],
        "output_folder": str(output_folder),
        "naming_pattern": "{filename}",
        "content_mode": "tags",
        "overwrite_policy": "unique",
        "image_overrides": {
            str(path.resolve()): caption for path, caption in overrides.items()
        },
    }
    payload.update(updates)
    return DatasetReadinessRequest.model_validate(payload)


def _plan(request: DatasetReadinessRequest) -> DatasetReadinessPlan:
    return plan_dataset_readiness(
        request,
        readiness_report_id="readiness-skip-test",
        progress_callback=lambda _processed, _total, _message: None,
        cancellation_requested=lambda: False,
    )


def _export(request: DatasetReadinessRequest, plan: DatasetReadinessPlan):
    return export_dataset(
        DatasetExportRequest.model_validate(request.model_dump(mode="json")),
        skipped_items=plan.skipped_items,
    )


@pytest.fixture
def mixed_sources(tmp_path: Path) -> dict[str, Path]:
    return {
        "good": _image(tmp_path / "good.png"),
        "empty": _image(tmp_path / "empty.png"),
        "missing": tmp_path / "missing.png",
    }


def test_item_problems_block_by_default_and_are_counted_as_skippable(
    tmp_path: Path,
    mixed_sources: dict[str, Path],
) -> None:
    request = _request(
        list(mixed_sources.values()),
        tmp_path / "out",
        {mixed_sources["good"]: "subject", mixed_sources["empty"]: ""},
    )

    plan = _plan(request)

    assert plan.report.summary.status == "blocked"
    assert plan.report.summary.skippable_items == 2
    assert plan.report.summary.empty_caption_items == 1
    assert plan.skipped_items == {}


def test_skip_blocked_items_downgrades_item_problems_and_exports_the_rest(
    tmp_path: Path,
    mixed_sources: dict[str, Path],
) -> None:
    output = tmp_path / "out"
    request = _request(
        list(mixed_sources.values()),
        output,
        {mixed_sources["good"]: "subject", mixed_sources["empty"]: ""},
        skip_blocked_items=True,
    )

    plan = _plan(request)
    result = _export(request, plan)

    summary = plan.report.summary
    assert summary.status == "warnings"
    assert summary.blocker_count == 0
    assert summary.trainable_pairs == 1
    assert summary.skippable_items == 2
    assert dict(plan.skipped_items) == {
        str(mixed_sources["empty"].resolve()): "empty_caption",
        readiness_item_key(0, str(mixed_sources["missing"])): "source_unreadable",
    }
    assert all(issue.severity == "warning" for issue in plan.report.issues)
    assert all(issue.message.startswith("Skipped: ") for issue in plan.report.issues)
    assert result.status == "ok"
    assert result.exported == 1
    assert result.skipped == 2
    assert result.error_count == 0
    assert (output / "good.png").exists()
    assert (output / "good.txt").read_text(encoding="utf-8") == "subject"
    assert not (output / "empty.png").exists()
    assert not (output / "empty.txt").exists()
    assert {item.skipped_reason for item in result.items if item.skipped_reason} == {
        "empty_caption",
        "source_unreadable",
    }


def test_allow_empty_captions_writes_an_empty_caption_file(
    tmp_path: Path,
    mixed_sources: dict[str, Path],
) -> None:
    output = tmp_path / "out"
    request = _request(
        [mixed_sources["good"], mixed_sources["empty"]],
        output,
        {mixed_sources["good"]: "subject", mixed_sources["empty"]: ""},
        allow_empty_captions=True,
    )

    plan = _plan(request)
    result = _export(request, plan)

    assert plan.report.summary.status == "warnings"
    assert plan.report.summary.trainable_pairs == 2
    assert plan.report.summary.empty_caption_items == 1
    assert plan.report.summary.skippable_items == 0
    assert "empty_caption" in {
        issue.code for issue in plan.report.issues if issue.severity == "warning"
    }
    assert result.exported == 2
    assert (output / "empty.png").exists()
    assert (output / "empty.txt").read_text(encoding="utf-8") == ""


def test_skip_does_not_bypass_caption_name_collisions(tmp_path: Path) -> None:
    png_dir = tmp_path / "png"
    jpg_dir = tmp_path / "jpg"
    png_dir.mkdir()
    jpg_dir.mkdir()
    png_path = _image(png_dir / "same.png")
    jpg_path = _image(jpg_dir / "same.jpg")
    request = _request(
        [png_path, jpg_path],
        tmp_path / "out",
        {png_path: "subject", jpg_path: "subject"},
        skip_blocked_items=True,
    )

    plan = _plan(request)

    assert plan.report.summary.status == "blocked"
    assert plan.skipped_items == {}
    assert "caption_destination_collision" in {
        issue.code for issue in plan.report.issues if issue.severity == "blocker"
    }


def test_existing_output_under_skip_policy_is_a_warning_not_a_blocker(
    tmp_path: Path,
) -> None:
    output = tmp_path / "out"
    output.mkdir()
    kept = _image(tmp_path / "kept.png")
    fresh = _image(tmp_path / "fresh.png")
    (output / "kept.png").write_bytes(b"existing export")
    request = _request(
        [kept, fresh],
        output,
        {kept: "subject", fresh: "subject"},
        overwrite_policy="skip",
    )

    plan = _plan(request)
    result = _export(request, plan)

    assert plan.report.summary.status == "warnings"
    assert "existing_output_skipped" in {issue.code for issue in plan.report.issues}
    assert result.exported == 1
    assert result.skipped == 1
    assert (output / "kept.png").read_bytes() == b"existing export"
    assert (output / "fresh.txt").read_text(encoding="utf-8") == "subject"


def test_library_items_with_missing_rows_or_files_are_skipped_by_id(
    test_db,
    tmp_path: Path,
) -> None:
    good = _image(tmp_path / "library-good.png")
    gone = _image(tmp_path / "library-gone.png")
    good_id = int(test_db.add_image(path=str(good), filename=good.name))
    gone_id = int(test_db.add_image(path=str(gone), filename=gone.name))
    gone.unlink()
    output = tmp_path / "out"
    request = DatasetReadinessRequest.model_validate(
        {
            "image_ids": [good_id, gone_id, 999_999],
            "output_folder": str(output),
            "naming_pattern": "{filename}",
            "content_mode": "tags",
            "image_overrides": {str(good_id): "subject"},
            "skip_blocked_items": True,
        }
    )

    plan = _plan(request)
    result = _export(request, plan)

    assert dict(plan.skipped_items) == {
        str(gone_id): "source_unreadable",
        "999999": "source_unreadable",
    }
    assert result.status == "ok"
    assert result.exported == 1
    assert result.skipped == 2
    assert (output / "library-good.txt").read_text(encoding="utf-8") == "subject"


def test_skip_blocked_items_is_rejected_for_verified_trainer_packages(
    tmp_path: Path,
) -> None:
    request = DatasetExportRequest.model_validate(
        {
            "image_ids": [1],
            "output_folder": str(tmp_path / "package"),
            "trainer_config": "kohya_toml",
            "skip_blocked_items": True,
        }
    )

    with pytest.raises(HTTPException, match="skip_blocked_items"):
        _validate_export_request_read_only(request)


def test_export_route_skips_blocked_items_through_the_readiness_proof(
    authorize_legacy_dataset_exports,
    test_client,
    tmp_path: Path,
    mixed_sources: dict[str, Path],
) -> None:
    output = tmp_path / "route-out"
    response = test_client.post(
        "/api/dataset/export",
        json={
            "image_paths": [str(path) for path in mixed_sources.values()],
            "output_folder": str(output),
            "naming_pattern": "{filename}",
            "content_mode": "tags",
            "image_overrides": {
                str(mixed_sources["good"].resolve()): "subject",
                str(mixed_sources["empty"].resolve()): "",
            },
            "skip_blocked_items": True,
        },
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "ok"
    assert body["exported"] == 1
    assert body["skipped"] == 2
    assert (output / "good.txt").read_text(encoding="utf-8") == "subject"
