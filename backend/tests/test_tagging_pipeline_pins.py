"""Characterization pins for services/tagging_pipeline_service.py.

Companion to test_tagging_pipeline_service.py (the Debt-16 FIFO-queue
contract suite) and test_tagging_service.py (the legacy worker-lifecycle
suite). Those two already pin the high-level behaviors: busy -> queued
instead of 409, fail-closed probes, cross-kind FIFO dispatch, duplicate
collapse of an A/A pair, queued-cancel, and persistence round-trips.

This file pins the seams and edges those two leave uncovered, so a
refactor of the orchestrator (e.g. a facade + mixin split) is caught if it
drifts:

- the ONE module-global rebind seam ``_server_loop`` and its binding into
  a dispatched VLM entry,
- ``_start_queued_vlm_batch``'s claim / release-on-failure contract (the
  FIFO suite monkeypatches this function away),
- ``_ThreadLaunchBackgroundTasks`` (never hit because the fakes ignore the
  background-tasks argument),
- ``_fingerprint`` identity + the TAIL-only, consecutive-only nature of
  duplicate collapse, including the unfingerprintable-never-collapses edge,
- ``queue_snapshot``'s dict-vs-scalar last_start_error surface,
- restore-path edges: identical running+head collapse, non-``q<n>``
  queue_id regeneration, invalid gallery payload skip, cancel clearing a
  persisted RUNNING marker, and a failed dispatch leaving no running marker,
- probe status filtering (terminal Smart job / missing legacy service),
- the small ``_exception_detail`` / ``_with_owner`` helpers,
- ServiceProvider singleton semantics of get/set_tagging_pipeline_service.

All tests are hermetic: conftest's autouse ``_isolate_ai_job_queue_state``
redirects the queue-state file to a per-test tmp path, so constructing a
service never touches the real data/state/ai-job-queue.json. No real worker
processes, models, or database are used.
"""

from __future__ import annotations

import json
import threading
from types import SimpleNamespace

import pytest
from fastapi import HTTPException


# ---------------------------------------------------------------------------
# Shared helpers / fixtures
# ---------------------------------------------------------------------------


class _FakeLegacyTaggingService:
    """Idle-by-default gallery TaggingService stand-in (mirrors the reader suite)."""

    def __init__(self, progress=None):
        self.progress = progress or {"status": "idle"}
        self.started = False
        self.start_count = 0
        self.cancelled = False
        self.worker_active = False

    def get_progress(self):
        return dict(self.progress)

    def is_worker_active(self) -> bool:
        return self.worker_active

    def start_tagging(self, request, background_tasks):
        self.started = True
        self.start_count += 1
        return {"status": "started", "message": "legacy started"}

    def cancel_tagging(self):
        self.cancelled = True
        self.progress = {"status": "cancelled"}
        return {"status": "cancelled", "message": "legacy cancelled"}


def _make_service(**kwargs):
    from services.tagging_pipeline_service import TaggingPipelineService

    kwargs.setdefault("auto_dispatch", False)
    return TaggingPipelineService(**kwargs)


def _idle_probes(monkeypatch):
    """Force all three busy probes to 'idle'."""
    import routers.vlm as vlm_router
    from services import tagging_pipeline_service

    monkeypatch.setattr(
        tagging_pipeline_service.smart_tag_service, "get_active_job", lambda: None
    )
    monkeypatch.setattr(vlm_router, "is_caption_batch_active", lambda: False)


def _smart_busy(monkeypatch):
    """Force Smart Tag busy + VLM idle so every kind queues behind it."""
    import routers.vlm as vlm_router
    from services import tagging_pipeline_service

    monkeypatch.setattr(
        tagging_pipeline_service.smart_tag_service,
        "get_active_job",
        lambda: SimpleNamespace(job_id="smart-active", status="running"),
    )
    monkeypatch.setattr(vlm_router, "is_caption_batch_active", lambda: False)


@pytest.fixture(autouse=True)
def _restore_module_globals():
    """Snapshot + restore the two module-global seams this file mutates.

    ``_server_loop`` and the ServiceProvider's cached instance are process
    globals; without save/restore a pin that sets them would leak into the
    rest of the 4600-test suite.
    """
    from services import tagging_pipeline_service as tps

    saved_loop = tps._server_loop
    saved_instance = tps._tagging_pipeline_provider._instance
    try:
        yield
    finally:
        tps._server_loop = saved_loop
        tps._tagging_pipeline_provider._instance = saved_instance


# ---------------------------------------------------------------------------
# 1. Module-global rebind seam: _server_loop
# ---------------------------------------------------------------------------


def test_set_server_loop_records_and_get_returns_same_object():
    from services import tagging_pipeline_service as tps

    sentinel = object()
    tps.set_server_loop(sentinel)

    assert tps._get_server_loop() is sentinel


def test_set_server_loop_none_resets_the_seam():
    from services import tagging_pipeline_service as tps

    tps.set_server_loop(object())
    tps.set_server_loop(None)

    assert tps._get_server_loop() is None


def test_dispatched_vlm_entry_binds_server_loop_when_its_loop_is_missing(monkeypatch):
    """A VLM entry queued with loop=None picks up the captured server loop at
    dispatch (dispatch_pending_once lines 570-571), and that loop is the one
    handed to start_caption_batch_from_queue."""
    import routers.vlm as vlm_router
    from services import tagging_pipeline_service as tps

    service = _make_service()
    legacy = _FakeLegacyTaggingService()
    _smart_busy(monkeypatch)

    # Enqueue behind the busy Smart job with loop=None.
    queued = service.start_vlm_caption_batch(
        lambda: pytest.fail("must queue, not claim"),
        payload={"image_ids": [1]},
        loop=None,
        legacy_service=legacy,
    )
    assert queued["status"] == "queued"

    server_loop = object()
    tps.set_server_loop(server_loop)

    seen = {}
    monkeypatch.setattr(
        vlm_router, "claim_caption_batch_slot", lambda: seen.setdefault("claimed", True)
    )
    monkeypatch.setattr(
        vlm_router,
        "start_caption_batch_from_queue",
        lambda payload, loop: seen.update(payload=payload, loop=loop),
    )
    # Everything idle now so the queued VLM entry dispatches.
    monkeypatch.setattr(tps.smart_tag_service, "get_active_job", lambda: None)

    assert service.dispatch_pending_once() is True
    assert seen["claimed"] is True
    assert seen["payload"] == {"image_ids": [1]}
    assert seen["loop"] is server_loop


# ---------------------------------------------------------------------------
# 2. _start_queued_vlm_batch claim / release-on-failure contract
# ---------------------------------------------------------------------------


def test_start_queued_vlm_batch_claims_then_starts_without_release(monkeypatch):
    import routers.vlm as vlm_router
    from services import tagging_pipeline_service as tps

    calls: list[str] = []
    loop = object()
    entry = tps._QueuedPipelineJob(
        queue_id="q1", kind=tps.KIND_VLM, payload={"image_ids": [3]}, loop=loop
    )
    monkeypatch.setattr(
        vlm_router, "claim_caption_batch_slot", lambda: calls.append("claim")
    )
    monkeypatch.setattr(
        vlm_router,
        "start_caption_batch_from_queue",
        lambda payload, passed_loop: calls.append(
            f"start:{payload['image_ids']}:{passed_loop is loop}"
        ),
    )
    monkeypatch.setattr(
        vlm_router,
        "release_caption_batch_slot",
        lambda *a, **k: calls.append("release"),
    )

    tps._start_queued_vlm_batch(entry)

    assert calls == ["claim", "start:[3]:True"]


def test_start_queued_vlm_batch_releases_slot_when_start_raises(monkeypatch):
    """A start failure after the claim must release the slot and re-raise, so a
    failed queued dispatch never leaves the VLM slot wedged."""
    import routers.vlm as vlm_router
    from services import tagging_pipeline_service as tps

    calls: list[str] = []
    entry = tps._QueuedPipelineJob(
        queue_id="q1", kind=tps.KIND_VLM, payload={}, loop=object()
    )

    def _boom(payload, loop):
        raise RuntimeError("no usable event loop")

    monkeypatch.setattr(
        vlm_router, "claim_caption_batch_slot", lambda: calls.append("claim")
    )
    monkeypatch.setattr(vlm_router, "start_caption_batch_from_queue", _boom)
    monkeypatch.setattr(
        vlm_router,
        "release_caption_batch_slot",
        lambda *a, **k: calls.append("release"),
    )

    with pytest.raises(RuntimeError, match="no usable event loop"):
        tps._start_queued_vlm_batch(entry)

    assert calls == ["claim", "release"]


# ---------------------------------------------------------------------------
# 3. _ThreadLaunchBackgroundTasks (queued gallery start off the event loop)
# ---------------------------------------------------------------------------


def test_thread_launch_background_tasks_runs_func_off_thread_with_args():
    from services.tagging_pipeline_service import _ThreadLaunchBackgroundTasks

    done = threading.Event()
    seen: dict[str, object] = {}

    def _record(a, b, *, k):
        seen["args"] = (a, b)
        seen["kwargs"] = {"k": k}
        seen["thread_name"] = threading.current_thread().name
        done.set()

    _ThreadLaunchBackgroundTasks().add_task(_record, 1, 2, k="v")

    assert done.wait(5.0), "background task never ran"
    assert seen["args"] == (1, 2)
    assert seen["kwargs"] == {"k": "v"}
    # Runs on a distinct daemon thread with the documented name, not inline.
    assert seen["thread_name"] == "queued-gallery-tag-job"
    assert seen["thread_name"] != threading.current_thread().name


# ---------------------------------------------------------------------------
# 4. _fingerprint identity + duplicate-collapse precision
# ---------------------------------------------------------------------------


def test_fingerprint_is_kind_prefixed_and_key_order_independent():
    from services.tagging_pipeline_service import KIND_GALLERY, KIND_SMART, _fingerprint
    from services.tagging_service import TagRequest

    # Same kind + equal payload -> identical fingerprint (model_dump + sort_keys).
    a = _fingerprint(KIND_GALLERY, TagRequest(image_ids=[1]))
    b = _fingerprint(KIND_GALLERY, TagRequest(image_ids=[1]))
    assert a == b
    assert a.startswith("gallery-tag:")

    # Dict key insertion order does not change the fingerprint.
    assert _fingerprint(KIND_SMART, {"a": 1, "b": 2}) == _fingerprint(
        KIND_SMART, {"b": 2, "a": 1}
    )

    # The kind is part of the identity: same payload, different kind -> different.
    assert _fingerprint(KIND_SMART, {"a": 1}) != _fingerprint(KIND_GALLERY, {"a": 1})


def test_fingerprint_returns_empty_for_unserializable_payload():
    from services.tagging_pipeline_service import KIND_SMART, _fingerprint

    circular: dict = {}
    circular["self"] = circular  # json.dumps raises ValueError on the cycle

    assert _fingerprint(KIND_SMART, circular) == ""


def test_only_consecutive_duplicates_collapse(monkeypatch):
    """Collapse compares only the queue TAIL, so an A, B, A sequence keeps all
    three entries -- the middle B breaks the run even though A repeats."""
    from services.tagging_service import TagRequest

    service = _make_service()
    legacy = _FakeLegacyTaggingService()
    _smart_busy(monkeypatch)

    first = service.start_gallery_tagging(
        TagRequest(image_ids=[1]), background_tasks=None, legacy_service=legacy
    )
    service.start_gallery_tagging(
        TagRequest(image_ids=[2]), background_tasks=None, legacy_service=legacy
    )
    third = service.start_gallery_tagging(
        TagRequest(image_ids=[1]), background_tasks=None, legacy_service=legacy
    )

    assert third.get("duplicate") is None
    assert third["queue_id"] != first["queue_id"]
    assert service.queue_snapshot()["total_queued"] == 3


def test_unfingerprintable_payloads_never_collapse(monkeypatch):
    """Two consecutive identical-but-unfingerprintable payloads both enqueue
    (empty fingerprint skips the collapse branch), and the best-effort persist
    of the unserializable payload never raises."""
    service = _make_service()
    legacy = _FakeLegacyTaggingService()
    _smart_busy(monkeypatch)

    circular: dict = {}
    circular["self"] = circular

    service.start_smart_tagging(circular, legacy_service=legacy)
    service.start_smart_tagging(circular, legacy_service=legacy)

    assert service.queue_snapshot()["total_queued"] == 2


# ---------------------------------------------------------------------------
# 5. queue_snapshot last_start_error surface (dict for all-kinds, scalar per kind)
# ---------------------------------------------------------------------------


def _record_failed_gallery_start(monkeypatch):
    """Queue one gallery job then let its dispatch fail, recording an error."""
    from services.tagging_service import TagRequest

    service = _make_service()

    smart_job = {"job": SimpleNamespace(job_id="smart-active", status="running")}
    import routers.vlm as vlm_router
    from services import tagging_pipeline_service as tps

    monkeypatch.setattr(
        tps.smart_tag_service, "get_active_job", lambda: smart_job["job"]
    )
    monkeypatch.setattr(vlm_router, "is_caption_batch_active", lambda: False)

    class _ExplodingLegacy(_FakeLegacyTaggingService):
        def start_tagging(self, request, background_tasks):
            raise HTTPException(
                status_code=400, detail="selection token no longer decodes"
            )

    service.start_gallery_tagging(
        TagRequest(image_ids=[1]),
        background_tasks=None,
        legacy_service=_ExplodingLegacy(),
    )
    smart_job["job"] = None
    assert service.dispatch_pending_once() is True  # consumes the broken entry
    return service


def test_queue_snapshot_last_error_is_dict_for_all_kinds_and_scalar_per_kind(
    monkeypatch,
):
    service = _record_failed_gallery_start(monkeypatch)

    all_kinds = service.queue_snapshot()["last_start_error"]
    assert isinstance(all_kinds, dict)
    assert "gallery-tag" in all_kinds

    gallery = service.queue_snapshot("gallery-tag")["last_start_error"]
    assert gallery["kind"] == "gallery-tag"
    assert "selection token" in gallery["error"]

    # A kind with no recorded error reports None, not the aggregate dict.
    assert service.queue_snapshot("smart-tag")["last_start_error"] is None
    # A clean service surfaces None for the all-kinds view too.
    assert _make_service().queue_snapshot()["last_start_error"] is None


def test_successful_start_clears_a_previously_recorded_start_error(monkeypatch):
    from services.tagging_service import TagRequest

    service = _make_service()
    legacy = _FakeLegacyTaggingService()
    _idle_probes(monkeypatch)
    # Seed a stale error for the gallery kind.
    service._last_start_errors["gallery-tag"] = {
        "kind": "gallery-tag",
        "error": "stale",
    }

    out = service.start_gallery_tagging(
        TagRequest(image_ids=[1]), background_tasks=None, legacy_service=legacy
    )

    assert out["status"] == "started"
    assert service.queue_snapshot("gallery-tag")["last_start_error"] is None


# ---------------------------------------------------------------------------
# 6. Restore-path + running-marker durability edges
# ---------------------------------------------------------------------------


def _write_queue_state(entries):
    """Write a state file at the (conftest-redirected) queue path and return it."""
    from services import ai_job_queue_store

    path = ai_job_queue_store.get_queue_state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"schema_version": 1, "entries": entries}), encoding="utf-8"
    )
    return path


def test_restore_collapses_identical_running_and_head_queued_entries():
    """A job that was RUNNING at shutdown followed by an identical queued job
    collapses into ONE entry on restore (the running entry is restored first,
    then the duplicate head is dropped)."""
    _write_queue_state(
        [
            {
                "queue_id": "q1",
                "kind": "gallery-tag",
                "payload": {"image_ids": [1]},
                "running": True,
            },
            {
                "queue_id": "q2",
                "kind": "gallery-tag",
                "payload": {"image_ids": [1]},
                "running": False,
            },
        ]
    )

    service = _make_service()

    assert service.queue_snapshot()["total_queued"] == 1
    assert service._queue[0].payload.image_ids == [1]


def test_restore_regenerates_nonstandard_queue_id_and_advances_seq(monkeypatch):
    """A persisted entry whose queue_id is not ``q<digits>`` gets a fresh id,
    and _queue_seq advances so the next real enqueue cannot collide with it."""
    from services.tagging_service import TagRequest

    _write_queue_state(
        [
            {
                "queue_id": "legacy-xyz",
                "kind": "gallery-tag",
                "payload": {"image_ids": [3]},
                "running": False,
            }
        ]
    )

    service = _make_service()
    restored_id = service._queue[0].queue_id
    assert restored_id == "q1"

    # A subsequent enqueue must get a distinct, non-colliding id.
    legacy = _FakeLegacyTaggingService()
    _smart_busy(monkeypatch)
    out = service.start_gallery_tagging(
        TagRequest(image_ids=[4]), background_tasks=None, legacy_service=legacy
    )
    assert out["queue_id"] == "q2"
    assert out["queue_id"] != restored_id


def test_restore_skips_gallery_entry_whose_payload_fails_validation():
    """A persisted gallery payload that no longer validates as a TagRequest is
    skipped (not restored as a malformed job); a sibling valid entry loads."""
    _write_queue_state(
        [
            {
                "queue_id": "q1",
                "kind": "gallery-tag",
                "payload": {"batch_size": "not-an-int"},
                "running": False,
            },
            {
                "queue_id": "q2",
                "kind": "gallery-tag",
                "payload": {"image_ids": [5]},
                "running": False,
            },
        ]
    )

    service = _make_service()

    assert service.queue_snapshot()["total_queued"] == 1
    assert service._queue[0].payload.image_ids == [5]


def test_cancel_clears_persisted_running_marker_so_restart_restores_nothing(
    monkeypatch,
):
    """cancel_<kind> drops a persisted RUNNING marker of the same kind (even
    with an empty queue), so the cancelled job is not re-queued on restart."""
    from services.tagging_service import TagRequest

    service = _make_service()
    legacy = _FakeLegacyTaggingService()

    smart_job = {"job": SimpleNamespace(job_id="smart-active", status="running")}
    import routers.vlm as vlm_router
    from services import tagging_pipeline_service as tps

    monkeypatch.setattr(
        tps.smart_tag_service, "get_active_job", lambda: smart_job["job"]
    )
    monkeypatch.setattr(vlm_router, "is_caption_batch_active", lambda: False)

    # Queue a gallery job behind the busy Smart job, then let Smart finish so it
    # dispatches and becomes the persisted RUNNING marker.
    service.start_gallery_tagging(
        TagRequest(image_ids=[1]), background_tasks=None, legacy_service=legacy
    )
    smart_job["job"] = None
    assert service.dispatch_pending_once() is True
    assert legacy.started is True
    assert service.queue_snapshot()["total_queued"] == 0  # running, not queued

    # Cancelling the gallery job clears the RUNNING marker.
    service.cancel_gallery_tagging(legacy_service=legacy)

    assert _make_service().queue_snapshot()["total_queued"] == 0


def test_failed_dispatch_leaves_no_running_marker_on_disk(monkeypatch):
    """A queued job whose start raises is dropped and no RUNNING marker is
    persisted, so a restart restores nothing for it."""
    from services.tagging_service import TagRequest
    from services import ai_job_queue_store

    service = _make_service()

    smart_job = {"job": SimpleNamespace(job_id="smart-active", status="running")}
    import routers.vlm as vlm_router
    from services import tagging_pipeline_service as tps

    monkeypatch.setattr(
        tps.smart_tag_service, "get_active_job", lambda: smart_job["job"]
    )
    monkeypatch.setattr(vlm_router, "is_caption_batch_active", lambda: False)

    class _ExplodingLegacy(_FakeLegacyTaggingService):
        def start_tagging(self, request, background_tasks):
            raise HTTPException(
                status_code=400, detail="selection token no longer decodes"
            )

    service.start_gallery_tagging(
        TagRequest(image_ids=[1]),
        background_tasks=None,
        legacy_service=_ExplodingLegacy(),
    )
    smart_job["job"] = None

    assert service.dispatch_pending_once() is True  # consumes + drops the broken entry

    on_disk = json.loads(
        ai_job_queue_store.get_queue_state_path().read_text(encoding="utf-8")
    )
    assert on_disk["entries"] == []
    # And the error was recorded for the kind.
    assert (
        "selection token"
        in service.queue_snapshot("gallery-tag")["last_start_error"]["error"]
    )


# ---------------------------------------------------------------------------
# 7. Probe status filtering
# ---------------------------------------------------------------------------


def test_smart_probe_treats_a_terminal_status_job_as_idle(monkeypatch):
    """get_active_job returning a job in a non-active status (e.g. 'done') is
    treated as idle, so a new Smart Tag start proceeds rather than queueing."""
    import routers.vlm as vlm_router
    from services import tagging_pipeline_service as tps

    service = _make_service()
    legacy = _FakeLegacyTaggingService()
    monkeypatch.setattr(
        tps.smart_tag_service,
        "get_active_job",
        lambda: SimpleNamespace(job_id="smart-done", status="done"),
    )
    monkeypatch.setattr(vlm_router, "is_caption_batch_active", lambda: False)
    started = []
    monkeypatch.setattr(
        tps.smart_tag_service,
        "start_smart_tag_job",
        lambda payload: (
            started.append(payload) or {"job_id": "smart-new", "status": "queued"}
        ),
    )

    out = service.start_smart_tagging({"image_ids": [1]}, legacy_service=legacy)

    assert out.get("pipeline_queued") is None
    assert out["job_id"] == "smart-new"
    assert started == [{"image_ids": [1]}]


def test_missing_legacy_service_probes_as_idle(monkeypatch):
    """A None legacy_service probes idle (no gallery job to conflict with)."""
    import routers.vlm as vlm_router
    from services import tagging_pipeline_service as tps

    service = _make_service()
    monkeypatch.setattr(tps.smart_tag_service, "get_active_job", lambda: None)
    monkeypatch.setattr(vlm_router, "is_caption_batch_active", lambda: False)
    started = []
    monkeypatch.setattr(
        tps.smart_tag_service,
        "start_smart_tag_job",
        lambda payload: (
            started.append(payload) or {"job_id": "smart-new", "status": "queued"}
        ),
    )

    out = service.start_smart_tagging({"image_ids": [1]}, legacy_service=None)

    assert out.get("pipeline_queued") is None
    assert started == [{"image_ids": [1]}]


# ---------------------------------------------------------------------------
# 8. Small helpers: _exception_detail / _with_owner + dispatch/cancel edges
# ---------------------------------------------------------------------------


def test_exception_detail_prefers_detail_then_str_then_classname():
    from services.tagging_pipeline_service import _exception_detail

    assert _exception_detail(HTTPException(status_code=409, detail="busy")) == "busy"
    assert _exception_detail(RuntimeError("boom")) == "boom"

    class _Blank(Exception):
        pass

    # No detail attr and an empty str(exc) -> falls back to the class name.
    assert _exception_detail(_Blank()) == "_Blank"


def test_with_owner_copies_input_and_stamps_owner_and_mode():
    from services.tagging_pipeline_service import (
        KIND_SMART,
        PIPELINE_OWNER,
        _with_owner,
    )

    source = {"status": "started"}
    out = _with_owner(source, KIND_SMART)

    assert out["pipeline_owner"] == PIPELINE_OWNER
    assert out["pipeline_mode"] == KIND_SMART
    # Input dict is not mutated (new object returned).
    assert "pipeline_owner" not in source
    assert out is not source


def test_dispatch_pending_once_returns_false_on_empty_queue():
    service = _make_service()

    assert service.dispatch_pending_once() is False


def test_remove_queued_jobs_returns_zero_and_leaves_other_kinds(monkeypatch):
    from services.tagging_service import TagRequest

    service = _make_service()
    legacy = _FakeLegacyTaggingService()
    _smart_busy(monkeypatch)

    service.start_gallery_tagging(
        TagRequest(image_ids=[1]), background_tasks=None, legacy_service=legacy
    )

    removed = service.remove_queued_jobs("smart-tag")

    assert removed == 0
    assert service.queue_snapshot()["total_queued"] == 1  # the gallery entry survives


def test_cancel_smart_with_active_job_reports_cancel_requested(monkeypatch):
    from services import tagging_pipeline_service as tps

    service = _make_service()
    monkeypatch.setattr(
        tps.smart_tag_service,
        "cancel_active_job",
        lambda: SimpleNamespace(job_id="smart-9", status="cancelling"),
    )

    out = service.cancel_smart_tagging()

    assert out["job_id"] == "smart-9"
    assert out["status"] == "cancelling"
    assert out["cancel_requested"] is True
    assert out["removed_queued"] == 0
    assert out["pipeline_mode"] == "smart-tag"


# ---------------------------------------------------------------------------
# 9. ServiceProvider singleton semantics (get/set_tagging_pipeline_service)
# ---------------------------------------------------------------------------


def test_pipeline_provider_get_returns_a_singleton():
    from services.tagging_pipeline_service import (
        get_tagging_pipeline_service,
        set_tagging_pipeline_service,
    )

    set_tagging_pipeline_service(None)  # clear so get() builds lazily

    first = get_tagging_pipeline_service()
    second = get_tagging_pipeline_service()

    assert first is second


def test_pipeline_provider_set_replaces_and_none_rebuilds_fresh():
    from services.tagging_pipeline_service import (
        TaggingPipelineService,
        get_tagging_pipeline_service,
        set_tagging_pipeline_service,
    )

    injected = _make_service()
    set_tagging_pipeline_service(injected)
    assert get_tagging_pipeline_service() is injected

    set_tagging_pipeline_service(None)
    rebuilt = get_tagging_pipeline_service()

    assert rebuilt is not injected
    assert isinstance(rebuilt, TaggingPipelineService)
