import sys
from pathlib import Path

from PIL import Image


sys.path.insert(0, str(Path(__file__).parent.parent))


def test_detect_reads_images_via_pillow_rgba_array(tmp_path):
    import numpy as np
    from nudenet_detector import NudeNetDetector

    image_path = tmp_path / "nudenet-read.png"
    Image.new("RGB", (32, 24), color="red").save(image_path)

    captured = {}

    class FakeBackend:
        def detect(self, image_input):
            captured["input_type"] = type(image_input)
            captured["shape"] = image_input.shape
            return [
                {
                    "class": "FEMALE_BREAST_EXPOSED",
                    "score": 0.91,
                    "box": [2, 3, 10, 12],
                }
            ]

    detector = NudeNetDetector()
    detector._detector = FakeBackend()

    results = detector.detect(str(image_path), conf_threshold=0.5, exposed_only=True)

    assert captured["input_type"] is np.ndarray
    assert captured["shape"] == (24, 32, 4)
    assert results[0]["class"] == "breasts"
    assert results[0]["box"] == [2, 3, 12, 15]


def test_detect_raises_clear_error_when_pillow_cannot_read_input(tmp_path):
    from nudenet_detector import NudeNetDetector

    broken_path = tmp_path / "broken.png"
    broken_path.write_bytes(b"not-an-image")

    detector = NudeNetDetector()

    try:
        detector._prepare_detector_input(str(broken_path))
    except RuntimeError as exc:
        message = str(exc)
    else:
        raise AssertionError("Expected _prepare_detector_input() to raise RuntimeError for unreadable input")

    assert "NudeNet could not read image file" in message
    assert str(broken_path) in message
