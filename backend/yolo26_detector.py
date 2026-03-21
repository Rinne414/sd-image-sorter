"""
YOLO26 detector for the SD Image Sorter censor pipeline.

Uses Ultralytics YOLO26 (latest generation, dual-head architecture)
with segmentation support for precise mask-based censoring.

Requires: pip install ultralytics>=8.4.0
"""
import os
import threading
from typing import Dict, List, Optional, Tuple

import numpy as np
from PIL import Image


# Lazy-loaded model
_model = None
_model_lock = threading.Lock()
_model_name = None


def _get_model(model_name: str = "yolo26n-seg"):
    """Load YOLO26 model (singleton, thread-safe)."""
    global _model, _model_name
    if _model is None or _model_name != model_name:
        with _model_lock:
            if _model is None or _model_name != model_name:
                try:
                    from ultralytics import YOLO
                except ImportError:
                    raise RuntimeError(
                        "ultralytics not installed. Run: pip install ultralytics>=8.4.0"
                    )
                weight_file = f"{model_name}.pt"
                print(f"[YOLO26] Loading model: {weight_file}")
                _model = YOLO(weight_file)
                _model_name = model_name
                print(f"[YOLO26] Model loaded successfully")
    return _model


class YOLO26Detector:
    """
    YOLO26 detector wrapper for censoring.

    Supports detection, segmentation, and ONNX export.
    Uses the dual-head architecture with NMS-free end-to-end prediction.
    """

    # Map COCO class IDs to body-part labels for censoring
    # These are the standard COCO classes — the model detects general objects.
    # For body-part-specific detection, use with NudeNet or a custom model.
    COCO_PERSON_ID = 0  # "person" class in COCO

    def __init__(self, model_name: str = "yolo26n-seg"):
        """
        Initialize YOLO26 detector.

        Args:
            model_name: Model variant. Options:
                - "yolo26n-seg" (nano, fastest, ~2.7M params)
                - "yolo26s-seg" (small, balanced, ~10.4M params)
                - "yolo26m-seg" (medium, ~23.6M params)
                - "yolo26l-seg" (large, ~28.0M params)
                - "yolo26x-seg" (extra-large, ~62.8M params)
        """
        self.model_name = model_name
        self._model = None

    def load(self):
        """Load the model (downloads weights automatically if needed)."""
        self._model = _get_model(self.model_name)

    @property
    def model(self):
        if self._model is None:
            self.load()
        return self._model

    def detect(
        self,
        image_path: str,
        conf_threshold: float = 0.5,
        classes: Optional[List[int]] = None,
    ) -> List[Dict]:
        """
        Run detection on an image file.

        Args:
            image_path: Path to image file.
            conf_threshold: Minimum confidence threshold.
            classes: Filter to specific class IDs (None = all classes).

        Returns:
            List of detection dicts with keys:
                class, class_id, confidence, box [x1,y1,x2,y2], mask (if seg model)
        """
        results = self.model.predict(
            source=image_path,
            conf=conf_threshold,
            classes=classes,
            verbose=False,
        )
        return self._parse_results(results)

    def detect_from_pil(
        self,
        image: Image.Image,
        conf_threshold: float = 0.5,
        classes: Optional[List[int]] = None,
    ) -> List[Dict]:
        """Run detection on a PIL Image."""
        img_array = np.array(image)
        results = self.model.predict(
            source=img_array,
            conf=conf_threshold,
            classes=classes,
            verbose=False,
        )
        return self._parse_results(results)

    def detect_persons(
        self, image_path: str, conf_threshold: float = 0.5
    ) -> List[Dict]:
        """Detect only person instances (useful for SAM3 input)."""
        return self.detect(
            image_path,
            conf_threshold=conf_threshold,
            classes=[self.COCO_PERSON_ID],
        )

    def export_onnx(self, output_path: Optional[str] = None) -> str:
        """
        Export model to ONNX format.

        Args:
            output_path: Custom output path. If None, uses default.

        Returns:
            Path to the exported ONNX file.
        """
        exported = self.model.export(format="onnx")
        if output_path and isinstance(exported, str):
            os.rename(exported, output_path)
            return output_path
        return exported if isinstance(exported, str) else str(exported)

    def _parse_results(self, results) -> List[Dict]:
        """Parse Ultralytics results into standard detection dicts."""
        detections = []

        for result in results:
            boxes = result.boxes
            if boxes is None:
                continue

            masks = result.masks if hasattr(result, "masks") else None

            for i in range(len(boxes)):
                box = boxes.xyxy[i].cpu().numpy().astype(int).tolist()
                conf = float(boxes.conf[i].cpu().numpy())
                cls_id = int(boxes.cls[i].cpu().numpy())
                cls_name = result.names.get(cls_id, f"class_{cls_id}")

                det = {
                    "class": cls_name,
                    "class_id": cls_id,
                    "confidence": round(conf, 4),
                    "box": box,
                }

                # Include segmentation mask if available
                if masks is not None and i < len(masks):
                    mask_data = masks.data[i].cpu().numpy()
                    det["mask"] = mask_data  # Binary mask (H, W)

                detections.append(det)

        return detections


# Singleton
_yolo26_detector = None


def get_yolo26_detector(
    model_name: str = "yolo26n-seg",
) -> YOLO26Detector:
    """Get singleton YOLO26 detector."""
    global _yolo26_detector
    if _yolo26_detector is None or _yolo26_detector.model_name != model_name:
        _yolo26_detector = YOLO26Detector(model_name=model_name)
    return _yolo26_detector
