"""CPU-only tests for deterministic watermark transforms."""
from __future__ import annotations

from PIL import Image, ImageChops, ImageDraw
import pytest

from services.watermark_service import (
    TextWatermarkConfig,
    WatermarkRegion,
    WatermarkRemovalConfig,
    WatermarkServiceError,
    apply_text_watermark,
    apply_watermark_removal,
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


def test_watermark_removal_changes_only_requested_region() -> None:
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
