"""GET /api/images/repair-candidates must not stall the server (T5b review MEDIUM-1).

The listing hashes one found file per review to answer ``pixels_match``. Done
inside an ``async def`` endpoint that work blocked the event loop: with a page
of 4K files, thumbnails and progress polls issued meanwhile waited for the
whole page to be hashed. Pinned here: the endpoint runs the work off the loop
(a cheap request issued meanwhile answers within 100 ms), digests are cached
in-process per (path, mtime, size), and a page above 50 carries no verdicts.
"""

from __future__ import annotations

import asyncio
import shutil
import sys
import time
from pathlib import Path

import httpx
import numpy as np
import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent.parent))

import image_fingerprint
from services.image import repair as repair_module

N_REVIEWS = 6
FAST_REQUEST_BUDGET_SECONDS = 0.1


@pytest.fixture(autouse=True)
def _fresh_digest_cache():
    cache = getattr(repair_module, "_cached_found_digest", None)
    if cache is not None:
        cache.cache_clear()
    yield
    if cache is not None:
        cache.cache_clear()


@pytest.fixture
def hash_calls(monkeypatch):
    calls: list[str] = []
    real = image_fingerprint.compute_image_content_fingerprint

    def counted(path, *args, **kwargs):
        calls.append(str(path))
        return real(path, *args, **kwargs)

    monkeypatch.setattr(image_fingerprint, "compute_image_content_fingerprint", counted)
    return calls


def _noisy_4k_png(target: Path) -> Path:
    rng = np.random.default_rng(1)
    height, width = 2160, 3840
    yy, xx = np.mgrid[0:height, 0:width]
    base = np.stack(
        [
            (xx * 255 // width),
            (yy * 255 // height),
            ((xx + yy) * 255 // (width + height)),
        ],
        -1,
    ).astype(np.int16)
    pixels = np.clip(
        base + rng.integers(-12, 13, size=(height, width, 3)), 0, 255
    ).astype(np.uint8)
    target.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(pixels).save(target, compress_level=1)
    return target


def _seed_reviews(db, tmp_path: Path, count: int, *, source: Path) -> None:
    for index in range(count):
        found = tmp_path / "found" / f"d{index}" / f"pic{index}.png"
        found.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(source, found)
        stat = found.stat()
        ids = [
            db.add_image(
                path=str(tmp_path / f"old{k}" / found.name),
                filename=found.name,
                metadata_json="{}",
                file_size=stat.st_size,
                source_size=stat.st_size,
                source_mtime_ns=stat.st_mtime_ns,
                content_fingerprint=f"digest-{index}-{k}",
                is_readable=False,
                read_error="File not found",
                metadata_status="error",
            )
            for k in range(2)
        ]
        db.add_reconnect_review(
            filename=found.name,
            found_path=str(found),
            candidate_ids=ids,
            candidate_count=2,
            run_started_at=1000.0,
        )


def test_listing_a_page_of_4k_files_does_not_block_other_requests(
    test_client, tmp_path
):
    _seed_reviews(
        test_client.test_db,
        tmp_path,
        N_REVIEWS,
        source=_noisy_4k_png(tmp_path / "src.png"),
    )
    from main import app

    async def run():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(
            transport=transport, base_url="http://testserver", timeout=600
        ) as client:

            async def cheap_request_issued_meanwhile():
                started = time.perf_counter()
                await asyncio.sleep(0.05)
                await client.get("/api/images/reconnect-missing/progress")
                return time.perf_counter() - started - 0.05

            listing, waited = await asyncio.gather(
                client.get(f"/api/images/repair-candidates?limit={N_REVIEWS}"),
                cheap_request_issued_meanwhile(),
            )
            return listing, waited

    listing, waited = asyncio.run(run())

    assert listing.status_code == 200
    body = listing.json()
    assert len(body["items"]) == N_REVIEWS
    assert all(
        c["pixels_match"] is False for item in body["items"] for c in item["candidates"]
    )
    assert waited < FAST_REQUEST_BUDGET_SECONDS, (
        f"a cheap request waited {waited * 1000:.0f} ms behind the listing"
    )


def _small_png(target: Path) -> Path:
    target.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (8, 8), color="red").save(target)
    return target


def test_digests_are_cached_so_paging_back_hashes_nothing(
    test_db, tmp_path, hash_calls
):
    from services.image_service import ImageService

    _seed_reviews(test_db, tmp_path, 3, source=_small_png(tmp_path / "src.png"))
    service = ImageService()

    first = service.get_repair_candidates(limit=20)
    assert len(hash_calls) == 3
    second = service.get_repair_candidates(limit=20)

    assert len(hash_calls) == 3
    assert [
        c["pixels_match"] for item in second["items"] for c in item["candidates"]
    ] == [False] * 6
    assert first["items"] == second["items"]


def test_a_rewritten_found_file_is_hashed_again(test_db, tmp_path, hash_calls):
    from services.image_service import ImageService

    _seed_reviews(test_db, tmp_path, 1, source=_small_png(tmp_path / "src.png"))
    service = ImageService()
    service.get_repair_candidates(limit=20)
    assert len(hash_calls) == 1

    found = tmp_path / "found" / "d0" / "pic0.png"
    Image.new("RGB", (16, 16), color="blue").save(found)
    service.get_repair_candidates(limit=20)

    assert len(hash_calls) == 2


def test_a_transient_read_failure_is_not_remembered(test_db, tmp_path, monkeypatch):
    """Locked by another process, an antivirus scan, a cloud placeholder: the
    first listing answers None, the next one (file unchanged) hashes again and
    answers for real instead of staying None until the process restarts."""
    from services.image_service import ImageService

    _seed_reviews(test_db, tmp_path, 1, source=_small_png(tmp_path / "src.png"))
    service = ImageService()
    real = image_fingerprint.compute_image_content_fingerprint

    def locked(*_args, **_kwargs):
        raise PermissionError("locked by another process")

    monkeypatch.setattr(image_fingerprint, "compute_image_content_fingerprint", locked)
    while_locked = [c["pixels_match"] for c in service.get_repair_candidates(limit=20)["items"][0]["candidates"]]
    monkeypatch.setattr(image_fingerprint, "compute_image_content_fingerprint", real)
    afterwards = [c["pixels_match"] for c in service.get_repair_candidates(limit=20)["items"][0]["candidates"]]

    assert while_locked == [None, None]
    assert afterwards == [False, False]


def test_pages_above_fifty_carry_no_verdicts_and_hash_nothing(
    test_db, tmp_path, hash_calls
):
    from services.image_service import ImageService

    _seed_reviews(test_db, tmp_path, 2, source=_small_png(tmp_path / "src.png"))

    payload = ImageService().get_repair_candidates(
        limit=repair_module.PIXEL_VERDICT_MAX_LIMIT + 1
    )

    assert hash_calls == []
    assert [
        c["pixels_match"] for item in payload["items"] for c in item["candidates"]
    ] == [None] * 4
