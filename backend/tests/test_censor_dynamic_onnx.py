"""YOLO exports with symbolic output dimensions run on the lightweight ONNX path.

deepghs' anime censor and face detectors (MIT) are Ultralytics YOLOv8 exports
whose output shape is declared as ['batch', 'anchors', ...]: the channel count
(4 + classes) is only known after a run. The lightweight parser used to reject
them and fall back to Ultralytics, which then failed on the missing 'task'
metadata. One probe run on a blank frame now reads the real channel count.
"""

from __future__ import annotations

import numpy as np
import pytest

from censor import CensorDetector, canonicalize_class_name
from services.censor.detection import _DetectionMixin


class _Port:
    def __init__(self, shape, name="images"):
        self.shape = shape
        self.name = name


class _Session:
    def __init__(self, declared_output, actual_output, outputs=1):
        self._declared = declared_output
        self._actual = actual_output
        self._outputs = outputs
        self.runs = 0

    def get_outputs(self):
        return [_Port(self._declared, "output0")] + [
            _Port([1, 32, 160, 160], "output1")
        ] * (self._outputs - 1)

    def run(self, names, feeds):
        self.runs += 1
        (frame,) = feeds.values()
        assert frame.shape == (1, 3, 640, 640)
        return [np.zeros(self._actual, dtype=np.float32)]


def _detector(classes):
    detector = CensorDetector(classes=classes)
    detector.input_name = "images"
    detector.input_size = (640, 640)
    return detector


def test_a_symbolic_channel_count_is_read_from_one_probe_run() -> None:
    detector = _detector(["nipple_f", "penis", "pussy"])
    session = _Session(["batch", "anchors", "Concatoutput0_dim_2"], (1, 7, 8400))

    assert detector._supports_lightweight_onnx(session) is True
    assert session.runs == 1


def test_a_probe_that_disagrees_with_the_classes_still_falls_back() -> None:
    detector = _detector(["face"])
    session = _Session(["batch", "anchors", "dim"], (1, 7, 8400))

    assert detector._supports_lightweight_onnx(session) is False


def test_a_failing_probe_falls_back_instead_of_crashing() -> None:
    detector = _detector(["face"])

    class Broken(_Session):
        def run(self, names, feeds):
            raise RuntimeError("bad graph")

    assert (
        detector._supports_lightweight_onnx(
            Broken(["batch", "anchors", "dim"], (1, 5, 8400))
        )
        is False
    )


def test_static_shapes_are_still_checked_without_a_run() -> None:
    detector = _detector(["a", "b"])
    session = _Session([1, 6, 8400], (1, 6, 8400))

    assert detector._supports_lightweight_onnx(session) is True
    assert session.runs == 0


@pytest.mark.parametrize("label", ["nipple_f", "Nipple-F", "nipple"])
def test_female_nipples_count_as_breasts(label: str) -> None:
    assert canonicalize_class_name(label) == "breasts"
    assert _DetectionMixin._normalize_target_family(label) == "breasts"


class _MetaSession:
    def __init__(self, names):
        self._names = names

    def get_modelmeta(self):
        class Meta:
            custom_metadata_map = {"names": self._names}

        return Meta()


@pytest.mark.parametrize(
    "names",
    ["{0: 'nipple_f', 1: 'penis', 2: 'pussy'}", '{"0": "nipple_f", "1": "penis", "2": "pussy"}'],
)
def test_class_names_are_read_from_python_or_json_metadata(names: str) -> None:
    detector = CensorDetector(classes=["placeholder"])

    detector._load_onnx_metadata(_MetaSession(names))

    assert detector.raw_classes == ["nipple_f", "penis", "pussy"]
    assert detector.classes == ["breasts", "dick", "pussy"]


def test_metadata_that_is_not_a_literal_is_never_evaluated() -> None:
    detector = CensorDetector(classes=["placeholder"])

    detector._load_onnx_metadata(_MetaSession("__import__('os').system('echo pwned')"))

    assert detector.classes == ["placeholder"]


def test_the_model_center_reads_the_same_names_and_sees_a_privacy_detector() -> None:
    import model_health_paths

    names = model_health_paths._parse_class_mapping("{0: 'nipple_f', 1: 'penis', 2: 'pussy'}")
    profile = model_health_paths._infer_yolo_model_profile(names, "deepghs_anime_censor_v1.0_s.onnx")

    assert names == ["nipple_f", "penis", "pussy"]
    assert profile["id"] == "privacy-censor"
    assert profile["recommended_for_censor"] is True
    assert model_health_paths._parse_class_mapping("__import__('os')") == []
