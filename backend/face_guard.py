"""Face guard: drop censor detections that are really a face.

Detectors sometimes read an anime face as a private part: a mouth as a
pussy, eyes as nipples. With the deepghs anime face detector installed
(Model Center, "Anime Censor + Face Guard"), a detection whose area lies
mostly inside a detected face is dropped before anything is mosaicked.

Only the families that are mistaken for facial features are guarded.
A penis or cum on a face is a real subject (oral / facial scenes), so
those are never dropped: leaving something uncensored is worse than one
mosaic too many.
"""

from __future__ import annotations

import logging
import threading
from typing import Any, Dict, List, Optional, Sequence, Tuple

from PIL import Image

import anime_censor_models

logger = logging.getLogger(__name__)

GUARDED_FAMILIES = frozenset({"pussy", "anus", "breasts"})
# Faces are widened by this share of their size on each side (hair, chin).
FACE_MARGIN = 0.1
# A detection is dropped when at least this share of its area is on a face.
MIN_SHARE_ON_FACE = 0.5

Box = Tuple[float, float, float, float]

_lock = threading.Lock()
_detector = None
_detector_path: Optional[str] = None


def _face_detector():
    """The loaded face detector, or None when its model is not downloaded."""
    global _detector, _detector_path
    path = anime_censor_models.face_model_path()
    if not path.is_file():
        return None
    with _lock:
        if _detector is None or _detector_path != str(path):
            from censor import CensorDetector

            detector = CensorDetector(str(path))
            detector.load()
            _detector, _detector_path = detector, str(path)
        return _detector


def detect_faces(image: Image.Image) -> Optional[List[Box]]:
    """Widened face boxes in the image's pixel frame; None when unavailable."""
    detector = _face_detector()
    if detector is None:
        return None
    width, height = image.size
    faces: List[Box] = []
    for detection in detector.detect_from_image(
        image, conf_threshold=anime_censor_models.FACE_CONFIDENCE
    ):
        x1, y1, x2, y2 = (float(value) for value in detection["box"])
        margin_x = (x2 - x1) * FACE_MARGIN
        margin_y = (y2 - y1) * FACE_MARGIN
        faces.append(
            (
                max(0.0, x1 - margin_x),
                max(0.0, y1 - margin_y),
                min(width, x2 + margin_x),
                min(height, y2 + margin_y),
            )
        )
    return faces


def share_on_face(box: Box, face: Box) -> float:
    """Fraction of ``box``'s area that lies inside ``face``."""
    inner_w = max(0.0, min(box[2], face[2]) - max(box[0], face[0]))
    inner_h = max(0.0, min(box[3], face[3]) - max(box[1], face[1]))
    area = max(1.0, (box[2] - box[0]) * (box[3] - box[1]))
    return inner_w * inner_h / area


def guard(
    detections: Sequence[Dict[str, Any]],
    faces: Sequence[Box],
    family_of,
) -> Tuple[List[Dict[str, Any]], int]:
    """Split detections into kept ones and a count of face false positives."""
    kept: List[Dict[str, Any]] = []
    dropped = 0
    for detection in detections:
        box = detection.get("box")
        guarded = (
            family_of(detection.get("class") or detection.get("label") or "")
            in GUARDED_FAMILIES
        )
        on_face = (
            guarded
            and isinstance(box, (list, tuple))
            and len(box) == 4
            and any(
                share_on_face(tuple(float(v) for v in box), face) >= MIN_SHARE_ON_FACE
                for face in faces
            )
        )
        if on_face:
            dropped += 1
        else:
            kept.append(detection)
    return kept, dropped


def apply(
    detections: Sequence[Dict[str, Any]],
    image: Image.Image,
    family_of,
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """Run the guard on one picture; returns the kept detections and a report."""
    if not detections:
        return list(detections), {"active": False, "faces": 0, "dropped": 0}
    try:
        faces = detect_faces(image)
    except Exception:
        # A broken face model must not stop censoring: keep every detection.
        logger.exception("Face guard could not run; keeping every detection")
        return list(detections), {
            "active": False,
            "faces": 0,
            "dropped": 0,
            "error": True,
        }
    if faces is None:
        return list(detections), {"active": False, "faces": 0, "dropped": 0}
    kept, dropped = guard(detections, faces, family_of)
    return kept, {"active": True, "faces": len(faces), "dropped": dropped}
