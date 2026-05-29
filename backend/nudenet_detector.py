"""
NudeNet v3 detector for the SD Image Sorter censor pipeline.

ONNX-based 20-class body part detection, optimized for NSFW content.
More granular than generic YOLO for body-part-specific censoring.

Requires: pip install nudenet
"""
import logging
import os
import threading
from typing import Dict, List

from PIL import Image
from config import get_nudenet_model_dir
from ai_runtime_guard import exclusive_ai_runtime


logger = logging.getLogger(__name__)

# Lazy-loaded detector
_detector = None
_detector_lock = threading.Lock()


def _get_nudenet():
    """Get or create NudeNet detector (singleton, thread-safe)."""
    global _detector
    if _detector is None:
        with _detector_lock:
            if _detector is None:
                try:
                    from nudenet import NudeDetector  # type: ignore
                except ImportError:
                    raise RuntimeError(
                        "nudenet not installed. Run: pip install nudenet"
                    )
                logger.info("[NudeNet] Loading detector...")
                local_model = os.path.join(get_nudenet_model_dir(), "320n.onnx")
                with exclusive_ai_runtime("nudenet-load"):
                    _detector = NudeDetector(model_path=local_model if os.path.exists(local_model) else None)
                logger.info("[NudeNet] Detector loaded")
    return _detector


# NudeNet class labels
NUDENET_CLASSES = {
    "FEMALE_BREAST_EXPOSED": "breasts",
    "FEMALE_GENITALIA_EXPOSED": "pussy",
    "MALE_GENITALIA_EXPOSED": "dick",
    "BUTTOCKS_EXPOSED": "buttocks",
    "ANUS_EXPOSED": "anus",
    "FEMALE_BREAST_COVERED": "breasts_covered",
    "FEMALE_GENITALIA_COVERED": "pussy_covered",
    "MALE_GENITALIA_COVERED": "dick_covered",
    "BUTTOCKS_COVERED": "buttocks_covered",
    "ANUS_COVERED": "anus_covered",
    "BELLY_EXPOSED": "belly",
    "BELLY_COVERED": "belly_covered",
    "FEET_EXPOSED": "feet",
    "FEET_COVERED": "feet_covered",
    "ARMPITS_EXPOSED": "armpits",
    "ARMPITS_COVERED": "armpits_covered",
    "FACE_FEMALE": "face_female",
    "FACE_MALE": "face_male",
    "MALE_BREAST_EXPOSED": "male_breasts",
    "MALE_BREAST_COVERED": "male_breasts_covered",
}

# Groups for censor filtering
EXPOSED_CLASSES = {
    "FEMALE_BREAST_EXPOSED",
    "FEMALE_GENITALIA_EXPOSED",
    "MALE_GENITALIA_EXPOSED",
    "BUTTOCKS_EXPOSED",
    "ANUS_EXPOSED",
}

COVERED_CLASSES = {
    "FEMALE_BREAST_COVERED",
    "FEMALE_GENITALIA_COVERED",
    "MALE_GENITALIA_COVERED",
    "BUTTOCKS_COVERED",
    "ANUS_COVERED",
}


class NudeNetDetector:
    """
    NudeNet v3 wrapper for body-part detection.

    Provides 20-class body part detection with configurable
    filtering between exposed/covered parts.
    """

    def __init__(self):
        self._detector = None

    def load(self):
        """Load the NudeNet model."""
        self._detector = _get_nudenet()

    @property
    def detector(self):
        if self._detector is None:
            self.load()
        return self._detector

    def detect(
        self,
        image_path: str,
        conf_threshold: float = 0.5,
        exposed_only: bool = True,
    ) -> List[Dict]:
        """
        Run NudeNet detection on an image file.

        Args:
            image_path: Path to image file.
            conf_threshold: Minimum confidence threshold.
            exposed_only: If True, only return exposed body parts.

        Returns:
            List of detection dicts with keys:
                class, class_id, confidence, box [x1,y1,x2,y2], label
        """
        detector_input = self._prepare_detector_input(image_path)
        with exclusive_ai_runtime("nudenet-inference"):
            raw_detections = self.detector.detect(detector_input)
        return self._filter_detections(raw_detections, conf_threshold, exposed_only)

    def detect_from_pil(
        self,
        image: Image.Image,
        conf_threshold: float = 0.5,
        exposed_only: bool = True,
    ) -> List[Dict]:
        """Run NudeNet detection on a PIL Image."""
        try:
            detector_input = self._pil_to_detector_input(image)
            with exclusive_ai_runtime("nudenet-inference"):
                raw_detections = self.detector.detect(detector_input)
            return self._filter_detections(raw_detections, conf_threshold, exposed_only)
        except Exception as exc:
            raise RuntimeError(f"NudeNet could not read the image input: {exc}") from exc

    @staticmethod
    def _pil_to_detector_input(image: Image.Image):
        """Convert a PIL image into the RGBA ndarray NudeNet expects internally."""
        import numpy as np

        return np.array(image.convert("RGBA"))

    def _prepare_detector_input(self, image_path: str):
        """
        Read image data with Pillow first, then pass an RGBA array to NudeNet.

        This avoids NudeNet's internal `cv2.imread(path)` path handling, which can
        fail on some Windows paths even when the file exists and Pillow can open it.
        """
        try:
            with Image.open(image_path) as image:
                return self._pil_to_detector_input(image)
        except Exception as exc:
            raise RuntimeError(f"NudeNet could not read image file '{image_path}': {exc}") from exc

    def _filter_detections(
        self,
        raw_detections: list,
        conf_threshold: float,
        exposed_only: bool,
    ) -> List[Dict]:
        """Filter and normalize NudeNet detections."""
        results = []

        for det in raw_detections:
            label = det.get("class", "")
            score = det.get("score", 0.0)

            if score < conf_threshold:
                continue

            if exposed_only and label not in EXPOSED_CLASSES:
                continue

            box = det.get("box", [0, 0, 0, 0])
            # NudeNet returns [x, y, width, height], so normalize to [x1, y1, x2, y2]
            x, y, w, h = [int(b) for b in box]
            mapped_label = NUDENET_CLASSES.get(label, label.lower())

            results.append({
                "class": mapped_label,
                "class_id": list(NUDENET_CLASSES.keys()).index(label) if label in NUDENET_CLASSES else -1,
                "confidence": round(score, 4),
                "box": [x, y, x + max(0, w), y + max(0, h)],
                "label": label,  # Original NudeNet label
            })

        return results


# Singleton
_nudenet_instance = None


def get_nudenet_detector() -> NudeNetDetector:
    """Get singleton NudeNet detector."""
    global _nudenet_instance
    if _nudenet_instance is None:
        _nudenet_instance = NudeNetDetector()
    return _nudenet_instance
