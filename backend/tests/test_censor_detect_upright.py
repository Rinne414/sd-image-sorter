"""The optional ``upright`` flag on the censor detect / SAM3 endpoints.

V4 draws the picture upright (EXIF orientation applied, like every browser),
so it asks for boxes, masks and the reported size in that frame. Without the
flag (V3.5) everything stays in the file's raw pixel frame, exactly as before.

The picture: a JPEG stored 80 x 40 with EXIF orientation 6 ("rotate 90 degrees
clockwise to show"), black with one bright square at raw x 10-19, y 5-14. Shown
upright it is 40 x 80 and the square sits at x 25-34, y 10-19. Fake detectors
report the bright square of whatever picture they are given, so no model runs.
"""

from __future__ import annotations

import sys
import types
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import censor as censor_module  # noqa: E402
import database  # noqa: E402
import nudenet_detector  # noqa: E402
from services import censor_service as cs  # noqa: E402
from services.censor_service import (  # noqa: E402
    BatchMaskRefineRequest,
    CensorDetectRequest,
    CensorService,
    MaskRefineRequest,
    TextSegmentRequest,
)

RAW_BOX = [10, 5, 20, 15]
UPRIGHT_BOX = [25, 10, 35, 20]


def bright_box(image: Image.Image) -> list[int]:
    """x1, y1, x2, y2 (exclusive) of the bright pixels."""
    x1, y1, x2, y2 = image.convert("L").point(lambda v: 255 if v > 128 else 0).getbbox()
    return [x1, y1, x2, y2]


def bright_mask(image: Image.Image) -> np.ndarray:
    return (np.asarray(image.convert("L")) > 128).astype(np.uint8)


def close(box: list[int], expected: list[int]) -> bool:
    """JPEG edges may move a pixel."""
    return all(abs(int(a) - b) <= 1 for a, b in zip(box, expected))


@pytest.fixture()
def rotated_jpeg(tmp_path, monkeypatch) -> Path:
    raw = Image.new("RGB", (80, 40), (0, 0, 0))
    raw.paste((255, 255, 255), (10, 5, 20, 15))
    exif = Image.Exif()
    exif[0x0112] = 6
    path = tmp_path / "rotated.jpg"
    raw.save(path, quality=98, exif=exif)
    monkeypatch.setattr(
        database,
        "get_image_by_id",
        lambda image_id: {"id": image_id, "path": str(path)},
    )
    monkeypatch.setattr(
        CensorService, "_resolve_source_image_path", staticmethod(lambda p, **kw: p)
    )
    return path


class FakeNudeNet:
    def __init__(self) -> None:
        self.calls: list[str] = []

    def _found(self, image: Image.Image) -> dict:
        return {
            "class": "breasts",
            "confidence": 0.9,
            "box": bright_box(image),
            "label": "FEMALE_BREAST_EXPOSED",
        }

    def detect(self, image_path, conf_threshold=0.5, exposed_only=True, priority=0):
        self.calls.append("path")
        with Image.open(image_path) as image:
            return [self._found(image)]

    def detect_from_pil(self, image, conf_threshold=0.5, exposed_only=True, priority=0):
        self.calls.append("pil")
        return [self._found(image)]


class FakeYolo:
    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple[int, int] | None, str | None]] = []

    def detect(self, image_path, conf_threshold=0.5, priority=0):
        self.calls.append(("path", None, None))
        with Image.open(image_path) as image:
            return [{"class": "dick", "confidence": 0.8, "box": bright_box(image)}]

    def detect_from_image(self, image, conf_threshold=0.5, priority=0):
        self.calls.append(("image", image.size, image.mode))
        return [{"class": "dick", "confidence": 0.8, "box": bright_box(image)}]


class FakeSam3:
    def __init__(self) -> None:
        self.sizes: list[tuple[int, int]] = []

    def detect_privacy_regions(
        self, image, conf_threshold=0.5, prompts=None, priority=0
    ):
        self.sizes.append(image.size)
        return [
            {
                "class": "breasts",
                "confidence": 0.7,
                "box": bright_box(image),
                "mask": bright_mask(image),
                "source": "sam3",
            }
        ]

    def segment_by_text(self, image, text_prompt, presence_threshold=None):
        self.sizes.append(image.size)
        return bright_mask(image)

    def refine_box(self, image, box, text_prompt=None, confidence_threshold=None):
        self.sizes.append(image.size)
        return bright_mask(image)


@pytest.fixture()
def nudenet(monkeypatch) -> FakeNudeNet:
    fake = FakeNudeNet()
    monkeypatch.setattr(nudenet_detector, "get_nudenet_detector", lambda: fake)
    return fake


@pytest.fixture()
def yolo(monkeypatch) -> FakeYolo:
    fake = FakeYolo()
    monkeypatch.setattr(censor_module, "get_detector", lambda path=None: fake)
    monkeypatch.setattr(
        cs, "get_default_legacy_model_path", lambda: "X:/models/yolo/fake.pt"
    )
    return fake


@pytest.fixture()
def sam3(monkeypatch) -> FakeSam3:
    fake = FakeSam3()
    monkeypatch.setitem(
        sys.modules,
        "sam3_refiner",
        types.SimpleNamespace(get_sam3_refiner=lambda: fake),
    )
    health = {"censor": {"sam3": {"available": True, "message": "ready"}}}
    monkeypatch.setattr(cs, "get_model_health", lambda *a, **kw: health)
    return fake


def detect(**fields) -> dict:
    return CensorService().detect(
        CensorDetectRequest(
            image_id=1, confidence_threshold=0.5, target_classes=None, **fields
        )
    )


class TestDetect:
    def test_upright_boxes_masks_and_size_follow_the_exif_orientation(
        self, rotated_jpeg, nudenet
    ):
        result = detect(model_type="nudenet", upright=True)
        assert (result["image_width"], result["image_height"]) == (40, 80)
        assert close(result["detections"][0]["box"], UPRIGHT_BOX)
        assert close(result["combined_mask_bounds"], UPRIGHT_BOX)
        assert nudenet.calls == ["pil"]

    def test_without_the_flag_everything_stays_in_the_raw_frame(
        self, rotated_jpeg, nudenet
    ):
        result = detect(model_type="nudenet")
        assert (result["image_width"], result["image_height"]) == (80, 40)
        assert close(result["detections"][0]["box"], RAW_BOX)
        assert close(result["combined_mask_bounds"], RAW_BOX)
        assert nudenet.calls == ["path"]

    def test_yolo_gets_the_upright_picture_as_rgb(self, rotated_jpeg, yolo):
        result = detect(model_type="legacy", upright=True)
        assert yolo.calls == [("image", (40, 80), "RGB")]
        assert close(result["detections"][0]["box"], UPRIGHT_BOX)
        assert close(detect(model_type="legacy")["detections"][0]["box"], RAW_BOX)
        assert yolo.calls[-1] == ("path", None, None)

    def test_both_detectors_see_the_same_upright_frame(
        self, rotated_jpeg, nudenet, yolo
    ):
        result = detect(model_type="both", upright=True)
        assert [d["source"] for d in result["detections"]] == ["nudenet", "legacy"]
        assert all(close(d["box"], UPRIGHT_BOX) for d in result["detections"])
        assert (result["image_width"], result["image_height"]) == (40, 80)

    def test_sam3_detector_gets_the_upright_picture(self, rotated_jpeg, sam3):
        result = detect(model_type="sam3", upright=True)
        assert sam3.sizes == [(40, 80)]
        assert close(result["combined_mask_bounds"], UPRIGHT_BOX)
        detect(model_type="sam3")
        assert sam3.sizes[-1] == (80, 40)


class TestSam3Tools:
    def test_text_segmentation(self, rotated_jpeg, sam3):
        up = CensorService().segment_text(
            TextSegmentRequest(image_id=1, text_prompt="square", upright=True)
        )
        assert (up["image_width"], up["image_height"]) == (40, 80)
        assert close(up["mask_bounds"], UPRIGHT_BOX)
        raw = CensorService().segment_text(
            TextSegmentRequest(image_id=1, text_prompt="square")
        )
        assert (raw["image_width"], raw["image_height"]) == (80, 40)
        assert close(raw["mask_bounds"], RAW_BOX)

    def test_refine_one_box(self, rotated_jpeg, sam3):
        up = CensorService().refine_mask(
            MaskRefineRequest(image_id=1, box=UPRIGHT_BOX, upright=True)
        )
        assert close(up["mask_bounds"], UPRIGHT_BOX)
        assert (up["image_width"], up["image_height"]) == (40, 80)
        raw = CensorService().refine_mask(MaskRefineRequest(image_id=1, box=RAW_BOX))
        assert close(raw["mask_bounds"], RAW_BOX)

    def test_batch_refine_takes_the_flag_for_every_item(self, rotated_jpeg, sam3):
        items = [MaskRefineRequest(image_id=1, box=UPRIGHT_BOX)]
        up = CensorService().batch_refine_mask(
            BatchMaskRefineRequest(items=items, upright=True)
        )
        assert up["results"][0]["status"] == "ok"
        assert close(up["results"][0]["mask_bounds"], UPRIGHT_BOX)
        raw = CensorService().batch_refine_mask(
            BatchMaskRefineRequest(items=[MaskRefineRequest(image_id=1, box=RAW_BOX)])
        )
        assert close(raw["results"][0]["mask_bounds"], RAW_BOX)
        # an item may ask for itself too
        one = CensorService().batch_refine_mask(
            BatchMaskRefineRequest(
                items=[MaskRefineRequest(image_id=1, box=UPRIGHT_BOX, upright=True)]
            )
        )
        assert close(one["results"][0]["mask_bounds"], UPRIGHT_BOX)


def test_the_flag_defaults_to_off():
    assert CensorDetectRequest(image_id=1).upright is False
    assert MaskRefineRequest(image_id=1, box=[0, 0, 1, 1]).upright is False
    assert TextSegmentRequest(image_id=1, text_prompt="x").upright is False
    assert (
        BatchMaskRefineRequest(
            items=[MaskRefineRequest(image_id=1, box=[0, 0, 1, 1])]
        ).upright
        is False
    )
