"""Regression tests for security-fuzz Phase-5 findings.

Background
==========
Phase-5 security boundary fuzz surfaced these issues:

1. ``/api/obfuscate/preview`` returned 500 with the BytesIO repr leaked
   into the response body when given a non-image file (zip, HTML,
   empty bytes). The ``except Exception`` catch-all reported the raw
   error: ``Preview processing failed: cannot identify image file
   <_io.BytesIO object at 0x0000000000DEDE40>``. This both gave bad UX
   and leaked an internal Python object reference.

2. ``GET /api/images/999999999999999999999999`` (24-digit number that
   overflows int64) returned 500 with type ``UnhandledException``.
   The ``image_id: int`` path parameter wasn't bounded so SQLite int
   overflow propagated as a server error.

This file pins the fixes:
  - obfuscate preview now catches ``UnidentifiedImageError`` and
    OSError as 400 with sanitized messages.
  - ``/api/images/{image_id}`` now requires ``1 <= id <= 2_147_483_647``
    (signed 32-bit) and returns 400/422 for out-of-range values.
"""
from __future__ import annotations

import io
import zipfile
from pathlib import Path

import pytest


def _multipart_upload(client, path: str, file_name: str, file_bytes: bytes,
                     content_type: str = "image/png", **fields):
    files = {"file": (file_name, io.BytesIO(file_bytes), content_type)}
    return client.post(path, files=files, data=fields)


def test_obfuscate_preview_rejects_non_image_with_400(test_client):
    """Zip file disguised as PNG must return 400, not 500."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("a.txt", "hello")
    response = _multipart_upload(
        test_client,
        "/api/obfuscate/preview",
        "fake.png",
        buf.getvalue(),
        mode="decode",
        password="",
        compat_mode="big_tomato",
    )
    assert response.status_code == 400, (
        f"Expected 400 for non-image upload, got {response.status_code}: {response.text[:300]}"
    )
    body = response.json()
    detail = body.get("detail") or body.get("error") or ""
    assert "BytesIO" not in detail, "Response leaked BytesIO repr"
    assert "0x" not in detail, "Response leaked memory-address-like value"


def test_obfuscate_preview_rejects_empty_with_400(test_client):
    """Empty file must return 400, not 500."""
    response = _multipart_upload(
        test_client,
        "/api/obfuscate/preview",
        "empty.png",
        b"",
        mode="decode",
        password="",
        compat_mode="big_tomato",
    )
    assert response.status_code == 400


def test_obfuscate_preview_rejects_html_with_400(test_client):
    """HTML payload must return 400, not 500."""
    payload = b"<script>alert(1)</script>" + b"\x00" * 100
    response = _multipart_upload(
        test_client,
        "/api/obfuscate/preview",
        "xss.png",
        payload,
        mode="decode",
        password="",
        compat_mode="big_tomato",
    )
    assert response.status_code == 400
    body = response.json()
    detail = body.get("detail") or body.get("error") or ""
    assert "BytesIO" not in detail


def test_image_get_rejects_int_overflow(test_client):
    """24-digit numbers used to crash with UnhandledException; should be 422 / 400."""
    # 24-digit number exceeds signed int64 / int32
    response = test_client.get("/api/images/999999999999999999999999")
    assert response.status_code in (400, 422), response.text
    body = response.json()
    detail = str(body.get("detail") or body.get("error") or "")
    # Verify no stack-trace leaked
    assert "Traceback" not in detail
    assert "UnhandledException" not in detail or response.status_code != 500


def test_image_get_rejects_negative_id(test_client):
    response = test_client.get("/api/images/-1")
    assert response.status_code in (400, 404, 422), response.text


def test_image_get_rejects_non_numeric_id(test_client):
    response = test_client.get("/api/images/abc")
    assert response.status_code in (400, 422), response.text


def test_image_get_max_int32_returns_404_not_500(test_client):
    """Boundary value 2**31 - 1 should return clean 404 (not in DB), never 500."""
    response = test_client.get("/api/images/2147483647")
    assert response.status_code == 404
