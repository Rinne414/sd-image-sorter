"""
Censor service for SD Image Sorter.

Handles business logic for NSFW detection, censoring preview, and save operations.
"""
import logging
import os
import base64
import binascii
import threading
import time
import traceback
import uuid
from typing import Optional, List, Dict, Any
from pathlib import Path
from io import BytesIO

from fastapi import HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field, field_validator
from PIL import Image, ImageDraw, PngImagePlugin, ImageEnhance, ImageFilter, ImageColor, ImageChops

import database as db
from config import get_temp_dir
from model_health import get_default_legacy_model_path, get_model_health
from services.indexed_file_mutation_service import save_and_reconcile_checked
from utils.source_paths import resolve_existing_indexed_image_path

logger = logging.getLogger(__name__)
MAX_SAVE_DATA_BYTES = 40 * 1024 * 1024
MAX_SAVE_DATA_PIXELS = 40_000_000
MASK_INLINE_DATA_PIXEL_THRESHOLD = 8_000_000
MASK_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60
MASK_CACHE_DIR = Path(get_temp_dir()) / "censor_mask_cache"
MAX_EDIT_OPERATION_COUNT = 5000
MAX_EDIT_STROKE_POINTS = 250_000
MAX_EDIT_GEOMETRY_POINTS = 250_000
MAX_INLINE_OPERATION_MASK_BYTES = 12 * 1024 * 1024
MAX_INLINE_OPERATION_MASK_PIXELS = 12_000_000
MAX_FULL_IMAGE_FILTER_PIXELS = 45_000_000
MAX_SERVER_EDIT_CANVAS_PIXELS = 80_000_000


def _paths_match_runtime_case(candidate: Path, resolved: Path) -> bool:
    """Treat Windows case normalization as the same path for symlink checks."""
    return os.path.normcase(str(candidate)) == os.path.normcase(str(resolved))


class CensorDetectRequest(BaseModel):
    """Request model for detection."""
    image_id: int = Field(..., ge=1)
    model_path: str = ""
    model_type: str = Field("legacy", pattern="^(legacy|nudenet|sam3|both)$")
    confidence_threshold: float = Field(0.5, ge=0.0, le=1.0)
    exposed_only: bool = True
    target_classes: Optional[List[str]] = None
    text_prompts: Optional[List[str]] = None


class MaskRefineRequest(BaseModel):
    """Request model for mask refinement."""
    image_id: int = Field(..., ge=1)
    box: List[int] = Field(..., min_length=4, max_length=4)
    text_prompt: Optional[str] = None
    # SAM3 confidence gate for this refinement (mask-score floor; also the
    # presence gate when a text prompt is given). None -> the refiner's
    # built-in defaults on the single endpoint, or the batch-level
    # ``sam3_confidence`` when nested inside a BatchMaskRefineRequest.
    sam3_confidence: Optional[float] = Field(None, ge=0.0, le=1.0)


class TextSegmentRequest(BaseModel):
    """Request model for text segmentation."""
    image_id: int = Field(..., ge=1)
    text_prompt: str = Field(..., min_length=1)
    # Optional override for SAM3's presence gate. Omitted -> the looser
    # explicit-text default (decoupled from the 0.5 auto-detect gate).
    presence_threshold: Optional[float] = Field(None, ge=0.0, le=1.0)


class BatchMaskRefineRequest(BaseModel):
    """Request model for batch mask refinement via SAM3."""
    # No hard cap: batch_refine_mask runs sequentially and GC/empty_cache()s
    # every 4 items, so a large batch is slow but not a crash risk.
    items: List[MaskRefineRequest] = Field(..., min_length=1)
    # Confidence gate applied to every item that doesn't set its own
    # ``sam3_confidence``. The frontend slider (sidebar + detect modal)
    # sends this on every batch refine.
    sam3_confidence: float = Field(0.5, ge=0.0, le=1.0)


class CensorApplyRequest(BaseModel):
    """Request model for censor apply/preview."""
    image_id: int = Field(..., ge=1)
    regions: List[List[int]] = Field(..., min_length=1)
    style: str = Field("mosaic", pattern="^(mosaic|blur|solid|black_bar|white_bar|sticker)$")
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
    style: str = Field("mosaic", pattern="^(mosaic|blur|solid|black_bar|white_bar|sticker)$")
    block_size: int = Field(16, ge=1)
    blur_radius: int = Field(20, ge=1)
    sticker_path: Optional[str] = None
    output_folder: str = Field(..., min_length=1)
    filename_suffix: str = "_censored"
    allow_overwrite: bool = False

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
    allow_overwrite: bool = False


class CensorSaveOperationsRequest(BaseModel):
    """Request to save non-destructive edit operations on top of the original image."""
    original_image_id: int = Field(..., ge=1)
    operations: List[Dict[str, Any]] = Field(default_factory=list, max_length=MAX_EDIT_OPERATION_COUNT)
    filename: str = Field(..., min_length=1)
    output_folder: str = Field(..., min_length=1)
    metadata_option: str = Field("keep", pattern="^(keep|minimal|strip)$")
    output_format: str = Field("png", pattern="^(png|jpg|jpeg|webp)$")
    allow_overwrite: bool = False


class CensorService:
    """Service for NSFW detection and image censoring."""

    _mask_cache_lock = threading.Lock()
    _mask_cache_index: Dict[str, Dict[str, Any]] = {}
    _mask_cache_dir = MASK_CACHE_DIR

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
    def _mask_image_to_png_bytes(mask_image: Image.Image) -> bytes:
        normalized = mask_image.convert("L")
        rgba_mask = Image.new("RGBA", normalized.size, (255, 255, 255, 0))
        rgba_mask.putalpha(normalized)
        buffer = BytesIO()
        rgba_mask.save(buffer, format="PNG")
        return buffer.getvalue()

    @classmethod
    def _ensure_mask_cache_dir(cls) -> Path:
        cls._mask_cache_dir.mkdir(parents=True, exist_ok=True)
        return cls._mask_cache_dir

    @classmethod
    def _cleanup_mask_cache(cls) -> None:
        cutoff = time.time() - MASK_CACHE_TTL_SECONDS
        stale_entries: List[Dict[str, Any]] = []
        with cls._mask_cache_lock:
            stale_tokens = []
            for mask_ref, entry in cls._mask_cache_index.items():
                last_accessed_at = float(entry.get("last_accessed_at", entry.get("created_at", 0)))
                path = Path(entry.get("path", ""))
                if last_accessed_at < cutoff or not path.exists():
                    stale_tokens.append(mask_ref)
            for mask_ref in stale_tokens:
                entry = cls._mask_cache_index.pop(mask_ref, None)
                if entry:
                    stale_entries.append(entry)

        for entry in stale_entries:
            try:
                Path(entry["path"]).unlink(missing_ok=True)
            except OSError:
                logger.debug("Failed to remove stale cached mask %s", entry.get("path"), exc_info=True)

    @staticmethod
    def _normalize_mask_bounds(
        bounds: Any,
        *,
        image_size: Optional[tuple[int, int]] = None,
    ) -> Optional[tuple[int, int, int, int]]:
        if not isinstance(bounds, (list, tuple)) or len(bounds) != 4:
            return None
        try:
            x1, y1, x2, y2 = [int(float(value)) for value in bounds]
        except (TypeError, ValueError):
            return None

        if image_size:
            width, height = image_size
            x1 = max(0, min(width, x1))
            y1 = max(0, min(height, y1))
            x2 = max(0, min(width, x2))
            y2 = max(0, min(height, y2))

        if x2 <= x1 or y2 <= y1:
            return None
        return x1, y1, x2, y2

    @classmethod
    def _cache_mask_image(cls, mask_image: Image.Image) -> Optional[Dict[str, Any]]:
        normalized = mask_image.convert("L")
        bbox = normalized.getbbox()
        if bbox is None:
            return None

        bounds = cls._normalize_mask_bounds(bbox, image_size=normalized.size)
        if bounds is None:
            return None

        cls._ensure_mask_cache_dir()
        cls._cleanup_mask_cache()

        x1, y1, x2, y2 = bounds
        cropped = normalized.crop(bounds)
        mask_ref = uuid.uuid4().hex
        mask_path = cls._mask_cache_dir / f"{mask_ref}.png"
        cropped.save(mask_path, format="PNG", optimize=True)

        now = time.time()
        with cls._mask_cache_lock:
            cls._mask_cache_index[mask_ref] = {
                "path": str(mask_path),
                "bounds": [x1, y1, x2, y2],
                "image_width": normalized.width,
                "image_height": normalized.height,
                "created_at": now,
                "last_accessed_at": now,
            }

        return {
            "mask_ref": mask_ref,
            "mask_bounds": [x1, y1, x2, y2],
            "image_width": normalized.width,
            "image_height": normalized.height,
        }

    @classmethod
    def _get_cached_mask_entry(cls, mask_ref: str) -> Dict[str, Any]:
        token = str(mask_ref or "").strip()
        if not token:
            raise HTTPException(status_code=400, detail="Mask reference is required")

        cls._cleanup_mask_cache()
        with cls._mask_cache_lock:
            entry = cls._mask_cache_index.get(token)
            if entry:
                entry["last_accessed_at"] = time.time()
                resolved = dict(entry)
            else:
                resolved = None

        if not resolved:
            raise HTTPException(status_code=404, detail="Cached mask not found")
        if not Path(resolved["path"]).exists():
            with cls._mask_cache_lock:
                cls._mask_cache_index.pop(token, None)
            raise HTTPException(status_code=404, detail="Cached mask file no longer exists")
        return resolved

    @classmethod
    def _build_mask_payload(cls, mask_image: Image.Image) -> Dict[str, Any]:
        normalized = mask_image.convert("L")
        payload: Dict[str, Any] = {
            "mask": None,
            "mask_ref": None,
            "mask_bounds": None,
            "image_width": normalized.width,
            "image_height": normalized.height,
        }
        bbox = normalized.getbbox()
        if bbox is None:
            payload["mask"] = cls._encode_mask_image_as_data_url(normalized)
            return payload

        payload["mask_bounds"] = [int(value) for value in bbox]
        if normalized.width * normalized.height <= MASK_INLINE_DATA_PIXEL_THRESHOLD:
            payload["mask"] = cls._encode_mask_image_as_data_url(normalized)
            return payload

        cached = cls._cache_mask_image(normalized)
        if cached:
            payload.update(cached)
        else:
            payload["mask"] = cls._encode_mask_image_as_data_url(normalized)
        return payload

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
    def _build_combined_mask_image(
        image_size: tuple[int, int],
        detections: List[Dict[str, Any]],
        *,
        include_boxes: bool = False,
    ) -> Optional[Image.Image]:
        if not detections:
            return None

        mask_image = Image.new("L", image_size, 0)
        draw = ImageDraw.Draw(mask_image)
        drew_any = False

        for detection in detections:
            raw_mask = detection.get("mask")
            if raw_mask is not None:
                try:
                    import numpy as np
                    arr = np.asarray(raw_mask)
                    if arr.ndim == 2 and arr.shape[0] > 0 and arr.shape[1] > 0:
                        mask_pil = Image.fromarray((arr > 0).astype(np.uint8) * 255, mode="L")
                        if mask_pil.size == image_size:
                            mask_image = Image.composite(
                                Image.new("L", image_size, 255),
                                mask_image,
                                mask_pil,
                            )
                            drew_any = True
                            continue
                        else:
                            mask_pil = mask_pil.resize(image_size, Image.NEAREST)
                            mask_image = Image.composite(
                                Image.new("L", image_size, 255),
                                mask_image,
                                mask_pil,
                            )
                            drew_any = True
                            continue
                except Exception:
                    logger.warning(
                        "censor: failed to composite detection mask (label=%s); "
                        "falling back to polygon/box",
                        detection.get("label") or detection.get("class_name"),
                        exc_info=True,
                    )

            polygon = detection.get("polygon")
            if isinstance(polygon, list):
                points = [
                    (float(point[0]), float(point[1]))
                    for point in polygon
                    if isinstance(point, (list, tuple)) and len(point) >= 2
                ]
                if len(points) >= 3:
                    draw.polygon(points, fill=255)
                    drew_any = True
                    continue

            if include_boxes:
                box = detection.get("box")
                if isinstance(box, list) and len(box) == 4:
                    x1, y1, x2, y2 = [int(float(value)) for value in box]
                    draw.rectangle([x1, y1, x2, y2], fill=255)
                    drew_any = True

        if not drew_any or mask_image.getbbox() is None:
            return None
        return mask_image

    @classmethod
    def _build_combined_mask_payload(
        cls,
        image_size: tuple[int, int],
        detections: List[Dict[str, Any]],
        *,
        include_boxes: bool = False,
    ) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "combined_mask": None,
            "combined_mask_ref": None,
            "combined_mask_bounds": None,
            "image_width": int(image_size[0]),
            "image_height": int(image_size[1]),
        }
        mask_image = cls._build_combined_mask_image(
            image_size,
            detections,
            include_boxes=include_boxes,
        )
        if mask_image is None:
            return payload

        mask_payload = cls._build_mask_payload(mask_image)
        payload["combined_mask"] = mask_payload.get("mask")
        payload["combined_mask_ref"] = mask_payload.get("mask_ref")
        payload["combined_mask_bounds"] = mask_payload.get("mask_bounds")
        payload["image_width"] = int(mask_payload.get("image_width") or image_size[0])
        payload["image_height"] = int(mask_payload.get("image_height") or image_size[1])
        return payload

    @classmethod
    def _build_combined_mask_data_url(
        cls,
        image_size: tuple[int, int],
        detections: List[Dict[str, Any]],
        *,
        include_boxes: bool = False,
    ) -> Optional[str]:
        mask_image = cls._build_combined_mask_image(
            image_size,
            detections,
            include_boxes=include_boxes,
        )
        if mask_image is None:
            return None
        return cls._encode_mask_image_as_data_url(mask_image)

    @staticmethod
    def _has_polygon_geometry(detection: Dict[str, Any]) -> bool:
        if detection.get("mask") is not None:
            return True
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
        resolved_candidate = candidate.resolve(strict=False)
        if candidate.is_symlink() or not _paths_match_runtime_case(candidate, resolved_candidate):
            raise HTTPException(status_code=400, detail="Symlink paths are not allowed")

        if not candidate.exists() or not candidate.is_file():
            raise HTTPException(status_code=404, detail="File not found")

        if allowed_extensions and candidate.suffix.lower() not in allowed_extensions:
            raise HTTPException(status_code=400, detail="File type is not allowed")

        return str(candidate)

    @staticmethod
    def _resolve_source_image_path(
        path: str,
        *,
        image_id: Optional[int] = None,
        action_label: str = "This action",
    ) -> str:
        """Resolve an indexed image path using the same fallback rules as image serving."""
        normalized = str(path or "").strip()
        if not normalized:
            raise HTTPException(
                status_code=404,
                detail="The library entry does not contain a source image path.",
            )

        resolved_path = resolve_existing_indexed_image_path(normalized, backend_file=__file__)
        if resolved_path:
            return CensorService._ensure_safe_existing_file(resolved_path)

        image_prefix = f"Image {image_id}" if image_id else "This image"
        raise HTTPException(
            status_code=404,
            detail=(
                f"{image_prefix} source file is missing on disk. {action_label} needs the original file, "
                f"but the library still points to: {normalized}. The file was probably moved, deleted, "
                "or its drive/folder is not available. Reconnect it and rescan that folder."
            ),
        )

    @staticmethod
    def _ensure_safe_output_directory(path: str) -> str:
        """Validate an output directory and reject symlinks."""
        candidate = Path(os.path.abspath(path))
        resolved_candidate = candidate.resolve(strict=False)
        if candidate.is_symlink() or not _paths_match_runtime_case(candidate, resolved_candidate):
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

    @staticmethod
    def _output_validation_error(message: str) -> HTTPException:
        return HTTPException(status_code=400, detail=message)

    @staticmethod
    def _output_conflict_error(message: str) -> HTTPException:
        return HTTPException(status_code=409, detail=message)

    @staticmethod
    def _save_response(output_path: str, filename: str, *, warnings: Optional[List[str]] = None, target_existed: bool = False) -> Dict[str, Any]:
        indexed_output = db.get_image_by_path(output_path)
        return {
            "status": "ok",
            "output_path": output_path,
            "filename": filename,
            "warnings": warnings or [],
            "overwrote_existing": bool(target_existed),
            "overwrote_indexed_path": bool(indexed_output),
            "reconciled_image_id": int(indexed_output["id"]) if indexed_output else None,
        }

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

        image_path = self._resolve_source_image_path(
            image["path"],
            image_id=request.image_id,
            action_label="Auto Censor",
        )

        try:
            model_type = request.model_type

            if model_type == "sam3":
                from sam3_refiner import get_sam3_refiner
                sam3_health = get_model_health()["censor"]["sam3"]
                if not sam3_health["available"]:
                    raise HTTPException(status_code=503, detail=sam3_health.get("message", "SAM3 is not available"))
                refiner = get_sam3_refiner()
                custom_prompts = None
                if request.text_prompts:
                    custom_prompts = [
                        {"prompt": p.strip(), "class": p.strip()}
                        for p in request.text_prompts if p.strip()
                    ]
                try:
                    with Image.open(image_path) as img:
                        detections = refiner.detect_privacy_regions(
                            img,
                            conf_threshold=request.confidence_threshold,
                            prompts=custom_prompts,
                        )
                except RuntimeError as exc:
                    # SAM3 load / CUDA failures surface the real reason (503),
                    # rather than being masked as a generic 500 "Detection failed".
                    raise HTTPException(status_code=503, detail=str(exc)) from exc

            elif model_type == "nudenet":
                from nudenet_detector import get_nudenet_detector
                detector = get_nudenet_detector()
                try:
                    detections = detector.detect(
                        image_path,
                        conf_threshold=request.confidence_threshold,
                        exposed_only=request.exposed_only,
                    )
                except RuntimeError as exc:
                    raise HTTPException(status_code=422, detail=str(exc)) from exc

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
                combined_mask_payload = self._build_combined_mask_payload(
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
                "combined_mask": combined_mask_payload["combined_mask"],
                "combined_mask_ref": combined_mask_payload["combined_mask_ref"],
                "combined_mask_bounds": combined_mask_payload["combined_mask_bounds"],
                "image_width": combined_mask_payload["image_width"],
                "image_height": combined_mask_payload["image_height"],
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

        image_path = self._resolve_source_image_path(
            image_data["path"],
            image_id=request.image_id,
            action_label="Preview",
        )

        # Validate sticker_path to prevent arbitrary file read
        if request.sticker_path:
            from utils.path_validation import validate_file_path
            is_valid, error = validate_file_path(request.sticker_path, allowed_extensions={'.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'})
            if not is_valid:
                raise HTTPException(status_code=400, detail=error or "Invalid sticker path")

        try:
            with Image.open(image_path) as src:
                image = src.convert('RGB')
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

    def save(self, request: CensorSaveRequest) -> Dict[str, Any]:
        """Apply censoring and save to output folder."""
        from censor import Censor
        from utils.path_validation import validate_folder_path, validate_file_path

        image_data = db.get_image_by_id(request.image_id)
        if not image_data:
            raise HTTPException(status_code=404, detail="Image not found")

        image_path = self._resolve_source_image_path(
            image_data["path"],
            image_id=request.image_id,
            action_label="Saving",
        )

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

            with Image.open(image_path) as src:
                image = src.convert('RGB')
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

            def _write_censored_image(final_output_path: str, _overwrite_requested: bool) -> None:
                if ext.lower() in ['.jpg', '.jpeg']:
                    censored.save(final_output_path, format='JPEG', quality=95)
                else:
                    censored.save(final_output_path, format='PNG')

            write_result = save_and_reconcile_checked(
                output_path,
                _write_censored_image,
                allow_overwrite=request.allow_overwrite,
                backend_file=__file__,
                validation_error_factory=self._output_validation_error,
                conflict_error_factory=self._output_conflict_error,
            )

            return self._save_response(
                output_path,
                output_filename,
                warnings=write_result.warnings,
                target_existed=write_result.target_existed,
            )
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(status_code=500, detail="Save failed")

    def save_data(self, request: CensorSaveDataRequest) -> Dict[str, Any]:
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
            width, height = image.size
            if width <= 0 or height <= 0:
                raise HTTPException(status_code=400, detail="Invalid image data")
            if width * height > MAX_SAVE_DATA_PIXELS:
                raise HTTPException(
                    status_code=413,
                    detail="Image dimensions are too large for canvas save (max 40 megapixels)",
                )

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

            def _write_canvas_save(final_output_path: str, _overwrite_requested: bool) -> None:
                self._save_image_with_format(image, final_output_path, output_format, save_kwargs)

            write_result = save_and_reconcile_checked(
                output_path,
                _write_canvas_save,
                allow_overwrite=request.allow_overwrite,
                backend_file=__file__,
                validation_error_factory=self._output_validation_error,
                conflict_error_factory=self._output_conflict_error,
            )

            return self._save_response(
                output_path,
                output_filename,
                warnings=write_result.warnings,
                target_existed=write_result.target_existed,
            )
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(status_code=500, detail="Save data failed")

    def save_operations(self, request: CensorSaveOperationsRequest) -> Dict[str, Any]:
        """Save original image with non-destructive censor operations applied server-side."""
        from utils.path_validation import validate_folder_path, sanitize_filename

        is_valid, error = validate_folder_path(request.output_folder, allow_create=True)
        if not is_valid:
            raise HTTPException(status_code=400, detail=error or "Invalid output folder")

        image_row = db.get_image_by_id(request.original_image_id)
        if not image_row:
            raise HTTPException(status_code=404, detail="Image not found")

        output_folder = self._ensure_safe_output_directory(request.output_folder)
        source_path = self._resolve_source_image_path(
            image_row["path"],
            image_id=request.original_image_id,
            action_label="Saving edited image",
        )

        try:
            os.makedirs(output_folder, exist_ok=True)

            with Image.open(source_path) as src:
                original_image = src.convert("RGBA")
            width, height = original_image.size
            if width <= 0 or height <= 0:
                raise HTTPException(status_code=400, detail="Invalid source image")
            self._validate_edit_operation_budget(request.operations, image_size=(width, height))

            working_image = original_image.copy()
            self._apply_edit_operations(working_image, original_image, request.operations)

            safe_filename = sanitize_filename(request.filename)
            base_name = os.path.splitext(safe_filename)[0]
            output_format = self._normalize_output_format(request.output_format)
            ext = f".{output_format}"
            output_filename = f"{base_name}{ext}"
            output_path = self._ensure_output_path(output_folder, output_filename)

            if request.metadata_option == "strip":
                image_to_save = self._strip_all_metadata(working_image)
                save_kwargs = {}
            else:
                image_to_save = working_image
                save_kwargs = self._prepare_metadata_for_save(
                    working_image,
                    request.original_image_id,
                    request.metadata_option,
                    output_format,
                )

            def _write_operations_save(final_output_path: str, _overwrite_requested: bool) -> None:
                self._save_image_with_format(image_to_save, final_output_path, output_format, save_kwargs)

            write_result = save_and_reconcile_checked(
                output_path,
                _write_operations_save,
                allow_overwrite=request.allow_overwrite,
                backend_file=__file__,
                validation_error_factory=self._output_validation_error,
                conflict_error_factory=self._output_conflict_error,
            )

            return self._save_response(
                output_path,
                output_filename,
                warnings=write_result.warnings,
                target_existed=write_result.target_existed,
            )
        except HTTPException:
            raise
        except Exception:
            logger.exception("Save operations failed")
            raise HTTPException(status_code=500, detail="Save operations failed")

    @staticmethod
    def _clamp_float(value: Any, minimum: float, maximum: float) -> float:
        try:
            return max(minimum, min(maximum, float(value)))
        except (TypeError, ValueError):
            return minimum

    @staticmethod
    def _normalize_operation_points(points: Any) -> List[tuple[float, float]]:
        normalized: List[tuple[float, float]] = []
        for point in points or []:
            if not isinstance(point, dict):
                continue
            try:
                normalized.append((float(point.get("x")), float(point.get("y"))))
            except (TypeError, ValueError):
                continue
        return normalized

    @staticmethod
    def _count_polygon_points(regions: Any) -> int:
        if not isinstance(regions, list):
            return 0
        total = 0
        for region in regions:
            if not isinstance(region, dict):
                continue
            polygon = region.get("polygon")
            if isinstance(polygon, list):
                total += len(polygon)
        return total

    @classmethod
    def _decode_operation_mask_header(cls, mask_data: str) -> tuple[bytes, str]:
        mask_bytes, _ = cls._decode_base64_image(mask_data)
        if len(mask_bytes) > MAX_INLINE_OPERATION_MASK_BYTES:
            raise HTTPException(
                status_code=413,
                detail="Inline edit mask is too large. Use cached mask refs for large masks.",
            )
        return mask_bytes, mask_data

    @classmethod
    def _validate_edit_operation_budget(
        cls,
        operations: List[Dict[str, Any]],
        *,
        image_size: tuple[int, int],
    ) -> None:
        width, height = image_size
        total_pixels = width * height
        if total_pixels > MAX_SERVER_EDIT_CANVAS_PIXELS:
            raise HTTPException(
                status_code=413,
                detail="Source image is too large for server-side edit saving. Export a smaller version first.",
            )

        stroke_points = 0
        geometry_points = 0
        inline_mask_pixels = 0
        has_full_image_filter = False

        if len(operations or []) > MAX_EDIT_OPERATION_COUNT:
            raise HTTPException(status_code=413, detail="Too many edit operations to save safely")

        for operation in operations or []:
            if not isinstance(operation, dict):
                continue
            kind = str(operation.get("kind") or "").strip().lower()
            if kind == "stroke":
                points = operation.get("points") or []
                if isinstance(points, list):
                    stroke_points += len(points)
            elif kind == "geometry_effect":
                geometry_points += cls._count_polygon_points(operation.get("regions"))
            elif kind == "mask_effect":
                mask_ref = str(operation.get("mask_ref") or "").strip()
                mask_data = str(operation.get("mask_data") or "").strip()
                if mask_ref:
                    entry = cls._get_cached_mask_entry(mask_ref)
                    bounds = cls._normalize_mask_bounds(
                        operation.get("mask_bounds") or entry.get("bounds"),
                        image_size=image_size,
                    )
                    if bounds is None:
                        raise HTTPException(status_code=400, detail="Invalid cached mask bounds")
                    inline_mask_pixels += max(0, bounds[2] - bounds[0]) * max(0, bounds[3] - bounds[1])
                elif mask_data:
                    mask_bytes, _ = cls._decode_operation_mask_header(mask_data)
                    try:
                        with Image.open(BytesIO(mask_bytes)) as mask_image:
                            mask_image.verify()
                            inline_mask_pixels += mask_image.width * mask_image.height
                    except HTTPException:
                        raise
                    except Exception as exc:
                        raise HTTPException(status_code=400, detail="Invalid edit mask data") from exc
            elif kind == "filter":
                has_full_image_filter = True

        if stroke_points > MAX_EDIT_STROKE_POINTS:
            raise HTTPException(
                status_code=413,
                detail=f"Too many brush points to save safely ({stroke_points:,} > {MAX_EDIT_STROKE_POINTS:,})",
            )
        if geometry_points > MAX_EDIT_GEOMETRY_POINTS:
            raise HTTPException(
                status_code=413,
                detail=f"Too many polygon points to save safely ({geometry_points:,} > {MAX_EDIT_GEOMETRY_POINTS:,})",
            )
        if inline_mask_pixels > MAX_INLINE_OPERATION_MASK_PIXELS:
            raise HTTPException(
                status_code=413,
                detail="Edit masks are too large to save inline. Re-run mask refinement so cached mask refs are used.",
            )
        if has_full_image_filter and total_pixels > MAX_FULL_IMAGE_FILTER_PIXELS:
            raise HTTPException(
                status_code=413,
                detail="Full-image filters are too large for server-side saving on this image. Disable the filter or export a smaller version.",
            )

    @staticmethod
    def _draw_stroke_mask(mask: Image.Image, points: List[tuple[float, float]], brush_size: float) -> None:
        if not points:
            return

        width = max(1, int(round(brush_size)))
        draw = ImageDraw.Draw(mask)
        if len(points) == 1:
            x, y = points[0]
            radius = brush_size / 2.0
            draw.ellipse([x - radius, y - radius, x + radius, y + radius], fill=255)
            return

        draw.line(points, fill=255, width=width, joint="curve")
        radius = brush_size / 2.0
        for x, y in (points[0], points[-1]):
            draw.ellipse([x - radius, y - radius, x + radius, y + radius], fill=255)

    @staticmethod
    def _pixelate_image_crop(image: Image.Image, bbox: tuple[int, int, int, int], block_size: int) -> Image.Image:
        crop = image.crop(bbox)
        downscale = max(1, int(block_size))
        small_w = max(1, crop.width // downscale)
        small_h = max(1, crop.height // downscale)
        pixelated = crop.resize((small_w, small_h), Image.Resampling.BILINEAR)
        return pixelated.resize(crop.size, Image.Resampling.NEAREST)

    @staticmethod
    def _build_pen_overlay(size: tuple[int, int], color: str, opacity: float, mask: Image.Image) -> Image.Image:
        rgba = ImageColor.getrgb(color or "#ff0000")
        overlay = Image.new("RGBA", size, (*rgba, 0))
        alpha_mask = mask.point(lambda value: int(value * max(0.0, min(1.0, opacity))))
        overlay.putalpha(alpha_mask)
        return overlay

    @staticmethod
    def _composite_crop_with_mask(
        image: Image.Image,
        effect_crop: Image.Image,
        mask_crop: Image.Image,
        bbox: tuple[int, int, int, int],
    ) -> None:
        base_crop = image.crop(bbox).convert("RGBA")
        composited = Image.composite(effect_crop.convert("RGBA"), base_crop, mask_crop)
        image.paste(composited, bbox)

    @classmethod
    def _apply_mask_crop_style(
        cls,
        image: Image.Image,
        original_image: Image.Image,
        mask_crop: Image.Image,
        bbox: tuple[int, int, int, int],
        *,
        style: str,
        block_size: int,
        blur_radius: int,
        pen_color: str = "#ff0000",
        pen_opacity: float = 1.0,
    ) -> None:
        x1, y1, x2, y2 = [int(value) for value in bbox]
        if x2 <= x1 or y2 <= y1 or mask_crop.getbbox() is None:
            return

        bbox = (x1, y1, x2, y2)
        if mask_crop.size != (x2 - x1, y2 - y1):
            mask_crop = mask_crop.resize((x2 - x1, y2 - y1), Image.Resampling.LANCZOS)
        normalized_style = str(style or "").strip().lower()

        if normalized_style == "pen":
            overlay = cls._build_pen_overlay(mask_crop.size, pen_color, pen_opacity, mask_crop)
            base_crop = image.crop(bbox).convert("RGBA")
            composited = Image.alpha_composite(base_crop, overlay)
            image.paste(composited, bbox)
            return

        if normalized_style == "eraser":
            cls._composite_crop_with_mask(image, original_image.crop(bbox).convert("RGBA"), mask_crop, bbox)
            return

        if normalized_style in {"black_bar", "solid", "black"}:
            effect_crop = Image.new("RGBA", (x2 - x1, y2 - y1), (0, 0, 0, 255))
            cls._composite_crop_with_mask(image, effect_crop, mask_crop, bbox)
            return

        if normalized_style == "white_bar":
            effect_crop = Image.new("RGBA", (x2 - x1, y2 - y1), (255, 255, 255, 255))
            cls._composite_crop_with_mask(image, effect_crop, mask_crop, bbox)
            return

        if normalized_style == "blur":
            effect_crop = image.crop(bbox).filter(ImageFilter.GaussianBlur(radius=max(1, int(round(blur_radius)))))
            cls._composite_crop_with_mask(image, effect_crop.convert("RGBA"), mask_crop, bbox)
            return

        effect_crop = cls._pixelate_image_crop(image, bbox, max(1, int(round(block_size))))
        cls._composite_crop_with_mask(image, effect_crop.convert("RGBA"), mask_crop, bbox)

    @classmethod
    def _apply_mask_style(
        cls,
        image: Image.Image,
        original_image: Image.Image,
        mask: Image.Image,
        *,
        style: str,
        block_size: int,
        blur_radius: int,
        pen_color: str = "#ff0000",
        pen_opacity: float = 1.0,
    ) -> None:
        bbox = mask.getbbox()
        if not bbox:
            return

        x1, y1, x2, y2 = [int(value) for value in bbox]
        bbox = (x1, y1, x2, y2)
        mask_crop = mask.crop(bbox)
        cls._apply_mask_crop_style(
            image,
            original_image,
            mask_crop,
            bbox,
            style=style,
            block_size=block_size,
            blur_radius=blur_radius,
            pen_color=pen_color,
            pen_opacity=pen_opacity,
        )

    @classmethod
    def _apply_clone_operation(
        cls,
        image: Image.Image,
        original_image: Image.Image,
        *,
        points: List[tuple[float, float]],
        brush_size: float,
        clone_offset: Dict[str, Any],
    ) -> None:
        if not points:
            return

        diameter = max(1, int(round(brush_size)))
        mask = Image.new("L", (diameter, diameter), 0)
        ImageDraw.Draw(mask).ellipse([0, 0, diameter - 1, diameter - 1], fill=255)
        offset_x = float(clone_offset.get("x", 0))
        offset_y = float(clone_offset.get("y", 0))

        for x, y in points:
            src_x = int(round(x + offset_x))
            src_y = int(round(y + offset_y))
            dst_x = int(round(x))
            dst_y = int(round(y))
            source_patch = original_image.crop((
                src_x - diameter // 2,
                src_y - diameter // 2,
                src_x - diameter // 2 + diameter,
                src_y - diameter // 2 + diameter,
            )).convert("RGBA")
            image.paste(
                source_patch,
                (dst_x - diameter // 2, dst_y - diameter // 2),
                mask,
            )

    @classmethod
    def _apply_stroke_operation(
        cls,
        image: Image.Image,
        original_image: Image.Image,
        operation: Dict[str, Any],
    ) -> None:
        tool = str(operation.get("tool") or "brush").strip().lower()
        points = cls._normalize_operation_points(operation.get("points"))
        if not points:
            return

        brush_size = cls._clamp_float(operation.get("brush_size", 1), 1.0, 4096.0)
        if tool == "clone":
            clone_offset = operation.get("clone_offset") or {}
            cls._apply_clone_operation(
                image,
                original_image,
                points=points,
                brush_size=brush_size,
                clone_offset=clone_offset,
            )
            return

        mask = Image.new("L", image.size, 0)
        cls._draw_stroke_mask(mask, points, brush_size)
        cls._apply_mask_style(
            image,
            original_image,
            mask,
            style=operation.get("style") if tool == "brush" else tool,
            block_size=int(operation.get("block_size", 16) or 16),
            blur_radius=int(operation.get("blur_radius", 20) or 20),
            pen_color=str(operation.get("pen_color") or "#ff0000"),
            pen_opacity=cls._clamp_float(operation.get("pen_opacity", 1.0), 0.0, 1.0),
        )

    @classmethod
    def _apply_geometry_effect_operation(
        cls,
        image: Image.Image,
        original_image: Image.Image,
        operation: Dict[str, Any],
    ) -> None:
        regions = operation.get("regions") or []
        if not isinstance(regions, list) or not regions:
            return

        polygon_mask = Image.new("L", image.size, 0)
        polygon_draw = ImageDraw.Draw(polygon_mask)
        box_regions: List[List[int]] = []

        for region in regions:
            if not isinstance(region, dict):
                continue
            polygon = region.get("polygon")
            if isinstance(polygon, list):
                points = [
                    (float(point[0]), float(point[1]))
                    for point in polygon
                    if isinstance(point, (list, tuple)) and len(point) >= 2
                ]
                if len(points) >= 3:
                    polygon_draw.polygon(points, fill=255)
                    continue

            box = region.get("box")
            if isinstance(box, list) and len(box) == 4:
                box_regions.append([int(float(value)) for value in box])

        cls._apply_mask_style(
            image,
            original_image,
            polygon_mask,
            style=str(operation.get("style") or "mosaic"),
            block_size=int(operation.get("block_size", 16) or 16),
            blur_radius=int(operation.get("blur_radius", 20) or 20),
        )

        if box_regions:
            mask = Image.new("L", image.size, 0)
            draw = ImageDraw.Draw(mask)
            for x1, y1, x2, y2 in box_regions:
                draw.rectangle([x1, y1, x2, y2], fill=255)
            cls._apply_mask_style(
                image,
                original_image,
                mask,
                style=str(operation.get("style") or "mosaic"),
                block_size=int(operation.get("block_size", 16) or 16),
                blur_radius=int(operation.get("blur_radius", 20) or 20),
            )

    @classmethod
    def _apply_mask_effect_operation(
        cls,
        image: Image.Image,
        original_image: Image.Image,
        operation: Dict[str, Any],
    ) -> None:
        mask_data = str(operation.get("mask_data") or "").strip()
        mask_ref = str(operation.get("mask_ref") or "").strip()
        alpha: Optional[Image.Image] = None

        if mask_ref:
            entry = cls._get_cached_mask_entry(mask_ref)
            bounds = cls._normalize_mask_bounds(
                operation.get("mask_bounds") or entry.get("bounds"),
                image_size=image.size,
            )
            if bounds is None:
                raise HTTPException(status_code=400, detail="Invalid cached mask bounds")

            crop_path = Path(entry["path"])
            with Image.open(crop_path) as cached_mask_src:
                crop_mask = cached_mask_src.convert("L")
            expected_size = (bounds[2] - bounds[0], bounds[3] - bounds[1])
            if crop_mask.size != expected_size:
                crop_mask = crop_mask.resize(expected_size, Image.Resampling.LANCZOS)
            cls._apply_mask_crop_style(
                image,
                original_image,
                crop_mask,
                bounds,
                style=str(operation.get("style") or "mosaic"),
                block_size=int(operation.get("block_size", 16) or 16),
                blur_radius=int(operation.get("blur_radius", 20) or 20),
            )
            return
        elif mask_data:
            mask_bytes, _ = cls._decode_operation_mask_header(mask_data)
            mask_image = Image.open(BytesIO(mask_bytes)).convert("RGBA")
            mask_pixels = mask_image.width * mask_image.height
            if mask_pixels > MAX_INLINE_OPERATION_MASK_PIXELS:
                raise HTTPException(
                    status_code=413,
                    detail="Inline edit mask is too large. Use cached mask refs for large masks.",
                )
            alpha = mask_image.getchannel("A") if "A" in mask_image.getbands() else mask_image.convert("L")
            if mask_image.size != image.size:
                alpha = alpha.resize(image.size, Image.Resampling.LANCZOS)

        if alpha is None:
            return

        cls._apply_mask_style(
            image,
            original_image,
            alpha,
            style=str(operation.get("style") or "mosaic"),
            block_size=int(operation.get("block_size", 16) or 16),
            blur_radius=int(operation.get("blur_radius", 20) or 20),
        )

    @staticmethod
    def _apply_hue_rotation(image: Image.Image, degrees: float) -> Image.Image:
        if not degrees:
            return image

        alpha = image.getchannel("A") if "A" in image.getbands() else None
        hsv = image.convert("RGB").convert("HSV")
        h, s, v = hsv.split()
        shift = int(round((degrees / 360.0) * 255)) % 256
        h = h.point(lambda value: (value + shift) % 256)
        rotated = Image.merge("HSV", (h, s, v)).convert("RGBA")
        if alpha is not None:
            rotated.putalpha(alpha)
        return rotated

    @staticmethod
    def _apply_temperature_shift(image: Image.Image, temperature: float) -> Image.Image:
        if not temperature:
            return image

        normalized = max(-100.0, min(100.0, float(temperature))) / 100.0
        overlay_color = (255, 176, 64, int(90 * abs(normalized))) if normalized > 0 else (64, 128, 255, int(90 * abs(normalized)))
        overlay = Image.new("RGBA", image.size, overlay_color)
        return Image.alpha_composite(image.convert("RGBA"), overlay)

    @classmethod
    def _apply_vignette_filter(cls, image: Image.Image, amount: float) -> Image.Image:
        if amount <= 0:
            return image

        width, height = image.size
        inner_mask = Image.new("L", (width, height), 0)
        draw = ImageDraw.Draw(inner_mask)
        inset_ratio = max(0.0, min(1.0, 1 - amount * 0.5))
        inset_x = int((width * (1 - inset_ratio)) / 2)
        inset_y = int((height * (1 - inset_ratio)) / 2)
        draw.ellipse([inset_x, inset_y, width - inset_x, height - inset_y], fill=255)
        blur_radius = max(1, int(max(width, height) * 0.08))
        soft_inner = inner_mask.filter(ImageFilter.GaussianBlur(radius=blur_radius))
        vignette_alpha = ImageChops.invert(soft_inner).point(
            lambda value: int(value * min(1.0, amount * 0.7))
        )
        overlay = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        overlay.putalpha(vignette_alpha)
        return Image.alpha_composite(image.convert("RGBA"), overlay)

    @classmethod
    def _apply_filter_operation(
        cls,
        image: Image.Image,
        operation: Dict[str, Any],
    ) -> Image.Image:
        values = operation.get("values") or {}
        if not isinstance(values, dict):
            return image

        result = image.convert("RGBA")
        brightness = float(values.get("brightness", 0) or 0)
        contrast = float(values.get("contrast", 0) or 0)
        saturation = float(values.get("saturation", 0) or 0)
        hue = float(values.get("hue", 0) or 0)
        blur = float(values.get("blur", 0) or 0)
        sharpen = float(values.get("sharpen", 0) or 0)
        temperature = float(values.get("temperature", 0) or 0)
        vignette = float(values.get("vignette", 0) or 0)

        if brightness:
            result = ImageEnhance.Brightness(result).enhance(1 + brightness / 100.0)
        if contrast:
            result = ImageEnhance.Contrast(result).enhance(1 + contrast / 100.0)
        if saturation:
            result = ImageEnhance.Color(result).enhance(1 + saturation / 100.0)
        if hue:
            result = cls._apply_hue_rotation(result, hue)
        if blur > 0:
            result = result.filter(ImageFilter.GaussianBlur(radius=blur))
        if temperature:
            result = cls._apply_temperature_shift(result, temperature)
        if sharpen > 0:
            result = result.filter(ImageFilter.UnsharpMask(radius=1, percent=max(1, int(sharpen * 3)), threshold=0))
        if vignette > 0:
            result = cls._apply_vignette_filter(result, vignette / 100.0)

        return result

    @classmethod
    def _apply_edit_operations(
        cls,
        image: Image.Image,
        original_image: Image.Image,
        operations: List[Dict[str, Any]],
    ) -> None:
        for operation in operations or []:
            if not isinstance(operation, dict):
                continue

            kind = str(operation.get("kind") or "").strip().lower()
            if kind == "stroke":
                cls._apply_stroke_operation(image, original_image, operation)
            elif kind == "geometry_effect":
                cls._apply_geometry_effect_operation(image, original_image, operation)
            elif kind == "mask_effect":
                cls._apply_mask_effect_operation(image, original_image, operation)
            elif kind == "filter":
                next_image = cls._apply_filter_operation(image, operation)
                image.paste(next_image)

    def get_cached_mask_preview(
        self,
        mask_ref: str,
        width: Optional[int] = None,
        height: Optional[int] = None,
    ):
        entry = self._get_cached_mask_entry(mask_ref)
        mask_path = Path(entry["path"])

        if not width and not height:
            return FileResponse(
                mask_path,
                media_type="image/png",
                headers={"Cache-Control": "public, max-age=3600"},
            )

        with Image.open(mask_path) as mask_file:
            mask_image = mask_file.convert("L")
            target_width = max(1, int(width or 0)) if width else None
            target_height = max(1, int(height or 0)) if height else None
            if target_width and target_height:
                resized = mask_image.resize((target_width, target_height), Image.Resampling.LANCZOS)
            elif target_width:
                resized = mask_image.resize(
                    (target_width, max(1, int(round(mask_image.height * (target_width / mask_image.width))))),
                    Image.Resampling.LANCZOS,
                )
            else:
                resized = mask_image.resize(
                    (max(1, int(round(mask_image.width * (target_height / mask_image.height)))), target_height),
                    Image.Resampling.LANCZOS,
                )

        return StreamingResponse(
            BytesIO(self._mask_image_to_png_bytes(resized)),
            media_type="image/png",
            headers={"Cache-Control": "public, max-age=3600"},
        )

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

        image_path = self._resolve_source_image_path(
            image_data["path"],
            image_id=request.image_id,
            action_label="SAM3 mask refinement",
        )

        try:
            with Image.open(image_path) as src:
                image = src.convert("RGB")
            refiner = get_sam3_refiner()
            mask = refiner.refine_box(
                image,
                request.box,
                text_prompt=request.text_prompt,
                confidence_threshold=request.sam3_confidence,
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
                **self._build_mask_payload(Image.fromarray(mask * 255, mode="L")),
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

        image_path = self._resolve_source_image_path(
            image_data["path"],
            image_id=request.image_id,
            action_label="Text segmentation",
        )

        try:
            with Image.open(image_path) as src:
                image = src.convert("RGB")
            refiner = get_sam3_refiner()
            mask = refiner.segment_by_text(
                image,
                request.text_prompt,
                presence_threshold=request.presence_threshold,
            )

            if mask is None:
                return {
                    "status": "no_match",
                    "message": f"No regions matched text prompt: '{request.text_prompt}'",
                    "mask": None,
                }

            return {
                "status": "ok",
                **self._build_mask_payload(Image.fromarray(mask * 255, mode="L")),
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

                image_path = self._resolve_source_image_path(
                    image_data["path"],
                    image_id=item.image_id,
                    action_label="SAM3 batch refinement",
                )
                with Image.open(image_path) as src:
                    image = src.convert("RGB")

                if refiner is None:
                    refiner = get_sam3_refiner()

                # Per-item confidence wins; otherwise the batch-level slider
                # value gates how confident SAM3 must be before a box is
                # accepted as a refined mask (low-confidence -> "fallback").
                item_confidence = (
                    item.sam3_confidence
                    if item.sam3_confidence is not None
                    else request.sam3_confidence
                )
                mask = refiner.refine_box(
                    image,
                    item.box,
                    text_prompt=item.text_prompt,
                    confidence_threshold=item_confidence,
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
                        **self._build_mask_payload(Image.fromarray(mask * 255, mode="L")),
                        "box": item.box,
                    })
            except Exception as exc:
                logger.warning("Batch SAM3 refinement failed for item %d (image %d): %s", idx, item.image_id, exc)
                errors.append({"index": idx, "image_id": item.image_id, "error": str(exc)})
            finally:
                if (idx + 1) % 4 == 0:
                    import gc as _gc
                    _gc.collect()
                    try:
                        import torch as _torch
                        if _torch.cuda.is_available():
                            _torch.cuda.empty_cache()
                    except Exception:
                        pass

        refined = sum(1 for r in results if r.get("status") == "ok")
        return {
            "status": "ok",
            "total": len(request.items),
            "completed": len(results),
            # `completed` = boxes that ran (ok + fallback). Split it out so the UI
            # doesn't report SAM3-could-not-refine fallbacks as real refinements.
            "refined": refined,
            "fallback": len(results) - refined,
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
        if len(image_bytes) > MAX_SAVE_DATA_BYTES:
            raise HTTPException(
                status_code=413,
                detail="Canvas image data is too large to save (max 40MB)",
            )
        return image_bytes, data

    @staticmethod
    def _strip_all_metadata(image: Image.Image) -> Image.Image:
        """Strip all metadata by creating a clean copy."""
        clean_image = Image.new(image.mode, image.size)
        pixel_data_getter = getattr(image, "get_flattened_data", image.getdata)
        clean_image.putdata(list(pixel_data_getter()))
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
            original_source_path = self._resolve_source_image_path(
                original_image_data["path"],
                image_id=original_image_id,
                action_label="Metadata copy",
            )
            # `.info` is read multiple times below, and `_png_text_to_exif`
            # / `_copy_png_text_metadata` both walk PNG text chunks on the
            # still-open file object. Wrap the whole reader block so the
            # OS handle is released deterministically afterwards (matters
            # on Windows: a leaked handle blocks subsequent move/delete of
            # the source file).
            with Image.open(original_source_path) as original_img:
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
