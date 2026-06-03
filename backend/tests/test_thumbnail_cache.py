import asyncio
import os
import sys
import threading
import time
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).parent.parent))

import scan_state  # noqa: E402
import thumbnail_cache  # noqa: E402


def _write_cache_file(path: Path, size: int, mtime: float) -> None:
    path.write_bytes(b"x" * size)
    os.utime(path, (mtime, mtime))


def test_enforce_cache_size_limit_evicts_oldest_webp_files(monkeypatch, tmp_path):
    monkeypatch.setattr(thumbnail_cache, "CACHE_DIR", tmp_path)
    monkeypatch.setattr(thumbnail_cache, "get_thumbnail_cache_max_mb", lambda: 1)

    now = time.time()
    old_file = tmp_path / "old_256.webp"
    middle_file = tmp_path / "middle_256.webp"
    newest_file = tmp_path / "newest_256.webp"
    _write_cache_file(old_file, 600 * 1024, now - 30)
    _write_cache_file(middle_file, 400 * 1024, now - 20)
    _write_cache_file(newest_file, 300 * 1024, now - 10)

    result = thumbnail_cache.enforce_cache_size_limit(force=True)

    assert result["deleted_count"] == 1
    assert result["total_size_bytes"] <= 1024 * 1024
    assert not old_file.exists()
    assert middle_file.exists()
    assert newest_file.exists()


def test_zero_cache_limit_disables_persistent_thumbnail_writes(monkeypatch, tmp_path):
    cache_dir = tmp_path / "thumbs"
    image_path = tmp_path / "source.png"
    Image.new("RGB", (80, 80), color="red").save(image_path)
    monkeypatch.setattr(thumbnail_cache, "CACHE_DIR", cache_dir)
    monkeypatch.setattr(thumbnail_cache, "get_thumbnail_cache_max_mb", lambda: 0)

    thumbnail_bytes, _ = thumbnail_cache.generate_and_cache_thumbnail(str(image_path), 256)

    assert thumbnail_bytes
    assert not list(cache_dir.glob("*.webp"))


def test_thumbnail_cache_temp_paths_are_unique_for_same_cache_key(monkeypatch, tmp_path):
    cache_path = tmp_path / "same_256.webp"

    first = thumbnail_cache._get_cache_tmp_path(cache_path)
    second = thumbnail_cache._get_cache_tmp_path(cache_path)

    assert first != second
    assert first.parent == cache_path.parent
    assert second.parent == cache_path.parent
    assert first.name.startswith(f"{cache_path.name}.")
    assert second.name.startswith(f"{cache_path.name}.")
    assert first.suffix == ".tmp"
    assert second.suffix == ".tmp"


def test_cache_stats_report_configured_limit(monkeypatch, tmp_path):
    monkeypatch.setattr(thumbnail_cache, "CACHE_DIR", tmp_path)
    monkeypatch.setattr(thumbnail_cache, "get_thumbnail_cache_max_mb", lambda: 500)
    (tmp_path / "one.webp").write_bytes(b"abc")

    stats = thumbnail_cache.get_cache_stats()

    assert stats["max_size_mb"] == 500
    assert stats["max_size_bytes"] == 500 * 1024 * 1024
    assert stats["limit_enabled"] is True
    assert stats["file_count_complete"] is True


def test_zero_cache_limit_ignores_existing_persistent_cache(monkeypatch, tmp_path):
    cache_dir = tmp_path / "thumbs"
    image_path = tmp_path / "source.png"
    Image.new("RGB", (80, 80), color="blue").save(image_path)

    limit = {"max_mb": 1}
    monkeypatch.setattr(thumbnail_cache, "CACHE_DIR", cache_dir)
    monkeypatch.setattr(thumbnail_cache, "get_thumbnail_cache_max_mb", lambda: limit["max_mb"])

    first_bytes, _ = thumbnail_cache.generate_and_cache_thumbnail(str(image_path), 256)
    assert first_bytes
    assert list(cache_dir.glob("*.webp"))

    limit["max_mb"] = 0
    cached = thumbnail_cache.get_cached_thumbnail(str(image_path), 256)
    assert cached is None

    _thumb_bytes, _last_modified, cache_hit = thumbnail_cache.get_thumbnail(str(image_path), 256)
    assert cache_hit is False


def test_cache_stats_use_limited_scan_for_large_thumbnail_cache(monkeypatch, tmp_path):
    monkeypatch.setattr(thumbnail_cache, "CACHE_DIR", tmp_path)
    monkeypatch.setattr(thumbnail_cache, "get_thumbnail_cache_max_mb", lambda: 500)
    monkeypatch.setattr(thumbnail_cache, "_scan_cache_files_limited", lambda: (10000, 123456, False))

    stats = thumbnail_cache.get_cache_stats()

    assert stats["file_count"] == 10000
    assert stats["file_count_complete"] is False
    assert stats["total_size_bytes"] is None
    assert stats["total_size_mb"] is None


def test_force_cache_cleanup_uses_limited_scan(monkeypatch, tmp_path):
    monkeypatch.setattr(thumbnail_cache, "CACHE_DIR", tmp_path)
    monkeypatch.setattr(thumbnail_cache, "get_thumbnail_cache_max_mb", lambda: 1)

    calls = []

    def fake_limited_scan(max_files):
        calls.append(max_files)
        return [], False

    def fail_full_scan():
        raise AssertionError("force cleanup must not scan the full cache directory")

    monkeypatch.setattr(thumbnail_cache, "_iter_cache_files_limited", fake_limited_scan)
    monkeypatch.setattr(thumbnail_cache, "_iter_cache_files", fail_full_scan)

    result = thumbnail_cache.enforce_cache_size_limit(force=True)

    assert calls == [thumbnail_cache.FORCE_CLEANUP_SCAN_LIMIT]
    assert result["partial"] is True


def _drain_scan_state() -> None:
    """Reset the process-wide scan counter to a clean baseline for a test."""
    while scan_state.is_scan_running():
        scan_state.scan_finished()


def test_scan_state_counter_tracks_overlapping_scans():
    _drain_scan_state()
    assert scan_state.is_scan_running() is False

    scan_state.scan_started()
    scan_state.scan_started()
    assert scan_state.is_scan_running() is True
    assert scan_state.active_scan_count() == 2

    scan_state.scan_finished()
    assert scan_state.is_scan_running() is True  # one scan still in flight

    scan_state.scan_finished()
    assert scan_state.is_scan_running() is False

    # Over-finishing never drives the counter negative.
    scan_state.scan_finished()
    assert scan_state.active_scan_count() == 0


def test_thumbnail_generation_throttles_during_scan(monkeypatch):
    _drain_scan_state()

    # Force the cache-miss branch so generation runs through the executor.
    monkeypatch.setattr(thumbnail_cache, "get_cached_thumbnail", lambda *a, **k: None)
    # Rebind the throttle semaphore to this test's fresh event loop.
    monkeypatch.setattr(thumbnail_cache, "_THUMB_CONCURRENCY_DURING_SCAN", 2)
    monkeypatch.setattr(thumbnail_cache, "_thumb_scan_semaphore", None)

    observed = {"current": 0, "max": 0}
    guard = threading.Lock()

    def fake_generate(source_path, size):
        with guard:
            observed["current"] += 1
            observed["max"] = max(observed["max"], observed["current"])
        time.sleep(0.05)
        with guard:
            observed["current"] -= 1
        return (b"thumb-bytes", 1234.5)

    monkeypatch.setattr(thumbnail_cache, "generate_and_cache_thumbnail", fake_generate)

    async def run_many():
        scan_state.scan_started()
        try:
            return await asyncio.gather(
                *(thumbnail_cache.get_thumbnail_async(f"img-{i}.png", 256) for i in range(8))
            )
        finally:
            scan_state.scan_finished()

    results = asyncio.run(run_many())

    assert len(results) == 8
    assert all(cache_hit is False for *_payload, cache_hit in results)
    assert observed["max"] <= 2  # scan-time throttle held the line


def test_thumbnail_generation_runs_unthrottled_without_scan(monkeypatch):
    _drain_scan_state()
    monkeypatch.setattr(thumbnail_cache, "get_cached_thumbnail", lambda *a, **k: None)

    def fake_generate(source_path, size):
        return (b"thumb-bytes", 9.0)

    monkeypatch.setattr(thumbnail_cache, "generate_and_cache_thumbnail", fake_generate)

    async def run_one():
        return await thumbnail_cache.get_thumbnail_async("solo.png", 256)

    thumbnail_bytes, last_modified, cache_hit = asyncio.run(run_one())

    assert thumbnail_bytes == b"thumb-bytes"
    assert last_modified == 9.0
    assert cache_hit is False
