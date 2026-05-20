"""VLM captioning API router."""
from __future__ import annotations

import asyncio
import json
import logging
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import urlsplit, urlunsplit

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from config import CONFIG_DIR
from utils.source_paths import resolve_existing_indexed_image_path
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
    "active_requests": 0,
    "api_status": "idle",
    "api_message": "",
    "api_ok": 0,
    "api_error": 0,
    "last_api_latency_ms": None,
    "last_api_error": "",
    "output_format": "nl_caption",
}

_debug_chat_events: List[Dict[str, Any]] = []
_debug_chat_next_id = 1
_DEBUG_CHAT_LIMIT = 80


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


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _redact_debug_text(value: Any, limit: int = 5000) -> str:
    text = "" if value is None else str(value)
    if len(text) > limit:
        return text[:limit] + f"\n...[truncated {len(text) - limit} chars]"
    return text


def _redact_debug_endpoint(value: Any) -> str:
    """Hide endpoint credentials and query tokens before exposing debug events."""
    endpoint = str(value or "").strip()
    if not endpoint:
        return ""
    try:
        parsed = urlsplit(endpoint)
    except ValueError:
        return _redact_debug_text(endpoint.split("?", 1)[0], 500)
    if not parsed.scheme or not parsed.netloc:
        return _redact_debug_text(endpoint.split("?", 1)[0], 500)
    host = parsed.hostname or ""
    if parsed.port:
        host = f"{host}:{parsed.port}"
    redacted_query = "..." if parsed.query else ""
    redacted = urlunsplit((parsed.scheme, host, parsed.path, redacted_query, ""))
    return _redact_debug_text(redacted, 500)


def _coerce_int_setting(value: Any, default: int, *, minimum: int, maximum: int) -> int:
    try:
        coerced = int(value)
    except (TypeError, ValueError):
        coerced = default
    return max(minimum, min(maximum, coerced))


def _coerce_float_setting(value: Any, default: float, *, minimum: float, maximum: float) -> float:
    try:
        coerced = float(value)
    except (TypeError, ValueError):
        coerced = default
    return max(minimum, min(maximum, coerced))


def _resolve_image_path(image: Dict[str, Any]) -> str:
    image_path = str((image or {}).get("path") or "")
    resolved_path = resolve_existing_indexed_image_path(image_path, backend_file=__file__)
    if not resolved_path:
        raise HTTPException(404, "Image file not found on disk")
    return resolved_path


def _append_debug_chat_event(event: Dict[str, Any]) -> int:
    global _debug_chat_next_id
    with _batch_state_lock:
        event_id = _debug_chat_next_id
        _debug_chat_next_id += 1
        safe_event = {"id": event_id, "at": _utc_now_iso(), **event}
        _debug_chat_events.append(safe_event)
        if len(_debug_chat_events) > _DEBUG_CHAT_LIMIT:
            del _debug_chat_events[:-_DEBUG_CHAT_LIMIT]
        return event_id


def _build_debug_request_event(
    *,
    image_id: int,
    image_name: str,
    config: VLMConfig,
    provider_name: str,
    tags: List[str],
    user_message: str,
) -> Dict[str, Any]:
    return {
        "phase": "request",
        "image_id": image_id,
        "image_name": image_name,
        "provider": provider_name,
        "model": config.model,
        "output_format": config.output_format,
        "endpoint": _redact_debug_endpoint(config.endpoint),
        "system_prompt": _redact_debug_text(config.system_prompt),
        "user_prompt": _redact_debug_text(user_message),
        "tags": tags[:120],
        "tags_count": len(tags),
        "note": "Image bytes are sent to the API but hidden here; API keys and base64 payloads are never shown.",
    }


def _append_debug_response_event(
    *,
    request_event_id: int,
    image_id: int,
    image_name: str,
    result: Any,
    latency_ms: int,
) -> None:
    _append_debug_chat_event({
        "phase": "response" if not getattr(result, "error", None) else "error",
        "request_id": request_event_id,
        "image_id": image_id,
        "image_name": image_name,
        "model": getattr(result, "model", "") or "",
        "latency_ms": latency_ms,
        "tokens_used": int(getattr(result, "tokens_used", 0) or 0),
        "caption": _redact_debug_text(getattr(result, "caption", "")),
        "tags": list(getattr(result, "tags", []) or [])[:120],
        "raw_text": _redact_debug_text(getattr(result, "raw_text", "")),
        "error": _redact_debug_text(getattr(result, "error", "") or ""),
        "error_type": getattr(result, "error_type", "") or "",
        "retries_used": int(getattr(result, "retries_used", 0) or 0),
    })


def _reset_debug_chat_events() -> None:
    global _debug_chat_next_id
    with _batch_state_lock:
        _debug_chat_events.clear()
        _debug_chat_next_id = 1


def _normalize_openai_endpoint(url: str) -> str:
    """Auto-append ``/v1`` for OpenAI-compatible endpoints missing the version path.

    A common new-user mistake is to paste ``https://aihubmix.com`` (or any
    other OpenAI gateway) into the VLM endpoint field without the ``/v1``
    suffix. The provider then builds ``https://aihubmix.com/chat/completions``
    which the gateway's CDN often answers with an XML 401 "AuthenticationRequired"
    from the underlying object storage instead of a useful API error.

    We only touch URLs whose path is empty or ``/``. URLs that already have
    any non-trivial path (e.g. ``/v1``, ``/openai/v1``, ``/api/proxy``) are
    left alone — the user explicitly chose them.
    """
    if not url:
        return url
    cleaned = url.strip().rstrip("/")
    if not cleaned:
        return cleaned
    try:
        from urllib.parse import urlparse

        parsed = urlparse(cleaned)
        if not parsed.scheme or not parsed.netloc:
            return cleaned  # not a parseable URL; do not mangle
        path = parsed.path or ""
        if path in ("", "/"):
            return cleaned + "/v1"
        return cleaned
    except Exception:
        return cleaned


def _build_config(overrides: Optional[Dict[str, Any]] = None) -> VLMConfig:
    settings = _load_vlm_settings()
    if overrides:
        settings.update({k: v for k, v in overrides.items() if v is not None})
    provider = settings.get("provider", "openai_compat")
    endpoint = settings.get("endpoint", "")
    # OpenAI-compatible gateways always live under /v1; auto-pad missing paths
    # so URLs saved without the suffix still hit /v1/chat/completions and
    # /v1/models correctly.
    if provider == "openai_compat" and endpoint:
        endpoint = _normalize_openai_endpoint(endpoint)
    return VLMConfig(
        provider=provider,
        endpoint=endpoint,
        api_key=settings.get("api_key", ""),
        model=settings.get("model", ""),
        max_retries=_coerce_int_setting(settings.get("max_retries"), 3, minimum=0, maximum=10),
        retry_delay_seconds=_coerce_float_setting(settings.get("retry_delay_seconds"), 2.0, minimum=0.0, maximum=60.0),
        timeout_seconds=_coerce_float_setting(settings.get("timeout_seconds"), 60.0, minimum=1.0, maximum=600.0),
        concurrent_requests=_coerce_int_setting(settings.get("concurrent_requests"), 2, minimum=1, maximum=16),
        system_prompt=settings.get("system_prompt", ""),
        user_prompt=settings.get("user_prompt", ""),
        include_tags_as_context=bool(settings.get("include_tags_as_context", True)),
        max_image_size=_coerce_int_setting(settings.get("max_image_size"), 1024, minimum=128, maximum=4096),
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
    max_retries: Optional[int] = Field(default=None, ge=0, le=10)
    retry_delay_seconds: Optional[float] = Field(default=None, ge=0, le=60)
    timeout_seconds: Optional[float] = Field(default=None, ge=1, le=600)
    concurrent_requests: Optional[int] = Field(default=None, ge=1, le=16)
    system_prompt: Optional[str] = None
    user_prompt: Optional[str] = None
    include_tags_as_context: Optional[bool] = None
    max_image_size: Optional[int] = Field(default=None, ge=128, le=4096)
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

    image_path = _resolve_image_path(image)

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
    _reset_debug_chat_events()
    with _batch_state_lock:
        _batch_state.update({
            "running": True,
            "cancel_requested": False,
            "total": len(request.image_ids),
            "completed": 0,
            "failed": 0,
            "tokens_used": 0,
            "errors": [],
            "current_image": "",
            "active_requests": 0,
            "api_status": "queued" if request.image_ids else "idle",
            "api_message": "Waiting to send images to the VLM API" if request.image_ids else "No images queued",
            "api_ok": 0,
            "api_error": 0,
            "last_api_latency_ms": None,
            "last_api_error": "",
            "output_format": config.output_format,
        })

    asyncio.create_task(_run_batch(request.image_ids))
    return {"status": "started", "total": len(request.image_ids), "output_format": config.output_format}


@router.get("/caption-batch/progress")
async def batch_progress():
    with _batch_state_lock:
        return dict(_batch_state)


@router.get("/caption-batch/debug-chat")
async def batch_debug_chat():
    with _batch_state_lock:
        return {
            "events": list(_debug_chat_events),
            "limit": _DEBUG_CHAT_LIMIT,
            "running": bool(_batch_state.get("running")),
        }


@router.post("/caption-batch/cancel")
async def batch_cancel():
    with _batch_state_lock:
        if not _batch_state["running"]:
            raise HTTPException(400, "No batch in progress")
        _batch_state["cancel_requested"] = True
        _batch_state["api_status"] = "cancelling"
        _batch_state["api_message"] = "Cancel requested; waiting for active API calls to finish"
    return {"status": "cancel_requested"}


async def _run_batch(image_ids: List[int]) -> None:
    """Run batch captioning with concurrency control."""
    import database as db

    try:
        config = _build_config()
        provider = get_provider(config)
        semaphore = asyncio.Semaphore(config.concurrent_requests)
    except Exception as exc:
        message = str(exc) or "Failed to initialize VLM batch"
        with _batch_state_lock:
            _batch_state["running"] = False
            _batch_state["failed"] = int(_batch_state.get("total") or len(image_ids) or 0)
            _batch_state["current_image"] = ""
            _batch_state["active_requests"] = 0
            _batch_state["api_status"] = "error"
            _batch_state["api_message"] = "Could not start VLM batch"
            _batch_state["last_api_error"] = message
            if len(_batch_state["errors"]) < 50:
                _batch_state["errors"].append({
                    "image_id": None,
                    "error": message,
                    "error_type": "batch_init",
                })
        _append_debug_chat_event({
            "phase": "error",
            "image_id": None,
            "image_name": "",
            "error": _redact_debug_text(message),
            "error_type": "batch_init",
        })
        return

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

                image_path = str(image.get("path") or "")
                with _batch_state_lock:
                    _batch_state["current_image"] = Path(image_path).name if image_path else ""

                try:
                    resolved_image_path = _resolve_image_path(image)
                except HTTPException:
                    _record_error(image_id, "File not found on disk", "file_missing")
                    return

                tag_rows = db.get_image_tags(image_id)
                tags = [t["tag"] for t in tag_rows] if tag_rows else []

                user_message = provider.build_user_message(tags)
                image_name = Path(image_path or resolved_image_path).name
                request_event_id = _append_debug_chat_event(_build_debug_request_event(
                    image_id=image_id,
                    image_name=image_name,
                    config=config,
                    provider_name=getattr(provider, "name", config.provider),
                    tags=tags,
                    user_message=user_message,
                ))

                start_time = time.monotonic()
                with _batch_state_lock:
                    _batch_state["active_requests"] += 1
                    _batch_state["api_status"] = "waiting"
                    _batch_state["api_message"] = f"Waiting for API response: {image_name}"
                    _batch_state["last_api_error"] = ""

                result = await provider.caption_image(resolved_image_path, tags=tags)
                latency_ms = int((time.monotonic() - start_time) * 1000)
                _append_debug_response_event(
                    request_event_id=request_event_id,
                    image_id=image_id,
                    image_name=image_name,
                    result=result,
                    latency_ms=latency_ms,
                )

                if not result.error and (result.caption or result.tags):
                    if result.caption:
                        db.update_image_caption(image_id, result.caption)
                    if result.tags:
                        _persist_tags(db, image_id, result.tags)
                    with _batch_state_lock:
                        _batch_state["completed"] += 1
                        _batch_state["tokens_used"] += result.tokens_used
                        _batch_state["api_ok"] += 1
                        _batch_state["last_api_latency_ms"] = latency_ms
                        _batch_state["api_status"] = "responded"
                        _batch_state["api_message"] = f"API response OK in {latency_ms} ms"
                else:
                    with _batch_state_lock:
                        _batch_state["api_error"] += 1
                        _batch_state["last_api_latency_ms"] = latency_ms
                        _batch_state["api_status"] = "error"
                        _batch_state["api_message"] = f"API response failed in {latency_ms} ms"
                        _batch_state["last_api_error"] = result.error or "No output"
                    _record_error(image_id, result.error or "No output", result.error_type or "unknown")

            except Exception as e:
                try:
                    _append_debug_chat_event({
                        "phase": "error",
                        "image_id": image_id,
                        "image_name": Path(image_path).name if "image_path" in locals() and image_path else "",
                        "error": _redact_debug_text(str(e)),
                        "error_type": "exception",
                    })
                except Exception:
                    pass
                with _batch_state_lock:
                    _batch_state["api_error"] += 1
                    _batch_state["api_status"] = "error"
                    _batch_state["api_message"] = "API request failed before a usable response"
                    _batch_state["last_api_error"] = str(e)
                _record_error(image_id, str(e), "exception")
            finally:
                with _batch_state_lock:
                    _batch_state["active_requests"] = max(0, int(_batch_state.get("active_requests") or 0) - 1)
                    if _batch_state["cancel_requested"]:
                        _batch_state["api_status"] = "cancelling"
                        _batch_state["api_message"] = "Cancel requested; waiting for active API calls to finish"
                    elif _batch_state["active_requests"] > 0:
                        _batch_state["api_status"] = "waiting"
                        _batch_state["api_message"] = f"Waiting for {_batch_state['active_requests']} API response(s)"

    tasks = [process_one(img_id) for img_id in image_ids]
    await asyncio.gather(*tasks, return_exceptions=True)

    with _batch_state_lock:
        _batch_state["running"] = False
        _batch_state["current_image"] = ""
        _batch_state["active_requests"] = 0
        if _batch_state["cancel_requested"]:
            _batch_state["api_status"] = "cancelled"
            _batch_state["api_message"] = "Cancelled"
        elif _batch_state["failed"] > 0:
            _batch_state["api_status"] = "done_with_errors"
            _batch_state["api_message"] = "Finished with API or image errors"
        else:
            _batch_state["api_status"] = "done"
            _batch_state["api_message"] = "Finished"


def _record_error(image_id: int, message: str, error_type: str) -> None:
    with _batch_state_lock:
        _batch_state["failed"] += 1
        if _batch_state.get("api_status") not in {"error", "cancelling", "cancelled"}:
            _batch_state["api_status"] = "error"
            _batch_state["api_message"] = message
        _batch_state["last_api_error"] = message
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
    asyncio.create_task(_do_pull(request.model))
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
