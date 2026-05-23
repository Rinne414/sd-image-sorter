"""
FastAPI backend for SD Image Sorter.
Provides REST API for image management, tagging, and sorting.

This is the main application entry point. Endpoints are organized into routers:
- routers/images.py - Image retrieval and serving
- routers/tags.py - Tag management and tagging
- routers/sorting.py - Scanning, moving, and manual sorting
- routers/censor.py - NSFW detection and censoring
"""
import ipaddress
import os
import sys
import asyncio
import shutil
import subprocess
import logging
import threading
import time
import traceback
import re
import zlib
from logging.handlers import RotatingFileHandler
from pathlib import Path
from collections import defaultdict, deque
from typing import Optional, Dict, Any
from contextlib import asynccontextmanager

# Add current dir to path for imports
sys.path.insert(0, os.path.dirname(__file__))

from runtime_env import prepare_onnxruntime_environment

prepare_onnxruntime_environment()

from app_info import APP_VERSION
from config import (
    SERVER_HOST,
    SERVER_PORT,
    CORS_ORIGIN_REGEX,
    RATE_LIMIT_ENABLED as CONFIG_RATE_LIMIT_ENABLED,
    RATE_LIMIT_WINDOW_SECONDS as CONFIG_RATE_LIMIT_WINDOW_SECONDS,
    RATE_LIMIT_MAX_REQUESTS as CONFIG_RATE_LIMIT_MAX_REQUESTS,
    RATE_LIMIT_APPLY_TO_LOOPBACK as CONFIG_RATE_LIMIT_APPLY_TO_LOOPBACK,
    LOG_LEVEL,
    LOG_ACCESS_ENABLED,
    LOG_FILE_ENABLED,
    LOG_FILE_PATH,
    LOG_FILE_MAX_BYTES,
    LOG_FILE_BACKUP_COUNT,
    BACKEND_DIR,
    validate_config,
    ensure_directories,
)

# Configure logging
def configure_console_logging() -> None:
    """Keep normal console output quiet while preserving a support log file."""
    level = getattr(logging, LOG_LEVEL.upper(), logging.INFO)
    log_format = "%(asctime)s %(levelname)s [%(name)s] %(message)s"
    formatter = logging.Formatter(log_format, datefmt="%H:%M:%S")
    logging.basicConfig(level=level, format=log_format, datefmt="%H:%M:%S")
    logging.getLogger().setLevel(level)
    logging.getLogger("uvicorn.access").setLevel(
        logging.INFO if LOG_ACCESS_ENABLED else logging.WARNING
    )

    if not LOG_FILE_ENABLED:
        return

    log_path = Path(LOG_FILE_PATH)
    existing_paths = {
        str(getattr(handler, "baseFilename", ""))
        for handler in logging.getLogger().handlers
        if isinstance(handler, RotatingFileHandler)
    }
    if str(log_path) in existing_paths:
        return

    try:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        file_handler = RotatingFileHandler(
            log_path,
            maxBytes=LOG_FILE_MAX_BYTES,
            backupCount=LOG_FILE_BACKUP_COUNT,
            encoding="utf-8",
        )
        file_handler.setLevel(level)
        file_handler.setFormatter(formatter)
        logging.getLogger().addHandler(file_handler)
    except OSError as exc:
        logging.getLogger("sd-image-sorter").warning(
            "Could not initialize file log at %s: %s",
            LOG_FILE_PATH,
            exc,
        )


configure_console_logging()
logger = logging.getLogger("sd-image-sorter")

from PIL import Image as _PILImage
_PILImage.MAX_IMAGE_PIXELS = 178956970  # ~13400x13400, prevents decompression bombs

from fastapi import FastAPI, Request, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware

import database as db
from exceptions import (
    SDImageSorterError,
    ImageNotFoundError,
    ImageFileNotFoundError,
    TaggingError,
    ScanError,
    ConfigurationError,
    ValidationError,
    FileOperationError,
    DatabaseError,
    ModelLoadError,
    OperationInProgressError,
    PathSecurityError,
)

# Import routers
from routers import images, tags, sorting, censor, prompts, similarity, artists, models, obfuscation, aesthetic, updates, disk, vlm, colors, tags_bulk, dataset

# Import services
from services import (
    ImageService,
    TaggingService,
    SortingService,
    CensorService,
    SimilarityService,
)


# Service instances (singleton pattern)
_image_service: Optional[ImageService] = None
_sorting_service: Optional[SortingService] = None
_censor_service: Optional[CensorService] = None
_similarity_service: Optional[SimilarityService] = None

# Lock for thread-safe singleton creation
_service_lock = threading.Lock()


def get_tagger(
    model_name: Optional[str] = None,
    model_path: Optional[str] = None,
    tags_path: Optional[str] = None,
    threshold: float = 0.35,
    character_threshold: float = 0.85,
    use_gpu: bool = True
) -> "WD14Tagger":
    """Get or create the tagger instance with given settings."""
    from tagger import get_tagger as _get_tagger, DEFAULT_MODEL

    model_name = model_name or DEFAULT_MODEL

    return _get_tagger(
        model_name=model_name,
        model_path=model_path,
        tags_path=tags_path,
        threshold=threshold,
        character_threshold=character_threshold,
        use_gpu=use_gpu
    )


def get_image_service() -> ImageService:
    """Get the ImageService singleton with thread-safe double-checked locking."""
    global _image_service
    if _image_service is None:
        with _service_lock:
            if _image_service is None:
                _image_service = ImageService()
    return _image_service



def get_sorting_service() -> SortingService:
    """Get the SortingService singleton with thread-safe double-checked locking."""
    global _sorting_service
    if _sorting_service is None:
        with _service_lock:
            if _sorting_service is None:
                _sorting_service = SortingService()
    return _sorting_service


def get_censor_service() -> CensorService:
    """Get the CensorService singleton with thread-safe double-checked locking."""
    global _censor_service
    if _censor_service is None:
        with _service_lock:
            if _censor_service is None:
                _censor_service = CensorService()
    return _censor_service


def get_similarity_service() -> SimilarityService:
    """Get the SimilarityService singleton with thread-safe double-checked locking."""
    global _similarity_service
    if _similarity_service is None:
        with _service_lock:
            if _similarity_service is None:
                _similarity_service = SimilarityService()
    return _similarity_service


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application startup and shutdown handler."""
    # Startup
    logger.info("SD Image Sorter backend starting...")
    _install_windows_loop_exception_handler()

    # Ensure all required directories exist
    ensure_directories()

    # Validate configuration and log warnings
    config_warnings = validate_config()
    for warning in config_warnings:
        logger.warning(f"Configuration warning: {warning}")

    db.init_db()

    bind_host = os.environ.get("SD_IMAGE_SORTER_BIND_HOST", SERVER_HOST)
    if not _is_loopback_host(bind_host):
        raise RuntimeError(
            "This application only allows localhost binding. Set SD_IMAGE_SORTER_BIND_HOST to 127.0.0.1 or localhost."
        )

    # Initialize services
    logger.info("Initializing services...")
    image_svc = get_image_service()
    tagging_svc = tags.get_tagging_service()
    sorting_svc = get_sorting_service()
    censor_svc = get_censor_service()
    similarity_svc = get_similarity_service()

    # Load sort session from disk
    sorting_svc.load_session_from_disk()

    # Set tagger getter for tagging service
    tagging_svc.set_tagger_getter(get_tagger)

    # Configure routers with service instances
    images.set_image_service(image_svc)
    tags.set_tagging_service(tagging_svc)
    sorting.set_sorting_service(sorting_svc)
    censor.set_censor_service(censor_svc)
    similarity.set_similarity_service(similarity_svc)

    logger.info("Services initialized successfully")

    yield
    # Shutdown
    logger.info("Shutting down...")


app = FastAPI(
    title="SD Image Sorter",
    description="""
# SD Image Sorter API

A local web application for managing, tagging, sorting, and censoring Stable Diffusion generated images.

## Features

- **Image Management**: Scan folders, retrieve images with filters, serve files
- **AI Tagging**: WD14 tagger for automatic image tagging
- **Sorting**: Batch move operations and manual keyboard sorting sessions
- **Censoring**: NSFW detection with multiple backends (YOLOv8, NudeNet, SAM3)
- **Similarity Search**: CLIP-based image similarity and duplicate detection
- **Prompt Generation**: Intelligent prompt builder with exclusion rules

## Authentication

**None required.** This is a local-only application with CORS restricted to localhost.

## Interactive Documentation

- **Swagger UI**: `/docs`
- **ReDoc**: `/redoc`

## Getting Started

1. Scan a folder: `POST /api/scan`
2. Tag images: `POST /api/tag`
3. Browse images: `GET /api/images`
4. Sort manually: `POST /api/sort/start`

For detailed documentation, see `docs/API.md` in the GitHub repository:
https://github.com/peter119lee/sd-image-sorter/blob/main/docs/API.md
    """,
    version=APP_VERSION,
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url="/redoc",
    openapi_tags=[
        {"name": "images", "description": "Image retrieval, filtering, and file serving"},
        {"name": "tags", "description": "Tag management, AI tagging, and import/export"},
        {"name": "sorting", "description": "Scanning, moving, batch operations, and manual sorting"},
        {"name": "censor", "description": "NSFW detection and image censoring"},
        {"name": "prompts", "description": "Prompt generation and tag categorization"},
        {"name": "similarity", "description": "Image similarity search and duplicate detection"},
        {"name": "artists", "description": "Artist/style identification"},
        {"name": "models", "description": "Model inventory and first-run preparation"},
        {"name": "updates", "description": "Package-local application update checks and apply flow"},
    ]
)


LOCALHOST_ALIASES = {"127.0.0.1", "localhost", "::1", "[::1]"}
RATE_LIMIT_ENABLED = CONFIG_RATE_LIMIT_ENABLED
RATE_LIMIT_WINDOW_SECONDS = CONFIG_RATE_LIMIT_WINDOW_SECONDS
RATE_LIMIT_MAX_REQUESTS = CONFIG_RATE_LIMIT_MAX_REQUESTS
RATE_LIMIT_APPLY_TO_LOOPBACK = CONFIG_RATE_LIMIT_APPLY_TO_LOOPBACK
RATE_LIMIT_EXEMPT_PATHS = {"/docs", "/redoc", "/openapi.json"}
RATE_LIMIT_EXEMPT_PREFIXES = ("/static", "/api/image-file", "/api/image-thumbnail")
_rate_limit_lock = threading.Lock()
_rate_limit_buckets: dict[str, deque[float]] = defaultdict(deque)
_rate_limit_cleanup_time = [0.0]
_RATE_LIMIT_CLEANUP_INTERVAL = 300  # 5 minutes


def _is_loopback_host(host: Optional[str]) -> bool:
    """Return True when the host refers to the local machine."""
    if not host:
        return False
    if host == "testclient" and os.environ.get("SD_SORTER_TESTING") == "1":
        return True
    if host in LOCALHOST_ALIASES:
        return True
    try:
        return ipaddress.ip_address(host.strip("[]")).is_loopback
    except ValueError:
        return False


def _is_rate_limit_exempt(path: str) -> bool:
    """Return True when a request path should skip in-memory rate limiting."""
    return path in RATE_LIMIT_EXEMPT_PATHS or path.startswith(RATE_LIMIT_EXEMPT_PREFIXES)


# CORS for frontend
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=CORS_ORIGIN_REGEX,
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Accept", "X-Requested-With"],
)


@app.middleware("http")
async def localhost_only_middleware(request: Request, call_next):
    """Reject non-local clients even if the server is started on a wider bind address."""
    client_host = request.client.host if request.client else None
    if client_host and not _is_loopback_host(client_host):
        logger.warning("Rejected non-local request from %s to %s", client_host, request.url.path)
        return JSONResponse(
            status_code=403,
            content={"error": "This application only accepts local requests", "type": "Forbidden"},
        )
    return await call_next(request)


@app.middleware("http")
async def rate_limit_middleware(request: Request, call_next):
    """Apply a lightweight in-memory rate limit to API requests."""
    if not RATE_LIMIT_ENABLED:
        return await call_next(request)

    path = request.url.path
    if _is_rate_limit_exempt(path):
        return await call_next(request)

    client_host = request.client.host if request.client else "unknown"
    if client_host and _is_loopback_host(client_host) and not RATE_LIMIT_APPLY_TO_LOOPBACK:
        return await call_next(request)

    now = time.monotonic()
    cutoff = now - RATE_LIMIT_WINDOW_SECONDS

    with _rate_limit_lock:
        bucket = _rate_limit_buckets[client_host]
        while bucket and bucket[0] <= cutoff:
            bucket.popleft()
        if len(bucket) >= RATE_LIMIT_MAX_REQUESTS:
            logger.warning("Rate limit exceeded for %s on %s", client_host, path)
            return JSONResponse(
                status_code=429,
                content={"error": "Too many requests. Please try again shortly.", "type": "RateLimitExceeded"},
            )
        bucket.append(now)

        # Periodically clean up stale rate limit buckets
        if now - _rate_limit_cleanup_time[0] > _RATE_LIMIT_CLEANUP_INTERVAL:
            _rate_limit_cleanup_time[0] = now
            stale_keys = [k for k, v in _rate_limit_buckets.items() if not v]
            for k in stale_keys:
                del _rate_limit_buckets[k]

    return await call_next(request)


@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    """Add security headers to all responses."""
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    return response


# Serve frontend static files
frontend_path = str(BACKEND_DIR.parent / "frontend")
if os.path.exists(frontend_path):
    app.mount("/static", StaticFiles(directory=frontend_path), name="static")


# Regex used by GET / to add ``?v=APP_VERSION`` to /static/*.js and *.css URLs
# in index.html. Matches src="/static/.../foo.js" and href="/static/.../foo.css"
# but only when no query string is already present, so we never double-append.
_STATIC_CACHE_BUST_RE = re.compile(r'((?:src|href)=")(/static/[^"?]+\.(?:js|css))(")')


def _static_cache_bust_token(asset_path: str) -> str:
    """Return a cache-bust token that changes for same-version repacks too."""
    relative_path = asset_path.removeprefix("/static/").replace("/", os.sep)
    full_path = os.path.join(frontend_path, relative_path)
    try:
        stat = os.stat(full_path)
    except OSError:
        return APP_VERSION
    raw = f"{APP_VERSION}:{int(stat.st_mtime_ns)}:{stat.st_size}"
    return f"{APP_VERSION}.{zlib.crc32(raw.encode('utf-8')) & 0xffffffff:08x}"


def _inject_static_cache_busters(html: str) -> str:
    def replace(match: re.Match[str]) -> str:
        prefix, asset_path, suffix = match.groups()
        return f'{prefix}{asset_path}?v={_static_cache_bust_token(asset_path)}{suffix}'

    return _STATIC_CACHE_BUST_RE.sub(replace, html)


# Include routers
app.include_router(images.router)
app.include_router(tags.router)
app.include_router(sorting.router)
app.include_router(censor.router)
app.include_router(prompts.router)
app.include_router(similarity.router)
app.include_router(artists.router)
app.include_router(models.router)
app.include_router(obfuscation.router)
app.include_router(aesthetic.router)
app.include_router(updates.router)
app.include_router(disk.router)
app.include_router(vlm.router)
app.include_router(colors.router)
app.include_router(tags_bulk.router)
app.include_router(dataset.router)


def _read_tail_lines(path: Path, max_lines: int) -> tuple[list[str], int]:
    if max_lines <= 0 or not path.exists() or not path.is_file():
        return [], 0
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return [], 0
    return lines[-max_lines:], len(lines)


def _redact_support_log_text(text: str) -> str:
    """Redact likely local filesystem paths before exposing logs to the browser."""
    field_boundary = r"(?=(?:\s+[-A-Za-z0-9_]+[:=])|[\r\n\"'<>]|$)"
    text = re.sub(rf"[A-Za-z]:\\.*?{field_boundary}", "<PATH>", text)
    text = re.sub(rf"(?<!\w)/(?:mnt|home|Users|var|tmp|Volumes|media)/.*?{field_boundary}", "<PATH>", text)
    return text


def build_support_diagnostics(max_lines: int = 200) -> Dict[str, Any]:
    """Return a bounded, redacted diagnostics payload users can copy from the UI."""
    log_path = Path(LOG_FILE_PATH)
    lines, line_count = _read_tail_lines(log_path, max(1, min(int(max_lines or 200), 1000)))
    redacted_lines = [_redact_support_log_text(line) for line in lines]
    recent_log_text = "\n".join(redacted_lines)
    return {
        "app_version": APP_VERSION,
        "log_level": LOG_LEVEL.upper(),
        "access_log_enabled": bool(LOG_ACCESS_ENABLED),
        "log_file_enabled": bool(LOG_FILE_ENABLED),
        "log_file_path": str(log_path),
        "log_file_path_redacted": _redact_support_log_text(str(log_path)),
        "log_file_exists": log_path.exists(),
        "log_file_max_bytes": LOG_FILE_MAX_BYTES,
        "log_file_backup_count": LOG_FILE_BACKUP_COUNT,
        "log_line_count": line_count,
        "recent_log_text": recent_log_text,
        "recent_log_lines": redacted_lines,
    }


def _build_file_manager_command(path: Path) -> Optional[list[str]]:
    """Build an OS file-manager command for a trusted local path, if one exists."""
    normalized_path = str(path.resolve())
    if sys.platform == "win32":
        return ["explorer", "/select,", normalized_path] if path.is_file() else ["explorer", normalized_path]
    if sys.platform == "darwin":
        opener = shutil.which("open")
        if not opener:
            return None
        return [opener, "-R", normalized_path] if path.is_file() else [opener, normalized_path]

    opener = shutil.which("xdg-open")
    if not opener:
        return None
    target = normalized_path if path.is_dir() else str(path.parent.resolve())
    return [opener, target]


def _open_path_in_file_manager(path: Path) -> bool:
    """Open a known local path in the OS file manager without accepting user input."""
    command = _build_file_manager_command(path)
    if not command:
        return False
    subprocess.Popen(command)
    return True


def open_support_log_file() -> Dict[str, Any]:
    """Open the configured support log location in the user's file manager."""
    if not LOG_FILE_ENABLED:
        raise HTTPException(status_code=409, detail="Support log file is disabled")

    log_path = Path(LOG_FILE_PATH)

    try:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        if not log_path.exists():
            log_path.touch()
        opened = _open_path_in_file_manager(log_path)
    except OSError as exc:
        logger.warning("Failed to open support log file %s: %s", LOG_FILE_PATH, exc)
        raise HTTPException(status_code=500, detail=f"Failed to open support log file: {exc}") from exc

    payload = {
        "success": opened,
        "opened": opened,
        "path": str(log_path),
        "path_redacted": _redact_support_log_text(str(log_path)),
        "exists": log_path.exists(),
    }
    if not opened:
        payload["message"] = "No OS file manager command is available; copy the log path manually."
    return payload



# ============================================================
# Exception Handlers
# ============================================================

@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    """Handle request validation errors with user-friendly messages."""
    errors = []
    for error in exc.errors():
        field = ".".join(str(loc) for loc in error.get("loc", []))
        msg = error.get("msg", "Invalid value")
        errors.append({"field": field, "message": msg})

    logger.warning(
        "Validation error on %s %s: %s",
        request.method,
        request.url.path,
        errors
    )
    return JSONResponse(
        status_code=400,
        content={
            "error": "Invalid request parameters",
            "type": "ValidationError",
            "details": errors
        }
    )


@app.exception_handler(SDImageSorterError)
async def sd_image_sorter_exception_handler(request: Request, exc: SDImageSorterError) -> JSONResponse:
    """Handle custom SD Image Sorter exceptions with appropriate HTTP status codes."""
    # Map exception types to HTTP status codes
    status_code_map = {
        ImageNotFoundError: 404,
        ImageFileNotFoundError: 404,
        ValidationError: 400,
        PathSecurityError: 400,
        ConfigurationError: 500,
        TaggingError: 500,
        ScanError: 500,
        FileOperationError: 500,
        DatabaseError: 500,
        ModelLoadError: 500,
        OperationInProgressError: 409,  # Conflict
    }

    status_code = status_code_map.get(type(exc), 500)

    # Log with appropriate level based on status code
    log_level = logging.WARNING if status_code < 500 else logging.ERROR
    logger.log(
        log_level,
        "%s on %s %s: %s",
        exc.__class__.__name__,
        request.method,
        request.url.path,
        exc.message,
        exc_info=exc if status_code >= 500 else None
    )

    response_content = exc.to_dict()

    # For 500 errors, don't expose internal details to client
    if status_code >= 500:
        response_content = {"error": exc.message, "type": exc.__class__.__name__}

    return JSONResponse(status_code=status_code, content=response_content)


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException) -> JSONResponse:
    """Handle HTTPExceptions with consistent JSON format."""
    logger.warning(
        "HTTP %d on %s %s: %s",
        exc.status_code,
        request.method,
        request.url.path,
        exc.detail
    )
    if isinstance(exc.detail, dict):
        payload = dict(exc.detail)
        if "message" in payload and "error" not in payload:
            payload["error"] = payload["message"]
        payload.setdefault("type", "HTTPException")
        payload.setdefault("status_code", exc.status_code)
        return JSONResponse(status_code=exc.status_code, content=payload)
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": exc.detail if isinstance(exc.detail, str) else "Request failed", "type": "HTTPException", "status_code": exc.status_code}
    )


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """Catch all unhandled exceptions and return a safe JSON error response.

    Stack traces are logged server-side but never sent to the client.
    """
    logger.error(
        "Unhandled exception on %s %s: %s",
        request.method,
        request.url.path,
        "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
    )
    return JSONResponse(
        status_code=500,
        content={"error": "Internal server error", "type": "UnhandledException"}
    )


@app.get("/api/support/diagnostics")
async def support_diagnostics(lines: int = 200):
    """Return a bounded support diagnostics bundle for copy/paste debugging."""
    return build_support_diagnostics(max_lines=lines)


@app.post("/api/support/open-log")
async def support_open_log():
    """Open the rotating support log file in the OS file manager."""
    return open_support_log_file()


@app.get("/")
async def root():
    """
    Serve the main frontend page.

    Injects ``?v=APP_VERSION`` cache-busters onto every ``/static/*.js`` and
    ``/static/*.css`` reference in ``index.html``. This ensures that when a
    user upgrades the app (e.g. v3.2.0 -> v3.2.1) the browser refetches the
    JS/CSS bundles on a normal F5, instead of silently serving the old
    cached language packs and breaking new i18n keys until the user does a
    hard refresh (ctrl+shift+r). DB rows, scan progress, filters and
    selections live in localStorage / SQLite so this is purely a transport
    fix; no user data is touched.
    """
    index_path = os.path.join(frontend_path, "index.html")
    if os.path.exists(index_path):
        try:
            with open(index_path, "r", encoding="utf-8") as f:
                html = f.read()
            html = _inject_static_cache_busters(html)
            return HTMLResponse(content=html, status_code=200)
        except OSError as exc:
            logger.warning("Falling back to FileResponse for index.html: %s", exc)
            return FileResponse(index_path)
    return {"message": "SD Image Sorter API", "docs": "/docs"}


# ============== Run Server ==============

def _check_host_security(host: str) -> None:
    """Enforce localhost-only binding."""
    if not _is_loopback_host(host):
        raise ValueError("This application only allows localhost binding. Use 127.0.0.1 or localhost.")


def _configure_event_loop_policy() -> None:
    """Use the selector event loop on Windows to avoid noisy Proactor shutdown resets."""
    if sys.platform != "win32":
        return

    selector_policy = getattr(asyncio, "WindowsSelectorEventLoopPolicy", None)
    if selector_policy is None:
        return

    current_policy = asyncio.get_event_loop_policy()
    if isinstance(current_policy, selector_policy):
        return

    asyncio.set_event_loop_policy(selector_policy())


def _should_ignore_windows_shutdown_connection_reset(context: Dict[str, Any]) -> bool:
    """Ignore the known Proactor shutdown reset noise on Windows without hiding real app errors."""
    if sys.platform != "win32":
        return False

    exc = context.get("exception")
    if not isinstance(exc, ConnectionResetError):
        return False
    if getattr(exc, "winerror", None) != 10054:
        return False

    message = str(context.get("message") or "")
    handle_repr = repr(context.get("handle")) if context.get("handle") else ""
    transport_marker = "_ProactorBasePipeTransport._call_connection_lost"
    return transport_marker in message or transport_marker in handle_repr


def _install_windows_loop_exception_handler() -> None:
    """Suppress the specific Proactor shutdown reset callback noise on Windows."""
    if sys.platform != "win32":
        return

    loop = asyncio.get_running_loop()
    previous_handler = loop.get_exception_handler()

    def handler(loop: asyncio.AbstractEventLoop, context: Dict[str, Any]) -> None:
        if _should_ignore_windows_shutdown_connection_reset(context):
            logger.debug("Ignored Windows Proactor shutdown ConnectionResetError noise: %s", context.get("message"))
            return

        if previous_handler is not None:
            previous_handler(loop, context)
            return

        loop.default_exception_handler(context)

    loop.set_exception_handler(handler)


if __name__ == "__main__":
    import argparse
    import uvicorn

    parser = argparse.ArgumentParser(description="SD Image Sorter Backend")
    parser.add_argument("--host", default=SERVER_HOST, help=f"Host to bind to (default: {SERVER_HOST})")
    parser.add_argument("--port", type=int, default=SERVER_PORT, help=f"Port to bind to (default: {SERVER_PORT})")
    args = parser.parse_args()

    _check_host_security(args.host)
    _configure_event_loop_policy()
    os.environ["SD_IMAGE_SORTER_BIND_HOST"] = args.host
    os.environ["SD_IMAGE_SORTER_PORT"] = str(args.port)
    logger.info(
        "Starting server on %s:%s (access_log=%s, log_level=%s, log_file=%s)",
        args.host,
        args.port,
        "on" if LOG_ACCESS_ENABLED else "off",
        LOG_LEVEL.upper(),
        LOG_FILE_PATH if LOG_FILE_ENABLED else "off",
    )
    uvicorn.run(
        app,
        host=args.host,
        port=args.port,
        access_log=LOG_ACCESS_ENABLED,
        log_level=LOG_LEVEL.lower(),
    )
