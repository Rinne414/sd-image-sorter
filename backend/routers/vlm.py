"""VLM captioning API router."""
from __future__ import annotations

import asyncio
import json
import logging
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from config import CONFIG_DIR
from vlm_providers import (
    PROMPT_PRESETS,
    VLMConfig,
    detect_provider,
    get_provider,
    list_providers,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/vlm", tags=["vlm"])

VLM_SETTINGS_PATH = CONFIG_DIR / "vlm-settings.json"

_batch_state_lock = threading.Lock()
_batch_state: Dict[str, Any] = {
    "running": False,
    "cancel_requested": False,
    "total": 0,
    "completed": 0,
    "failed": 0,
    "tokens_used": 0,
    "errors": [],
    "current_image": "",
    "output_format": "nl_caption",
}


def _load_vlm_settings() -> Dict[str, Any]:
    if not VLM_SETTINGS_PATH.exists():
        return {}
    try:
        return json.loads(VLM_SETTINGS_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


def _save_vlm_settings(settings: Dict[str, Any]) -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    safe = {k: v for k, v in settings.items() if k != "api_key_display" and k != "service_account_json_display"}
    VLM_SETTINGS_PATH.write_text(json.dumps(safe, indent=2, ensure_ascii=False), encoding="utf-8")


def _build_config(overrides: Optional[Dict[str, Any]] = None) -> VLMConfig:
    settings = _load_vlm_settings()
    if overrides:
        settings.update({k: v for k, v in overrides.items() if v is not None})
    return VLMConfig(
        provider=settings.get("provider", "openai_compat"),
        endpoint=settings.get("endpoint", ""),
        api_key=settings.get("api_key", ""),
        model=settings.get("model", ""),
        max_retries=int(settings.get("max_retries", 3)),
        retry_delay_seconds=float(settings.get("retry_delay_seconds", 2.0)),
        timeout_seconds=float(settings.get("timeout_seconds", 60.0)),
        concurrent_requests=int(settings.get("concurrent_requests", 2)),
        system_prompt=settings.get("system_prompt", ""),
        user_prompt=settings.get("user_prompt", ""),
        include_tags_as_context=bool(settings.get("include_tags_as_context", True)),
        max_image_size=int(settings.get("max_image_size", 1024)),
        nsfw_retry_prompt=settings.get("nsfw_retry_prompt", ""),
        output_format=settings.get("output_format", "nl_caption"),
        http_proxy=settings.get("http_proxy", ""),
        https_proxy=settings.get("https_proxy", ""),
        socks_proxy=settings.get("socks_proxy", ""),
        use_vertex=bool(settings.get("use_vertex", False)),
        vertex_project=settings.get("vertex_project", ""),
        vertex_location=settings.get("vertex_location", "us-central1"),
        service_account_json=settings.get("service_account_json", ""),
    )


# === API Endpoints ===


@router.get("/providers")
async def get_providers():
    return {"providers": list_providers()}


class DetectProviderRequest(BaseModel):
    endpoint: str


@router.post("/detect-provider")
async def detect_provider_endpoint(request: DetectProviderRequest):
    """Auto-detect provider from endpoint URL pattern."""
    provider = detect_provider(request.endpoint)
    return {"provider": provider}


@router.get("/presets")
async def get_presets():
    return {"presets": PROMPT_PRESETS}


@router.get("/settings")
async def get_settings():
    settings = _load_vlm_settings()
    if settings.get("api_key"):
        settings["api_key_display"] = settings["api_key"][:8] + "***"
        del settings["api_key"]
    if settings.get("service_account_json"):
        settings["service_account_json_display"] = "*** (configured)"
        del settings["service_account_json"]
    return settings


class SaveSettingsRequest(BaseModel):
    provider: Optional[str] = None
    endpoint: Optional[str] = None
    api_key: Optional[str] = None
    model: Optional[str] = None
    max_retries: Optional[int] = None
    retry_delay_seconds: Optional[float] = None
    timeout_seconds: Optional[float] = None
    concurrent_requests: Optional[int] = None
    system_prompt: Optional[str] = None
    user_prompt: Optional[str] = None
    include_tags_as_context: Optional[bool] = None
    max_image_size: Optional[int] = None
    nsfw_retry_prompt: Optional[str] = None
    output_format: Optional[str] = None
    http_proxy: Optional[str] = None
    https_proxy: Optional[str] = None
    socks_proxy: Optional[str] = None
    use_vertex: Optional[bool] = None
    vertex_project: Optional[str] = None
    vertex_location: Optional[str] = None
    service_account_json: Optional[str] = None


@router.post("/settings")
async def save_settings(request: SaveSettingsRequest):
    current = _load_vlm_settings()
    updates = {k: v for k, v in request.model_dump().items() if v is not None}
    current.update(updates)
    _save_vlm_settings(current)
    return {"status": "ok"}


@router.post("/test")
async def test_connection():
    config = _build_config()
    if not config.endpoint and not config.use_vertex:
        raise HTTPException(400, "No endpoint configured")
    provider = get_provider(config)
    result = await provider.test_connection()
    return result


@router.post("/models")
async def fetch_models():
    config = _build_config()
    if not config.endpoint and not config.use_vertex:
        raise HTTPException(400, "No endpoint configured")
    provider = get_provider(config)
    models = await provider.list_models()
    return {"models": models}


class CaptionSingleRequest(BaseModel):
    image_id: int
    tags: Optional[List[str]] = None


@router.post("/caption")
async def caption_single(request: CaptionSingleRequest):
    """Caption a single image by ID."""
    import database as db

    image = db.get_image_by_id(request.image_id)
    if not image:
        raise HTTPException(404, "Image not found")

    image_path = image.get("path", "")
    if not image_path or not Path(image_path).exists():
        raise HTTPException(404, "Image file not found on disk")

    tags = request.tags
    if tags is None:
        tag_rows = db.get_image_tags(request.image_id)
        tags = [t["tag"] for t in tag_rows] if tag_rows else []

    config = _build_config()
    if not config.endpoint and not config.use_vertex:
        raise HTTPException(400, "No VLM endpoint configured")

    provider = get_provider(config)
    result = await provider.caption_image(image_path, tags=tags)

    # Persist results based on output format
    if not result.error:
        if result.caption:
            db.update_image_caption(request.image_id, result.caption)
        if result.tags:
            _persist_tags(db, request.image_id, result.tags)

    return {
        "caption": result.caption,
        "tags": result.tags,
        "tokens_used": result.tokens_used,
        "retries_used": result.retries_used,
        "error": result.error,
        "error_type": result.error_type,
        "model": result.model,
        "output_format": config.output_format,
    }


def _persist_tags(db, image_id: int, vlm_tags: List[str]) -> None:
    """Merge VLM-generated tags with existing local-tagger tags.

    Strategy: keep existing tags (with their confidence), append VLM tags that
    aren't already present. VLM tags use confidence=0.85 (manual-tier marker).
    """
    if not vlm_tags:
        return
    try:
        existing = db.get_image_tags(image_id) or []
        existing_lower = {(t.get("tag") or "").lower() for t in existing}
        new_tags = [t for t in vlm_tags if t and t.lower() not in existing_lower]
        if not new_tags:
            return
        merged = [
            {"tag": t.get("tag"), "confidence": float(t.get("confidence") or 1.0)}
            for t in existing if t.get("tag")
        ] + [
            {"tag": t, "confidence": 0.85} for t in new_tags
        ]
        db.add_tags(image_id, merged)
    except Exception as e:
        logger.warning(f"Failed to persist VLM tags for image {image_id}: {e}")


class BatchCaptionRequest(BaseModel):
    image_ids: List[int] = Field(default_factory=list, max_length=100000)


@router.post("/caption-batch")
async def caption_batch(request: BatchCaptionRequest):
    """Start batch captioning. Returns immediately; poll /caption-batch/progress."""
    config = _build_config()
    with _batch_state_lock:
        if _batch_state["running"]:
            raise HTTPException(409, "Batch captioning already in progress")
        _batch_state.update({
            "running": True,
            "cancel_requested": False,
            "total": len(request.image_ids),
            "completed": 0,
            "failed": 0,
            "tokens_used": 0,
            "errors": [],
            "current_image": "",
            "output_format": config.output_format,
        })

    asyncio.get_event_loop().create_task(_run_batch(request.image_ids))
    return {"status": "started", "total": len(request.image_ids), "output_format": config.output_format}


@router.get("/caption-batch/progress")
async def batch_progress():
    with _batch_state_lock:
        return dict(_batch_state)


@router.post("/caption-batch/cancel")
async def batch_cancel():
    with _batch_state_lock:
        if not _batch_state["running"]:
            raise HTTPException(400, "No batch in progress")
        _batch_state["cancel_requested"] = True
    return {"status": "cancel_requested"}


async def _run_batch(image_ids: List[int]) -> None:
    """Run batch captioning with concurrency control."""
    import database as db

    config = _build_config()
    provider = get_provider(config)
    semaphore = asyncio.Semaphore(config.concurrent_requests)

    async def process_one(image_id: int) -> None:
        with _batch_state_lock:
            if _batch_state["cancel_requested"]:
                return

        async with semaphore:
            with _batch_state_lock:
                if _batch_state["cancel_requested"]:
                    return

            try:
                image = db.get_image_by_id(image_id)
                if not image:
                    _record_error(image_id, "Image not found in DB", "not_found")
                    return

                image_path = image.get("path", "")
                with _batch_state_lock:
                    _batch_state["current_image"] = Path(image_path).name if image_path else ""

                if not image_path or not Path(image_path).exists():
                    _record_error(image_id, "File not found on disk", "file_missing")
                    return

                tag_rows = db.get_image_tags(image_id)
                tags = [t["tag"] for t in tag_rows] if tag_rows else []

                result = await provider.caption_image(image_path, tags=tags)

                if not result.error and (result.caption or result.tags):
                    if result.caption:
                        db.update_image_caption(image_id, result.caption)
                    if result.tags:
                        _persist_tags(db, image_id, result.tags)
                    with _batch_state_lock:
                        _batch_state["completed"] += 1
                        _batch_state["tokens_used"] += result.tokens_used
                else:
                    _record_error(image_id, result.error or "No output", result.error_type or "unknown")

            except Exception as e:
                _record_error(image_id, str(e), "exception")

    tasks = [process_one(img_id) for img_id in image_ids]
    await asyncio.gather(*tasks, return_exceptions=True)

    with _batch_state_lock:
        _batch_state["running"] = False
        _batch_state["current_image"] = ""


def _record_error(image_id: int, message: str, error_type: str) -> None:
    with _batch_state_lock:
        _batch_state["failed"] += 1
        if len(_batch_state["errors"]) < 50:
            _batch_state["errors"].append({
                "image_id": image_id,
                "error": message,
                "error_type": error_type,
            })


# === Local Model Management (Ollama) ===


_pull_state: Dict[str, Any] = {"pulling": False, "model": "", "percent": 0, "status": ""}


@router.get("/local-models/recommended")
async def get_recommended_models():
    from vlm_providers.local_models import RECOMMENDED_MODELS, OllamaManager
    mgr = OllamaManager()
    installed = await mgr.is_running()
    local = await mgr.list_local_models() if installed else []
    local_ids = {m["id"] for m in local}

    models = []
    for m in RECOMMENDED_MODELS:
        entry = dict(m)
        entry["installed"] = m["id"] in local_ids
        models.append(entry)

    return {
        "ollama_installed": OllamaManager.is_ollama_installed(),
        "ollama_running": installed,
        "install_instructions": OllamaManager.get_install_instructions() if not OllamaManager.is_ollama_installed() else None,
        "models": models,
        "local_models": local,
    }


class PullModelRequest(BaseModel):
    model: str


@router.post("/local-models/pull")
async def pull_model(request: PullModelRequest):
    """Start pulling a model. Poll /local-models/pull/progress for status."""
    from vlm_providers.local_models import OllamaManager

    if _pull_state["pulling"]:
        raise HTTPException(409, f"Already pulling: {_pull_state['model']}")

    mgr = OllamaManager()
    if not await mgr.is_running():
        start_result = await OllamaManager.start_ollama()
        if start_result.get("status") != "ok":
            raise HTTPException(503, start_result.get("error", "Cannot start Ollama"))

    _pull_state.update({"pulling": True, "model": request.model, "percent": 0, "status": "starting"})
    asyncio.get_event_loop().create_task(_do_pull(request.model))
    return {"status": "started", "model": request.model}


@router.get("/local-models/pull/progress")
async def pull_progress():
    return dict(_pull_state)


async def _do_pull(model_name: str) -> None:
    from vlm_providers.local_models import OllamaManager
    mgr = OllamaManager()
    try:
        async for progress in mgr.pull_model(model_name):
            _pull_state["percent"] = progress.get("percent", 0)
            _pull_state["status"] = progress.get("status", "")
            if progress.get("status") == "error":
                _pull_state["status"] = f"error: {progress.get('error', '')}"
                break
    except Exception as e:
        _pull_state["status"] = f"error: {e}"
    finally:
        _pull_state["pulling"] = False


class DeleteModelRequest(BaseModel):
    model: str


@router.post("/local-models/delete")
async def delete_model(request: DeleteModelRequest):
    from vlm_providers.local_models import OllamaManager
    mgr = OllamaManager()
    success = await mgr.delete_model(request.model)
    if not success:
        raise HTTPException(500, "Failed to delete model")
    return {"status": "ok"}


@router.post("/local-models/start-ollama")
async def start_ollama():
    from vlm_providers.local_models import OllamaManager
    result = await OllamaManager.start_ollama()
    if result.get("status") != "ok":
        raise HTTPException(503, result.get("error", "Cannot start Ollama"))
    return result
