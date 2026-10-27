"""Trashing pictures and listing a folder never freeze the rest of the program.

Both handlers were ``async def`` around plain blocking work, so they ran on
the event loop: a Duplicate cleanup of a few hundred pictures (about 35 ms a
file to the Recycle Bin, measured 2026-10-17) stopped thumbnails, progress
polls and every other page for half a minute, and a wide folder in the
folder browser did the same for as long as its listing took.
"""

from __future__ import annotations

import asyncio
import time
from types import SimpleNamespace

import httpx

SLOW_SECONDS = 1.0
CHEAP_BUDGET_SECONDS = 0.2
SLEEP_BUDGET_SECONDS = 0.5
CHEAP_URL = "/api/updates/boot-id"


async def _cheap_request_while(app, url, json_body):
    """Fire the slow request, then time a cheap one issued while it runs."""
    transport = httpx.ASGITransport(app=app, client=("127.0.0.1", 50000))
    async with httpx.AsyncClient(
        transport=transport, base_url="http://127.0.0.1", timeout=30
    ) as client:
        slow = asyncio.create_task(client.post(url, json=json_body))
        # A blocked loop holds this sleep until the slow work is over.
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


def test_a_slow_trash_run_does_not_stall_other_requests(
    test_client, tmp_path, monkeypatch
):
    from main import app
    from services import image_service

    picture = tmp_path / "dup.png"
    picture.write_bytes(b"png")
    image_id = int(
        test_client.test_db.add_image(
            path=str(picture), filename=picture.name, metadata_json="{}"
        )
    )
    trashed = []

    def slow_trash(path):
        time.sleep(SLOW_SECONDS)  # the Recycle Bin call
        trashed.append(path)

    monkeypatch.setattr(image_service, "move_file_to_trash", slow_trash)

    result = asyncio.run(
        _cheap_request_while(
            app,
            "/api/images/delete-selected",
            {"image_ids": [image_id], "confirm_delete_files": True},
        )
    )

    _assert_loop_stayed_free(result)
    assert result.slow.status_code == 200, result.slow.text
    assert result.slow.json()["deleted"] == 1
    assert trashed == [str(picture)]


def test_a_slow_folder_listing_does_not_stall_other_requests(test_client, monkeypatch):
    from main import app
    from routers import sorting as sorting_router

    service = sorting_router.get_sorting_service()

    def slow_listing(path):
        time.sleep(SLOW_SECONDS)  # a wide folder or a slow drive
        return {"current": path, "parent": None, "subdirs": []}

    monkeypatch.setattr(service, "browse_folder", slow_listing)

    result = asyncio.run(
        _cheap_request_while(app, "/api/browse-folder", {"path": "D:\\wide"})
    )

    _assert_loop_stayed_free(result)
    assert result.slow.status_code == 200, result.slow.text
    assert result.slow.json()["current"] == "D:\\wide"
