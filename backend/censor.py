"""
SD Image Sorter - Censor Module
YOLOv8 ONNX-based detection and censoring for sensitive content.

Requires a YOLOv8 ONNX model trained to detect body parts.
Recommended model: https://civitai.com/models/1736285
"""

import ast
import logging
import os
import numpy as np
from PIL import Image, ImageFilter, ImageDraw
from typing import List, Dict, Tuple, Optional

from config import (
    CENSOR_DEFAULT_CLASSES,
    CENSOR_CONFIDENCE_THRESHOLD,
    CENSOR_IOU_THRESHOLD,
    YOLO_INPUT_SIZE,
    CENSOR_DEFAULT_BLOCK_SIZE,
    CENSOR_DEFAULT_BLUR_RADIUS,
)

logger = logging.getLogger(__name__)

# Lazy import: onnxruntime is loaded on first use (see CensorDetector.load)
ort = None


def _ensure_ort():
    """Lazily import onnxruntime."""
    global ort
    if ort is None:
        import onnxruntime as ort_module  # type: ignore
        ort = ort_module


class CensorDetector:
    """YOLOv8 ONNX detector for sensitive body parts."""

    def __init__(self, model_path: Optional[str] = None, classes: Optional[List[str]] = None):
        self.model_path = model_path
        self.session = None
        self.runtime = None
        self.runtime_backend = None
        self.requested_classes = list(classes) if classes else None
        self.raw_classes = list(classes) if classes else list(CENSOR_DEFAULT_CLASSES)
        self.classes = list(classes) if classes else list(CENSOR_DEFAULT_CLASSES)
        self.input_size = YOLO_INPUT_SIZE

    @staticmethod
    def _canonicalize_class_name(class_name: str) -> str:
        normalized = str(class_name or "").strip().lower().replace("_", " ").replace("-", " ")
        collapsed = normalized.replace(" ", "")
        aliases = {
            "breast": "breasts",
            "breasts": "breasts",
            "boob": "breasts",
            "boobs": "breasts",
            "tits": "breasts",
            "tit": "breasts",
            "vagina": "pussy",
            "vulva": "pussy",
            "pussy": "pussy",
            "labia": "pussy",
            "penis": "dick",
            "dick": "dick",
            "cock": "dick",
            "cum": "cum",
            "semen": "cum",
            "anus": "anus",
            "butthole": "anus",
        }
        return aliases.get(collapsed, normalized)

    def _set_classes(self, class_names: List[str]):
        cleaned = [str(name).strip() for name in class_names if str(name).strip()]
        if not cleaned:
            cleaned = list(self.requested_classes) if self.requested_classes else list(CENSOR_DEFAULT_CLASSES)
        self.raw_classes = cleaned
        self.classes = [self._canonicalize_class_name(name) for name in cleaned]

    @staticmethod
    def _names_from_mapping(mapping) -> List[str]:
        if isinstance(mapping, dict):
            ordered = []
            for key in sorted(mapping.keys(), key=lambda item: int(item) if str(item).isdigit() else str(item)):
                ordered.append(str(mapping[key]))
            return ordered
        if isinstance(mapping, list):
            return [str(item) for item in mapping]
        return []

    def _load_onnx_metadata(self, session):
        try:
            metadata = session.get_modelmeta().custom_metadata_map or {}
            raw_names = metadata.get("names")
            if not raw_names:
                return
            parsed = ast.literal_eval(raw_names) if isinstance(raw_names, str) else raw_names
            names = self._names_from_mapping(parsed)
            if names:
                self._set_classes(names)
        except Exception as exc:
            logger.debug("Could not parse ONNX metadata names for %s: %s", self.model_path, exc)

    def _supports_lightweight_onnx(self, session) -> bool:
        outputs = session.get_outputs()
        if not outputs:
            return False

        output_shape = outputs[0].shape
        if len(output_shape) != 3:
            return False

        channel_dim = output_shape[1]
        if not isinstance(channel_dim, int):
            return False

        expected_channels = 4 + len(self.classes)
        if len(outputs) > 1:
            expected_channels += 32
        return channel_dim == expected_channels

    def _load_with_ultralytics(self, model_path: str):
        from ultralytics import YOLO

        logger.info("Loading model with Ultralytics runtime: %s", model_path)
        model = YOLO(model_path)
        self.runtime = model
        self.session = model
        self.runtime_backend = "ultralytics"
        self.input_size = YOLO_INPUT_SIZE

        names = self._names_from_mapping(getattr(model, "names", {}))
        if names:
            self._set_classes(names)

    @staticmethod
    def _lookup_runtime_name(names, class_id: int) -> str:
        if isinstance(names, dict):
            return str(names.get(class_id, names.get(str(class_id), f"class_{class_id}")))
        if isinstance(names, list) and 0 <= class_id < len(names):
            return str(names[class_id])
        return f"class_{class_id}"

    def _detect_with_ultralytics(self, image_source, conf_threshold: float) -> List[Dict]:
        if self.runtime is None:
            raise RuntimeError("Model not loaded. Call load() first.")

        results = self.runtime.predict(image_source, conf=conf_threshold, device="cpu", verbose=False)
        if not results:
            return []

        result = results[0]
        boxes = getattr(result, "boxes", None)
        if boxes is None or len(boxes) == 0:
            return []

        detections = []
        names = getattr(result, "names", getattr(self.runtime, "names", {}))
        for index in range(len(boxes)):
            class_id = int(boxes.cls[index].item())
            confidence = float(boxes.conf[index].item())
            x1, y1, x2, y2 = [int(round(value)) for value in boxes.xyxy[index].tolist()]
            class_name = self._canonicalize_class_name(self._lookup_runtime_name(names, class_id))
            detections.append(
                {
                    "class": class_name,
                    "class_id": class_id,
                    "confidence": confidence,
                    "box": [x1, y1, x2, y2],
                }
            )

        return detections
        
    def load(self, model_path: Optional[str] = None):
        """Load the selected YOLO model with the most compatible runtime."""
        _ensure_ort()

        if model_path:
            self.model_path = model_path

        if not self.model_path or not os.path.exists(self.model_path):
            raise FileNotFoundError(f"Model file not found: {self.model_path}")

        extension = os.path.splitext(self.model_path)[1].lower()
        if extension in {".pt", ".pth"}:
            try:
                self._load_with_ultralytics(self.model_path)
                logger.info("Censor detector loaded via Ultralytics: %s", os.path.basename(self.model_path))
                logger.info("Classes: %d", len(self.classes))
                return
            except ImportError as exc:
                raise RuntimeError(
                    "Cannot load a PyTorch YOLO model because 'ultralytics' is not installed.\n\n"
                    "Install ultralytics or switch to an ONNX model in models/yolo."
                ) from exc
            except Exception as exc:
                logger.error("Error loading PyTorch YOLO model: %s", exc)
                raise RuntimeError(f"Failed to load PyTorch YOLO model: {exc}") from exc

        try:
            # Create ONNX Runtime session
            # Note: We assign to a temp variable first to ensure full success before setting self.session
            logger.info("Initializing ONNX session for: %s", self.model_path)
            available_providers = ort.get_available_providers()
            providers = [provider for provider in ['CUDAExecutionProvider', 'CPUExecutionProvider'] if provider in available_providers]
            if not providers:
                providers = ['CPUExecutionProvider']
            session = ort.InferenceSession(self.model_path, providers=providers)
            
            # Get input details
            input_info = session.get_inputs()[0]
            self.input_name = input_info.name
            
            # Update input size from model if available
            if len(input_info.shape) == 4:
                _, _, h, w = input_info.shape
                if isinstance(h, int) and isinstance(w, int):
                    self.input_size = (w, h)

            self._load_onnx_metadata(session)

            if not self._supports_lightweight_onnx(session):
                logger.info(
                    "ONNX output layout for %s is not supported by the lightweight parser. Falling back to Ultralytics runtime.",
                    self.model_path,
                )
                self._load_with_ultralytics(self.model_path)
                logger.info("Censor detector loaded via Ultralytics fallback: %s", os.path.basename(self.model_path))
                logger.info("Classes: %d", len(self.classes))
                return
            
            self.session = session
            self.runtime = None
            self.runtime_backend = "onnxruntime"
            logger.info("Censor detector loaded: %s", os.path.basename(self.model_path))
            logger.info("Input size: %s, Classes: %d", self.input_size, len(self.classes))
            
        except Exception as e:
            logger.error("Error loading ONNX model: %s", e)
            self.session = None  # Ensure it's None on failure
            self.runtime = None
            self.runtime_backend = None
            
            # Provide helpful error message
            error_msg = str(e)
            if "Protobuf" in error_msg or "INVALID_PROTOBUF" in error_msg:
                raise RuntimeError(
                    "ONNX model file appears to be corrupted or invalid.\n\n"
                    "If this is a .pt file, it cannot be loaded as ONNX directly. "
                    "The automatic conversion requires 'ultralytics' to be installed:\n"
                    "  pip install ultralytics\n\n"
                    "If this is an .onnx file, it may be corrupted. Try re-exporting it."
                )
            raise e
        
    def preprocess(self, image: Image.Image) -> Tuple[np.ndarray, Tuple[float, float], Tuple[int, int]]:
        """Preprocess image for YOLOv8 inference."""
        original_size = image.size  # (width, height)
        
        # Resize with letterboxing to maintain aspect ratio
        img_w, img_h = original_size
        target_w, target_h = self.input_size
        
        scale = min(target_w / img_w, target_h / img_h)
        new_w = int(img_w * scale)
        new_h = int(img_h * scale)
        
        # Resize
        resized = image.resize((new_w, new_h), Image.Resampling.LANCZOS)
        
        # Create padded image
        padded = Image.new('RGB', self.input_size, (114, 114, 114))
        pad_x = (target_w - new_w) // 2
        pad_y = (target_h - new_h) // 2
        padded.paste(resized, (pad_x, pad_y))
        
        # Convert to numpy and normalize
        img_array = np.array(padded, dtype=np.float32) / 255.0
        
        # HWC to CHW, add batch dimension
        img_array = img_array.transpose(2, 0, 1)
        img_array = np.expand_dims(img_array, axis=0)
        
        # Return scale info for postprocessing
        scale_info = (scale, scale)
        pad_info = (pad_x, pad_y)
        
        return img_array, scale_info, pad_info
    
    def postprocess(
        self,
        outputs: np.ndarray,
        original_size: Tuple[int, int],
        scale_info: Tuple[float, float],
        pad_info: Tuple[int, int],
        conf_threshold: float = CENSOR_CONFIDENCE_THRESHOLD,
        iou_threshold: float = CENSOR_IOU_THRESHOLD
    ) -> List[Dict]:
        """Postprocess YOLOv8 outputs to detection boxes."""
        predictions = np.squeeze(outputs).T
        
        # Extract boxes (x_center, y_center, width, height)
        boxes = predictions[:, :4]
        
        # Handle segmentation models (channels > 4 + num_classes)
        num_classes = len(self.classes)
        
        if predictions.shape[1] > 4 + num_classes:
            # Segmentation model detected: Only use class columns, ignore mask coeffs
            scores = predictions[:, 4:4+num_classes]
        else:
            scores = predictions[:, 4:]
        
        # Get max class score and class id for each box
        class_ids = np.argmax(scores, axis=1)
        confidences = np.max(scores, axis=1)
        
        # Filter by confidence
        mask = confidences >= conf_threshold
        boxes = boxes[mask]
        confidences = confidences[mask]
        class_ids = class_ids[mask]
        
        if len(boxes) == 0:
            return []
        
        # Convert from center to corner format
        x_center, y_center, width, height = boxes[:, 0], boxes[:, 1], boxes[:, 2], boxes[:, 3]
        x1 = x_center - width / 2
        y1 = y_center - height / 2
        x2 = x_center + width / 2
        y2 = y_center + height / 2
        
        # Unscale
        scale_x, scale_y = scale_info
        pad_x, pad_y = pad_info
        
        x1 = (x1 - pad_x) / scale_x
        y1 = (y1 - pad_y) / scale_y
        x2 = (x2 - pad_x) / scale_x
        y2 = (y2 - pad_y) / scale_y
        
        # Clip
        orig_w, orig_h = original_size
        x1 = np.clip(x1, 0, orig_w)
        y1 = np.clip(y1, 0, orig_h)
        x2 = np.clip(x2, 0, orig_w)
        y2 = np.clip(y2, 0, orig_h)
        
        # NMS
        boxes_xyxy = np.stack([x1, y1, x2, y2], axis=1)
        indices = self._nms(boxes_xyxy, confidences, iou_threshold)
        
        detections = []
        for i in indices:
            class_id = int(class_ids[i])
            class_name = self.classes[class_id] if class_id < len(self.classes) else f"class_{class_id}"
            
            detections.append({
                "class": class_name,
                "class_id": class_id,
                "confidence": float(confidences[i]),
                "box": [int(x1[i]), int(y1[i]), int(x2[i]), int(y2[i])]
            })
        
        return detections
    
    def _nms(self, boxes: np.ndarray, scores: np.ndarray, iou_threshold: float) -> List[int]:
        """Non-maximum suppression."""
        x1, y1, x2, y2 = boxes[:, 0], boxes[:, 1], boxes[:, 2], boxes[:, 3]
        areas = (x2 - x1) * (y2 - y1)
        
        order = scores.argsort()[::-1]
        keep = []
        
        while order.size > 0:
            i = order[0]
            keep.append(i)
            
            if order.size == 1:
                break
            
            # Compute IoU
            xx1 = np.maximum(x1[i], x1[order[1:]])
            yy1 = np.maximum(y1[i], y1[order[1:]])
            xx2 = np.minimum(x2[i], x2[order[1:]])
            yy2 = np.minimum(y2[i], y2[order[1:]])
            
            w = np.maximum(0.0, xx2 - xx1)
            h = np.maximum(0.0, yy2 - yy1)
            inter = w * h
            
            iou = inter / (areas[i] + areas[order[1:]] - inter + 1e-6)  # Added epsilon to prevent div/0
            
            # Keep boxes with IoU below threshold
            inds = np.where(iou <= iou_threshold)[0]
            order = order[inds + 1]
        
        return keep
    
    def detect(self, image_path: str, conf_threshold: float = CENSOR_CONFIDENCE_THRESHOLD) -> List[Dict]:
        """Run detection on an image file."""
        if self.session is None:
            raise RuntimeError("Model not loaded. Call load() first.")

        if self.runtime_backend == "ultralytics":
            return self._detect_with_ultralytics(image_path, conf_threshold)

        # Load and preprocess image
        image = Image.open(image_path).convert('RGB')
        original_size = image.size

        img_array, scale_info, pad_info = self.preprocess(image)

        # Run inference
        outputs = self.session.run(None, {self.input_name: img_array})

        # Postprocess
        detections = self.postprocess(
            outputs[0],
            original_size,
            scale_info,
            pad_info,
            conf_threshold
        )

        return detections

    def detect_from_image(self, image: Image.Image, conf_threshold: float = CENSOR_CONFIDENCE_THRESHOLD) -> List[Dict]:
        """Run detection on a PIL Image."""
        if self.session is None:
            raise RuntimeError("Model not loaded. Call load() first.")

        if self.runtime_backend == "ultralytics":
            return self._detect_with_ultralytics(image, conf_threshold)
        
        original_size = image.size
        img_array, scale_info, pad_info = self.preprocess(image)
        
        outputs = self.session.run(None, {self.input_name: img_array})
        
        detections = self.postprocess(
            outputs[0],
            original_size,
            scale_info,
            pad_info,
            conf_threshold
        )
        
        return detections


class Censor:
    """Image censoring utilities."""

    @staticmethod
    def apply_mosaic(
        image: Image.Image,
        regions: List[Tuple[int, int, int, int]],
        block_size: int = CENSOR_DEFAULT_BLOCK_SIZE
    ) -> Image.Image:
        """Apply mosaic/pixelation to regions."""
        result = image.copy()

        for x1, y1, x2, y2 in regions:
            # Ensure valid coordinates
            x1, y1 = max(0, x1), max(0, y1)
            x2, y2 = min(image.width, x2), min(image.height, y2)

            if x2 <= x1 or y2 <= y1:
                continue

            # Extract region
            region = result.crop((x1, y1, x2, y2))

            # Pixelate: resize down then up
            w, h = region.size
            small_w = max(1, w // block_size)
            small_h = max(1, h // block_size)

            small = region.resize((small_w, small_h), Image.Resampling.NEAREST)
            pixelated = small.resize((w, h), Image.Resampling.NEAREST)

            # Paste back
            result.paste(pixelated, (x1, y1))

        return result

    @staticmethod
    def apply_bar(
        image: Image.Image,
        regions: List[Tuple[int, int, int, int]],
        color: Tuple[int, int, int] = (0, 0, 0)
    ) -> Image.Image:
        """Apply solid color bar to regions."""
        result = image.copy()
        draw = ImageDraw.Draw(result)

        for x1, y1, x2, y2 in regions:
            draw.rectangle([x1, y1, x2, y2], fill=color)

        return result

    @staticmethod
    def apply_blur(
        image: Image.Image,
        regions: List[Tuple[int, int, int, int]],
        blur_radius: int = CENSOR_DEFAULT_BLUR_RADIUS
    ) -> Image.Image:
        """Apply gaussian blur to regions."""
        result = image.copy()

        for x1, y1, x2, y2 in regions:
            x1, y1 = max(0, x1), max(0, y1)
            x2, y2 = min(image.width, x2), min(image.height, y2)

            if x2 <= x1 or y2 <= y1:
                continue

            region = result.crop((x1, y1, x2, y2))
            blurred = region.filter(ImageFilter.GaussianBlur(radius=blur_radius))
            result.paste(blurred, (x1, y1))

        return result
    
    @staticmethod
    def apply_sticker(
        image: Image.Image,
        regions: List[Tuple[int, int, int, int]],
        sticker_path: Optional[str] = None,
        sticker_emoji: str = "⭐"
    ) -> Image.Image:
        """Apply sticker overlay to regions."""
        result = image.copy()
        
        if sticker_path and os.path.exists(sticker_path):
            sticker = Image.open(sticker_path).convert('RGBA')
        else:
            # Create simple emoji-style sticker
            sticker = None
        
        for x1, y1, x2, y2 in regions:
            w, h = x2 - x1, y2 - y1
            
            if sticker:
                # Resize sticker to fit region
                resized = sticker.resize((w, h), Image.Resampling.LANCZOS)
                result.paste(resized, (x1, y1), resized)
            else:
                # Draw simple star/circle overlay
                draw = ImageDraw.Draw(result)
                center_x = (x1 + x2) // 2
                center_y = (y1 + y2) // 2
                radius = min(w, h) // 2
                draw.ellipse(
                    [center_x - radius, center_y - radius, 
                     center_x + radius, center_y + radius],
                    fill=(255, 215, 0)  # Gold color
                )
        
        return result
    
    @staticmethod
    def apply_censoring(
        image: Image.Image,
        regions: List[Tuple[int, int, int, int]],
        style: str = "mosaic",
        **kwargs
    ) -> Image.Image:
        """Apply censoring with specified style."""
        if style == "mosaic":
            block_size = kwargs.get("block_size", 16)
            return Censor.apply_mosaic(image, regions, block_size)
        elif style == "black_bar":
            return Censor.apply_bar(image, regions, (0, 0, 0))
        elif style == "white_bar":
            return Censor.apply_bar(image, regions, (255, 255, 255))
        elif style == "blur":
            blur_radius = kwargs.get("blur_radius", 20)
            return Censor.apply_blur(image, regions, blur_radius)
        elif style == "sticker":
            sticker_path = kwargs.get("sticker_path")
            return Censor.apply_sticker(image, regions, sticker_path)
        else:
            raise ValueError(f"Unknown censor style: {style}")


# Global detector instance (lazy loaded)
_detector: Optional[CensorDetector] = None


def get_detector(model_path: Optional[str] = None) -> CensorDetector:
    """Get or create the global detector instance."""
    global _detector
    
    if _detector is None or (model_path and _detector.model_path != model_path):
        _detector = CensorDetector(model_path)
        if model_path:
            _detector.load()
    
    return _detector
