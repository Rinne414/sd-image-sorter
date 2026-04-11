"""
Censor endpoints for SD Image Sorter.
Handles NSFW detection, censoring preview and save operations.

Supports multiple detection backends:
- Legacy YOLOv8 ONNX (wenaka model)
- NudeNet v3 (NSFW-specific body part detection)
- SAM3 mask refinement (pixel-precise segmentation)

Refactored to use Service Layer pattern with dependency injection.
"""
from typing import Optional

from fastapi import APIRouter, Depends, File, UploadFile, Query

from services.censor_service import (
    CensorService,
    CensorDetectRequest,
    MaskRefineRequest,
    BatchMaskRefineRequest,
    TextSegmentRequest,
    CensorApplyRequest,
    CensorSaveRequest,
    CensorSaveDataRequest,
)


router = APIRouter(prefix="/api/censor", tags=["censor"])

# Service instance - will be set via dependency injection
_censor_service: Optional[CensorService] = None


def get_censor_service() -> CensorService:
    """Dependency injection for CensorService."""
    global _censor_service
    if _censor_service is None:
        _censor_service = CensorService()
    return _censor_service


def set_censor_service(service: CensorService) -> None:
    """Set the censor service instance."""
    global _censor_service
    _censor_service = service


@router.post(
    "/detect",
    summary="Detect regions to censor",
    description="""
Run detection on an image to find regions that may need censoring.

**Supported detection backends:**
- `"legacy"`: Original YOLOv8 ONNX model (requires model_path)
- `"nudenet"`: NudeNet v3 body part detection (recommended for NSFW)
- `"both"`: Run both detectors and merge results

**NudeNet detects 20 body part classes including:**
- `exposed_breasts`, `exposed_buttocks`, `exposed_genitalia`
- `covered_breasts`, `covered_buttocks`, etc.

Use `exposed_only=true` to detect only exposed (not covered) parts.
    """,
    responses={
        200: {
            "description": "Detection results",
            "content": {
                "application/json": {
                    "example": {
                        "status": "ok",
                        "image_id": 1,
                        "model_type": "nudenet",
                        "detections": [
                            {
                                "box": [100, 200, 300, 400],
                                "label": "exposed_breasts",
                                "confidence": 0.89,
                                "source": "nudenet"
                            }
                        ]
                    }
                }
            }
        },
        400: {"description": "Invalid model path for legacy mode"},
        404: {"description": "Image not found"},
        500: {"description": "Detection failed"}
    }
)
async def censor_detect(
    request: CensorDetectRequest,
    service: CensorService = Depends(get_censor_service),
):
    """Run detection on an image to find regions to censor."""
    return service.detect(request)


@router.post(
    "/preview",
    summary="Preview censored image",
    description="""
Apply censoring to specified regions and return a base64-encoded preview image.

**Censoring styles:**
- `mosaic`: Pixelate the region with adjustable block size
- `blur`: Gaussian blur with adjustable radius
- `solid`: Fill with solid color
- `sticker`: Overlay a sticker image

Use this endpoint to preview before saving with `/api/censor/save`.
    """,
    responses={
        200: {
            "description": "Preview image",
            "content": {
                "application/json": {
                    "example": {
                        "status": "ok",
                        "preview": "data:image/jpeg;base64,/9j/4AAQSkZJRg..."
                    }
                }
            }
        },
        404: {"description": "Image not found"},
        500: {"description": "Preview failed"}
    }
)
async def censor_preview(
    request: CensorApplyRequest,
    service: CensorService = Depends(get_censor_service),
):
    """Apply censoring and return base64 preview image."""
    return service.preview(request)


@router.post("/save")
async def censor_save(
    request: CensorSaveRequest,
    service: CensorService = Depends(get_censor_service),
):
    """Apply censoring and save to output folder."""
    return service.save(request)


@router.post("/save-data")
async def censor_save_data(
    request: CensorSaveDataRequest,
    service: CensorService = Depends(get_censor_service),
):
    """
    Save base64 image data directly to disk.
    Used for saving canvas-edited images.
    Supports metadata handling: 'keep' preserves original metadata, 'strip' removes all metadata.
    """
    return service.save_data(request)


@router.post("/refine-mask")
async def refine_mask(
    request: MaskRefineRequest,
    service: CensorService = Depends(get_censor_service),
):
    """
    Refine a bounding box into a pixel-precise segmentation mask using SAM3.

    Takes a detection bounding box and returns a refined binary mask
    that follows the actual contours of the detected region.
    Falls back gracefully if SAM3 is unavailable.
    """
    return service.refine_mask(request)


@router.post("/batch-refine-mask")
async def batch_refine_mask(
    request: BatchMaskRefineRequest,
    service: CensorService = Depends(get_censor_service),
):
    """
    Run SAM3 mask refinement on multiple images/boxes sequentially.

    Processes each item one-by-one through SAM3 (heavy model) but
    presents as a single batch operation. Returns results and errors
    for each item.
    """
    return service.batch_refine_mask(request)


@router.post("/segment-text")
async def segment_text(
    request: TextSegmentRequest,
    service: CensorService = Depends(get_censor_service),
):
    """
    Segment objects by text description using SAM3's open-vocabulary feature.

    Allows users to describe what they want to censor in natural language,
    e.g. "exposed breasts", "person's face", "tattoo on arm".
    """
    return service.segment_text(request)


@router.get("/models")
async def list_models(
    service: CensorService = Depends(get_censor_service),
):
    """
    List available detection backends and their status.

    Returns which detection models are installed and ready to use,
    helping the frontend show appropriate options.
    """
    return service.list_models()
