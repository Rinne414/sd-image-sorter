"""Send to generator: a picture's recipe for WebUI, NovelAI and ComfyUI."""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, HTTPException, Path as FastAPIPath
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

import config
from services import generator_recipe
from services.comfyui_client import (
    DEFAULT_COMFYUI_URL,
    ComfyUIError,
    configured_comfyui_url,
    normalize_comfyui_url,
)

router = APIRouter(prefix="/api", tags=["send-to-generator"])

ImageId = FastAPIPath(..., ge=1, le=2_147_483_647, description="Image ID")


def _not_found() -> HTTPException:
    return HTTPException(
        status_code=404,
        detail={"code": "image_not_found", "message": "Image not found"},
    )


def _comfy_error(error: ComfyUIError) -> HTTPException:
    return HTTPException(
        status_code=error.status_code,
        detail={"code": error.code, "message": error.message, "details": error.details},
    )


@router.get(
    "/images/{image_id}/generator-recipe",
    summary="A picture's recipe for WebUI, NovelAI and ComfyUI",
    description=(
        "WebUI parameters text (the picture's own text for WebUI/Forge pictures), "
        "NovelAI text for NovelAI pictures, and whether the file holds a ComfyUI "
        "run prompt and workflow (the workflow is returned ready to paste)."
    ),
)
async def get_generator_recipe(image_id: int = ImageId):
    try:
        return await run_in_threadpool(generator_recipe.build_recipe, image_id)
    except generator_recipe.RecipeNotFound as exc:
        raise _not_found() from exc


@router.post(
    "/images/{image_id}/comfyui/workflow-file",
    summary="Save the picture's ComfyUI workflow as a .json file",
    description=(
        "Writes the UI workflow (else the API prompt) to the workflows output "
        "folder; an existing name gets _2, _3 ..."
    ),
)
async def save_workflow_file(image_id: int = ImageId):
    try:
        result = await run_in_threadpool(generator_recipe.save_workflow_file, image_id)
    except generator_recipe.RecipeNotFound as exc:
        raise _not_found() from exc
    except OSError as exc:
        raise HTTPException(
            status_code=503,
            detail={
                "code": "write_failed",
                "message": f"Could not save the workflow: {exc}",
            },
        ) from exc
    if not result["saved"]:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "no_comfyui_recipe",
                "message": "This picture has no ComfyUI workflow to save.",
            },
        )
    return result


class QueueRequest(BaseModel):
    seed_mode: Literal["new", "same"] = Field(
        "new", description="new = random seeds; same = as stored"
    )


@router.post(
    "/images/{image_id}/comfyui/queue",
    summary="Run the picture's recipe again in ComfyUI",
    description=(
        "Queues the stored API prompt on the ComfyUI address from Settings "
        "(POST {address}/prompt). seed_mode=new gives every numeric seed input a "
        "new random value; linked inputs are left alone."
    ),
)
async def queue_in_comfyui(request: QueueRequest, image_id: int = ImageId):
    try:
        return await run_in_threadpool(
            generator_recipe.queue_in_comfyui, image_id, request.seed_mode
        )
    except generator_recipe.RecipeNotFound as exc:
        raise _not_found() from exc
    except ComfyUIError as exc:
        raise _comfy_error(exc) from exc


def _describe_comfyui_setting() -> dict:
    custom = config.get_comfyui_url_setting()
    try:
        url = configured_comfyui_url()
    except ValueError:
        url = None
    return {"url": url, "custom_url": custom, "default_url": DEFAULT_COMFYUI_URL}


class ComfyUISettingRequest(BaseModel):
    url: str = Field("", max_length=2048)


@router.get("/settings/comfyui", summary="The ComfyUI address used by Run again")
async def get_comfyui_setting():
    return _describe_comfyui_setting()


@router.patch("/settings/comfyui", summary="Set the ComfyUI address (empty = default)")
def set_comfyui_setting(request: ComfyUISettingRequest):
    text = request.url.strip()
    stored = ""
    if text:
        try:
            stored = normalize_comfyui_url(text)
        except ValueError as exc:
            raise HTTPException(
                status_code=400, detail={"code": "bad_address", "message": str(exc)}
            ) from exc
        if stored == DEFAULT_COMFYUI_URL:
            stored = ""
    try:
        config.save_comfyui_url_setting(stored)
    except OSError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return _describe_comfyui_setting()
