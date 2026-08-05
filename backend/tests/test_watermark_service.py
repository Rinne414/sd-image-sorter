"""CPU-only tests for deterministic watermark transforms."""
from __future__ import annotations

import sys
from types import SimpleNamespace

import numpy as np
import pytest
from PIL import Image, ImageChops, ImageDraw

from services.watermark_service import (
    TextWatermarkConfig,
    WatermarkRegion,
    WatermarkRemovalConfig,
    WatermarkServiceError,
    apply_text_watermark,
    apply_watermark_removal,
)


def _install_fake_cv2(monkeypatch: pytest.MonkeyPatch) -> None:
    """Stub OpenCV so runners without opencv-python still exercise removal logic."""

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


def _text_config() -> TextWatermarkConfig:
    return TextWatermarkConfig(
        enabled=True,
        text="sample",
        position="bottom_right",
        opacity=80,
        size_percent=8,
        margin_percent=2,
        color="#FFFFFF",
    )


def test_text_watermark_is_deterministic_and_does_not_mutate_input() -> None:
    source = Image.new("RGB", (240, 160), (35, 55, 75))
    before = source.copy()

    first = apply_text_watermark(source, _text_config())
    second = apply_text_watermark(source, _text_config())

    assert source.tobytes() == before.tobytes()
    assert first.mode == "RGBA"
    assert first.tobytes() == second.tobytes()
    changed_box = ImageChops.difference(first.convert("RGB"), source).getbbox()
    assert changed_box is not None
    margin = round(min(source.size) * _text_config().margin_percent / 100)
    assert changed_box[2] <= source.width - margin
    assert changed_box[3] <= source.height - margin


def test_text_watermark_disabled_returns_a_copy() -> None:
    source = Image.new("RGBA", (32, 32), (1, 2, 3, 4))
    config = TextWatermarkConfig(
        enabled=False,
        text="",
        position="bottom_right",
        opacity=80,
        size_percent=8,
        margin_percent=2,
        color="#FFFFFF",
    )

    result = apply_text_watermark(source, config)

    assert result is not source
    assert result.mode == source.mode
    assert result.tobytes() == source.tobytes()


def test_watermark_region_rejects_out_of_bounds_geometry() -> None:
    with pytest.raises(WatermarkServiceError, match="within 0..10000"):
        WatermarkRegion(x=9000, y=0, width=2000, height=1000)


def test_watermark_removal_requires_at_least_one_region_when_enabled() -> None:
    with pytest.raises(WatermarkServiceError, match="at least one region"):
        WatermarkRemovalConfig(
            enabled=True,
            method="telea",
            radius=3,
            padding_percent=2,
            regions=(),
        )


def test_watermark_removal_changes_only_requested_region(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _install_fake_cv2(monkeypatch)
    source = Image.new("RGB", (180, 120), (120, 120, 120))
    draw = ImageDraw.Draw(source)
    draw.rectangle((132, 90, 174, 111), fill=(255, 255, 255))
    before = source.copy()
    config = WatermarkRemovalConfig(
        enabled=True,
        method="telea",
        radius=3,
        padding_percent=0,
        regions=(WatermarkRegion(x=7300, y=7500, width=2400, height=1800),),
    )

    result = apply_watermark_removal(source, config)

    assert source.tobytes() == before.tobytes()
    assert result.size == source.size
    assert result.mode == "RGB"
    outside = ImageChops.difference(result.crop((0, 0, 120, 80)), before.crop((0, 0, 120, 80)))
    assert outside.getbbox() is None
    assert ImageChops.difference(result, before).getbbox() is not None
