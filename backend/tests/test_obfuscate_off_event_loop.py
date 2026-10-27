"""Scrambling a picture never freezes the rest of the program.

The pixel work takes seconds a picture (measured 2026-10-17: 3 s for
1024x1536, 13 s for 2048x3072) and ran on the event loop, so while the
Image Obfuscate tool went through a set, thumbnails, progress polls and
every other page waited. A failed preview also left its temp file behind.
"""

from __future__ import annotations

import asyncio
import io
import tempfile
import time
from types import SimpleNamespace

import httpx
from PIL import Image

SLOW_SECONDS = 1.0
CHEAP_BUDGET_SECONDS = 0.2
SLEEP_BUDGET_SECONDS = 0.5
CHEAP_URL = "/api/updates/boot-id"


def _png_bytes() -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (8, 8), (40, 80, 120)).save(buffer, format="PNG")
    return buffer.getvalue()


async def _cheap_request_while(app, send_slow):
    transport = httpx.ASGITransport(app=app, client=("127.0.0.1", 50000))
    async with httpx.AsyncClient(
        transport=transport, base_url="http://127.0.0.1", timeout=30
    ) as client:
        slow = asyncio.create_task(send_slow(client))
        sleep_started = time.perf_counter()
        await asyncio.sleep(0.05)
        sleep_elapsed = time.perf_counter() - sleep_started
        started = time.perf_counter()
        cheap = await client.get(CHEAP_URL)
        elapsed = time.perf_counter() - started
        still_waiting = not slow.done()
        return SimpleNamespace(
            sleep_elapsed=sleep_elapsed,
            elapsed=elapsed,
            still_waiting=still_waiting,
            cheap=cheap,
            slow=await slow,
        )


def _assert_loop_stayed_free(result):
    assert result.sleep_elapsed < SLEEP_BUDGET_SECONDS, (
        f"the loop was blocked: asyncio.sleep(0.05) took {result.sleep_elapsed:.2f}s"
    )
    assert result.cheap.status_code == 200
    assert result.still_waiting, "the cheap request only ran after the slow one"
    assert result.elapsed < CHEAP_BUDGET_SECONDS, (
        f"the cheap request took {result.elapsed:.2f}s"
    )


def _post_preview(client):
    return client.post(
        "/api/obfuscate/preview",
        files={"file": ("pose.png", _png_bytes(), "image/png")},
        data={"mode": "encode", "password": "", "preserve_metadata": "false"},
    )


def test_a_slow_preview_does_not_stall_other_requests(test_client, monkeypatch):
    from main import app
    from routers import obfuscation as obfuscation_router

    def slow_encode(content, *_args, **_kwargs):
        time.sleep(SLOW_SECONDS)  # the pixel work
        return content

    monkeypatch.setattr(obfuscation_router, "encode_image_bytes", slow_encode)

    result = asyncio.run(_cheap_request_while(app, _post_preview))

    _assert_loop_stayed_free(result)
    assert result.slow.status_code == 200, result.slow.text
    assert result.slow.content == _png_bytes()


def test_a_slow_file_encode_does_not_stall_other_requests(
    test_client, tmp_path, monkeypatch
):
    from main import app
    from routers import obfuscation as obfuscation_router

    source = tmp_path / "pose.png"
    source.write_bytes(_png_bytes())
    monkeypatch.setattr(obfuscation_router, "_validate_source_image", lambda path: path)
    monkeypatch.setattr(obfuscation_router, "_validate_output_path", lambda path: path)

    def slow_encode(*_args, **_kwargs):
        time.sleep(SLOW_SECONDS)
        return {"success": True}

    monkeypatch.setattr(obfuscation_router, "encode_image", slow_encode)

    def send(client):
        return client.post(
            "/api/obfuscate/encode",
            json={"image_path": str(source), "output_path": str(tmp_path / "out.png")},
        )

    result = asyncio.run(_cheap_request_while(app, send))

    _assert_loop_stayed_free(result)
    assert result.slow.status_code == 200, result.slow.text


def test_a_failed_preview_leaves_no_temp_file(test_client, tmp_path, monkeypatch):
    from routers import obfuscation as obfuscation_router

    temp_dir = tmp_path / "temp"
    temp_dir.mkdir()
    monkeypatch.setattr(tempfile, "tempdir", str(temp_dir))

    def refuse(*_args, **_kwargs):
        raise ValueError("Wrong password")

    monkeypatch.setattr(obfuscation_router, "encode_image_bytes", refuse)

    response = test_client.post(
        "/api/obfuscate/preview",
        files={"file": ("pose.png", _png_bytes(), "image/png")},
        data={"mode": "encode", "password": "", "preserve_metadata": "false"},
    )

    assert response.status_code == 400, response.text
    assert list(temp_dir.iterdir()) == []


def test_two_pictures_are_scrambled_one_at_a_time(test_client, tmp_path, monkeypatch):
    """Off the loop the handlers could run side by side: twice the peak memory
    on large pictures, and two writes racing on one output file."""
    import threading

    from routers import obfuscation as obfuscation_router

    source = tmp_path / "pose.png"
    source.write_bytes(_png_bytes())
    monkeypatch.setattr(obfuscation_router, "_validate_source_image", lambda path: path)
    monkeypatch.setattr(obfuscation_router, "_validate_output_path", lambda path: path)
    running = 0
    most = 0
    guard = threading.Lock()

    def counted_encode(*_args, **_kwargs):
        nonlocal running, most
        with guard:
            running += 1
            most = max(most, running)
        time.sleep(0.2)
        with guard:
            running -= 1
        return {"success": True}

    monkeypatch.setattr(obfuscation_router, "encode_image", counted_encode)
    request = obfuscation_router.SingleProcessRequest(
        image_path=str(source), output_path=str(tmp_path / "out.png")
    )
    threads = [
        threading.Thread(target=obfuscation_router.encode_single, args=(request,))
        for _ in range(3)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert most == 1
