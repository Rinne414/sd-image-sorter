"""Frontend serving: the UI at / and /static. The retired second interfaces' addresses lead to /."""

from __future__ import annotations

import logging
import os
import re
import zlib
from urllib.parse import parse_qs

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles


logger = logging.getLogger("sd-image-sorter")

IMMUTABLE_CACHE = "public, max-age=31536000, immutable"

_STATIC_CACHE_BUST_RE = re.compile(r'((?:src|href)=")(/static/[^"?]+\.(?:js|css))(")')


class NoCacheStaticFiles(StaticFiles):
    """Serve frontend JS/CSS; a URL carrying the file's current ``?v=`` token is kept for good.

    GET / adds the token to the 219 classic scripts, and the token changes with
    the file, so the browser need not ask for each one again on every start
    (measured 2026-11-08: about a second of a warm start was spent there). A
    bare URL (a script appended at runtime) or a stale token revalidates.
    """

    async def get_response(self, path: str, scope):  # type: ignore[override]
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = (
            IMMUTABLE_CACHE if response.status_code == 200 and self._has_current_token(path, scope) else "no-cache"
        )
        return response

    def _has_current_token(self, path: str, scope) -> bool:
        from app_info import APP_VERSION

        tokens = parse_qs(scope.get("query_string", b"").decode("latin-1")).get("v")
        if not tokens or not self.directory:
            return False
        current = static_cache_bust_token(
            "/static/" + path.replace(os.sep, "/"),
            frontend_path=str(self.directory),
            app_version=APP_VERSION,
        )
        return tokens[0] == current


def static_cache_bust_token(asset_path: str, *, frontend_path: str, app_version: str) -> str:
    """Return a cache-bust token that changes for same-version repacks too."""
    relative_path = asset_path.removeprefix("/static/").replace("/", os.sep)
    full_path = os.path.join(frontend_path, relative_path)
    try:
        stat = os.stat(full_path)
    except OSError:
        return app_version
    raw = f"{app_version}:{int(stat.st_mtime_ns)}:{stat.st_size}"
    return f"{app_version}.{zlib.crc32(raw.encode('utf-8')) & 0xffffffff:08x}"


def inject_static_cache_busters(html: str, *, frontend_path: str, app_version: str) -> str:
    """Append content-derived cache-bust tokens to bare frontend JS/CSS URLs."""

    def replace(match: re.Match[str]) -> str:
        prefix, asset_path, suffix = match.groups()
        token = static_cache_bust_token(
            asset_path,
            frontend_path=frontend_path,
            app_version=app_version,
        )
        return f'{prefix}{asset_path}?v={token}{suffix}'

    return _STATIC_CACHE_BUST_RE.sub(replace, html)


def mount_frontend_static(app: FastAPI, *, frontend_path: str) -> None:
    """Mount the frontend static directory when present."""
    if os.path.exists(frontend_path):
        app.mount("/static", NoCacheStaticFiles(directory=frontend_path), name="static")


def serve_frontend_index(*, frontend_path: str, app_version: str):
    """Serve index.html with cache-busted static references."""
    index_path = os.path.join(frontend_path, "index.html")
    if not os.path.exists(index_path):
        return {"message": "SD Image Sorter API", "docs": "/docs"}

    try:
        with open(index_path, "r", encoding="utf-8") as handle:
            html = handle.read()
        html = inject_static_cache_busters(
            html,
            frontend_path=frontend_path,
            app_version=app_version,
        )
        return HTMLResponse(
            content=html,
            status_code=200,
            headers={"Cache-Control": "no-cache"},
        )
    except OSError as exc:
        logger.warning("Falling back to FileResponse for index.html: %s", exc)
        return FileResponse(index_path, headers={"Cache-Control": "no-cache"})


# V Opus (/vopus/, earlier /v4/) and the /next/ trial were second interfaces to
# the same program. They were retired on 2026-11-12: every feature had to be
# built and tested twice, and they had fallen behind. Their addresses still
# answer, so a bookmark or a remembered choice lands in the program.
RETIRED_INTERFACE_PREFIXES = ("vopus", "v4", "next")


def serve_root(request: Request, *, frontend_path: str, app_version: str):
    """``/``: the program's page (``?ui=classic`` from older links is simply ignored)."""
    return serve_frontend_index(frontend_path=frontend_path, app_version=app_version)


def mount_retired_interfaces(app: FastAPI) -> None:
    """Send /vopus/, /v4/ and /next/ (and anything under them) to ``/``."""

    async def moved(request: Request):
        return RedirectResponse(url="/", status_code=307)

    for prefix in RETIRED_INTERFACE_PREFIXES:
        app.add_api_route(f"/{prefix}", moved, methods=["GET"], include_in_schema=False)
        app.add_api_route(
            f"/{prefix}/{{old_path:path}}", moved, methods=["GET"], include_in_schema=False
        )
