"""Synthetic Pillow and export contracts for optional bucket preprocessing."""

from __future__ import annotations

import hashlib
from pathlib import Path

import pytest
from fastapi import HTTPException
from PIL import Image
from pydantic import ValidationError

import database as db
from services import mask_service
from services.dataset_bucket_service import (
    CANONICAL_SDXL_BUCKETS,
    BucketTransformError,
    apply_center_bucket_resize,
    apply_subject_aware_bucket_resize,
    generate_sdxl_buckets,
    select_center_bucket,
)
from services.dataset_export.artifacts import _validate_export_request_read_only
from services.dataset_export.engine import _pillow_save_options, export_dataset
from services.dataset_export.models import (
    DatasetExportPreviewRequest,
    DatasetExportRequest,
    DatasetReadinessRequest,
)
from services.dataset_export.readiness import run_dataset_readiness


BUCKET_RESIZE_DISABLED = {
    "enabled": False,
    "subject_aware": False,
    "alpha_threshold": 128,
}


def _bucket_settings(*, subject_aware: bool) -> dict[str, object]:
    return {
        "enabled": True,
        "subject_aware": subject_aware,
        "alpha_threshold": 128,
    }


def _stage_library_image(
    tmp_path: Path,
    *,
    size: tuple[int, int],
) -> tuple[int, Path]:
    source_dir = tmp_path / "source"
    source_dir.mkdir(exist_ok=True)
    source = source_dir / "bucket-source.png"
    image = Image.new("RGB", size)
    image.putdata([
        (x % 256, y % 256, (x + y) % 256)
        for y in range(image.height)
        for x in range(image.width)
    ])
    image.save(source)
    image_id = int(db.add_image(path=str(source), filename=source.name))
    db.add_tags(image_id, [{"tag": "subject", "confidence": 0.99}])
    return image_id, source


def _write_mask(
    masks_dir: Path,
    image_id: int,
    *,
    size: tuple[int, int],
    subject_box: tuple[int, int, int, int],
) -> Path:
    masks_dir.mkdir(parents=True, exist_ok=True)
    path = masks_dir / f"{image_id}.png"
    mask = Image.new("L", size, color=0)
    mask.paste(255, subject_box)
    mask.save(path)
    return path


def test_generate_sdxl_buckets_preserves_the_canonical_1024_table() -> None:
    assert generate_sdxl_buckets(1024) == CANONICAL_SDXL_BUCKETS


def test_transformed_image_encoding_policy_is_explicit() -> None:
    assert _pillow_save_options("JPEG") == {
        "quality": 95,
        "subsampling": 0,
        "optimize": True,
    }
    assert _pillow_save_options("WEBP") == {
        "lossless": True,
        "quality": 100,
        "method": 6,
    }
    assert _pillow_save_options("PNG") == {
        "compress_level": 9,
        "optimize": True,
    }


@pytest.mark.parametrize(
    ("suffix", "expected_format"),
    ((".jpg", "JPEG"), (".webp", "WEBP")),
)
def test_transformed_jpeg_and_webp_export_successfully(
    test_db,
    tmp_path: Path,
    suffix: str,
    expected_format: str,
) -> None:
    source_dir = tmp_path / "source"
    source_dir.mkdir()
    source = source_dir / f"bucket-source{suffix}"
    Image.new("RGB", (16, 10), color=(20, 40, 60)).save(source)
    image_id = int(db.add_image(path=str(source), filename=source.name))
    db.add_tags(image_id, [{"tag": "subject", "confidence": 0.99}])
    output = tmp_path / f"encoded-{expected_format.lower()}"

    result = export_dataset(DatasetExportRequest(
        image_ids=[image_id],
        output_folder=str(output),
        bucket_resize=_bucket_settings(subject_aware=False),
        trainer_resolution=256,
    ))

    with Image.open(output / source.name) as exported_image:
        exported_image.load()
        assert exported_image.format == expected_format
        assert exported_image.size == (320, 192)
    assert result.status == "ok"
    assert result.exported == 1


@pytest.mark.parametrize(
    ("source_size", "expected"),
    (
        ((1, 100), (640, 1536)),
        ((100, 1), (1536, 640)),
        ((1024, 1024), (1024, 1024)),
    ),
)
def test_select_center_bucket_handles_extreme_aspect_ratios(
    source_size: tuple[int, int],
    expected: tuple[int, int],
) -> None:
    assert select_center_bucket(source_size, CANONICAL_SDXL_BUCKETS) == expected


def test_select_center_bucket_uses_canonical_order_for_an_exact_tie() -> None:
    assert select_center_bucket((83, 168), CANONICAL_SDXL_BUCKETS) == (640, 1536)


def test_center_bucket_resize_applies_one_geometry_without_mutating_inputs() -> None:
    source = Image.new("RGB", (16, 10), color=(20, 40, 60))
    mask = Image.new("L", source.size, color=96)
    source_before = source.tobytes()
    mask_before = mask.tobytes()

    resized, resized_mask, bucket, crop_box = apply_center_bucket_resize(
        source,
        mask,
        trainer_resolution=256,
    )

    assert bucket == (320, 192)
    assert resized.size == bucket
    assert resized_mask is not None
    assert resized_mask.size == bucket
    assert crop_box == (0, 0, 16, 9)
    assert source.tobytes() == source_before
    assert mask.tobytes() == mask_before


def test_subject_aware_bucket_shifts_the_crop_to_preserve_an_edge_subject() -> None:
    source = Image.new("RGB", (160, 100), color=(20, 40, 60))
    mask = Image.new("L", source.size, color=0)
    mask.paste(255, (40, 90, 120, 100))

    resized, resized_mask, bucket, crop_box = apply_subject_aware_bucket_resize(
        source,
        mask,
        alpha_threshold=128,
        trainer_resolution=256,
    )

    assert bucket == (320, 192)
    assert crop_box == (0, 4, 160, 100)
    assert resized.size == bucket
    assert resized_mask is not None
    assert resized_mask.size == bucket
    assert resized_mask.getbbox() is not None
    assert resized_mask.getbbox()[3] == resized_mask.height


def test_subject_aware_bucket_rejects_a_subject_no_bucket_can_preserve() -> None:
    source = Image.new("RGB", (300, 100), color=(20, 40, 60))
    mask = Image.new("L", source.size, color=255)

    with pytest.raises(BucketTransformError, match="without clipping the subject"):
        apply_subject_aware_bucket_resize(
            source,
            mask,
            alpha_threshold=128,
            trainer_resolution=256,
        )


def test_subject_aware_bucket_threshold_ignores_soft_alpha_background_noise() -> None:
    source = Image.new("RGB", (160, 100), color=(20, 40, 60))
    mask = Image.new("L", source.size, color=1)
    mask.paste(255, (40, 90, 120, 100))

    resized, resized_mask, bucket, crop_box = apply_subject_aware_bucket_resize(
        source,
        mask,
        alpha_threshold=128,
        trainer_resolution=256,
    )

    assert bucket == (320, 192)
    assert crop_box == (0, 4, 160, 100)
    assert resized.size == resized_mask.size == bucket


def test_bucket_export_normalizes_exif_orientation_for_image_and_mask(
    test_db,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source_dir = tmp_path / "source"
    source_dir.mkdir()
    source = source_dir / "oriented.jpg"
    image = Image.new("RGB", (120, 80), color=(20, 40, 60))
    exif = Image.Exif()
    exif[274] = 6
    image.save(source, exif=exif)
    image_id = int(db.add_image(path=str(source), filename=source.name))
    db.add_tags(image_id, [{"tag": "subject", "confidence": 0.99}])
    masks_dir = tmp_path / "masks"
    monkeypatch.setattr(mask_service, "MASKS_DIR", masks_dir)
    _write_mask(
        masks_dir,
        image_id,
        size=(120, 80),
        subject_box=(20, 10, 100, 70),
    )
    output = tmp_path / "oriented-output"

    result = export_dataset(DatasetExportRequest(
        image_ids=[image_id],
        output_folder=str(output),
        mask_export="kohya",
        trainer_resolution=256,
        bucket_resize=_bucket_settings(subject_aware=False),
    ))

    with (
        Image.open(output / source.name) as exported_image,
        Image.open(output / "mask" / "oriented.png") as exported_mask,
    ):
        assert exported_image.size == exported_mask.size == (192, 320)
        assert exported_image.getexif().get(274, 1) == 1
    assert result.status == "ok"


def test_default_export_copy_does_not_open_pillow_for_bucket_processing(
    test_db,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    image_id, source = _stage_library_image(tmp_path, size=(16, 10))
    source_bytes = source.read_bytes()
    output = tmp_path / "default-copy"
    monkeypatch.setattr(
        Image,
        "open",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("disabled bucket resize must not open Pillow")
        ),
    )

    result = export_dataset(DatasetExportRequest(
        image_ids=[image_id],
        output_folder=str(output),
        image_overrides={str(image_id): "caption stays exact"},
    ))

    assert result.status == "ok"
    assert (output / source.name).read_bytes() == source_bytes


def test_bucket_export_aligns_image_mask_and_preserves_caption_and_source(
    test_db,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    image_id, source = _stage_library_image(tmp_path, size=(16, 10))
    masks_dir = tmp_path / "masks"
    monkeypatch.setattr(mask_service, "MASKS_DIR", masks_dir)
    _write_mask(
        masks_dir,
        image_id,
        size=(16, 10),
        subject_box=(4, 1, 12, 9),
    )
    source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    source_mtime = source.stat().st_mtime_ns
    output = tmp_path / "bucketed"

    result = export_dataset(DatasetExportRequest(
        image_ids=[image_id],
        output_folder=str(output),
        image_overrides={str(image_id): "exact caption, unchanged"},
        mask_export="kohya",
        trainer_resolution=256,
        bucket_resize=_bucket_settings(subject_aware=False),
    ))

    exported_image = output / source.name
    exported_mask = output / "mask" / source.name
    with Image.open(exported_image) as image_result, Image.open(exported_mask) as mask_result:
        assert image_result.size == mask_result.size == (320, 192)
        assert mask_result.mode == "L"
    assert result.status == "ok"
    assert result.masks_written == 1
    assert (output / "bucket-source.txt").read_text(encoding="utf-8") == (
        "exact caption, unchanged"
    )
    assert hashlib.sha256(source.read_bytes()).hexdigest() == source_hash
    assert source.stat().st_mtime_ns == source_mtime


@pytest.mark.parametrize(
    ("request_updates", "expected_error"),
    (
        ({"image_paths": ["C:/local/source.png"], "image_ids": []}, "library image_ids"),
        ({"image_ids": [0]}, "positive library image_id"),
        ({"dataset_scan_tokens": [{"scan_token": "a" * 32}]}, "dataset_scan_tokens"),
        ({"image_op": "move"}, "image_op='copy'"),
        ({"output_mode": "beside_image", "output_folder": ""}, "output_mode='folder'"),
        ({"trainer_config": "kohya_toml"}, "Verified Package v2"),
        ({"trainer_resolution": 1000}, "multiple of 64"),
    ),
)
def test_bucket_resize_rejects_unsupported_export_shapes(
    tmp_path: Path,
    request_updates: dict[str, object],
    expected_error: str,
) -> None:
    payload: dict[str, object] = {
        "image_ids": [1],
        "output_folder": str(tmp_path / "out"),
        "trainer_resolution": 1024,
        "bucket_resize": _bucket_settings(subject_aware=False),
    }
    payload.update(request_updates)
    request = DatasetExportRequest.model_validate(payload)

    with pytest.raises(HTTPException, match=expected_error):
        _validate_export_request_read_only(request)


def test_bucket_resize_request_and_preview_defaults_are_backward_compatible() -> None:
    export_request = DatasetExportRequest(image_ids=[1], output_folder="C:/output")
    preview_request = DatasetExportPreviewRequest(image_ids=[1])

    assert export_request.bucket_resize.model_dump() == BUCKET_RESIZE_DISABLED
    assert preview_request.bucket_resize.model_dump() == BUCKET_RESIZE_DISABLED
    with pytest.raises(ValidationError):
        DatasetExportRequest(
            image_ids=[1],
            output_folder="C:/output",
            bucket_resize={**BUCKET_RESIZE_DISABLED, "unexpected": True},
        )


def test_subject_aware_bucket_readiness_blocks_an_empty_subject_mask(
    test_db,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    image_id, _source = _stage_library_image(tmp_path, size=(16, 10))
    masks_dir = tmp_path / "masks"
    monkeypatch.setattr(mask_service, "MASKS_DIR", masks_dir)
    _write_mask(
        masks_dir,
        image_id,
        size=(16, 10),
        subject_box=(0, 0, 0, 0),
    )
    request = DatasetReadinessRequest(
        image_ids=[image_id],
        output_folder=str(tmp_path / "readiness-output"),
        trainer_resolution=256,
        bucket_resize=_bucket_settings(subject_aware=True),
    )

    report = run_dataset_readiness(
        request,
        readiness_report_id="bucket-resize-readiness",
        progress_callback=lambda _processed, _total, _message: None,
        cancellation_requested=lambda: False,
    )

    assert report.summary.status == "blocked"
    assert any(issue.code == "bucket_resize_mask_invalid" for issue in report.issues)
