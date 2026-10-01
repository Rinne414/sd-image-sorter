"""Security and request middleware wiring for the FastAPI app."""

from __future__ import annotations

import ipaddress
import logging
import os
import re
import threading
import time
from collections import defaultdict, deque
from typing import Mapping, Optional
from urllib.parse import urlsplit

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from config import (
    CORS_ORIGIN_REGEX,
    RATE_LIMIT_APPLY_TO_LOOPBACK as CONFIG_RATE_LIMIT_APPLY_TO_LOOPBACK,
    RATE_LIMIT_ENABLED as CONFIG_RATE_LIMIT_ENABLED,
    RATE_LIMIT_MAX_REQUESTS as CONFIG_RATE_LIMIT_MAX_REQUESTS,
    RATE_LIMIT_WINDOW_SECONDS as CONFIG_RATE_LIMIT_WINDOW_SECONDS,
    SERVER_PORT,
)


logger = logging.getLogger("sd-image-sorter")

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
_RATE_LIMIT_CLEANUP_INTERVAL = 300


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


# The API answers only its own page and local non-browser clients (the MCP
# server, the release QA script). The client IP check above cannot tell a
# browser that was sent here by another site: DNS rebinding resolves the
# attacker's hostname to 127.0.0.1, and a cross-site page can fire simple
# requests at a local port. Three headers can.
API_GUARD_PREFIX = "/api/"
_TEST_SERVER_HOST = "testserver"  # starlette's TestClient default
# Exactly host[:port] / scheme://host[:port]: userinfo, a path, a query, a
# fragment, whitespace or a second value is refused before anything parses it.
_HOST_TOKEN = r"(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(:[0-9]{1,5})?"
_HOST_HEADER_RE = re.compile(rf"^{_HOST_TOKEN}$")
_ORIGIN_RE = re.compile(rf"^https?://{_HOST_TOKEN}$")
# A rejection is logged once per reason per interval; the rest are counted
# and reported with the next line, so a hostile page cannot flood the log.
REJECTION_LOG_INTERVAL_SECONDS = 60
_rejection_log_lock = threading.Lock()
_rejection_log_state: dict[str, tuple[float, int]] = {}  # reason -> (last logged, skipped since)


def _bound_port(request: Request) -> int:
    """The port the socket that received this request is bound to. uvicorn
    fills scope["server"] from the socket, so no client can choose it; the
    --port main.py recorded in the env is only the fallback for a server
    that did not fill it."""
    server = request.scope.get("server")
    if isinstance(server, (tuple, list)) and len(server) == 2:
        port = server[1]
        if isinstance(port, int) and port > 0:
            return port
    raw = os.environ.get("SD_IMAGE_SORTER_PORT", "").strip()
    try:
        return int(raw) if raw else SERVER_PORT
    except ValueError:
        return SERVER_PORT


def _is_testing() -> bool:
    return os.environ.get("SD_SORTER_TESTING") == "1"


def _split_host_header(value: str) -> tuple[Optional[str], Optional[int]]:
    """(hostname, port) of a Host header; (None, None) when it is not exactly
    host[:port]. urlsplit then lowercases the name, strips IPv6 brackets
    and rejects a port out of range."""
    if not _HOST_HEADER_RE.match(value):
        return None, None
    try:
        parts = urlsplit("//" + value)
        return parts.hostname, parts.port
    except ValueError:
        return None, None


def _host_header_allowed(host_header: Optional[str], *, bound_port: int, testing: bool) -> bool:
    """A loopback name on the bound port. A rebound hostname, another local
    server's port and a LAN address all fail. The test gate also accepts
    starlette's ``testserver`` and a port-less loopback host."""
    hostname, port = _split_host_header(host_header or "")
    if not hostname:
        return False
    if testing and hostname == _TEST_SERVER_HOST:
        return True
    if not _is_loopback_host(hostname):
        return False
    if port is None:
        port = 80  # what a port-less Host header means
    return port == bound_port or testing


def _origin_allowed(origin: Optional[str]) -> bool:
    """Absent: a non-browser client or a same-origin GET. Present: a loopback
    origin on any port, so another local web app may still call the API."""
    if origin is None:
        return True
    if not _ORIGIN_RE.match(origin):
        return False
    try:
        parts = urlsplit(origin)
    except ValueError:
        return False
    return bool(parts.hostname) and _is_loopback_host(parts.hostname)


def api_request_rejection(
    *, path: str, method: str, headers: Mapping[str, str], bound_port: int, testing: bool
) -> Optional[str]:
    """Why an /api request must be refused ("host", "origin",
    "sec-fetch-site"), or None when it may proceed. Pure: the middleware
    and the tests call it with the same arguments."""
    if not path.startswith(API_GUARD_PREFIX):
        return None
    if not _host_header_allowed(headers.get("host"), bound_port=bound_port, testing=testing):
        return "host"
    if not _origin_allowed(headers.get("origin")):
        return "origin"
    site = (headers.get("sec-fetch-site") or "").strip().lower()
    if site == "cross-site" and headers.get("origin") is None:
        # Another local web app (localhost:3000 calling 127.0.0.1:8487 is
        # cross-site to the browser) sends a loopback Origin, checked above.
        # A link, a GET form, window.open, location= and a hidden <iframe>
        # are navigations and carry none: any site could make the browser
        # GET /api/... with a query string of its choosing.
        return "sec-fetch-site"
    return None


def _log_rejection(reason: str, method: str, path: str, value: Optional[str]) -> None:
    now = time.monotonic()
    with _rejection_log_lock:
        last_logged, skipped = _rejection_log_state.get(reason, (None, 0))
        if last_logged is not None and now - last_logged < REJECTION_LOG_INTERVAL_SECONDS:
            _rejection_log_state[reason] = (last_logged, skipped + 1)
            return
        _rejection_log_state[reason] = (now, 0)
    suffix = (
        f" (skipped {skipped} similar in the last {REJECTION_LOG_INTERVAL_SECONDS}s)"
        if skipped
        else ""
    )
    logger.warning(
        "Rejected %s %s: %s header is not this app's (%r)%s", method, path, reason, value, suffix
    )


async def api_request_guard_middleware(request: Request, call_next):
    """Refuse /api requests that another site or a rebound hostname sent."""
    reason = api_request_rejection(
        path=request.url.path,
        method=request.method,
        headers=request.headers,
        bound_port=_bound_port(request),
        testing=_is_testing(),
    )
    if reason is not None:
        _log_rejection(reason, request.method, request.url.path, request.headers.get(reason))
        return JSONResponse(
            status_code=403,
            content={
                "error": "This application only accepts requests from its own page",
                "type": "Forbidden",
            },
        )
    return await call_next(request)


async def localhost_only_middleware(request: Request, call_next):
    """Reject non-loopback clients.

    Production bind in ``main.py`` is already loopback. This is a second
    guard if the bind host is ever widened.
    """
    client_host = request.client.host if request.client else None
    if client_host and not _is_loopback_host(client_host):
        logger.warning("Rejected non-local request from %s to %s", client_host, request.url.path)
        return JSONResponse(
            status_code=403,
            content={"error": "This application only accepts local requests", "type": "Forbidden"},
        )
    return await call_next(request)


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

        if now - _rate_limit_cleanup_time[0] > _RATE_LIMIT_CLEANUP_INTERVAL:
            _rate_limit_cleanup_time[0] = now
            stale_keys = [key for key, value in _rate_limit_buckets.items() if not value]
            for key in stale_keys:
                del _rate_limit_buckets[key]

    return await call_next(request)


async def add_security_headers(request: Request, call_next):
    """Add security headers to all responses."""
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    return response


async def library_workspace_middleware(request: Request, call_next):
    """Bind long-lived library id for the request (multi-library isolation)."""
    from library_context import (
        LIBRARY_HEADER,
        bind_library_id_from_header,
        reset_current_library_id,
    )

    token = bind_library_id_from_header(request.headers.get(LIBRARY_HEADER))
    try:
        return await call_next(request)
    finally:
        reset_current_library_id(token)


def configure_security_middleware(app: FastAPI) -> None:
    """Attach CORS, local-only, rate-limit, and security-header middleware."""
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=CORS_ORIGIN_REGEX,
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=[
            "Content-Type",
            "Accept",
            "X-Requested-With",
            "X-SD-Library-Id",
        ],
    )
    app.middleware("http")(localhost_only_middleware)
    app.middleware("http")(api_request_guard_middleware)
    app.middleware("http")(rate_limit_middleware)
    app.middleware("http")(library_workspace_middleware)
    app.middleware("http")(add_security_headers)

