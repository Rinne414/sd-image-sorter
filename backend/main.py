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
import logging
import threading
import time
import traceback
from collections import defaultdict, deque
from typing import Optional, Dict, Any
from contextlib import asynccontextmanager

# Add current dir to path for imports
sys.path.insert(0, os.path.dirname(__file__))

from config import (
    SERVER_HOST,
    SERVER_PORT,
    CORS_ORIGIN_REGEX,
    LOG_LEVEL,
    BACKEND_DIR,
    validate_config,
    ensure_directories,
)

# Configure logging
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL.upper(), logging.INFO),
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger("sd-image-sorter")

from PIL import Image as _PILImage
_PILImage.MAX_IMAGE_PIXELS = 178956970  # ~13400x13400, prevents decompression bombs

from fastapi import FastAPI, Request, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware

import database as db
from exceptions import (
    SDImageSorterError,
    ImageNotFoundError,
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
from routers import images, tags, sorting, censor, prompts, similarity, artists, models, obfuscation, aesthetic

# Import services
from services import (
    ImageService,
    TaggingService,
    SortingService,
    CensorService,
    SimilarityService,
)


# Lazy import tagger to avoid loading model at startup
_tagger = None
_tagger_settings: Dict[str, Any] = {}

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
    global _tagger, _tagger_settings
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

For detailed documentation, see `docs/API.md`.
    """,
    version="3.0.0",
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
    ]
)


LOCALHOST_ALIASES = {"127.0.0.1", "localhost", "::1", "[::1]"}
RATE_LIMIT_WINDOW_SECONDS = 60
RATE_LIMIT_MAX_REQUESTS = 1000
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
    path = request.url.path
    if _is_rate_limit_exempt(path):
        return await call_next(request)

    client_host = request.client.host if request.client else "unknown"
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


@app.get("/")
async def root():
    """Serve the main frontend page."""
    index_path = os.path.join(frontend_path, "index.html")
    if os.path.exists(index_path):
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
    logger.info(f"Starting server on {args.host}:{args.port}")
    uvicorn.run(app, host=args.host, port=args.port)
