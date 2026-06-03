"""Tests for the v3.3.0 PERF-2 tiered AI runtime scheduler.

The VRAM tier must stay mutually exclusive (the original crash-prevention
invariant); the CPU tier must allow bounded concurrency. Both tiers must be
reentrant on the same thread so nested leases don't deadlock.
"""
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import ai_runtime_guard as g


def test_vram_tier_is_reentrant_same_thread():
    with g.exclusive_ai_runtime("vram-outer"):
        with g.exclusive_ai_runtime("vram-inner"):
            snap = g.get_ai_jobs_snapshot()
            # Nested same-thread VRAM leases collapse to one active job.
            assert snap["vram_active"] == 1
    assert g.get_ai_jobs_snapshot()["active"] == 0


def test_cpu_tier_allows_concurrency():
    # Ensure the pool is large enough for this test regardless of host CPU count.
    original = g._cpu_semaphore
    g._cpu_semaphore = threading.BoundedSemaphore(4)
    try:
        inside = []
        barrier = threading.Barrier(3, timeout=5)

        def worker(n):
            with g.exclusive_ai_runtime(f"cpu-{n}", tier="cpu"):
                inside.append(n)
                barrier.wait()  # all three must be inside at once

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(3)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        assert sorted(inside) == [0, 1, 2]
    finally:
        g._cpu_semaphore = original


def test_cpu_tier_reentrant_at_pool_size_one():
    # With a pool of 1, a nested CPU lease on the same thread must not deadlock.
    original = g._cpu_semaphore
    g._cpu_semaphore = threading.BoundedSemaphore(1)
    try:
        with g.exclusive_ai_runtime("cpu-outer", tier="cpu"):
            with g.exclusive_ai_runtime("cpu-inner", tier="cpu"):
                assert g.get_ai_jobs_snapshot()["cpu_active"] == 1
    finally:
        g._cpu_semaphore = original


def test_snapshot_shape():
    snap = g.get_ai_jobs_snapshot()
    for key in ("active", "vram_active", "cpu_active", "cpu_pool_size", "jobs"):
        assert key in snap
    assert isinstance(snap["jobs"], list)


def test_unknown_tier_falls_back_to_vram():
    lease = g.exclusive_ai_runtime("weird", tier="bogus")
    assert lease.tier == "vram"


def test_invalid_cpu_pool_env_falls_back(monkeypatch):
    monkeypatch.setenv("SD_IMAGE_SORTER_AI_CPU_POOL", "not-a-number")
    assert g._default_cpu_pool_size() >= 1


# --- v3.3.2 Phase 1: priority + timeout + VRAM estimate at the VRAM seam ---


def _wait_until(predicate, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.005)
    return predicate()


def test_vram_priority_admits_interactive_before_batch():
    gate = g._vram_gate
    order = []
    order_lock = threading.Lock()

    def waiter(label, priority):
        with g.exclusive_ai_runtime(label, priority=priority):
            with order_lock:
                order.append(label)
            time.sleep(0.01)

    with g.exclusive_ai_runtime("holder"):
        # Enqueue BATCH first, then INTERACTIVE — arrival order favors batch.
        batch = threading.Thread(target=waiter, args=("batch", g.PRIORITY_BATCH))
        batch.start()
        assert _wait_until(lambda: len(gate._heap) >= 1)
        inter = threading.Thread(target=waiter, args=("interactive", g.PRIORITY_INTERACTIVE))
        inter.start()
        assert _wait_until(lambda: len(gate._heap) >= 2)
        # holder released as this block exits

    batch.join(5)
    inter.join(5)
    # Despite enqueuing second, interactive must be admitted first.
    assert order == ["interactive", "batch"]


def test_same_priority_waiters_stay_fifo():
    gate = g._vram_gate
    order = []
    order_lock = threading.Lock()

    def waiter(label):
        with g.exclusive_ai_runtime(label, priority=g.PRIORITY_NORMAL):
            with order_lock:
                order.append(label)
            time.sleep(0.005)

    with g.exclusive_ai_runtime("holder"):
        first = threading.Thread(target=waiter, args=("first",))
        first.start()
        assert _wait_until(lambda: len(gate._heap) >= 1)
        second = threading.Thread(target=waiter, args=("second",))
        second.start()
        assert _wait_until(lambda: len(gate._heap) >= 2)

    first.join(5)
    second.join(5)
    assert order == ["first", "second"]


def test_vram_timeout_raises_when_busy():
    outcome = {}

    def waiter():
        try:
            with g.exclusive_ai_runtime("waiter", timeout=0.1):
                outcome["acquired"] = True
        except g.AiRuntimeBusyError:
            outcome["busy"] = True

    with g.exclusive_ai_runtime("holder"):
        t = threading.Thread(target=waiter)
        t.start()
        t.join(5)

    assert outcome.get("busy") is True
    assert "acquired" not in outcome
    # A timed-out waiter must leave no ghost ticket behind.
    assert g.get_ai_jobs_snapshot()["active"] == 0
    assert len(g._vram_gate._heap) == 0


def test_vram_timeout_acquires_when_free():
    with g.exclusive_ai_runtime("solo", timeout=2.0):
        assert g.get_ai_jobs_snapshot()["vram_active"] == 1
    assert g.get_ai_jobs_snapshot()["active"] == 0


def test_snapshot_reports_priority_and_vram_estimate():
    with g.exclusive_ai_runtime("estimating", priority=g.PRIORITY_INTERACTIVE, vram_mb=512):
        snap = g.get_ai_jobs_snapshot()
        job = next(j for j in snap["jobs"] if j["label"] == "estimating")
        assert job["priority"] == g.PRIORITY_INTERACTIVE
        assert job["estimated_vram_mb"] == 512
        assert job["stuck"] is False
        assert snap["vram_estimated_mb"] >= 512
        assert "stuck_after_seconds" in snap
    assert g.get_ai_jobs_snapshot()["active"] == 0


def test_cpu_timeout_raises_when_pool_exhausted():
    original = g._cpu_semaphore
    g._cpu_semaphore = threading.BoundedSemaphore(1)
    try:
        outcome = {}
        ready = threading.Event()
        release = threading.Event()

        def holder():
            with g.exclusive_ai_runtime("cpu-holder", tier="cpu"):
                ready.set()
                release.wait(5)

        h = threading.Thread(target=holder)
        h.start()
        assert ready.wait(5)
        try:
            with g.exclusive_ai_runtime("cpu-waiter", tier="cpu", timeout=0.1):
                outcome["acquired"] = True
        except g.AiRuntimeBusyError:
            outcome["busy"] = True
        release.set()
        h.join(5)
        assert outcome.get("busy") is True
        assert "acquired" not in outcome
    finally:
        g._cpu_semaphore = original
