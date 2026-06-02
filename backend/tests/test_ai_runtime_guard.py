"""Tests for the v3.3.0 PERF-2 tiered AI runtime scheduler.

The VRAM tier must stay mutually exclusive (the original crash-prevention
invariant); the CPU tier must allow bounded concurrency. Both tiers must be
reentrant on the same thread so nested leases don't deadlock.
"""
import sys
import threading
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
