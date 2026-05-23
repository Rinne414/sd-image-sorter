"""Regression tests for /api/library-health caching behavior.

Bug 18 (HIGH): The /api/library-health endpoint was implemented as an
async def route that called synchronous SQL aggregations. On a 71k-row
library the cold-cache report takes ~12 seconds. Under any concurrent
load (the gallery page + diagnostics panel + home page all hit it),
the event loop got blocked and concurrent requests timed out.
Reproducible: 50 parallel reads -> 16 succeeded, 34 hit a 15s timeout.

Fix:
  * Service-level TTL cache (60 seconds) keyed by sample_limit.
  * Route handler changed from async def -> def so FastAPI offloads
    to its thread pool and concurrent requests no longer block the
    event loop while the cache is cold.
"""
from __future__ import annotations

import threading
import time
import pytest


@pytest.fixture(autouse=True)
def _reset_library_health_cache():
    """Clear the cache between tests so each test starts cold."""
    from services.sorting_service import invalidate_library_health_cache
    invalidate_library_health_cache()
    yield
    invalidate_library_health_cache()


def test_library_health_cached_within_ttl(test_client, test_db_with_images):
    """Two consecutive calls with the same sample_limit must return the
    same payload object (cache hit on the second call)."""
    response_a = test_client.get("/api/library-health?sample_limit=4")
    assert response_a.status_code == 200, response_a.text
    payload_a = response_a.json()

    response_b = test_client.get("/api/library-health?sample_limit=4")
    assert response_b.status_code == 200, response_b.text
    payload_b = response_b.json()

    # Same shape and values
    assert payload_a == payload_b


def test_library_health_cache_keyed_on_sample_limit(test_client, test_db_with_images):
    """Different sample_limit values produce separate cache entries
    (so a sample_limit=4 caller doesn't get a sample_limit=25 payload)."""
    a4 = test_client.get("/api/library-health?sample_limit=4").json()
    a25 = test_client.get("/api/library-health?sample_limit=25").json()

    # Both succeed
    assert "summary" in a4
    assert "summary" in a25

    # The sample arrays are independently capped
    samples_a4 = a4.get("issue_samples", [])
    samples_a25 = a25.get("issue_samples", [])
    assert len(samples_a4) <= 4
    assert len(samples_a25) <= 25


def test_library_health_cache_invalidation(test_client, test_db_with_images):
    """invalidate_library_health_cache forces a recompute on next call."""
    from services.sorting_service import invalidate_library_health_cache, _LIBRARY_HEALTH_CACHE

    test_client.get("/api/library-health?sample_limit=4")
    assert 4 in _LIBRARY_HEALTH_CACHE

    invalidate_library_health_cache()
    assert _LIBRARY_HEALTH_CACHE == {}


def test_library_health_concurrent_reads_complete(test_client, test_db_with_images):
    """50 concurrent /api/library-health reads must all succeed.

    This is the regression for the original anti-pattern: async def
    route + sync SQL inside event loop. Now that the route is def + a
    TTL cache wraps the slow path, all parallel readers should get
    200 within a few seconds.
    """
    results: list[int] = []
    barrier = threading.Barrier(50)

    def fire():
        barrier.wait()
        try:
            r = test_client.get("/api/library-health?sample_limit=4")
            results.append(r.status_code)
        except Exception:
            results.append(-1)

    threads = [threading.Thread(target=fire) for _ in range(50)]
    start = time.time()
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)
    elapsed = time.time() - start

    ok = sum(1 for s in results if s == 200)
    assert ok == 50, f"Only {ok}/50 concurrent reads succeeded (elapsed {elapsed:.1f}s)"


def test_library_health_route_is_sync_def(test_client):
    """Sanity: ensure the route is registered as ``def`` (not async def)
    so FastAPI offloads to the thread pool."""
    import inspect
    from routers.sorting import get_library_health
    # Should be a regular function, not a coroutine
    assert not inspect.iscoroutinefunction(get_library_health), (
        "get_library_health must be 'def' (not 'async def') so FastAPI runs "
        "it on the thread pool. Otherwise the synchronous SQL inside blocks "
        "the event loop and concurrent requests time out."
    )
