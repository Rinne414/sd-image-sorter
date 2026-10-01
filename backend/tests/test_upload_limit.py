"""Oversized uploads are refused before the multipart body is parsed."""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route
from starlette.testclient import TestClient

from upload_limit import ENVELOPE_ALLOWANCE, MIB, UPLOAD_LIMITS, UploadSizeLimitMiddleware

LIMIT = MIB


def _app(calls: list):
    async def upload(request):
        calls.append(1)
        form = await request.form()
        data = await form["file"].read()
        return JSONResponse({"size": len(data)})

    async def other(request):
        await request.body()
        return JSONResponse({"ok": True})

    app = Starlette(routes=[Route("/up", upload, methods=["POST"]), Route("/other", other, methods=["POST"])])
    app.add_middleware(UploadSizeLimitMiddleware, limits={"/up": LIMIT})
    return app


def _temp_files() -> set[str]:
    return {p.name for p in Path(tempfile.gettempdir()).iterdir()}


def test_declared_size_over_the_limit_is_refused_without_reaching_the_app_or_the_disk():
    calls: list = []
    client = TestClient(_app(calls))
    before = _temp_files()
    big = b"x" * (LIMIT + ENVELOPE_ALLOWANCE + 2 * MIB)
    response = client.post("/up", files={"file": ("a.png", big, "image/png")})
    assert response.status_code == 413
    assert "too large" in response.json()["detail"]
    assert calls == []
    assert _temp_files() == before


def test_chunked_upload_is_cut_off_at_the_limit():
    calls: list = []
    client = TestClient(_app(calls))

    def chunks():
        for _ in range(8):
            yield b"y" * (512 * 1024)

    response = client.post(
        "/up",
        content=chunks(),
        headers={"content-type": "multipart/form-data; boundary=zz"},
    )
    assert response.status_code == 413


def test_an_upload_within_the_limit_passes():
    client = TestClient(_app([]))
    response = client.post("/up", files={"file": ("a.png", b"z" * 1000, "image/png")})
    assert response.status_code == 200 and response.json() == {"size": 1000}


def test_other_paths_are_not_limited():
    client = TestClient(_app([]))
    response = client.post("/other", content=b"q" * (LIMIT * 3))
    assert response.status_code == 200


@pytest.mark.parametrize("path", sorted(UPLOAD_LIMITS))
def test_the_real_app_refuses_a_huge_declared_upload_on_both_upload_routes(test_client, path):
    before = _temp_files()
    response = test_client.post(
        path,
        content=b"tiny",
        headers={
            "content-type": "multipart/form-data; boundary=zz",
            "content-length": str(UPLOAD_LIMITS[path] + ENVELOPE_ALLOWANCE + 1),
        },
    )
    assert response.status_code == 413
    assert _temp_files() == before
