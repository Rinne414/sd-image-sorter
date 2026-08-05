import sys
from pathlib import Path
from types import SimpleNamespace

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


def test_loader_materializes_official_package_model_into_app_directory(tmp_path, monkeypatch):
    import nudenet_detector as detector_module

    package_dir = tmp_path / "site-packages" / "nudenet"
    package_dir.mkdir(parents=True)
    package_model = package_dir / "320n.onnx"
    package_model.write_bytes(b"official-nudenet-model")
    app_dir = tmp_path / "data" / "models" / "nudenet"
    captured_paths = []

    class FakeNudeDetector:
        def __init__(self, model_path, providers=None, inference_resolution=320):
            captured_paths.append(model_path)

    monkeypatch.setattr(detector_module, "get_nudenet_model_dir", lambda: str(app_dir))
    monkeypatch.setattr(detector_module, "_detector", None)
    monkeypatch.setitem(
        sys.modules,
        "nudenet",
        SimpleNamespace(__file__=str(package_dir / "__init__.py"), NudeDetector=FakeNudeDetector),
    )

    detector_module._get_nudenet()

    target = app_dir / "320n.onnx"
    assert target.read_bytes() == package_model.read_bytes()
    assert captured_paths == [str(target)]


def test_loader_rejects_installed_runtime_without_model_artifact(tmp_path, monkeypatch):
    import nudenet_detector as detector_module

    package_dir = tmp_path / "site-packages" / "nudenet"
    package_dir.mkdir(parents=True)
    app_dir = tmp_path / "data" / "models" / "nudenet"

    class FakeNudeDetector:
        def __init__(self, model_path, providers=None, inference_resolution=320):
            raise AssertionError("detector must not load without a verified model")

    monkeypatch.setattr(detector_module, "get_nudenet_model_dir", lambda: str(app_dir))
    monkeypatch.setattr(detector_module, "_detector", None)
    monkeypatch.setitem(
        sys.modules,
        "nudenet",
        SimpleNamespace(__file__=str(package_dir / "__init__.py"), NudeDetector=FakeNudeDetector),
    )

    try:
        detector_module._get_nudenet()
    except RuntimeError as exc:
        message = str(exc)
    else:
        raise AssertionError("Expected a missing NudeNet model error")

    assert "official 320n.onnx artifact is missing" in message
