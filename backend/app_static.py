"""Frontend serving: the V4 build at /v4/, and / redirecting to it."""

from __future__ import annotations

import os

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, PlainTextResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles


class ImmutableStaticFiles(StaticFiles):
    """Serve content-hashed build assets with a year-long immutable cache."""

    async def get_response(self, path: str, scope):  # type: ignore[override]
        response = await super().get_response(path, scope)
        if response.status_code == 200:
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return response


V4_NOT_BUILT_MESSAGE = (
    "SD Image Sorter V4 界面还没有构建。\n"
    "安装 Node.js 后重新运行 run.bat（Windows）或 run.sh（Linux / macOS），会自动构建 V4；"
    "也可以在 frontend-v4 文件夹里运行 npm ci 和 npm run build，然后刷新本页。\n"
    "\n"
    "SD Image Sorter V4 has not been built yet.\n"
    "Install Node.js, then start the app again with run.bat (Windows) or run.sh (Linux / macOS): "
    "it builds V4 automatically. You can also run npm ci and npm run build in the frontend-v4 folder, "
    "then reload this page.\n"
)


def root_redirect_url(request: Request) -> str:
    """The V4 address for a request to /, keeping its query string."""
    query = request.url.query
    return f"/v4/?{query}" if query else "/v4/"


def mount_frontend_v4(app: FastAPI, *, dist_path: str) -> None:
    """Serve the V4 frontend build at /v4/ and send / there.

    ``dist_path`` is the Vite build output (index.html + content-hashed
    assets/). Client-side routes under /v4/ fall back to index.html; asset
    paths never do, so a missing file is a real 404.
    """
    assets_path = os.path.join(dist_path, "assets")
    if os.path.isdir(assets_path):
        app.mount(
            "/v4/assets", ImmutableStaticFiles(directory=assets_path), name="v4-assets"
        )

    @app.get("/", include_in_schema=False)
    async def root_redirect(request: Request):
        return RedirectResponse(url=root_redirect_url(request))

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
