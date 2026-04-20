"""
Censor service for SD Image Sorter.

Handles business logic for NSFW detection, censoring preview, and save operations.
"""
import logging
import os
import base64
import binascii
import traceback
from typing import Optional, List, Dict, Any
from pathlib import Path
from io import BytesIO

from fastapi import HTTPException
from pydantic import BaseModel, Field, field_validator
from PIL import Image, ImageDraw, PngImagePlugin

import database as db
from model_health import get_default_legacy_model_path, get_model_health

logger = logging.getLogger(__name__)


class CensorDetectRequest(BaseModel):
    """Request model for detection."""
    image_id: int = Field(..., ge=1)
    model_path: str = ""
    model_type: str = Field("legacy", pattern="^(legacy|nudenet|both)$")
    confidence_threshold: float = Field(0.5, ge=0.0, le=1.0)
    exposed_only: bool = True
    target_classes: Optional[List[str]] = None


class MaskRefineRequest(BaseModel):
    """Request model for mask refinement."""
    image_id: int = Field(..., ge=1)
    box: List[int] = Field(..., min_length=4, max_length=4)
    text_prompt: Optional[str] = None


class TextSegmentRequest(BaseModel):
    """Request model for text segmentation."""
    image_id: int = Field(..., ge=1)
    text_prompt: str = Field(..., min_length=1)


class BatchMaskRefineRequest(BaseModel):
    """Request model for batch mask refinement via SAM3."""
    items: List[MaskRefineRequest] = Field(..., min_length=1, max_length=500)
    sam3_confidence: float = Field(0.5, ge=0.0, le=1.0)


class CensorApplyRequest(BaseModel):
    """Request model for censor apply/preview."""
    image_id: int = Field(..., ge=1)
    regions: List[List[int]] = Field(..., min_length=1)
    style: str = Field("mosaic", pattern="^(mosaic|blur|solid|sticker)$")
    block_size: int = Field(16, ge=1)
    blur_radius: int = Field(20, ge=1)
    sticker_path: Optional[str] = None

    @field_validator("regions")
    @classmethod
    def validate_regions(cls, value: List[List[int]]) -> List[List[int]]:
        for region in value:
            if len(region) != 4:
                raise ValueError("Each region must contain exactly 4 coordinates")
        return value


class CensorSaveRequest(BaseModel):
    """Request model for censor save."""
    image_id: int = Field(..., ge=1)
    regions: List[List[int]] = Field(..., min_length=1)
    style: str = Field("mosaic", pattern="^(mosaic|blur|solid|sticker)$")
    block_size: int = Field(16, ge=1)
    blur_radius: int = Field(20, ge=1)
    sticker_path: Optional[str] = None
    output_folder: str = Field(..., min_length=1)
    filename_suffix: str = "_censored"

    @field_validator("regions")
    @classmethod
    def validate_save_regions(cls, value: List[List[int]]) -> List[List[int]]:
        for region in value:
            if len(region) != 4:
                raise ValueError("Each region must contain exactly 4 coordinates")
        return value


class CensorSaveDataRequest(BaseModel):
    """Request to save base64 image data directly."""
    image_data: str = Field(..., max_length=100_000_000)
    filename: str = Field(..., min_length=1)
    output_folder: str = Field(..., min_length=1)
    metadata_option: str = Field("keep", pattern="^(keep|minimal|strip)$")
    output_format: str = Field("png", pattern="^(png|jpg|jpeg|webp)$")
    original_image_id: Optional[int] = Field(None, ge=1)


class CensorService:
    """Service for NSFW detection and image censoring."""

    def __init__(self):
        """Initialize the censor service."""
        self._detector = None

    @staticmethod
    def _encode_mask_image_as_data_url(mask_image: Image.Image) -> Optional[str]:
        """Encode a mask as a transparent PNG so canvas compositing only affects masked pixels."""
        normalized = mask_image.convert("L")
        if normalized.getbbox() is None:
            # Return 1x1 transparent PNG for empty masks instead of None
            buf = BytesIO()
            Image.new("L", (1, 1), 0).save(buf, format="PNG")
            return f"data:image/png;base64,{base64.b64encode(buf.getvalue()).decode()}"

        rgba_mask = Image.new("RGBA", normalized.size, (255, 255, 255, 0))
        rgba_mask.putalpha(normalized)

        buffer = BytesIO()
        rgba_mask.save(buffer, format="PNG")
        buffer.seek(0)
        return f"data:image/png;base64,{base64.b64encode(buffer.getvalue()).decode('utf-8')}"

    @staticmethod
    def _normalize_target_family(label: str) -> str:
        normalized = str(label or "").strip().lower().replace("-", "_").replace(" ", "_")
        collapsed = normalized.replace("_", "")

        _BUTTOCKS_ALIASES = {
            "buttocks", "butt", "ass", "buttock",
            "buttocksexposed", "buttockscovered", "buttexposed",
        }
        _BREASTS_ALIASES = {
            "breasts", "breast", "malebreasts", "femalebreasts",
            "malebreast", "femalebreast", "boob", "boobs", "tits", "tit",
            "exposedbreasts", "coveredbreasts",
            "femalebreastexposed", "femalebreastcovered",
            "malebreastexposed", "malebreastcovered",
            "breastexposed", "breastcovered",
            "breastsexposed", "breastscovered",
        }
        _PUSSY_ALIASES = {
            "pussy", "vagina", "vulva", "labia",
            "femalegenitalia", "exposedgenitalia", "coveredgenitalia",
            "femalegenitaliaexposed", "femalegenitaliacovered",
            "pussyexposed",
        }
        _DICK_ALIASES = {
            "dick", "penis", "cock",
            "malegenitalia", "exposedpenis",
            "malegenitaliaexposed", "penisexposed",
        }
        _ANUS_ALIASES = {"anus", "butthole", "anusexposed", "anuscovered"}
        _CUM_ALIASES = {"cum", "semen"}

        if collapsed in _BUTTOCKS_ALIASES:
            return "buttocks"
        if collapsed in _BREASTS_ALIASES:
            return "breasts"
        if collapsed in _PUSSY_ALIASES:
            return "pussy"
        if collapsed in _DICK_ALIASES:
            return "dick"
        if collapsed in _ANUS_ALIASES:
            return "anus"
        if collapsed in _CUM_ALIASES:
            return "cum"
        return normalized

    @classmethod
    def _filter_detections_by_targets(
        cls,
        detections: List[Dict[str, Any]],
        target_classes: Optional[List[str]],
    ) -> List[Dict[str, Any]]:
        if target_classes is None:
            return detections

        normalized_targets = {
            cls._normalize_target_family(target)
            for target in target_classes
            if str(target or "").strip()
        }
        if not normalized_targets:
            return []

        filtered = []
        for detection in detections:
            detection_family = cls._normalize_target_family(detection.get("class", ""))
            if detection_family in normalized_targets:
                filtered.append(detection)
        return filtered

    @staticmethod
    def _build_combined_mask_data_url(
        image_size: tuple[int, int],
        detections: List[Dict[str, Any]],
        *,
        include_boxes: bool = False,
    ) -> Optional[str]:
        if not detections:
            return None

        mask_image = Image.new("L", image_size, 0)
        draw = ImageDraw.Draw(mask_image)

        for detection in detections:
            polygon = detection.get("polygon")
            if isinstance(polygon, list):
                points = [
                    (float(point[0]), float(point[1]))
                    for point in polygon
                    if isinstance(point, (list, tuple)) and len(point) >= 2
                ]
                if len(points) >= 3:
                    draw.polygon(points, fill=255)
                    continue

            if include_boxes:
                box = detection.get("box")
                if isinstance(box, list) and len(box) == 4:
                    x1, y1, x2, y2 = [int(float(value)) for value in box]
                    draw.rectangle([x1, y1, x2, y2], fill=255)

        return CensorService._encode_mask_image_as_data_url(mask_image)

    @staticmethod
    def _has_polygon_geometry(detection: Dict[str, Any]) -> bool:
        polygon = detection.get("polygon")
        if not isinstance(polygon, list):
            return False
        points = [
            point for point in polygon
            if isinstance(point, (list, tuple)) and len(point) >= 2
        ]
        return len(points) >= 3

    @staticmethod
    def _ensure_safe_existing_file(path: str, *, allowed_extensions: Optional[set] = None) -> str:
        """Validate an existing file path and reject symlinks."""
        if not path:
            raise HTTPException(status_code=404, detail="File not found")

        candidate = Path(os.path.abspath(path))
        if candidate.resolve(strict=False) != candidate:
            raise HTTPException(status_code=400, detail="Symlink paths are not allowed")

        if not candidate.exists() or not candidate.is_file():
            raise HTTPException(status_code=404, detail="File not found")

        if allowed_extensions and candidate.suffix.lower() not in allowed_extensions:
            raise HTTPException(status_code=400, detail="File type is not allowed")

        return str(candidate)

    @staticmethod
    def _ensure_safe_output_directory(path: str) -> str:
        """Validate an output directory and reject symlinks."""
        candidate = Path(os.path.abspath(path))
        if candidate.resolve(strict=False) != candidate:
            raise HTTPException(status_code=400, detail="Symlink paths are not allowed")
        return str(candidate)


    @staticmethod
    def _sanitize_suffix(suffix: str) -> str:
        """Convert user-provided suffix into a safe filename fragment."""
        allowed = ''.join(ch for ch in str(suffix or '') if ch.isalnum() or ch in {'_', '-'})
        if not allowed:
            return '_censored'
        if not allowed.startswith(('_', '-')):
            allowed = f'_{allowed}'
        return allowed[:64]

    @staticmethod
    def _normalize_output_format(output_format: str) -> str:
        """Normalize output format to a strict allowlist."""
        normalized = str(output_format or '').strip().lower()
        if normalized not in {'png', 'jpg', 'jpeg', 'webp'}:
            raise HTTPException(status_code=400, detail='Unsupported output format')
        return normalized

    @staticmethod
    def _ensure_output_path(output_folder: str, filename: str) -> str:
        """Build a final output path that cannot escape the target directory."""
        target_dir = Path(output_folder).resolve()
        output_path = (target_dir / filename).resolve()
        if output_path.parent != target_dir:
            raise HTTPException(status_code=400, detail='Invalid output path')
        return str(output_path)


    def detect(self, request: CensorDetectRequest) -> Dict[str, Any]:
        """
        Run detection on an image to find regions to censor.

        Supports multiple detection backends:
        - Legacy YOLOv8 ONNX: General segmentation model
        - NudeNet v3: Specialized NSFW body part detection
        - Both: Combine results from both detectors
        """
        image = db.get_image_by_id(request.image_id)
        if not image:
            raise HTTPException(status_code=404, detail="Image not found")

        image_path = self._ensure_safe_existing_file(image["path"])

        try:
            model_type = request.model_type

            if model_type == "nudenet":
                from nudenet_detector import get_nudenet_detector
                detector = get_nudenet_detector()
                detections = detector.detect(
                    image_path,
                    conf_threshold=request.confidence_threshold,
                    exposed_only=request.exposed_only,
                )

            elif model_type == "both":
                all_detections = []

                try:
                    from nudenet_detector import get_nudenet_detector
                    nn_det = get_nudenet_detector()
                    nn_results = nn_det.detect(
                        image_path,
                        conf_threshold=request.confidence_threshold,
                        exposed_only=request.exposed_only,
                    )
                    for d in nn_results:
                        d["source"] = "nudenet"
                    all_detections.extend(nn_results)
                except Exception as e:
                    logger.warning("NudeNet detection failed: %s", e)

                try:
                    from censor import CensorDetector
                    from config import PROJECT_ROOT

                    legacy_model_path = self._resolve_legacy_model_path(
                        request.model_path,
                        allowed_base=str(PROJECT_ROOT / "models"),
                    )
                    if legacy_model_path:
                        if self._detector is None or self._detector.model_path != legacy_model_path or self._detector.session is None:
                            self._detector = CensorDetector(legacy_model_path)
                            self._detector.load()
                        legacy_results = self._detector.detect(image_path, request.confidence_threshold)
                        for d in legacy_results:
                            d["source"] = "legacy"
                        all_detections.extend(legacy_results)
                except Exception as e:
                    logger.warning("Legacy detection failed: %s", e)

                detections = all_detections

            else:
                from censor import CensorDetector
                from config import PROJECT_ROOT

                legacy_model_path = self._resolve_legacy_model_path(
                    request.model_path,
                    allowed_base=str(PROJECT_ROOT / "models"),
                )

                if self._detector is None or self._detector.model_path != legacy_model_path or self._detector.session is None:
                    logger.info("Loading censor model: %s", legacy_model_path)
                    self._detector = CensorDetector(legacy_model_path)
                    self._detector.load()
                    logger.info("Model loaded successfully")

                detections = self._detector.detect(image_path, request.confidence_threshold)

            filtered_detections = self._filter_detections_by_targets(detections, request.target_classes)

            polygon_count = sum(1 for d in filtered_detections if self._has_polygon_geometry(d))
            with Image.open(image_path) as image_for_mask:
                combined_mask = self._build_combined_mask_data_url(
                    image_for_mask.size,
                    filtered_detections,
                    include_boxes=polygon_count != len(filtered_detections),
                )

            clean_detections = []
            for d in filtered_detections:
                clean = {k: v for k, v in d.items() if k != "mask"}
                if not self._has_polygon_geometry(clean):
                    clean.pop("polygon", None)
                clean_detections.append(clean)
            if not filtered_detections:
                geometry_mode = "none"
            elif polygon_count == len(filtered_detections):
                geometry_mode = "mask"
            elif polygon_count > 0:
                geometry_mode = "mixed"
            else:
                geometry_mode = "box"

            return {
                "status": "ok",
                "image_id": request.image_id,
                "model_type": model_type,
                "detections": clean_detections,
                "selected_target_classes": request.target_classes or [],
                "combined_mask": combined_mask,
                "geometry_mode": geometry_mode,
            }
        except HTTPException:
            raise
        except Exception:
            error_trace = traceback.format_exc()
            logger.error("Detection error:\n%s", error_trace)
            raise HTTPException(status_code=500, detail="Detection failed")

    def preview(self, request: CensorApplyRequest) -> Dict[str, str]:
        """Apply censoring and return base64 preview image."""
        from censor import Censor

        image_data = db.get_image_by_id(request.image_id)
        if not image_data:
            raise HTTPException(status_code=404, detail="Image not found")

        image_path = self._ensure_safe_existing_file(image_data["path"])

        # Validate sticker_path to prevent arbitrary file read
        if request.sticker_path:
            from utils.path_validation import validate_file_path
            is_valid, error = validate_file_path(request.sticker_path, allowed_extensions={'.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'})
            if not is_valid:
                raise HTTPException(status_code=400, detail=error or "Invalid sticker path")

        try:
            image = Image.open(image_path).convert('RGB')
            regions = [(int(r[0]), int(r[1]), int(r[2]), int(r[3])) for r in request.regions]

            censored = Censor.apply_censoring(
                image,
                regions,
                style=request.style,
                block_size=request.block_size,
                blur_radius=request.blur_radius,
                sticker_path=request.sticker_path
            )

            buffer = BytesIO()
            censored.save(buffer, format='JPEG', quality=90)
            buffer.seek(0)
            b64_image = base64.b64encode(buffer.getvalue()).decode('utf-8')

            return {
                "status": "ok",
                "preview": f"data:image/jpeg;base64,{b64_image}"
            }
        except Exception:
            raise HTTPException(status_code=500, detail="Preview failed")

    def save(self, request: CensorSaveRequest) -> Dict[str, str]:
        """Apply censoring and save to output folder."""
        from censor import Censor
        from utils.path_validation import validate_folder_path, validate_file_path

        image_data = db.get_image_by_id(request.image_id)
        if not image_data:
            raise HTTPException(status_code=404, detail="Image not found")

        image_path = self._ensure_safe_existing_file(image_data["path"])

        # Validate sticker_path to prevent arbitrary file read
        if request.sticker_path:
            is_valid_sticker, sticker_error = validate_file_path(request.sticker_path, allowed_extensions={'.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'})
            if not is_valid_sticker:
                raise HTTPException(status_code=400, detail=sticker_error or "Invalid sticker path")

        is_valid, error = validate_folder_path(request.output_folder, allow_create=True)
        if not is_valid:
            raise HTTPException(status_code=400, detail=error or "Invalid output folder")

        output_folder = self._ensure_safe_output_directory(request.output_folder)

        try:
            os.makedirs(output_folder, exist_ok=True)

            image = Image.open(image_path).convert('RGB')
            regions = [(int(r[0]), int(r[1]), int(r[2]), int(r[3])) for r in request.regions]

            censored = Censor.apply_censoring(
                image,
                regions,
                style=request.style,
                block_size=request.block_size,
                blur_radius=request.blur_radius,
                sticker_path=request.sticker_path
            )

            base_name = os.path.splitext(image_data["filename"])[0]
            safe_suffix = self._sanitize_suffix(request.filename_suffix)
            ext = os.path.splitext(image_data["filename"])[1] or ".png"
            output_filename = f"{base_name}{safe_suffix}{ext}"
            output_path = self._ensure_output_path(output_folder, output_filename)

            if ext.lower() in ['.jpg', '.jpeg']:
                censored.save(output_path, format='JPEG', quality=95)
            else:
                censored.save(output_path, format='PNG')

            return {
                "status": "ok",
                "output_path": output_path,
                "filename": output_filename
            }
        except Exception:
            raise HTTPException(status_code=500, detail="Save failed")

    def save_data(self, request: CensorSaveDataRequest) -> Dict[str, str]:
        """Save base64 image data directly to disk."""
        from utils.path_validation import validate_folder_path, sanitize_filename

        is_valid, error = validate_folder_path(request.output_folder, allow_create=True)
        if not is_valid:
            raise HTTPException(status_code=400, detail=error or "Invalid output folder")

        output_folder = self._ensure_safe_output_directory(request.output_folder)

        try:
            os.makedirs(output_folder, exist_ok=True)

            image_bytes, _ = self._decode_base64_image(request.image_data)
            image: Image.Image = Image.open(BytesIO(image_bytes))

            safe_filename = sanitize_filename(request.filename)
            base_name = os.path.splitext(safe_filename)[0]
            output_format = self._normalize_output_format(request.output_format)
            ext = f".{output_format}"
            output_filename = f"{base_name}{ext}"
            output_path = self._ensure_output_path(output_folder, output_filename)

            if request.metadata_option == "strip":
                image = self._strip_all_metadata(image)
                save_kwargs = {}
            else:
                save_kwargs = self._prepare_metadata_for_save(
                    image,
                    request.original_image_id,
                    request.metadata_option,
                    output_format
                )

            self._save_image_with_format(image, output_path, output_format, save_kwargs)

            return {
                "status": "ok",
                "output_path": output_path,
                "filename": output_filename
            }
        except Exception:
            raise HTTPException(status_code=500, detail="Save data failed")

    def refine_mask(self, request: MaskRefineRequest) -> Dict[str, Any]:
        """Refine a bounding box into a pixel-precise segmentation mask using SAM3."""
        try:
            from sam3_refiner import get_sam3_refiner
        except Exception:
            raise HTTPException(
                status_code=503,
                detail="SAM3 module unavailable"
            )

        sam3_status = get_model_health()["censor"]["sam3"]
        if not sam3_status["available"]:
            raise HTTPException(
                status_code=503,
                detail=sam3_status["message"]
            )

        image_data = db.get_image_by_id(request.image_id)
        if not image_data:
            raise HTTPException(status_code=404, detail="Image not found")

        image_path = self._ensure_safe_existing_file(image_data["path"])

        try:
            image = Image.open(image_path).convert("RGB")
            refiner = get_sam3_refiner()
            mask = refiner.refine_box(
                image,
                request.box,
                text_prompt=request.text_prompt,
            )

            if mask is None:
                return {
                    "status": "fallback",
                    "message": "SAM3 could not refine this box. Using bounding box.",
                    "mask": None,
                    "box": request.box,
                }

            return {
                "status": "ok",
                "mask": self._encode_mask_image_as_data_url(Image.fromarray(mask * 255, mode="L")),
                "box": request.box,
            }
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc))
        except Exception:
            raise HTTPException(status_code=500, detail="Mask refinement failed")

    def segment_text(self, request: TextSegmentRequest) -> Dict[str, Any]:
        """Segment objects by text description using SAM3."""
        try:
            from sam3_refiner import get_sam3_refiner
        except Exception:
            raise HTTPException(
                status_code=503,
                detail="SAM3 module unavailable"
            )

        sam3_status = get_model_health()["censor"]["sam3"]
        if not sam3_status["available"]:
            raise HTTPException(
                status_code=503,
                detail=sam3_status["message"]
            )

        image_data = db.get_image_by_id(request.image_id)
        if not image_data:
            raise HTTPException(status_code=404, detail="Image not found")

        image_path = self._ensure_safe_existing_file(image_data["path"])

        try:
            image = Image.open(image_path).convert("RGB")
            refiner = get_sam3_refiner()
            mask = refiner.segment_by_text(image, request.text_prompt)

            if mask is None:
                return {
                    "status": "no_match",
                    "message": f"No regions matched text prompt: '{request.text_prompt}'",
                    "mask": None,
                }

            return {
                "status": "ok",
                "mask": self._encode_mask_image_as_data_url(Image.fromarray(mask * 255, mode="L")),
                "text_prompt": request.text_prompt,
            }
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc))
        except Exception:
            raise HTTPException(status_code=500, detail="Text segmentation failed")

    def batch_refine_mask(self, request: "BatchMaskRefineRequest") -> Dict[str, Any]:
        """Run SAM3 mask refinement on multiple images/boxes sequentially."""
        try:
            from sam3_refiner import get_sam3_refiner
        except Exception:
            raise HTTPException(
                status_code=503,
                detail="SAM3 module unavailable"
            )

        sam3_status = get_model_health()["censor"]["sam3"]
        if not sam3_status["available"]:
            raise HTTPException(
                status_code=503,
                detail=sam3_status["message"]
            )

        results: List[Dict[str, Any]] = []
        errors: List[Dict[str, Any]] = []
        refiner = None

        for idx, item in enumerate(request.items):
            try:
                image_data = db.get_image_by_id(item.image_id)
                if not image_data:
                    errors.append({"index": idx, "image_id": item.image_id, "error": "Image not found"})
                    continue

                image_path = self._ensure_safe_existing_file(image_data["path"])
                image = Image.open(image_path).convert("RGB")

                if refiner is None:
                    refiner = get_sam3_refiner()

                mask = refiner.refine_box(
                    image,
                    item.box,
                    text_prompt=item.text_prompt,
                )

                if mask is None:
                    results.append({
                        "index": idx,
                        "image_id": item.image_id,
                        "status": "fallback",
                        "message": "SAM3 could not refine this box. Using bounding box.",
                        "mask": None,
                        "box": item.box,
                    })
                else:
                    results.append({
                        "index": idx,
                        "image_id": item.image_id,
                        "status": "ok",
                        "mask": self._encode_mask_image_as_data_url(Image.fromarray(mask * 255, mode="L")),
                        "box": item.box,
                    })
            except Exception as exc:
                logger.warning("Batch SAM3 refinement failed for item %d (image %d): %s", idx, item.image_id, exc)
                errors.append({"index": idx, "image_id": item.image_id, "error": str(exc)})

        return {
            "status": "ok",
            "total": len(request.items),
            "completed": len(results),
            "failed": len(errors),
            "results": results,
            "errors": errors,
        }

    def list_models(self) -> Dict[str, Any]:
        """List available detection backends and their status."""
        health = get_model_health()["censor"]
        legacy = health["legacy"]
        nudenet = health["nudenet"]
        sam3 = health["sam3"]

        models = [
            {
                "id": "legacy",
                "name": "Legacy YOLO",
                "description": "Uses the built-in local YOLO model from models/yolo. The recommended file is the privacy-part detector; generic YOLO26/YOLOv8 files are listed for compatibility tests only.",
                "available": legacy["available"],
                "requires_model_path": False,
                "recommended": legacy["available"] and legacy.get("privacy_model_count", 0) > 0,
                "default_model_path": legacy["default_model_path"],
                "message": legacy["message"],
                "files": legacy["files"],
                "has_yolo26": legacy["has_yolo26"],
                "has_yolov8s": legacy["has_yolov8s"],
                "privacy_model_count": legacy.get("privacy_model_count", 0),
                "general_model_count": legacy.get("general_model_count", 0),
                "simple_user_advice": legacy.get("simple_user_advice"),
                "advanced_user_advice": legacy.get("advanced_user_advice"),
                "capabilities": {
                    "input_mode_label": "Fixed built-in model classes",
                    "output_mode_label": "Model-dependent legacy detection",
                    "supports_text_prompt": False,
                    "supports_mask_output": any(
                        bool((file_info.get("capabilities") or {}).get("supports_mask_output"))
                        for file_info in legacy.get("files", [])
                    ),
                },
            },
            {
                "id": "nudenet",
                "name": "NudeNet v3",
                "description": "Recommended for NSFW region detection. No manual model path required.",
                "available": nudenet["available"],
                "requires_model_path": False,
                "recommended": nudenet["available"],
                "message": nudenet["message"],
                "model_path": nudenet["model_path"],
                "capabilities": nudenet.get("capabilities", {}),
            },
            {
                "id": "sam3",
                "name": "SAM 3",
                "description": "Used after detection to refine masks or segment by text prompt.",
                "available": sam3["available"],
                "requires_model_path": False,
                "recommended": sam3["available"],
                "message": sam3["message"],
                "checkpoint_path": sam3["checkpoint_path"],
                "missing_dependencies": sam3["missing_dependencies"],
                "capabilities": sam3.get("capabilities", {}),
            },
        ]

        return {
            "status": "ok",
            "models": models,
            "recommended_backend": (
                "both"
                if nudenet["available"] and legacy["available"] and legacy.get("privacy_model_count", 0) > 0
                else ("nudenet" if nudenet["available"] else ("legacy" if legacy["available"] else None))
            ),
        }

    @staticmethod
    def _resolve_legacy_model_path(requested_path: str, *, allowed_base: str) -> str:
        """Pick a safe legacy YOLO path, falling back to the built-in default."""
        from utils.path_validation import ALLOWED_MODEL_EXTENSIONS, validate_file_path

        normalized = str(requested_path or "").strip()
        if normalized:
            is_valid, error = validate_file_path(
                normalized,
                ALLOWED_MODEL_EXTENSIONS,
                allowed_base=allowed_base,
            )
            if not is_valid:
                raise HTTPException(status_code=400, detail=error or "Invalid model path")
            return str(Path(os.path.abspath(normalized)))

        default_model_path = get_default_legacy_model_path()
        if default_model_path:
            return default_model_path

        raise HTTPException(
            status_code=503,
            detail="No local legacy YOLO model was found in models/yolo. Download one there or switch to NudeNet.",
        )

    @staticmethod
    def _decode_base64_image(image_data: str) -> tuple:
        """Decode base64 image data into image bytes."""
        if ',' in image_data:
            _, data = image_data.split(',', 1)
        else:
            data = image_data
        try:
            image_bytes = base64.b64decode(data, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise HTTPException(status_code=400, detail="Invalid image data") from exc
        if not image_bytes:
            raise HTTPException(status_code=400, detail="Invalid image data")
        return image_bytes, data

    @staticmethod
    def _strip_all_metadata(image: Image.Image) -> Image.Image:
        """Strip all metadata by creating a clean copy."""
        clean_image = Image.new(image.mode, image.size)
        clean_image.putdata(list(image.getdata()))
        return clean_image

    @staticmethod
    def _png_text_to_exif(original_img: Image.Image) -> Optional[bytes]:
        """Convert PNG text chunks to EXIF UserComment for non-PNG formats.

        Priority: 'parameters' (WebUI/A1111), then 'prompt' (ComfyUI).
        """
        text_chunks = {}
        for key, value in original_img.info.items():
            if isinstance(key, str) and isinstance(value, str) and key not in {
                'exif', 'icc_profile', 'dpi', 'interlace', 'gamma', 'chromaticity',
            }:
                text_chunks[key] = value

        if not text_chunks:
            return None

        comment = text_chunks.get('parameters') or text_chunks.get('prompt', '')
        if not comment:
            return None

        try:
            import struct
            ascii_prefix = b'ASCII\x00\x00\x00'
            encoded = comment.encode('utf-8', errors='replace')
            user_comment = ascii_prefix + encoded

            # Build a minimal EXIF with UserComment (tag 0x9286) in Exif IFD
            # Header: "Exif\0\0" + TIFF header (little-endian)
            bo = b'II'  # little-endian
            tiff_header = bo + struct.pack('<H', 42) + struct.pack('<I', 8)

            # IFD0: one entry pointing to Exif IFD
            ifd0_count = struct.pack('<H', 1)
            # Tag 0x8769 (ExifIFD), type LONG(4), count 1, value = offset to Exif IFD
            exif_ifd_offset_placeholder = 8 + 2 + 12 + 4  # after IFD0
            ifd0_entry = struct.pack('<HHI', 0x8769, 4, 1) + struct.pack('<I', exif_ifd_offset_placeholder)
            ifd0_next = struct.pack('<I', 0)

            # Exif IFD: one entry for UserComment
            exif_ifd_count = struct.pack('<H', 1)
            uc_data_offset = exif_ifd_offset_placeholder + 2 + 12 + 4
            exif_ifd_entry = struct.pack('<HHI', 0x9286, 7, len(user_comment)) + struct.pack('<I', uc_data_offset)
            exif_ifd_next = struct.pack('<I', 0)

            tiff_body = (ifd0_count + ifd0_entry + ifd0_next +
                         exif_ifd_count + exif_ifd_entry + exif_ifd_next +
                         user_comment)

            exif_bytes = b'Exif\x00\x00' + tiff_header + tiff_body
            return exif_bytes
        except Exception as e:
            logger.warning("Failed to build EXIF from PNG text chunks: %s", e)
            return None

    @staticmethod
    def _copy_png_text_metadata(original_img: Image.Image) -> Optional[PngImagePlugin.PngInfo]:
        """Copy PNG text metadata chunks from original image."""
        pnginfo = PngImagePlugin.PngInfo()
        has_text = False

        skip_keys = {'exif', 'icc_profile', 'dpi', 'interlace', 'gamma', 'chromaticity'}

        for key, value in original_img.info.items():
            if not isinstance(key, str):
                continue
            if key in skip_keys:
                continue

            if isinstance(value, str):
                try:
                    pnginfo.add_text(key, value)
                    has_text = True
                except Exception as e:
                    logger.warning("Could not add text chunk %s: %s", key, e)
            elif isinstance(value, bytes):
                for encoding in ['utf-8', 'latin-1']:
                    try:
                        decoded = value.decode(encoding)
                        pnginfo.add_text(key, decoded)
                        has_text = True
                        break
                    except (UnicodeDecodeError, AttributeError):
                        continue

        return pnginfo if has_text else None

    def _prepare_metadata_for_save(
        self,
        image: Image.Image,
        original_image_id: Optional[int],
        metadata_option: str,
        output_format: str
    ) -> dict:
        """Prepare save kwargs with metadata based on options."""
        save_kwargs = {}

        if metadata_option == "strip":
            return save_kwargs

        if metadata_option not in {"keep", "minimal"} or not original_image_id:
            return save_kwargs

        original_image_data = db.get_image_by_id(original_image_id)
        if not original_image_data:
            return save_kwargs

        try:
            original_img = Image.open(self._ensure_safe_existing_file(original_image_data["path"]))

            if 'icc_profile' in original_img.info:
                save_kwargs['icc_profile'] = original_img.info['icc_profile']

            if 'dpi' in original_img.info:
                save_kwargs['dpi'] = original_img.info['dpi']

            if metadata_option == "keep" and 'exif' in original_img.info:
                save_kwargs['exif'] = original_img.info['exif']

            if metadata_option == "keep" and output_format == 'png':
                pnginfo = self._copy_png_text_metadata(original_img)
                if pnginfo:
                    save_kwargs['pnginfo'] = pnginfo

            # For non-PNG outputs, convert PNG text chunks to EXIF so SD
            # metadata survives the format change.  Many SD tools read
            # the "parameters" key from EXIF UserComment.
            if metadata_option == "keep" and output_format != 'png' and 'exif' not in save_kwargs:
                exif_bytes = self._png_text_to_exif(original_img)
                if exif_bytes:
                    save_kwargs['exif'] = exif_bytes

        except Exception as e:
            logger.warning("Could not copy metadata from original: %s", e)

        return save_kwargs

    @staticmethod
    def _save_image_with_format(
        image: Image.Image,
        output_path: str,
        output_format: str,
        save_kwargs: dict
    ) -> None:
        """Save image in the specified format."""
        if output_format == 'webp':
            webp_kwargs = {k: v for k, v in save_kwargs.items() if k in ['exif', 'icc_profile']}
            image.save(output_path, format='WEBP', quality=95, **webp_kwargs)
        elif output_format in ['jpg', 'jpeg']:
            if image.mode == 'RGBA':
                image = image.convert('RGB')
            jpeg_kwargs = {k: v for k, v in save_kwargs.items() if k in ['exif', 'icc_profile', 'dpi']}
            image.save(output_path, format='JPEG', quality=95, **jpeg_kwargs)
        else:
            png_kwargs = {k: v for k, v in save_kwargs.items() if k in ['pnginfo', 'dpi', 'icc_profile']}
            image.save(output_path, format='PNG', **png_kwargs)
