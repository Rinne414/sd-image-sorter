"""A gallery page checks only the pictures it shows, and paging still skips none.

The listing fetches twice the page so missing files can be dropped without a
second query, and it used to check every fetched picture on disk: 200 checks
for a 100-picture page, most of a page's time at 100,000 pictures.
"""

from __future__ import annotations

from pathlib import Path

import database as db
from services import image_service
from services.image_service import ImageService


def _library(tmp_path: Path, count: int, missing_every: int = 0) -> list[int]:
    """Pictures newest last; every ``missing_every``-th file is gone. Returns live ids."""
    live = []
    for index in range(count):
        path = tmp_path / f"p{index:03d}.png"
        path.write_bytes(b"png")
        image_id = db.add_image(path=str(path), filename=path.name)
        if missing_every and index % missing_every == 0:
            path.unlink()
        else:
            live.append(image_id)
    return live


def _count_checks(monkeypatch) -> list[str]:
    checked: list[str] = []
    real = image_service.resolve_existing_indexed_image_path

    def counting(path, *args, **kwargs):
        checked.append(path)
        return real(path, *args, **kwargs)

    monkeypatch.setattr(image_service, "resolve_existing_indexed_image_path", counting)
    return checked


def test_a_page_checks_the_pictures_it_shows_and_one_more(
    test_db, tmp_path, monkeypatch
):
    _library(tmp_path, 25)
    checked = _count_checks(monkeypatch)
    page = ImageService().get_images(limit=5)
    assert len(page["images"]) == 5
    assert page["has_more"] is True
    assert len(checked) == 6


def test_paging_past_missing_files_returns_every_live_picture_once(test_db, tmp_path):
    live = _library(tmp_path, 40, missing_every=3)
    service = ImageService()
    seen: list[int] = []
    cursor = None
    for _ in range(40):
        page = service.get_images(limit=5, cursor=cursor)
        seen.extend(image["id"] for image in page["images"])
        if not page["has_more"]:
            break
        cursor = page["next_cursor"]
    assert sorted(seen) == sorted(live)
    assert len(seen) == len(set(seen))
