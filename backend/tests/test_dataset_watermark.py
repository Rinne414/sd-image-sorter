"""CPU-only Dataset export tests for explicit watermark cleanup."""
from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
from PIL import Image, ImageDraw
from fastapi import HTTPException

import database as db
from services.dataset_export.artifacts import _validate_export_request_read_only
from services.dataset_export.engine import export_dataset
from services.dataset_export.models import DatasetExportRequest


pytestmark = pytest.mark.usefixtures("authorize_legacy_dataset_exports")


def _install_fake_cv2(monkeypatch: pytest.MonkeyPatch) -> None:
    """Stub OpenCV so CI runners without opencv-python stay green."""

    def rectangle(mask, pt1, pt2, color, thickness=-1):  # noqa: ARG001
        x1, y1 = pt1
        x2, y2 = pt2
        mask[y1 : y2 + 1, x1 : x2 + 1] = color

    def inpaint(src, mask, radius, flags):  # noqa: ARG001
        out = np.array(src, copy=True)
        out[mask == 255] = (10, 20, 30)
        return out

    monkeypatch.setitem(
        sys.modules,
        "cv2",
        SimpleNamespace(
            INPAINT_NS=1,
            INPAINT_TELEA=0,
            rectangle=rectangle,
            inpaint=inpaint,
        ),
    )


def _removal_settings() -> dict[str, object]:
    return {
        "enabled": True,
        "method": "telea",
        "radius": 3,
        "padding_percent": 1,
        "regions": [{"x": 7300, "y": 7500, "width": 2400, "height": 1800}],
    }


def _stage_image(tmp_path: Path) -> tuple[int, Path]:
    source = tmp_path / "watermarked.png"
    image = Image.new("RGB", (180, 120), (120, 120, 120))
    ImageDraw.Draw(image).rectangle((132, 90, 174, 111), fill=(255, 255, 255))
    image.save(source)
    image_id = int(db.add_image(path=str(source), filename=source.name))
    db.add_tags(image_id, [{"tag": "subject", "confidence": 0.99}])
    return image_id, source


def test_dataset_request_defaults_watermark_removal_to_disabled() -> None:
    request = DatasetExportRequest.model_validate({})
    assert request.watermark_removal.model_dump() == {
        "enabled": False,
        "method": "telea",
        "radius": 3,
        "padding_percent": 0,
        "regions": [],
    }


def test_dataset_watermark_removal_requires_folder_copy(
    tmp_path: Path,
    test_db,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Validation checks OpenCV availability before output_mode. Stub cv2 so
    # runners without opencv-python still pin the folder-mode contract.
    _install_fake_cv2(monkeypatch)
    image_id, _source = _stage_image(tmp_path)
    request = DatasetExportRequest.model_validate({
        "image_ids": [image_id],
        "output_mode": "beside_image",
        "image_op": "copy",
        "watermark_removal": _removal_settings(),
    })

    with pytest.raises(HTTPException, match="output_mode='folder'"):
        _validate_export_request_read_only(request)


def test_dataset_watermark_removal_requires_opencv(
    tmp_path: Path,
    test_db,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Force the dependency gate regardless of whether the host has OpenCV.
    monkeypatch.setitem(sys.modules, "cv2", None)
    image_id, _source = _stage_image(tmp_path)
    request = DatasetExportRequest.model_validate({
        "image_ids": [image_id],
        "output_folder": str(tmp_path / "out"),
        "image_op": "copy",
        "watermark_removal": _removal_settings(),
    })

    with pytest.raises(HTTPException, match="OpenCV and NumPy"):
        _validate_export_request_read_only(request)


def test_dataset_watermark_removal_writes_copy_and_keeps_source(
    tmp_path: Path,
    test_db,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _install_fake_cv2(monkeypatch)
    image_id, source = _stage_image(tmp_path)
    before = source.read_bytes()
    output = tmp_path / "output"
    request = DatasetExportRequest.model_validate({
        "image_ids": [image_id],
        "output_folder": str(output),
        "image_op": "copy",
        "watermark_removal": _removal_settings(),
    })

    result = export_dataset(request)

    assert result.status == "ok"
    assert result.exported == 1
    assert source.read_bytes() == before
    exported = output / "watermarked.png"
    assert exported.is_file()
    with Image.open(exported) as image:
        assert image.size == (180, 120)
    assert exported.read_bytes() != before


def test_dataset_watermark_removal_keeps_missing_mask_non_fatal(
    tmp_path: Path,
    test_db,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _install_fake_cv2(monkeypatch)
    image_id, _source = _stage_image(tmp_path)
    output = tmp_path / "output-with-mask"
    request = DatasetExportRequest.model_validate({
        "image_ids": [image_id],
        "output_folder": str(output),
        "image_op": "copy",
        "mask_export": "onetrainer",
        "watermark_removal": _removal_settings(),
    })

    result = export_dataset(request)

    assert result.status == "ok"
    assert result.exported == 1
    assert result.masks_written == 0
    assert result.masks_missing == 1
