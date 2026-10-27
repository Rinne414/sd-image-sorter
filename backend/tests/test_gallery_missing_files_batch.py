"""A library whose files are not there (an unplugged drive) never freezes the program.

A gallery listing marks every row whose file it cannot find, and keeps
reading pages until it has a page of pictures that exist. It marked one row
at a time (a connection and a commit each, ~6 ms) on the event loop, so
opening the Gallery with the drive of an 80k-picture library unplugged held
every request for about eight minutes (measured on a scratch library,
2026-10-17). The missing rows of a batch are now marked in one transaction,
and the listing runs in the threadpool.
"""

from __future__ import annotations

import asyncio
import time
from pathlib import Path
from types import SimpleNamespace

import httpx

SLOW_SECONDS = 1.0
CHEAP_BUDGET_SECONDS = 0.2
SLEEP_BUDGET_SECONDS = 0.5
CHEAP_URL = "/api/updates/boot-id"


def _add(db, path: Path) -> int:
    return int(db.add_image(path=str(path), filename=path.name, metadata_json="{}"))


def test_the_missing_rows_of_a_batch_are_marked_in_one_go(
    test_db, tmp_path, monkeypatch
):
    from services import image_service
    from services.image_service import ImageService

    live = tmp_path / "here.png"
    live.write_bytes(b"png")
    live_id = _add(test_db, live)
    gone_ids = [_add(test_db, tmp_path / f"unplugged-{n}.png") for n in range(3)]
    rows = image_service.db.get_images_by_ids(
        [gone_ids[0], live_id, gone_ids[1], gone_ids[2]]
    )
    listed = [rows[gone_ids[0]], rows[live_id], rows[gone_ids[1]], rows[gone_ids[2]]]

    single_marks = []
    monkeypatch.setattr(
        image_service.db,
        "mark_image_unreadable",
        lambda *a, **k: single_marks.append(a),
    )
    batch_marks = []
    real_batch = image_service.db.mark_images_unreadable

    def recording(checked, reason):
        batch_marks.append((dict(checked), reason))
        return real_batch(checked, reason)

    monkeypatch.setattr(image_service.db, "mark_images_unreadable", recording)

    shown, missing = ImageService()._filter_and_mark_missing_images(listed)

    assert [row["id"] for row in shown] == [live_id]
    assert missing == 3
    assert single_marks == []
    assert batch_marks == [
        ({image_id: rows[image_id]["path"] for image_id in gone_ids}, "File not found on disk")
    ]
    states = image_service.db.get_images_by_ids(gone_ids)
    assert all(states[image_id]["is_readable"] == 0 for image_id in gone_ids)


def test_a_row_whose_path_changed_after_the_check_is_not_marked(test_db, tmp_path):
    from services import image_service

    image_id = _add(test_db, tmp_path / "checked.png")
    image_service.db.update_image_path(image_id, str(tmp_path / "moved-since.png"))

    marked = image_service.db.mark_images_unreadable(
        {image_id: str(tmp_path / "checked.png")}, "File not found on disk"
    )

    assert marked == []
    assert image_service.db.get_image_by_id(image_id)["is_readable"] == 1


def test_a_row_moved_meanwhile_is_shown_from_its_new_place(test_db, tmp_path):
    from services import image_service
    from services.image_service import ImageService

    old_path = tmp_path / "old.png"
    image_id = _add(test_db, old_path)
    listed = [image_service.db.get_image_by_id(image_id)]
    new_path = tmp_path / "moved.png"
    new_path.write_bytes(b"png")
    image_service.db.update_image_path(image_id, str(new_path))

    shown, missing = ImageService()._filter_and_mark_missing_images(listed)

    assert missing == 0
    assert [row["path"] for row in shown] == [str(new_path)]


def test_a_slow_listing_does_not_stall_other_requests(test_client, monkeypatch):
    from main import app
    from routers import images as images_router

    service = images_router.get_image_service()

    def slow_listing(**_kwargs):
        time.sleep(SLOW_SECONDS)  # a library on an unplugged drive
        return {
            "images": [],
            "next_cursor": None,
            "next_offset": None,
            "has_more": False,
            "total": 0,
        }

    monkeypatch.setattr(service, "get_images", slow_listing)

    async def run():
        transport = httpx.ASGITransport(app=app, client=("127.0.0.1", 50000))
        async with httpx.AsyncClient(
            transport=transport, base_url="http://127.0.0.1", timeout=30
        ) as client:
            slow = asyncio.create_task(client.get("/api/images?limit=50"))
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

    result = asyncio.run(run())

    assert result.sleep_elapsed < SLEEP_BUDGET_SECONDS, (
        f"the loop was blocked: asyncio.sleep(0.05) took {result.sleep_elapsed:.2f}s"
    )
    assert result.cheap.status_code == 200
    assert result.still_waiting
    assert result.elapsed < CHEAP_BUDGET_SECONDS
    assert result.slow.status_code == 200, result.slow.text
