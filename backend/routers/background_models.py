"""What AI models are loaded right now, when idle ones are released, and "Unload now"."""

from fastapi import APIRouter
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from config_settings import (
    get_model_idle_unload_minutes,
    save_model_idle_unload_minutes,
)
from gpu_headroom import recent_fallbacks
from model_residency import get_model_residency

router = APIRouter(prefix="/api/background-models", tags=["background"])


class IdleUnloadRequest(BaseModel):
    # 0 = never; any positive number of minutes is accepted (Settings offers 5/10/30).
    minutes: float = Field(..., ge=0, le=7 * 24 * 60)


def _describe() -> dict:
    snapshot = get_model_residency().snapshot()
    return {
        "idle_unload_minutes": get_model_idle_unload_minutes(),
        "models": snapshot["models"],
        "last_release": snapshot["last_release"],
        "gpu_busy_fallbacks": recent_fallbacks(),
    }


@router.get("")
async def get_background_models() -> dict:
    """Loaded models (with CPU/GPU and idle time), the idle setting, recent GPU-busy fallbacks."""
    return await run_in_threadpool(_describe)


@router.patch("")
async def set_idle_unload(request: IdleUnloadRequest) -> dict:
    """Store how long an unused model stays loaded (0 = keep it until the program quits)."""
    await run_in_threadpool(save_model_idle_unload_minutes, request.minutes)
    return await run_in_threadpool(_describe)


@router.post("/unload")
async def unload_models_now() -> dict:
    """Release every loaded model a running job is not using."""
    result = await run_in_threadpool(get_model_residency().release_now)
    return {**result, **(await run_in_threadpool(_describe))}
