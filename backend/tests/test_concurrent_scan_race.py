"""Regression test for the concurrent scan-start race condition.

Background
==========
Phase-5 concurrent test: three threads firing POST /api/scan
simultaneously all received 200 "Scan started" responses, but only one
actual scan was running. The second/third callers raced through the
gate because:

  1. start_scan() acquired the lock, set status='running', released
     lock, then queued the worker via background_tasks.
  2. Until the background task got around to actually starting the
     worker thread, ``_scan_worker_thread`` was still None.
  3. The original guard was ``status in {running, cancelling} AND
     worker_alive``. Second/third callers in the race window saw
     status='running' but worker_alive=False, so the AND was False
     and they bypassed the guard.

The fix introduces a 'starting' transition state. start_scan() sets
status='starting' inside the lock; run_scan() flips it to 'running'
once the worker thread is actually live. Any non-terminal status
('starting', 'running', 'cancelling') now blocks new starts; the
"worker died but status stuck" stale-state path returns 409 with a
message pointing at /api/scan/reset.
"""
from __future__ import annotations

import threading
from pathlib import Path



def _build_sandbox_dir(tmp_path: Path) -> Path:
    sandbox = tmp_path / "scan-sandbox"
    sandbox.mkdir()
    from PIL import Image
    for i in range(3):
        Image.new("RGB", (32, 32), color=(i * 50, 100, 200)).save(sandbox / f"img-{i}.png")
    return sandbox


def test_concurrent_scan_starts_only_one_succeeds(test_client, test_db, tmp_path: Path):
    """Three threads firing /api/scan simultaneously: exactly one should
    get 200, the other two should get 409 conflict."""
    sandbox = _build_sandbox_dir(tmp_path)
    body = {"folder_path": str(sandbox), "recursive": False}

    results: list[tuple[str, int]] = []
    barrier = threading.Barrier(3)

    def fire(label: str) -> None:
        barrier.wait()  # Sync all 3 to fire as close to simultaneously as possible
        try:
            resp = test_client.post("/api/scan", json=body)
            results.append((label, resp.status_code))
        except Exception:
            results.append((label, -1))

    threads = [threading.Thread(target=fire, args=(f"caller-{i}",)) for i in range(3)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=10)

    statuses = [s for _, s in results]
    print(f"  concurrent statuses: {statuses}")

    # Exactly one should be 200; the other two should be 409 (or 400 fallback)
    ok_count = sum(1 for s in statuses if s == 200)
    conflict_count = sum(1 for s in statuses if s in (400, 409))

    assert ok_count == 1, (
        f"Expected exactly 1 successful scan-start, got {ok_count}. "
        f"Statuses: {statuses}"
    )
    assert ok_count + conflict_count == 3, (
        f"Some thread saw an unexpected status: {statuses}"
    )


def test_second_scan_after_first_finishes_is_allowed(test_client, test_db, tmp_path: Path):
    """Sanity: after the in-progress scan completes, a fresh scan must work."""
    sandbox = _build_sandbox_dir(tmp_path)
    body = {"folder_path": str(sandbox), "recursive": False}

    # Reset any leftover state from prior tests
    test_client.post("/api/scan/reset")

    response_a = test_client.post("/api/scan", json=body)
    assert response_a.status_code == 200, response_a.text

    # Wait for it to finish
    import time
    for _ in range(60):
        progress = test_client.get("/api/scan/progress").json()
        if progress.get("status") in ("done", "idle", "completed", "success"):
            break
        time.sleep(0.5)

    # New scan should succeed
    response_b = test_client.post("/api/scan", json=body)
    assert response_b.status_code == 200, response_b.text


def test_starting_state_blocks_concurrent_start(test_client, test_db, tmp_path: Path, monkeypatch):
    """If status is artificially stuck at 'starting', subsequent calls must
    get 409 (in-progress) not 200 (silent overlap)."""
    from routers.sorting import _sorting_service_provider

    svc = _sorting_service_provider.get()
    # Inject 'starting' state directly
    with svc._scan_lock:
        svc._scan_progress = {**svc._scan_progress, "status": "starting"}
        svc._scan_worker_thread = None

    sandbox = _build_sandbox_dir(tmp_path)
    response = test_client.post("/api/scan", json={"folder_path": str(sandbox), "recursive": False})
    assert response.status_code == 409, response.text
    assert "already in progress" in response.text.lower()

    # Cleanup so other tests don't see the stuck state
    test_client.post("/api/scan/reset")
