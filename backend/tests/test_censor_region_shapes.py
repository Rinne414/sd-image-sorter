"""Region shapes before censoring: ellipse, GrabCut fit, and grown edges."""

from __future__ import annotations

import math

import numpy as np
import pytest
from PIL import Image, ImageDraw

from services.censor import region_shapes as shapes

BOX = [100, 100, 200, 160]


def _polygon_area(points) -> float:
    return 0.5 * abs(
        sum(
            x1 * y2 - x2 * y1
            for (x1, y1), (x2, y2) in zip(points, points[1:] + points[:1])
        )
    )


def test_an_ellipse_fills_its_box_like_an_ellipse() -> None:
    (region,), warnings = shapes.reshape(
        [{"class": "pussy", "box": BOX}], Image.new("RGB", (400, 400)), "ellipse"
    )

    area = _polygon_area(region["polygon"])
    assert region["shape"] == "ellipse"
    assert area == pytest.approx(math.pi / 4 * 100 * 60, rel=0.02)
    assert all(99 <= x <= 201 and 99 <= y <= 161 for x, y in region["polygon"])
    assert warnings == []


def test_growth_is_a_share_of_the_regions_own_size_and_stays_in_the_picture() -> None:
    (grown,), _ = shapes.reshape(
        [{"box": BOX}], Image.new("RGB", (400, 400)), "precise", expand_percent=10
    )
    (edge,), _ = shapes.reshape(
        [{"box": [0, 0, 50, 50]}],
        Image.new("RGB", (400, 400)),
        "box",
        expand_percent=50,
    )

    assert grown["box"] == [90, 94, 210, 166]
    assert edge["box"] == [0, 0, 75, 75]


def test_box_mode_drops_outlines_and_precise_keeps_them() -> None:
    region = {
        "box": BOX,
        "polygon": [[110, 110], [190, 110], [150, 150]],
        "mask": np.ones((4, 4), np.uint8),
    }

    (as_box,), _ = shapes.reshape([region], Image.new("RGB", (400, 400)), "box")
    (as_ellipse,), _ = shapes.reshape([region], Image.new("RGB", (400, 400)), "ellipse")

    assert "polygon" not in as_box and "mask" not in as_box
    assert as_ellipse["polygon"] == region["polygon"]
    assert "shape" not in as_ellipse


def test_a_polygon_grows_around_its_centre() -> None:
    square = [[100.0, 100.0], [200.0, 100.0], [200.0, 200.0], [100.0, 200.0]]

    (region,), _ = shapes.reshape(
        [{"box": [100, 100, 200, 200], "polygon": square}],
        Image.new("RGB", (400, 400)),
        "precise",
        10,
    )

    assert region["polygon"] == [
        [90.0, 90.0],
        [210.0, 90.0],
        [210.0, 210.0],
        [90.0, 210.0],
    ]


def test_a_mask_grows_outward_and_never_shrinks() -> None:
    mask = np.zeros((200, 200), np.uint8)
    mask[80:120, 80:120] = 1

    grown = shapes.grow_mask(mask, 0.25)

    assert grown[80:120, 80:120].all()
    assert grown[75, 100] == 1 and grown[100, 125] == 1
    assert grown[40, 40] == 0


def _disk_picture() -> Image.Image:
    picture = Image.new("RGB", (400, 400), (30, 90, 40))
    ImageDraw.Draw(picture).ellipse((120, 120, 220, 220), fill=(240, 200, 180))
    return picture


def test_fit_traces_the_object_inside_its_box() -> None:
    pytest.importorskip("cv2")  # the GrabCut trace; without it fit is an ellipse
    (region,), warnings = shapes.reshape(
        [{"box": [100, 100, 240, 240]}], _disk_picture(), "fit"
    )

    assert region["shape"] == "fit"
    assert _polygon_area(region["polygon"]) == pytest.approx(
        math.pi * 50 * 50, rel=0.15
    )
    assert warnings == []


def test_fit_falls_back_to_an_ellipse_when_there_is_nothing_to_trace() -> None:
    (region,), warnings = shapes.reshape(
        [{"box": BOX}], Image.new("RGB", (400, 400), (128, 128, 128)), "fit"
    )

    assert region["shape"] == "ellipse"
    assert warnings == [
        "Fit could not trace 1 region(s) and used an ellipse there instead."
    ]


def test_an_unknown_shape_is_a_caller_error() -> None:
    with pytest.raises(ValueError):
        shapes.reshape([], None, "star")


# --------------------------------------------------------------- in detect()

from pathlib import Path  # noqa: E402

import database  # noqa: E402
import nudenet_detector  # noqa: E402
from services.censor_service import CensorDetectRequest, CensorService  # noqa: E402


class _BoxOnlyDetector:
    def detect(self, image_path, conf_threshold=0.5, exposed_only=True, priority=0):
        return [{"class": "pussy", "confidence": 0.9, "box": [100, 100, 240, 240], "label": "FEMALE_GENITALIA_EXPOSED"}]


@pytest.fixture
def disk_on_disk(tmp_path: Path, monkeypatch) -> Path:
    path = tmp_path / "disk.png"
    _disk_picture().save(path)
    monkeypatch.setattr(database, "get_image_by_id", lambda image_id: {"id": image_id, "path": str(path)})
    monkeypatch.setattr(CensorService, "_resolve_source_image_path", staticmethod(lambda p, **kw: p))
    monkeypatch.setattr(nudenet_detector, "get_nudenet_detector", lambda: _BoxOnlyDetector())
    return path


def _detect(**fields) -> dict:
    return CensorService().detect(
        CensorDetectRequest(image_id=1, model_type="nudenet", target_classes=None, face_guard=False, **fields)
    )


def test_by_default_a_box_stays_a_box() -> None:
    assert CensorDetectRequest(image_id=1).shape == "precise"
    assert CensorDetectRequest(image_id=1).expand_percent == 0


def test_detect_returns_ellipses_and_a_mask_built_from_them(disk_on_disk) -> None:
    result = _detect(shape="ellipse")

    (region,) = result["detections"]
    assert region["shape"] == "ellipse" and len(region["polygon"]) == shapes.ELLIPSE_POINTS
    assert result["geometry_mode"] == "mask"
    assert result["combined_mask_ref"] or result["combined_mask"]


def test_detect_fit_traces_the_part_and_grows_it(disk_on_disk) -> None:
    pytest.importorskip("cv2")  # the GrabCut trace; without it fit is an ellipse
    result = _detect(shape="fit", expand_percent=10)

    (region,) = result["detections"]
    assert region["shape"] == "fit"
    assert region["box"] == [86, 86, 254, 254]
    assert result["warnings"] == []
