"""Masked-training mask endpoints (Phase 4 mask editor).

Masks are auxiliary trainer inputs (white = train, black = ignore) stored
per gallery image; see ``services/mask_service.py`` for semantics. All
mutation routes validate the image id against the library first.
"""
from typing import List

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

router = APIRouter(prefix="/api", tags=["masks"])


class MaskSaveRequest(BaseModel):
    data_url: str = Field(..., min_length=32)


class MaskStatusRequest(BaseModel):
    image_ids: List[int] = Field(..., min_length=1)


class MaskAutoRequest(BaseModel):
    method: str = Field(default="rembg", max_length=32)


@router.get("/masks/{image_id}")
def get_mask(image_id: int):
    """Stored training mask as PNG; 404 = no mask (train the whole image)."""
    from services import mask_service

    path = mask_service.get_mask_file(image_id)
    if path is None:
        raise HTTPException(404, f"No mask stored for image {image_id}")
    return FileResponse(str(path), media_type="image/png")


@router.put("/masks/{image_id}")
def save_mask(image_id: int, request: MaskSaveRequest):
    """Save a canvas-edited mask (base64 data URL -> grayscale PNG)."""
    from services import mask_service

    try:
        return mask_service.save_mask_from_data_url(image_id, request.data_url)
    except LookupError as exc:
        raise HTTPException(404, str(exc))
    except mask_service.MaskError as exc:
        raise HTTPException(400, str(exc))


@router.delete("/masks/{image_id}")
def delete_mask(image_id: int):
    """Remove the stored mask (the image reverts to fully trained)."""
    from services import mask_service

    removed = mask_service.delete_mask(image_id)
    return {"removed": removed, "image_id": image_id}


@router.post("/masks/status")
def mask_status(request: MaskStatusRequest):
    """Which of these images carry a stored mask (queue badge data)."""
    from services import mask_service

    return {"masks": mask_service.mask_status(request.image_ids)}


@router.post("/masks/{image_id}/auto")
def auto_mask(image_id: int, request: MaskAutoRequest):
    """Generate a subject mask (rembg) for canvas preview — NOT saved until
    the user saves the edited result."""
    from services import mask_service

    try:
        return mask_service.generate_auto_mask(image_id, request.method)
    except LookupError as exc:
        raise HTTPException(404, str(exc))
    except mask_service.MaskError as exc:
        raise HTTPException(400, str(exc))
