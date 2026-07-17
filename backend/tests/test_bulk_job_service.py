"""Unit tests for the durable BulkJobService engine (Debt-22).

These exercise the generic registry/engine directly (no HTTP layer) so job
lifecycle, cancellation, server-side snapshotting, and bounded error samples
are deterministic and thread-free: ``run_job`` is synchronous when called
inline, which is exactly how FastAPI's TestClient runs the BackgroundTask.
"""
from __future__ import annotations

import pytest

from services.bulk_job_service import (
    JOB_KIND_DELETE_FILES,
    JOB_KIND_EXPORT_SIDECARS,
    JOB_KIND_REMOVE_FROM_GALLERY,
    MAX_ERROR_SAMPLES,
    MAX_RETAINED_TERMINAL_JOBS,
    BulkJobService,
)


@pytest.fixture
def service() -> BulkJobService:
    return BulkJobService()


def test_create_job_starts_queued_with_kind_and_total(service):
    job_id = service.create_job(JOB_KIND_DELETE_FILES, total=7, message="pending")
    job = service.get_job(job_id)

    assert job is not None
    assert job["id"] == job_id
    assert job["job_id"] == job_id
    assert job["kind"] == JOB_KIND_DELETE_FILES
    assert job["status"] == "queued"
    assert job["total"] == 7
    assert job["processed"] == 0


def test_create_job_rejects_unknown_kind(service):
    with pytest.raises(ValueError):
        service.create_job("not_a_real_kind")


def test_chunked_job_runs_to_done_and_merges_result(service):
    job_id = service.create_job(JOB_KIND_REMOVE_FROM_GALLERY)
    ids = list(range(1, 11))  # 10 ids

    def process_chunk(chunk):
        return {
            "processed": len(chunk),
            "errors": [],
            "result_delta": {"removed": len(chunk), "missing": 0},
        }

    worker = service.chunked_worker(lambda: ids, process_chunk, chunk_size=3)
    service.run_job(job_id, worker)

    job = service.get_job(job_id)
    assert job["status"] == "done"
    assert job["total"] == 10
    assert job["processed"] == 10
    assert job["error_count"] == 0
    assert job["result"] == {"removed": 10, "missing": 0}
    assert job["finished_at"] is not None
    assert job["started_at"] is not None


def test_cancel_mid_run_stops_before_later_chunks(service):
    job_id = service.create_job(JOB_KIND_DELETE_FILES)
    seen_chunks = []

    def process_chunk(chunk):
        seen_chunks.append(list(chunk))
        # Request cancellation while the first chunk is in flight. The engine
        # must not fetch/process any later chunk.
        service.cancel_job(job_id)
        return {"processed": len(chunk), "errors": [], "result_delta": {"deleted": len(chunk)}}

    worker = service.chunked_worker(lambda: [1, 2, 3, 4, 5], process_chunk, chunk_size=1)
    service.run_job(job_id, worker)

    job = service.get_job(job_id)
    assert job["status"] == "cancelled"
    assert seen_chunks == [[1]]  # only the first chunk ran
    assert job["processed"] == 1
    assert job["result"] == {"deleted": 1}


def test_cancel_before_start_short_circuits(service):
    job_id = service.create_job(JOB_KIND_REMOVE_FROM_GALLERY)
    processed = []

    def process_chunk(chunk):
        processed.append(chunk)
        return {"processed": len(chunk), "errors": [], "result_delta": {}}

    service.cancel_job(job_id)  # cancel while still queued
    service.run_job(job_id, service.chunked_worker(lambda: [1, 2, 3], process_chunk))

    job = service.get_job(job_id)
    assert job["status"] == "cancelled"
    assert processed == []  # worker never ran a chunk
    assert job["processed"] == 0


def test_cancel_queued_job_is_immediately_terminal_and_never_runs(service):
    job_id = service.create_job(JOB_KIND_REMOVE_FROM_GALLERY)
    worker_calls = []

    cancelled = service.cancel_job(job_id)

    assert cancelled is not None
    assert cancelled["status"] == "cancelled"
    assert cancelled["started_at"] is None
    assert cancelled["finished_at"] is not None

    service.run_job(job_id, lambda handle: worker_calls.append(handle.job_id))

    job = service.get_job(job_id)
    assert job is not None
    assert job["status"] == "cancelled"
    assert worker_calls == []


def test_snapshot_is_taken_before_mutation_and_scope_cannot_expand(service):
    """Rows added mid-job must not expand the job's scope.

    ``snapshot_fn`` is evaluated once at the start; growing the underlying
    source during processing must not add work to the running job.
    """
    job_id = service.create_job(JOB_KIND_DELETE_FILES)
    source = [1, 2, 3]

    def snapshot():
        return list(source)  # frozen copy taken before any chunk runs

    def process_chunk(chunk):
        # Simulate rows appearing that would match the same filter mid-job.
        source.append(9999)
        return {"processed": len(chunk), "errors": [], "result_delta": {"deleted": len(chunk)}}

    worker = service.chunked_worker(snapshot, process_chunk, chunk_size=1)
    service.run_job(job_id, worker)

    job = service.get_job(job_id)
    assert job["status"] == "done"
    assert job["total"] == 3  # snapshot froze the scope at 3
    assert job["processed"] == 3
    assert job["result"] == {"deleted": 3}
    assert len(source) > 3  # the source really did grow during the job


def test_error_samples_are_bounded(service):
    job_id = service.create_job(JOB_KIND_EXPORT_SIDECARS)

    def process_chunk(chunk):
        errors = [f"error for {i}" for i in chunk]
        return {"processed": len(chunk), "errors": errors, "result_delta": {}}

    worker = service.chunked_worker(lambda: list(range(50)), process_chunk, chunk_size=50)
    service.run_job(job_id, worker)

    job = service.get_job(job_id)
    assert job["status"] == "done"
    assert job["error_count"] == 50
    assert len(job["error_samples"]) == MAX_ERROR_SAMPLES  # bounded to 20


def test_worker_exception_marks_error_state(service):
    job_id = service.create_job(JOB_KIND_DELETE_FILES)

    def boom(handle):
        raise RuntimeError("kaboom")

    service.run_job(job_id, boom)

    job = service.get_job(job_id)
    assert job["status"] == "error"
    assert job["error_count"] >= 1
    assert any("kaboom" in sample for sample in job["error_samples"])
    assert job["finished_at"] is not None


def test_set_result_replaces_result_payload(service):
    job_id = service.create_job(JOB_KIND_EXPORT_SIDECARS)

    def worker(handle):
        handle.set_progress(total=4, processed=4)
        handle.record_errors(2, ["a", "b"])
        handle.set_result({"exported": 4, "status": "ok"})

    service.run_job(job_id, worker)

    job = service.get_job(job_id)
    assert job["status"] == "done"
    assert job["processed"] == 4
    assert job["error_count"] == 2
    assert job["result"] == {"exported": 4, "status": "ok"}


def test_list_jobs_active_only_filters_terminal(service):
    done_id = service.create_job(JOB_KIND_DELETE_FILES)
    service.run_job(done_id, service.chunked_worker(lambda: [1], lambda c: {"processed": 1}))
    queued_id = service.create_job(JOB_KIND_REMOVE_FROM_GALLERY)  # never run -> queued

    all_ids = {job["id"] for job in service.list_jobs()}
    active_ids = {job["id"] for job in service.list_jobs(active_only=True)}

    assert {done_id, queued_id} <= all_ids
    assert queued_id in active_ids
    assert done_id not in active_ids


def test_cancel_and_get_unknown_job_return_none(service):
    assert service.get_job("does-not-exist") is None
    assert service.cancel_job("does-not-exist") is None


def test_cancel_terminal_job_is_noop(service):
    job_id = service.create_job(JOB_KIND_DELETE_FILES)
    service.run_job(job_id, service.chunked_worker(lambda: [1], lambda c: {"processed": 1}))

    snapshot = service.cancel_job(job_id)
    assert snapshot is not None
    assert snapshot["status"] == "done"  # cancelling a finished job does not change it


def test_terminal_jobs_are_pruned(service):
    # Create + finish more terminal jobs than the retention cap; the registry
    # must stay bounded (recent jobs still pollable, old ones dropped).
    for _ in range(MAX_RETAINED_TERMINAL_JOBS + 15):
        job_id = service.create_job(JOB_KIND_REMOVE_FROM_GALLERY)
        service.run_job(job_id, service.chunked_worker(lambda: [1], lambda c: {"processed": 1}))

    assert len(service.list_jobs()) <= MAX_RETAINED_TERMINAL_JOBS + 1
