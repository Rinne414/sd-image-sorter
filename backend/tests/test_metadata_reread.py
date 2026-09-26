"""Re-reading the files of images whose generation details failed to read.

``POST /api/metadata/reparse`` with ``scope: "metadata_error"`` (V4's library
status fix for "N images whose generation details failed to read").
"""

from __future__ import annotations

import asyncio

import pytest
from fastapi import BackgroundTasks, HTTPException
from PIL import Image

from routers.metadata_repair import ReparseRequest, start_reparse
from services import metadata_repair_service as mrs
from services import metadata_reread_service as reread
from services.bulk_job_service import BulkJobService, set_bulk_job_service


def _row(db, image_id: int) -> dict:
    with db.get_db() as conn:
        return dict(
            conn.execute("SELECT * FROM images WHERE id = ?", (image_id,)).fetchone()
        )


def _release_slot() -> None:
    job_id = mrs.get_active_job_id()
    if job_id is not None:
        mrs.release_active_job_id(job_id)


@pytest.fixture
def jobs(test_db):
    service = BulkJobService()
    set_bulk_job_service(service)
    _release_slot()
    try:
        yield service
    finally:
        _release_slot()
        set_bulk_job_service(None)


def _error_row(db, path, name: str) -> int:
    return db.add_image(
        path=str(path), filename=name, metadata_status="error", read_error="bad chunk"
    )


def test_snapshot_lists_only_readable_rows_whose_details_failed(test_db, tmp_path):
    failed = _error_row(test_db, tmp_path / "a.png", "a.png")
    test_db.add_image(path=str(tmp_path / "ok.png"), filename="ok.png")
    test_db.add_image(
        path=str(tmp_path / "gone.png"),
        filename="gone.png",
        is_readable=False,
        metadata_status="error",
        read_error="missing",
    )

    assert reread.snapshot_metadata_error_ids() == [failed]


def test_a_file_that_reads_now_is_fixed_and_a_vanished_one_is_left_alone(
    test_db, tmp_path
):
    good = tmp_path / "good.png"
    Image.new("RGB", (32, 24), (10, 20, 30)).save(good)
    fixed_id = _error_row(test_db, good, "good.png")
    gone_id = _error_row(test_db, tmp_path / "vanished.png", "vanished.png")

    outcome = reread._process_chunk([fixed_id, gone_id])

    assert outcome["result_delta"] == {
        "scope": "metadata_error",
        "fixed": 1,
        "still_error": 0,
        "unreadable": 0,
        "gone": 1,
    }
    assert _row(test_db, fixed_id)["metadata_status"] == "complete"
    assert _row(test_db, fixed_id)["width"] == 32
    untouched = _row(test_db, gone_id)
    assert untouched["metadata_status"] == "error"
    assert untouched["is_readable"] == 1


def test_a_file_that_no_longer_opens_becomes_unreadable(test_db, tmp_path):
    broken = tmp_path / "broken.png"
    broken.write_bytes(b"not an image at all")
    broken_id = _error_row(test_db, broken, "broken.png")

    outcome = reread._process_chunk([broken_id])

    assert outcome["result_delta"]["unreadable"] == 1
    assert _row(test_db, broken_id)["is_readable"] == 0


def test_the_route_runs_the_reread_scope_to_the_end(jobs, test_db, tmp_path):
    good = tmp_path / "good.png"
    Image.new("RGB", (16, 16)).save(good)
    _error_row(test_db, good, "good.png")
    tasks = BackgroundTasks()

    started = start_reparse(ReparseRequest(scope="metadata_error"), tasks)
    asyncio.run(tasks())

    job = jobs.get_job(started["job_id"])
    assert job["status"] == "done"
    assert job["result"]["scope"] == "metadata_error"
    assert job["result"]["fixed"] == 1
    assert mrs.get_active_job_id() is None


def test_an_unknown_scope_is_refused(jobs):
    with pytest.raises(HTTPException) as error:
        start_reparse(ReparseRequest(scope="everything"), BackgroundTasks())
    assert error.value.status_code == 422
