"""Frontend serving: the classic UI at / and /static, Vopus (the frontend-v4 build) at /vopus/."""

from __future__ import annotations

import logging
import os
import re
import zlib
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, HTMLResponse, PlainTextResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles


logger = logging.getLogger("sd-image-sorter")

# The Vite build of the second interface, Vopus.
FRONTEND_V4_DIST_PATH = Path(__file__).resolve().parent.parent / "frontend-v4" / "dist"

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


class ImmutableStaticFiles(StaticFiles):
    """Serve content-hashed build assets with a year-long immutable cache."""

    async def get_response(self, path: str, scope):  # type: ignore[override]
        response = await super().get_response(path, scope)
        if response.status_code == 200:
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return response


V4_NOT_BUILT_MESSAGE = (
    "SD Image Sorter Vopus 界面还没有构建。\n"
    "安装 Node.js 后重新运行 run.bat（Windows）或 run.sh（Linux / macOS），会自动构建 Vopus 界面；"
    "也可以在 frontend-v4 文件夹里运行 npm ci 和 npm run build，然后刷新本页。\n"
    "\n"
    "SD Image Sorter Vopus has not been built yet.\n"
    "Install Node.js, then start the app again with run.bat (Windows) or run.sh (Linux / macOS): "
    "it builds Vopus automatically. You can also run npm ci and npm run build in the frontend-v4 folder, "
    "then reload this page.\n"
    "\n"
    "经典界面一直可以用：打开 / 即可。 The classic interface is always at /.\n"
)


def vopus_is_built(dist_path: Path | str | None = None) -> bool:
    """Whether the Vopus build exists (``FRONTEND_V4_DIST_PATH`` unless given)."""
    root = Path(dist_path) if dist_path is not None else FRONTEND_V4_DIST_PATH
    return (root / "index.html").is_file()


def serve_root(request: Request, *, frontend_path: str, app_version: str):
    """``/``: the classic UI, or a redirect to Vopus when Settings chose it and it is built.

    ``/?ui=classic`` always opens the classic UI, a way back if Vopus cannot load.
    """
    from services.interface_preference import VOPUS, get_preferred_interface

    if (
        request.query_params.get("ui") != "classic"
        and get_preferred_interface() == VOPUS
        and vopus_is_built()
    ):
        query = request.url.query
        return RedirectResponse(url=f"/vopus/?{query}" if query else "/vopus/", status_code=307)
    return serve_frontend_index(frontend_path=frontend_path, app_version=app_version)


def mount_frontend_v4(app: FastAPI, *, dist_path: str) -> None:
    """Serve the Vopus frontend build at /vopus/; the old /v4/ addresses lead there.

    ``dist_path`` is the Vite build output (index.html + content-hashed
    assets/). Client-side routes under /vopus/ fall back to index.html; asset
    paths never do, so a missing file is a real 404. ``/`` stays the classic UI
    (``serve_root``).
    """
    assets_path = os.path.join(dist_path, "assets")
    if os.path.isdir(assets_path):
        app.mount(
            "/vopus/assets", ImmutableStaticFiles(directory=assets_path), name="vopus-assets"
        )

    @app.get("/vopus", include_in_schema=False)
    async def vopus_redirect():
        return RedirectResponse(url="/vopus/")

    # Bookmarks and links from before the move keep their path and query.
    @app.get("/v4", include_in_schema=False)
    @app.get("/v4/{old_path:path}", include_in_schema=False)
    async def v4_moved(request: Request, old_path: str = ""):
        query = request.url.query
        target = f"/vopus/{old_path}" + (f"?{query}" if query else "")
        return RedirectResponse(url=target, status_code=308)

    @app.get("/vopus/{spa_path:path}", include_in_schema=False)
    async def vopus_index(spa_path: str = ""):
        index_path = os.path.join(dist_path, "index.html")
        if not os.path.isfile(index_path):
            return PlainTextResponse(V4_NOT_BUILT_MESSAGE, status_code=503)
        if spa_path.startswith("assets/") or spa_path == "assets":
            return PlainTextResponse("Not Found", status_code=404)
        return FileResponse(index_path, headers={"Cache-Control": "no-cache"})
