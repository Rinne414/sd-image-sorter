"""Shape detected regions before they are censored: ellipse, fitted outline, grown edges.

NudeNet and deepghs' anime detector report boxes only, and a full box also
covers the skin around the part. "ellipse" puts an ellipse inside each box;
"fit" traces the part inside its box with GrabCut (OpenCV, a core
dependency) and falls back to the ellipse when the trace fails. Regions
that already carry a precise outline (a -seg YOLO polygon, a SAM3 mask) keep
it: ellipse and fit only replace plain boxes.

Every region can also grow outward by a share of its own size, so the
mosaic reaches past the detection's edge equally on small and large
pictures. Growth is 0 by default, which keeps the old behaviour.
"""

from __future__ import annotations

import logging
import math
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np
from PIL import Image, ImageFilter

logger = logging.getLogger(__name__)

SHAPES = ("precise", "box", "ellipse", "fit")
ELLIPSE_POINTS = 48
# GrabCut runs on the box plus this share of context, scaled to at most FIT_WORK_SIDE.
FIT_CONTEXT = 0.15
FIT_WORK_SIDE = 384
FIT_ITERATIONS = 3
# A traced outline filling less than this share of its box is a failed trace.
FIT_MIN_FILL = 0.15
# Masks are grown on a copy scaled so the growth radius is at most this many pixels.
MAX_FILTER_RADIUS = 6

Box = Tuple[float, float, float, float]


def reshape(
    detections: Sequence[Dict[str, Any]],
    image: Optional[Image.Image],
    shape: str = "precise",
    expand_percent: float = 0.0,
) -> Tuple[List[Dict[str, Any]], List[str]]:
    """Return reshaped copies of ``detections`` plus user-facing warnings."""
    if shape not in SHAPES:
        raise ValueError(f"Unknown region shape {shape!r}")
    size = image.size if image is not None else None
    growth = max(0.0, float(expand_percent)) / 100.0
    shaped: List[Dict[str, Any]] = []
    failed_fits = 0
    for original in detections:
        detection = dict(original)
        box = _box(detection)
        if box is None:
            shaped.append(detection)
            continue
        grown_box = _grow_box(box, growth, size)
        has_outline = (
            _polygon(detection) is not None or detection.get("mask") is not None
        )
        if shape == "box":
            detection.pop("polygon", None)
            detection.pop("mask", None)
        elif has_outline:
            _grow_outline(detection, growth, size)
        elif shape == "ellipse":
            detection["polygon"] = ellipse_polygon(grown_box)
            detection["shape"] = "ellipse"
        elif shape == "fit":
            traced = fit_polygon(image, grown_box) if image is not None else None
            if traced is None:
                failed_fits += 1
                detection["polygon"] = ellipse_polygon(grown_box)
                detection["shape"] = "ellipse"
            else:
                detection["polygon"] = traced
                detection["shape"] = "fit"
        detection["box"] = [round(value) for value in grown_box]
        shaped.append(detection)
    warnings = []
    if failed_fits:
        warnings.append(
            f"Fit could not trace {failed_fits} region(s) and used an ellipse there instead."
        )
    return shaped, warnings


def _box(detection: Dict[str, Any]) -> Optional[Box]:
    box = detection.get("box")
    if not isinstance(box, (list, tuple)) or len(box) != 4:
        return None
    x1, y1, x2, y2 = (float(value) for value in box)
    if x2 <= x1 or y2 <= y1:
        return None
    return x1, y1, x2, y2


def _polygon(detection: Dict[str, Any]) -> Optional[List[List[float]]]:
    points = [
        [float(point[0]), float(point[1])]
        for point in detection.get("polygon") or []
        if isinstance(point, (list, tuple)) and len(point) >= 2
    ]
    return points if len(points) >= 3 else None


def _grow_box(box: Box, growth: float, size: Optional[Tuple[int, int]]) -> Box:
    x1, y1, x2, y2 = box
    dx = (x2 - x1) * growth
    dy = (y2 - y1) * growth
    grown = (x1 - dx, y1 - dy, x2 + dx, y2 + dy)
    if size is None:
        return grown
    return (
        max(0.0, grown[0]),
        max(0.0, grown[1]),
        min(float(size[0]), grown[2]),
        min(float(size[1]), grown[3]),
    )


def _grow_outline(
    detection: Dict[str, Any], growth: float, size: Optional[Tuple[int, int]]
) -> None:
    if growth <= 0:
        return
    polygon = _polygon(detection)
    if polygon is not None:
        # Scaling around the centre grows the outline by `growth` of its size on each side.
        cx = sum(point[0] for point in polygon) / len(polygon)
        cy = sum(point[1] for point in polygon) / len(polygon)
        factor = 1.0 + 2.0 * growth
        grown = [[cx + (x - cx) * factor, cy + (y - cy) * factor] for x, y in polygon]
        if size is not None:
            grown = [
                [min(max(x, 0.0), float(size[0])), min(max(y, 0.0), float(size[1]))]
                for x, y in grown
            ]
        detection["polygon"] = grown
    mask = detection.get("mask")
    if mask is not None:
        detection["mask"] = grow_mask(np.asarray(mask), growth)


def grow_mask(mask: np.ndarray, growth: float) -> np.ndarray:
    """Dilate a 0/1 mask by `growth` of its region's size (bounded cost)."""
    if growth <= 0 or mask.ndim != 2 or not mask.any():
        return mask
    rows = np.flatnonzero(mask.any(axis=1))
    cols = np.flatnonzero(mask.any(axis=0))
    extent = max(rows[-1] - rows[0] + 1, cols[-1] - cols[0] + 1)
    radius = max(1, round(extent * growth))
    scale = min(1.0, MAX_FILTER_RADIUS / radius)
    picture = Image.fromarray((mask > 0).astype(np.uint8) * 255, mode="L")
    small = picture.resize(
        (max(1, round(picture.width * scale)), max(1, round(picture.height * scale))),
        Image.NEAREST,
    )
    small_radius = max(1, round(radius * scale))
    grown = small.filter(ImageFilter.MaxFilter(2 * small_radius + 1)).resize(
        picture.size, Image.NEAREST
    )
    return ((np.asarray(grown) > 0) | (mask > 0)).astype(np.uint8)


def ellipse_polygon(box: Box, points: int = ELLIPSE_POINTS) -> List[List[float]]:
    x1, y1, x2, y2 = box
    cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
    rx, ry = (x2 - x1) / 2, (y2 - y1) / 2
    return [
        [
            cx + rx * math.cos(2 * math.pi * step / points),
            cy + ry * math.sin(2 * math.pi * step / points),
        ]
        for step in range(points)
    ]


def fit_polygon(image: Image.Image, box: Box) -> Optional[List[List[float]]]:
    """Trace the object inside ``box`` with GrabCut; None when the trace fails."""
    try:
        import cv2
    except ImportError:
        return None
    x1, y1, x2, y2 = box
    width, height = x2 - x1, y2 - y1
    left = max(0, int(x1 - width * FIT_CONTEXT))
    top = max(0, int(y1 - height * FIT_CONTEXT))
    right = min(image.width, int(math.ceil(x2 + width * FIT_CONTEXT)))
    bottom = min(image.height, int(math.ceil(y2 + height * FIT_CONTEXT)))
    crop = image.convert("RGB").crop((left, top, right, bottom))
    scale = min(1.0, FIT_WORK_SIDE / max(crop.size))
    work = crop.resize(
        (max(1, round(crop.width * scale)), max(1, round(crop.height * scale))),
        Image.BILINEAR,
    )
    rect = (
        max(0, int((x1 - left) * scale)),
        max(0, int((y1 - top) * scale)),
        max(1, int(width * scale)),
        max(1, int(height * scale)),
    )
    if rect[2] < 4 or rect[3] < 4:
        return None
    labels = np.zeros(work.size[::-1], np.uint8)
    background = np.zeros((1, 65), np.float64)
    foreground = np.zeros((1, 65), np.float64)
    try:
        cv2.grabCut(
            cv2.cvtColor(np.asarray(work), cv2.COLOR_RGB2BGR),
            labels,
            rect,
            background,
            foreground,
            FIT_ITERATIONS,
            cv2.GC_INIT_WITH_RECT,
        )
    except cv2.error as exc:
        logger.info("GrabCut failed on a %sx%s region: %s", rect[2], rect[3], exc)
        return None
    inside = np.isin(labels, (cv2.GC_FGD, cv2.GC_PR_FGD)).astype(np.uint8)
    if inside.sum() < FIT_MIN_FILL * rect[2] * rect[3]:
        return None
    contours, _ = cv2.findContours(inside, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None
    outline = max(contours, key=cv2.contourArea)
    outline = cv2.approxPolyDP(outline, 0.01 * cv2.arcLength(outline, True), True)
    if len(outline) < 3:
        return None
    return [
        [left + float(point[0][0]) / scale, top + float(point[0][1]) / scale]
        for point in outline
    ]
