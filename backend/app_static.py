"""Frontend static-file serving and cache-bust helpers."""

from __future__ import annotations

import logging
import os
import re
import zlib

from fastapi import FastAPI
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles


logger = logging.getLogger("sd-image-sorter")

_STATIC_CACHE_BUST_RE = re.compile(r'((?:src|href)=")(/static/[^"?]+\.(?:js|css))(")')


class NoCacheStaticFiles(StaticFiles):
    """Serve frontend JS/CSS with ``Cache-Control: no-cache``."""

    async def get_response(self, path: str, scope):  # type: ignore[override]
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache"
        return response


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

