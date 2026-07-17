"""Lifecycle integration tests for queued duplicate-scan jobs."""
from __future__ import annotations

import asyncio
from collections.abc import Generator

import pytest
from fastapi import BackgroundTasks, HTTPException

from routers.duplicates import (
    DuplicateScanRequest,
    get_scan_status,
    start_duplicate_scan,
)
from services import duplicate_group_service
from services.bulk_job_service import (
    BulkJobService,
    set_bulk_job_service,
)


def _release_active_scan_slot() -> None:
    job_id = duplicate_group_service.get_active_job_id()
    if job_id is not None:
        assert duplicate_group_service.release_active_job_id(job_id) is True


@pytest.fixture
def duplicate_jobs() -> Generator[BulkJobService, None, None]:
    service = BulkJobService()
    set_bulk_job_service(service)
    _release_active_scan_slot()
    try:
        yield service
    finally:
        _release_active_scan_slot()
        set_bulk_job_service(None)


def _start_scan(background_tasks: BackgroundTasks) -> dict[str, object]:
    return start_duplicate_scan(
        DuplicateScanRequest(threshold=0.95),
        background_tasks,
    )


def _run_background_tasks(background_tasks: BackgroundTasks) -> None:
    asyncio.run(background_tasks())


def test_rejected_second_start_leaves_no_nonterminal_job(
    duplicate_jobs: BulkJobService,
) -> None:
    first_tasks = BackgroundTasks()
    first = _start_scan(first_tasks)

    with pytest.raises(HTTPException) as error:
        _start_scan(BackgroundTasks())

    assert error.value.status_code == 409
    jobs = duplicate_jobs.list_jobs()
    assert len(jobs) == 2
    rejected = next(job for job in jobs if job["id"] != first["job_id"])
    assert rejected["status"] == "cancelled"
    assert rejected["finished_at"] is not None
    assert {
        job["id"] for job in duplicate_jobs.list_jobs(active_only=True)
    } == {first["job_id"]}


def test_cancelled_queued_scan_allows_new_scan_without_stale_release(
    duplicate_jobs: BulkJobService,
) -> None:
    first_tasks = BackgroundTasks()
    first = _start_scan(first_tasks)
    cancelled = duplicate_jobs.cancel_job(str(first["job_id"]))

    assert cancelled is not None
    assert cancelled["status"] == "cancelled"

    second_tasks = BackgroundTasks()
    second = _start_scan(second_tasks)

    assert duplicate_group_service.get_active_job_id() == second["job_id"]
    _run_background_tasks(first_tasks)
    assert duplicate_group_service.get_active_job_id() == second["job_id"]
    assert duplicate_jobs.get_job(str(first["job_id"]))["status"] == "cancelled"
    assert duplicate_jobs.get_job(str(second["job_id"]))["status"] == "queued"


def test_scan_status_does_not_report_cancelled_owner_as_active(
    duplicate_jobs: BulkJobService,
) -> None:
    started = _start_scan(BackgroundTasks())
    duplicate_jobs.cancel_job(str(started["job_id"]))

    status = get_scan_status()

    assert status["active"] is False
    assert status["job_id"] is None
    assert status["job"]["status"] == "cancelled"


def test_cancelled_queued_scan_releases_current_slot_when_dispatched(
    duplicate_jobs: BulkJobService,
) -> None:
    background_tasks = BackgroundTasks()
    started = _start_scan(background_tasks)
    cancelled = duplicate_jobs.cancel_job(str(started["job_id"]))

    assert cancelled is not None
    assert cancelled["status"] == "cancelled"
    assert duplicate_group_service.get_active_job_id() == started["job_id"]

    _run_background_tasks(background_tasks)

    assert duplicate_group_service.get_active_job_id() is None


def test_start_reclaims_slot_when_previous_owner_job_is_missing(
    duplicate_jobs: BulkJobService,
) -> None:
    assert duplicate_group_service.claim_active_job_id("missing-job") is True

    started = _start_scan(BackgroundTasks())

    assert duplicate_group_service.get_active_job_id() == started["job_id"]
    assert duplicate_jobs.get_job(str(started["job_id"]))["status"] == "queued"


def test_active_slot_release_requires_matching_owner() -> None:
    _release_active_scan_slot()
    assert duplicate_group_service.claim_active_job_id("current-job") is True
    try:
        assert duplicate_group_service.release_active_job_id("stale-job") is False
        assert duplicate_group_service.get_active_job_id() == "current-job"
        assert duplicate_group_service.release_active_job_id("current-job") is True
        assert duplicate_group_service.get_active_job_id() is None
    finally:
        _release_active_scan_slot()
