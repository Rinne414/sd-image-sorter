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

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from optional_dependencies import (
    UnsafeDependencyInstallError,
    UnsupportedOptionalDependencyError,
)
from services.model_service import (
    ExternalAuthRequiredError,
    ModelPreparationFailedError,
    ModelService,
    get_model_service,
)

_logger = logging.getLogger(__name__)

# In-memory progress mirror for the most recent /prepare invocation.
# NOTE: this state is process-local. The app is designed to run as a single
# uvicorn worker. Running multiple workers will fragment this dict across
# processes and the UI will see inconsistent results.
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


# Models the "Download all" button in Feature Setup will fetch.
# Intentionally excludes:
#   - censor-legacy (Wenaka2004 Privacy YOLO) — user opt-in only
#   - toriigate (~5 GB heavy alternative tagger; default WD14 covers tagging)
#   - oppai-oracle (~947 MB alternative tagger; default WD14 covers tagging,
#     and Model Manager surfaces a dedicated card for users who want it)
# WD14 is downloaded with the default variant only (`wd-swinv2-tagger-v3`),
# not the full tagger family.
# Sizes are best-effort estimates (compressed download size) sourced from
# README.md "模型体积" table. Tweak alongside that table when models change.
BULK_MODEL_BUNDLE: list = [
    {"id": "wd14", "variant": "wd-swinv2-tagger-v3", "size_bytes": 446 * 1024 * 1024, "label": "WD14 Tagger (default: wd-swinv2-tagger-v3)"},
    {"id": "censor-nudenet", "size_bytes": 12 * 1024 * 1024, "label": "NudeNet 320n"},
    {"id": "clip", "size_bytes": 335 * 1024 * 1024, "label": "CLIP ViT-B/32 (similarity search)"},
    {"id": "aesthetic", "size_bytes": 400 * 1024 * 1024, "label": "Aesthetic predictor (CLIP ViT-L/14 + LAION head)"},
    {"id": "artist", "size_bytes": int(2.8 * 1024 * 1024 * 1024), "label": "Kaloscope 2.0 (Artist ID)"},
    {"id": "sam3", "size_bytes": int(3.3 * 1024 * 1024 * 1024), "label": "SAM 3 (text-guided segmentation)"},
]


@router.get("/bulk-bundle")
async def get_bulk_bundle(service: ModelService = Depends(get_model_service)):
    """Inventory of models the "Download all" button covers.

    Returns each item with its current ready/missing status and an
    estimated download size, plus the total bytes the button would
    fetch if pressed right now (only "missing" entries contribute to
    the total). The frontend uses this to render the confirmation
    dialog showing how much disk space is needed.
    """
    inventory = service.build_model_inventory()
    by_id = {entry["id"]: entry for entry in inventory}

    items = []
    pending_total = 0
    for spec in BULK_MODEL_BUNDLE:
        entry = by_id.get(spec["id"])
        status = (entry or {}).get("status", "missing")
        is_ready = status == "ready"
        item = {
            "id": spec["id"],
            "label": spec["label"],
            "size_bytes": int(spec["size_bytes"]),
            "status": "ready" if is_ready else "missing",
            "name": (entry or {}).get("name") or spec["id"],
            "group": (entry or {}).get("group") or "",
            "variant": spec.get("variant"),
        }
        items.append(item)
        if not is_ready:
            pending_total += int(spec["size_bytes"])

    return {
        "items": items,
        "pending_total_bytes": pending_total,
        "all_total_bytes": sum(int(s["size_bytes"]) for s in BULK_MODEL_BUNDLE),
        "excluded": [
            {"id": "censor-legacy", "reason": "Privacy YOLO (Wenaka2004) is opt-in for content-safety reasons."},
            {"id": "toriigate", "reason": "ToriiGate VLM is a ~5 GB alternative tagger; the default WD14 already covers tagging."},
            {"id": "oppai-oracle", "reason": "OppaiOracle V1.1 is a ~947 MB alternative tagger; the default WD14 already covers tagging."},
        ],
    }


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
    except UnsupportedOptionalDependencyError as exc:
        message = str(exc)
        normalized_model_id = model_id.strip().lower()
        manual_steps = (
            [
                "Keep using the core Gallery, metadata, sorting, and ONNX features on this Mac.",
                "Use a Windows or Linux machine with an NVIDIA CUDA GPU for SAM3.",
            ]
            if normalized_model_id == "sam3"
            else [
                "Keep using the core Gallery, metadata, sorting, and ONNX features on this Mac.",
                "Use Apple Silicon with macOS 14 or newer, Windows, or Linux for Torch-backed AI features.",
            ]
        )
        with _prepare_lock:
            _prepare_result.update(
                status="error",
                error=message,
                message=message,
                error_type="UnsupportedPlatformRuntime",
                provider="Torch / CUDA runtime",
                manual_steps=manual_steps,
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
