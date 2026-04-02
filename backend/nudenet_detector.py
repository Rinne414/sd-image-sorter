"""
NudeNet v3 detector for the SD Image Sorter censor pipeline.

ONNX-based 20-class body part detection, optimized for NSFW content.
More granular than generic YOLO for body-part-specific censoring.

Requires: pip install nudenet
"""
import logging
import os
import tempfile
import threading
from typing import Dict, List, Optional

from PIL import Image


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
                _detector = NudeDetector()
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
        raw_detections = self.detector.detect(image_path)
        return self._filter_detections(raw_detections, conf_threshold, exposed_only)

    def detect_from_pil(
        self,
        image: Image.Image,
        conf_threshold: float = 0.5,
        exposed_only: bool = True,
    ) -> List[Dict]:
        """Run NudeNet detection on a PIL Image."""
        tmp_path = None
        try:
            # NudeNet requires a file path
            # Use delete=False and manual cleanup to ensure file is closed before deletion
            with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
                image.save(tmp, format="PNG")
                tmp_path = tmp.name

            raw_detections = self.detector.detect(tmp_path)
            return self._filter_detections(raw_detections, conf_threshold, exposed_only)
        finally:
            # Clean up temp file with existence check
            if tmp_path is not None:
                try:
                    if os.path.exists(tmp_path):
                        os.unlink(tmp_path)
                except OSError as e:
                    logger.debug("Failed to delete temp file %s: %s", tmp_path, e)

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
            # NudeNet returns [x1, y1, x2, y2]
            mapped_label = NUDENET_CLASSES.get(label, label.lower())

            results.append({
                "class": mapped_label,
                "class_id": list(NUDENET_CLASSES.keys()).index(label) if label in NUDENET_CLASSES else -1,
                "confidence": round(score, 4),
                "box": [int(b) for b in box],
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
