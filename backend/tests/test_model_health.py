"""
Tests for publish-facing model health diagnostics.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from model_health import _infer_yolo_model_profile  # noqa: E402


def test_wenaka_filename_is_treated_as_privacy_detector_even_without_metadata():
    profile = _infer_yolo_model_profile([], "wenaka_yolov8s-seg.onnx")

    assert profile["id"] == "privacy-censor"
    assert profile["recommended_for_censor"] is True


def test_generic_yolov8_filename_stays_general_object_when_no_privacy_labels_exist():
    profile = _infer_yolo_model_profile([], "yolov8s-seg.onnx")

    assert profile["id"] == "general-object"
    assert profile["recommended_for_censor"] is False
