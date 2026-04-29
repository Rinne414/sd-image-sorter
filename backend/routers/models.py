"""
Unified model inventory + preparation endpoints.

These endpoints back the frontend model manager so users can inspect which
runtime/model assets are ready and trigger first-run downloads explicitly.
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from services.model_service import (
    ExternalAuthRequiredError,
    ModelPreparationFailedError,
    ModelService,
    get_model_service,
)


router = APIRouter(prefix="/api/models", tags=["models"])


class PrepareModelRequest(BaseModel):
    model_id: str = Field(..., min_length=1)
    source: Optional[str] = None
    variant: Optional[str] = None


@router.get("/status")
async def get_models_status(service: ModelService = Depends(get_model_service)):
    return service.get_status()


@router.post("/prepare")
async def prepare_model(
    request: PrepareModelRequest,
    service: ModelService = Depends(get_model_service),
):
    try:
        return service.prepare_model(
            request.model_id,
            source=request.source,
            variant=request.variant,
        )
    except ExternalAuthRequiredError as exc:
        return JSONResponse(status_code=exc.status_code, content=exc.payload)
    except ModelPreparationFailedError as exc:
        return JSONResponse(status_code=exc.status_code, content=exc.payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
