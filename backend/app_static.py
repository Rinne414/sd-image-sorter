"""Frontend static-file serving and cache-bust helpers."""

from __future__ import annotations

import logging
import os
import re
import zlib

from fastapi import FastAPI
from fastapi.responses import FileResponse, HTMLResponse, PlainTextResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles


logger = logging.getLogger("sd-image-sorter")

_STATIC_CACHE_BUST_RE = re.compile(r'((?:src|href)=")(/static/[^"?]+\.(?:js|css))(")')


class ImmutableStaticFiles(StaticFiles):
    """Serve content-hashed build assets with a year-long immutable cache."""

    async def get_response(self, path: str, scope):  # type: ignore[override]
        response = await super().get_response(path, scope)
        if response.status_code == 200:
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return response


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


V4_NOT_BUILT_MESSAGE = (
    "SD Image Sorter V4 界面还没有构建。\n"
    "安装 Node.js 后重新运行 run.bat（Windows）或 run.sh（Linux / macOS），会自动构建 V4；"
    "也可以在 frontend-v4 文件夹里运行 npm ci 和 npm run build，然后刷新本页。\n"
    "不装 Node.js 也能用 V3.5：打开 /。\n"
    "\n"
    "SD Image Sorter V4 has not been built yet.\n"
    "Install Node.js, then start the app again with run.bat (Windows) or run.sh (Linux / macOS): "
    "it builds V4 automatically. You can also run npm ci and npm run build in the frontend-v4 folder, "
    "then reload this page.\n"
    "V3.5 works without Node.js: open /.\n"
)


def mount_frontend_v4(app: FastAPI, *, dist_path: str) -> None:
    """Serve the V4 frontend build at /v4/ next to the V3.5 app at /.

    ``dist_path`` is the Vite build output (index.html + content-hashed
    assets/). Client-side routes under /v4/ fall back to index.html; asset
    paths never do, so a missing file is a real 404.
    """
    assets_path = os.path.join(dist_path, "assets")
    if os.path.isdir(assets_path):
        app.mount("/v4/assets", ImmutableStaticFiles(directory=assets_path), name="v4-assets")

    @app.get("/v4", include_in_schema=False)
    async def v4_redirect():
        return RedirectResponse(url="/v4/")

    @app.get("/v4/{spa_path:path}", include_in_schema=False)
    async def v4_index(spa_path: str = ""):
        index_path = os.path.join(dist_path, "index.html")
        if not os.path.isfile(index_path):
            return PlainTextResponse(V4_NOT_BUILT_MESSAGE, status_code=503)
        if spa_path.startswith("assets/") or spa_path == "assets":
            return PlainTextResponse("Not Found", status_code=404)
        return FileResponse(index_path, headers={"Cache-Control": "no-cache"})
