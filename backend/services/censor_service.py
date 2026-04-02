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
from pydantic import BaseModel, Field
from PIL import Image, PngImagePlugin

import database as db

logger = logging.getLogger(__name__)


class CensorDetectRequest(BaseModel):
    """Request model for detection."""
    image_id: int
    model_path: str = ""
    model_type: str = "legacy"
    confidence_threshold: float = 0.5
    exposed_only: bool = True


class MaskRefineRequest(BaseModel):
    """Request model for mask refinement."""
    image_id: int
    box: List[int]
    text_prompt: Optional[str] = None


class TextSegmentRequest(BaseModel):
    """Request model for text segmentation."""
    image_id: int
    text_prompt: str


class CensorApplyRequest(BaseModel):
    """Request model for censor apply/preview."""
    image_id: int
    regions: List[List[int]]
    style: str = "mosaic"
    block_size: int = 16
    blur_radius: int = 20
    sticker_path: Optional[str] = None


class CensorSaveRequest(BaseModel):
    """Request model for censor save."""
    image_id: int
    regions: List[List[int]]
    style: str = "mosaic"
    block_size: int = 16
    blur_radius: int = 20
    sticker_path: Optional[str] = None
    output_folder: str
    filename_suffix: str = "_censored"


class CensorSaveDataRequest(BaseModel):
    """Request to save base64 image data directly."""
    image_data: str = Field(..., max_length=100_000_000)  # ~75MB decoded
    filename: str
    output_folder: str
    metadata_option: str = "keep"
    output_format: str = "png"
    original_image_id: Optional[int] = None


class CensorService:
    """Service for NSFW detection and image censoring."""

    def __init__(self):
        """Initialize the censor service."""
        self._detector = None

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
                    from utils.path_validation import validate_file_path, ALLOWED_MODEL_EXTENSIONS
                    from config import PROJECT_ROOT

                    if request.model_path:
                        is_valid, error = validate_file_path(request.model_path, ALLOWED_MODEL_EXTENSIONS, allowed_base=str(PROJECT_ROOT / "models"))
                        if is_valid:
                            if self._detector is None or self._detector.model_path != request.model_path or self._detector.session is None:
                                self._detector = CensorDetector(request.model_path)
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
                from utils.path_validation import validate_file_path, ALLOWED_MODEL_EXTENSIONS
                from config import PROJECT_ROOT

                if not request.model_path:
                    raise HTTPException(
                        status_code=400,
                        detail="model_path is required for legacy detection mode"
                    )

                is_valid, error = validate_file_path(request.model_path, ALLOWED_MODEL_EXTENSIONS, allowed_base=str(PROJECT_ROOT / "models"))
                if not is_valid:
                    raise HTTPException(status_code=400, detail=error or "Invalid model path")

                if self._detector is None or self._detector.model_path != request.model_path or self._detector.session is None:
                    logger.info("Loading censor model: %s", request.model_path)
                    self._detector = CensorDetector(request.model_path)
                    self._detector.load()
                    logger.info("Model loaded successfully")

                detections = self._detector.detect(image_path, request.confidence_threshold)

            # Strip numpy masks from response
            clean_detections = []
            for d in detections:
                clean = {k: v for k, v in d.items() if k != "mask"}
                clean_detections.append(clean)

            return {
                "status": "ok",
                "image_id": request.image_id,
                "model_type": model_type,
                "detections": clean_detections,
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
        from utils.path_validation import ALLOWED_IMAGE_EXTENSIONS, validate_folder_path, validate_file_path

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
            from sam3_refiner import get_sam3_refiner, SAM3Refiner
        except Exception as _sam3_import_err:
            raise HTTPException(
                status_code=503,
                detail="SAM3 module unavailable"
            )

        if not SAM3Refiner.is_available():
            raise HTTPException(
                status_code=503,
                detail="SAM3 is not available."
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

            mask_image = Image.fromarray(mask * 255, mode="L")
            buffer = BytesIO()
            mask_image.save(buffer, format="PNG")
            buffer.seek(0)
            mask_b64 = base64.b64encode(buffer.getvalue()).decode("utf-8")

            return {
                "status": "ok",
                "mask": f"data:image/png;base64,{mask_b64}",
                "box": request.box,
            }
        except Exception:
            raise HTTPException(status_code=500, detail="Mask refinement failed")

    def segment_text(self, request: TextSegmentRequest) -> Dict[str, Any]:
        """Segment objects by text description using SAM3."""
        try:
            from sam3_refiner import get_sam3_refiner, SAM3Refiner
        except Exception as _sam3_import_err:
            raise HTTPException(
                status_code=503,
                detail="SAM3 module unavailable"
            )

        if not SAM3Refiner.is_available():
            raise HTTPException(
                status_code=503,
                detail="SAM3 is not available."
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

            mask_image = Image.fromarray(mask * 255, mode="L")
            buffer = BytesIO()
            mask_image.save(buffer, format="PNG")
            buffer.seek(0)
            mask_b64 = base64.b64encode(buffer.getvalue()).decode("utf-8")

            return {
                "status": "ok",
                "mask": f"data:image/png;base64,{mask_b64}",
                "text_prompt": request.text_prompt,
            }
        except Exception:
            raise HTTPException(status_code=500, detail="Text segmentation failed")

    def list_models(self) -> Dict[str, Any]:
        """List available detection backends and their status."""
        models = []

        models.append({
            "id": "legacy",
            "name": "YOLOv8 ONNX (Legacy)",
            "description": "Original wenaka segmentation model. Requires .onnx model file.",
            "available": True,
            "requires_model_path": True,
        })

        try:
            from nudenet import NudeDetector
            nudenet_available = True
        except ImportError:
            nudenet_available = False

        models.append({
            "id": "nudenet",
            "name": "NudeNet v3",
            "description": "ONNX-based 20-class body part detection. Optimized for NSFW content.",
            "available": nudenet_available,
            "requires_model_path": False,
        })

        try:
            from sam3_refiner import SAM3Refiner
            sam3_available = SAM3Refiner.is_available()
        except Exception:
            sam3_available = False

        models.append({
            "id": "sam3",
            "name": "SAM 3 (Segment Anything with Concepts)",
            "description": "Pixel-precise mask refinement with text-guided segmentation. Requires GPU.",
            "available": sam3_available,
            "requires_model_path": False,
        })

        return {
            "status": "ok",
            "models": models,
        }

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

        if metadata_option != "keep" or not original_image_id:
            return save_kwargs

        original_image_data = db.get_image_by_id(original_image_id)
        if not original_image_data:
            return save_kwargs

        try:
            original_img = Image.open(self._ensure_safe_existing_file(original_image_data["path"]))

            if 'exif' in original_img.info:
                save_kwargs['exif'] = original_img.info['exif']

            if 'icc_profile' in original_img.info:
                save_kwargs['icc_profile'] = original_img.info['icc_profile']

            if 'dpi' in original_img.info:
                save_kwargs['dpi'] = original_img.info['dpi']

            if output_format == 'png':
                pnginfo = self._copy_png_text_metadata(original_img)
                if pnginfo:
                    save_kwargs['pnginfo'] = pnginfo

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
            png_kwargs = {k: v for k, v in save_kwargs.items() if k in ['pnginfo', 'dpi']}
            image.save(output_path, format='PNG', **png_kwargs)
