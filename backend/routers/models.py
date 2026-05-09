"""
Unified model inventory + preparation endpoints.

These endpoints back the frontend model manager so users can inspect which
runtime/model assets are ready and trigger first-run downloads explicitly.
"""
from __future__ import annotations

import asyncio
import logging
import threading
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from optional_dependencies import UnsafeDependencyInstallError
from services.model_service import (
    ExternalAuthRequiredError,
    ModelPreparationFailedError,
    ModelService,
    get_model_service,
)

_logger = logging.getLogger(__name__)

# In-memory progress mirror for the most recent /prepare invocation.
# NOTE: this state is process-local. The app is designed to run as a single
# uvicorn worker (see CLAUDE.md). Running multiple workers will fragment this
# dict across processes and the UI will see inconsistent results.
def _empty_prepare_result() -> Dict[str, Any]:
    # Rich-error fields (manual_steps, external_url, target_dir, provider,
    # error_type) are populated when ExternalAuthRequiredError /
    # ModelPreparationFailedError fire. The frontend prepare-progress poll
    # treats them as the trigger to render an actionable guidance dialog
    # instead of a generic toast — without these, users hitting the Civitai
    # login wall on Privacy YOLO see "Model setup failed" with no recovery
    # path.
    return {
        "active": False,
        "model_id": "",
        "status": "",
        "message": "",
        "error": "",
        "error_type": "",
        "provider": "",
        "manual_steps": [],
        "target_dir": "",
        "external_url": "",
        "restart_recommended": False,
        "installed_packages": [],
    }


_prepare_result: Dict[str, Any] = _empty_prepare_result()
_prepare_lock = threading.Lock()


router = APIRouter(prefix="/api/models", tags=["models"])


class PrepareModelRequest(BaseModel):
    model_id: str = Field(..., min_length=1)
    source: Optional[str] = None
    variant: Optional[str] = None


class MirrorRequest(BaseModel):
    mirror: str = Field("auto", pattern="^(auto|hf-mirror|modelscope)$")


@router.get("/mirror")
async def get_mirror():
    from config import get_download_mirror, VALID_MIRRORS
    return {"mirror": get_download_mirror(), "options": list(VALID_MIRRORS)}


@router.post("/mirror")
async def set_mirror(request: MirrorRequest):
    from config import save_download_mirror, get_download_mirror
    save_download_mirror(request.mirror)
    return {"mirror": get_download_mirror()}


@router.get("/download-progress")
async def get_download_progress():
    from services.model_service import get_download_progress
    progress = get_download_progress()
    with _prepare_lock:
        progress["prepare_result"] = dict(_prepare_result)
    return progress


@router.get("/status")
async def get_models_status(service: ModelService = Depends(get_model_service)):
    return service.get_status()


def _run_prepare_blocking(service: ModelService, model_id: str, source: Optional[str], variant: Optional[str]) -> None:
    try:
        result = service.prepare_model(model_id, source=source, variant=variant)
        result_status = str(result.get("status") or "ok")
        prepare_status = "done" if result_status in {"ok", "ready"} else "warning"
        with _prepare_lock:
            _prepare_result.update(
                status=prepare_status,
                message=result.get("message", "Ready."),
                error="",
                restart_recommended=bool(result.get("restart_recommended")),
                installed_packages=list(result.get("installed_packages") or []),
            )
    except (ExternalAuthRequiredError, ModelPreparationFailedError) as exc:
        # Forward the rich payload (manual_steps, external_url, target_dir,
        # provider, error type) so the frontend can render a guidance
        # dialog instead of swallowing the recovery path into a toast.
        with _prepare_lock:
            _prepare_result.update(
                status="error",
                error=str(exc),
                message=exc.payload.get("message", str(exc)),
                error_type=str(exc.payload.get("type") or ""),
                provider=str(exc.payload.get("provider") or ""),
                manual_steps=list(exc.payload.get("manual_steps") or []),
                target_dir=str(exc.payload.get("target_dir") or ""),
                external_url=str(exc.payload.get("external_url") or ""),
            )
    except UnsafeDependencyInstallError as exc:
        message = str(exc)
        with _prepare_lock:
            _prepare_result.update(
                status="error",
                error=message,
                message=message,
                error_type="UnsafeSystemPythonInstall",
                provider="Python runtime",
                manual_steps=[
                    "Close this SD Image Sorter window.",
                    "Start the app with run.bat, run-portable.bat, or run.sh so it uses the app-owned Python runtime.",
                    "Open Feature Setup again and click Prepare for this feature.",
                    "If you intentionally manage your own Python, activate a virtual environment first or set SD_IMAGE_SORTER_ALLOW_SYSTEM_PIP_INSTALL=1.",
                ],
            )
    except ValueError as exc:
        with _prepare_lock:
            _prepare_result.update(status="error", error=str(exc), message=str(exc))
    except Exception as exc:
        _logger.exception("Model preparation failed for %s", model_id)
        with _prepare_lock:
            _prepare_result.update(status="error", error=str(exc), message=str(exc))
    finally:
        with _prepare_lock:
            _prepare_result["active"] = False


@router.post("/prepare")
async def prepare_model(
    request: PrepareModelRequest,
    service: ModelService = Depends(get_model_service),
):
    global _prepare_result
    with _prepare_lock:
        if _prepare_result.get("active"):
            return {
                "status": "downloading",
                "model_id": _prepare_result["model_id"],
                "message": "A download is already in progress.",
            }
        # Wipe any stale fields from the previous prepare so the UI does not
        # render last-run's success message against this run's model_id.
        _prepare_result = _empty_prepare_result()
        _prepare_result.update(
            active=True,
            model_id=request.model_id,
            status="downloading",
            message="",
            error="",
        )
    loop = asyncio.get_running_loop()
    loop.run_in_executor(None, _run_prepare_blocking, service, request.model_id, request.source, request.variant)
    return {"status": "downloading", "model_id": request.model_id, "message": "Download started in background."}
