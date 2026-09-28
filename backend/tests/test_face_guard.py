"""Face guard: face false positives are dropped, real subjects on faces are not."""

from __future__ import annotations

from pathlib import Path

import pytest
from PIL import Image

import face_guard
from services.censor.detection import _DetectionMixin

FACE = (100.0, 100.0, 300.0, 300.0)
family = _DetectionMixin._normalize_target_family


def _det(label: str, box):
    return {"class": label, "confidence": 0.9, "box": list(box)}


def test_share_on_face_is_the_part_of_the_box_inside_the_face() -> None:
    assert face_guard.share_on_face((150, 150, 250, 250), FACE) == 1.0
    assert face_guard.share_on_face((250, 150, 350, 250), FACE) == 0.5
    assert face_guard.share_on_face((400, 400, 450, 450), FACE) == 0.0


@pytest.mark.parametrize(
    ("label", "box", "dropped"),
    [
        ("pussy", (150, 150, 200, 200), True),  # a mouth read as a pussy
        ("nipple_f", (120, 120, 160, 160), True),  # an eye read as a nipple
        ("anus", (150, 150, 200, 200), True),
        ("pussy", (260, 150, 360, 250), False),  # only 40% on the face
        ("pussy", (500, 500, 560, 560), False),
        ("penis", (150, 150, 250, 250), False),  # oral scene: must stay censored
        ("dick", (150, 150, 250, 250), False),
        ("cum", (150, 150, 250, 250), False),  # facial: must stay censored
    ],
)
def test_only_face_lookalikes_on_a_face_are_dropped(
    label: str, box, dropped: bool
) -> None:
    kept, count = face_guard.guard([_det(label, box)], [FACE], family)

    assert count == (1 if dropped else 0)
    assert len(kept) == (0 if dropped else 1)


def test_without_the_face_model_every_detection_is_kept(
    monkeypatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(
        face_guard.anime_censor_models,
        "face_model_path",
        lambda: tmp_path / "missing.onnx",
    )
    detections = [_det("pussy", (150, 150, 200, 200))]

    kept, report = face_guard.apply(detections, Image.new("RGB", (400, 400)), family)

    assert kept == detections
    assert report == {"active": False, "faces": 0, "dropped": 0}


class _FakeFaceDetector:
    def __init__(self, faces=None, error=None):
        self.faces = faces or []
        self.error = error

    def detect_from_image(self, image, conf_threshold):
        if self.error:
            raise self.error
        return [
            {"class": "face", "confidence": 0.9, "box": list(face)}
            for face in self.faces
        ]


def test_faces_are_widened_and_used_on_the_picture(monkeypatch) -> None:
    monkeypatch.setattr(
        face_guard, "_face_detector", lambda: _FakeFaceDetector([(100, 100, 200, 200)])
    )
    # Just outside the raw face box, inside the 10% margin.
    detections = [
        _det("pussy", (201, 150, 208, 180)),
        _det("penis", (120, 120, 180, 180)),
    ]

    kept, report = face_guard.apply(detections, Image.new("RGB", (400, 400)), family)

    assert [d["class"] for d in kept] == ["penis"]
    assert report == {"active": True, "faces": 1, "dropped": 1}


def test_a_broken_face_model_never_uncensors_anything(monkeypatch) -> None:
    monkeypatch.setattr(
        face_guard,
        "_face_detector",
        lambda: _FakeFaceDetector(error=RuntimeError("bad model")),
    )
    detections = [_det("pussy", (150, 150, 200, 200))]

    kept, report = face_guard.apply(detections, Image.new("RGB", (400, 400)), family)

    assert kept == detections
    assert report["active"] is False and report["error"] is True


def test_no_detections_means_no_face_run(monkeypatch) -> None:
    def must_not_run():
        raise AssertionError("face detector ran for nothing")

    monkeypatch.setattr(face_guard, "_face_detector", must_not_run)

    kept, report = face_guard.apply([], Image.new("RGB", (40, 40)), family)

    assert kept == [] and report["active"] is False


# --------------------------------------------------------------- in detect()

import database  # noqa: E402
import nudenet_detector  # noqa: E402
from services.censor_service import CensorDetectRequest, CensorService  # noqa: E402


class _FakeNudeNet:
    def detect(self, image_path, conf_threshold=0.5, exposed_only=True, priority=0):
        return [
            {"class": "pussy", "confidence": 0.9, "box": [150, 150, 200, 200], "label": "FEMALE_GENITALIA_EXPOSED"},
            {"class": "dick", "confidence": 0.9, "box": [120, 220, 180, 280], "label": "MALE_GENITALIA_EXPOSED"},
        ]


@pytest.fixture
def censor_picture(tmp_path: Path, monkeypatch) -> Path:
    path = tmp_path / "scene.png"
    Image.new("RGB", (400, 400), (90, 90, 90)).save(path)
    monkeypatch.setattr(database, "get_image_by_id", lambda image_id: {"id": image_id, "path": str(path)})
    monkeypatch.setattr(CensorService, "_resolve_source_image_path", staticmethod(lambda p, **kw: p))
    monkeypatch.setattr(nudenet_detector, "get_nudenet_detector", lambda: _FakeNudeNet())
    monkeypatch.setattr(face_guard, "_face_detector", lambda: _FakeFaceDetector([FACE]))
    return path


def _detect(**fields) -> dict:
    return CensorService().detect(
        CensorDetectRequest(image_id=1, model_type="nudenet", confidence_threshold=0.5, target_classes=None, **fields)
    )


def test_detect_drops_a_face_false_positive_and_keeps_the_real_subject(censor_picture) -> None:
    result = _detect()

    assert [d["class"] for d in result["detections"]] == ["dick"]
    assert result["face_guard"] == {"active": True, "faces": 1, "dropped": 1}


def test_the_face_guard_can_be_turned_off(censor_picture) -> None:
    result = _detect(face_guard=False)

    assert sorted(d["class"] for d in result["detections"]) == ["dick", "pussy"]
    assert result["face_guard"] == {"active": False, "faces": 0, "dropped": 0}
