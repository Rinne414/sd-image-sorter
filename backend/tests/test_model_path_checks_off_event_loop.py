"""SEC1f: checking a user-supplied model path never blocks the event loop.

A model file on a trusted NAS that is offline takes an SMB timeout (~21 s)
to resolve. The pydantic validators only do pure string work (source,
extension, network rule); the resolve / is_file step runs in the threadpool,
so thumbnails and progress polls keep answering while one request waits.
"""

from __future__ import annotations

import asyncio
import time
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

import model_roots

NAS = r"\\nas\share\models"
SLOW_SECONDS = 2.0
CHEAP_BUDGET_SECONDS = 0.1
SLEEP_BUDGET_SECONDS = 0.5
CHEAP_URL = "/api/updates/boot-id"


@pytest.fixture
def trusted_nas(tmp_path, monkeypatch):
    """Settings under tmp_path (never the owner's), with the NAS trusted so
    the network rule passes and the file check is what runs."""
    import config

    config_dir = tmp_path / "config"
    config_dir.mkdir()
    path = config_dir / "app-settings.json"
    project_data = (Path(__file__).resolve().parents[2] / "data").resolve()
    assert not path.resolve().is_relative_to(project_data), path
    monkeypatch.setattr(config, "CONFIG_DIR", config_dir)
    monkeypatch.setattr(config, "APP_SETTINGS_CONFIG_PATH", path)
    model_roots.add_trusted_model_folder(NAS)
    return SimpleNamespace(settings=path)


def _slow_network_resolve(monkeypatch, *modules):
    """`Path.resolve()` on a network path sleeps like an SMB timeout and then
    reports the file missing; local paths go through to the real call."""
    calls = []
    real_resolve = Path.resolve

    class _SlowPath(Path):
        def resolve(self, *args, **kwargs):
            if str(self).startswith("\\\\"):
                calls.append(str(self))
                time.sleep(SLOW_SECONDS)  # the SMB timeout
                return self  # unresolved: the file check below says "missing"
            return real_resolve(self, *args, **kwargs)

        def is_file(self):
            if str(self).startswith("\\\\"):
                return False
            return super().is_file()

        def exists(self):
            if str(self).startswith("\\\\"):
                return False
            return super().exists()

    for module in modules:
        monkeypatch.setattr(module, "Path", _SlowPath)
    return calls


async def _cheap_request_while(app, method, url, json_body, cheap_url=CHEAP_URL):
    """Fire the slow request, then time a cheap one issued while it runs."""
    transport = httpx.ASGITransport(app=app, client=("127.0.0.1", 50000))
    async with httpx.AsyncClient(
        transport=transport, base_url="http://127.0.0.1", timeout=30
    ) as client:
        slow = asyncio.create_task(client.request(method, url, json=json_body))
        # A blocked loop holds this very sleep until the wait is over, so the
        # sleep itself is timed too: it is the only probe that sees a handler
        # blocking the loop before the cheap request is even issued.
        sleep_started = time.perf_counter()
        await asyncio.sleep(0.05)  # the slow request has reached its wait
        sleep_elapsed = time.perf_counter() - sleep_started
        started = time.perf_counter()
        cheap = await client.get(cheap_url)
        elapsed = time.perf_counter() - started
        still_waiting = not slow.done()
        slow_response = await slow
        return SimpleNamespace(
            sleep_elapsed=sleep_elapsed,
            elapsed=elapsed,
            still_waiting=still_waiting,
            cheap=cheap,
            slow=slow_response,
        )


def _assert_loop_stayed_free(result):
    assert result.sleep_elapsed < SLEEP_BUDGET_SECONDS, (
        f"the loop was blocked: asyncio.sleep(0.05) took {result.sleep_elapsed:.2f}s"
    )
    assert result.cheap.status_code == 200
    assert result.still_waiting, (
        "the loop was blocked: the cheap request only ran after the NAS check"
    )
    assert result.elapsed < CHEAP_BUDGET_SECONDS, (
        f"the cheap request took {result.elapsed:.2f}s"
    )


class TestArtistModelPathChecksOffTheLoop:
    @pytest.mark.parametrize(
        "url, body",
        [
            ("/api/artists/identify", {"image_id": 1, "threshold": 0.03, "top_k": 5}),
            (
                "/api/artists/identify-batch",
                {"image_ids": [1], "threshold": 0.03, "top_k": 5},
            ),
            ("/api/style-map/vectors/start", {}),
        ],
    )
    def test_a_slow_nas_check_does_not_stall_other_requests(
        self, test_client, trusted_nas, monkeypatch, url, body
    ):
        from main import app
        from routers import artists as artists_router

        calls = _slow_network_resolve(monkeypatch, artists_router)
        payload = {
            **body,
            "model_source": "local",
            "model_path": NAS + r"\lsnet\best.pth",
        }
        result = asyncio.run(_cheap_request_while(app, "POST", url, payload))
        _assert_loop_stayed_free(result)
        assert result.slow.status_code == 400, (
            result.slow.text
        )  # the file is missing: same answer as before
        assert calls  # the check did run, just not on the loop

    def test_the_validator_is_pure_and_the_resolver_touches_the_file(
        self, trusted_nas, monkeypatch
    ):
        from routers import artists as artists_router
        from routers.artists import ArtistModelConfig, resolve_local_artist_model

        touched = []

        class _RecordingPath(Path):
            def _touched(self, *_args, **_kwargs):
                touched.append(str(self))
                raise FileNotFoundError(str(self))

            resolve = is_file = stat = exists = _touched

        monkeypatch.setattr(artists_router, "Path", _RecordingPath)
        config = ArtistModelConfig(
            model_source="local", model_path=NAS + r"\lsnet\best.pth"
        )
        assert config.model_path == NAS + r"\lsnet\best.pth"
        assert touched == []
        with pytest.raises(ValueError):
            resolve_local_artist_model(config.model_path)
        assert touched

    def test_a_local_file_still_resolves_to_its_real_path(self, tmp_path):
        from routers.artists import resolve_local_artist_model

        weights = tmp_path / "w.pth"
        weights.write_bytes(b"w")
        assert resolve_local_artist_model(str(weights)) == str(weights.resolve())
        with pytest.raises(ValueError, match="not found"):
            resolve_local_artist_model(str(tmp_path / "missing.pth"))


POLL_URLS = [
    CHEAP_URL,
    "/api/tag/progress",
    "/api/tags/pipeline-queue",
    "/api/vlm/caption-batch/progress",
]


class TestTaggerModelPathChecksOffTheLoop:
    @pytest.mark.parametrize("poll_url", POLL_URLS)
    def test_a_slow_nas_check_does_not_stall_other_requests(
        self, test_client, trusted_nas, monkeypatch, poll_url
    ):
        from main import app
        from utils import path_validation

        calls = _slow_network_resolve(monkeypatch, path_validation)
        payload = {"model_path": NAS + r"\wd14\model.onnx", "custom_profile": "wd14"}
        result = asyncio.run(
            _cheap_request_while(
                app, "POST", "/api/tag/start", payload, cheap_url=poll_url
            )
        )
        _assert_loop_stayed_free(result)
        assert result.slow.status_code == 400, result.slow.text
        assert calls


class TestLocalArtistModelErrorsSayWhatWentWrong:
    @staticmethod
    def _raising_path(monkeypatch, exc):
        from routers import artists as artists_router

        class _Path(Path):
            def resolve(self, *args, **kwargs):
                raise exc

        monkeypatch.setattr(artists_router, "Path", _Path)

    def test_a_permission_error_is_not_reported_as_missing(self, monkeypatch):
        from routers.artists import resolve_local_artist_model

        self._raising_path(monkeypatch, PermissionError(13, "denied", r"\nas\x"))
        with pytest.raises(ValueError, match="Permission denied") as caught:
            resolve_local_artist_model(r"\nas\x\w.pth")
        assert "nas" not in str(caught.value)

    @pytest.mark.parametrize("winerror", [53, 64, 67, 121, 1231])
    def test_a_windows_network_error_says_the_location_is_unreachable(
        self, monkeypatch, winerror
    ):
        from routers.artists import resolve_local_artist_model

        exc = OSError(0, "network", r"\nas\x")
        exc.winerror = winerror
        self._raising_path(monkeypatch, exc)
        with pytest.raises(ValueError, match="network location cannot be reached") as caught:
            resolve_local_artist_model(r"\nas\x\w.pth")
        assert "nas" not in str(caught.value)

    @pytest.mark.parametrize("code", ["ENETUNREACH", "EHOSTUNREACH", "ETIMEDOUT"])
    def test_a_posix_network_errno_says_the_location_is_unreachable(
        self, monkeypatch, code
    ):
        import errno

        from routers.artists import resolve_local_artist_model

        self._raising_path(monkeypatch, OSError(getattr(errno, code), "net"))
        with pytest.raises(ValueError, match="network location cannot be reached"):
            resolve_local_artist_model("/mnt/nas/w.pth")

    def test_any_other_os_error_stays_not_found(self, monkeypatch):
        from routers.artists import resolve_local_artist_model

        self._raising_path(monkeypatch, OSError(5, "io"))
        with pytest.raises(ValueError, match="not found"):
            resolve_local_artist_model("/x/w.pth")


class TestPollsThatTakeTheJobLockRunOffTheLoop:
    """A poll waiting for the pipeline lock waits in a worker thread, so the
    loop keeps serving everyone else however long the lock is held."""

    @pytest.mark.parametrize(
        "poll_url",
        [
            "/api/tag/progress",
            "/api/tags/pipeline-queue",
            "/api/vlm/caption-batch/progress",
        ],
    )
    def test_a_held_job_lock_does_not_stall_the_loop(self, test_client, poll_url):
        import threading

        from main import app
        from services import tagging_pipeline_service as tps

        holding = threading.Event()
        release = threading.Event()

        def hold_lock():
            with tps._start_lock:
                holding.set()
                release.wait(timeout=10)

        holder = threading.Thread(target=hold_lock, daemon=True)
        holder.start()
        assert holding.wait(timeout=5)

        async def scenario():
            transport = httpx.ASGITransport(app=app, client=("127.0.0.1", 50000))
            async with httpx.AsyncClient(
                transport=transport, base_url="http://127.0.0.1", timeout=30
            ) as client:
                poll = asyncio.create_task(client.get(poll_url))
                sleep_started = time.perf_counter()
                await asyncio.sleep(0.05)
                sleep_elapsed = time.perf_counter() - sleep_started
                started = time.perf_counter()
                cheap = await client.get(CHEAP_URL)
                elapsed = time.perf_counter() - started
                waiting = not poll.done()
                release.set()
                await poll
                return sleep_elapsed, elapsed, cheap, waiting

        try:
            sleep_elapsed, elapsed, cheap, waiting = asyncio.run(scenario())
        finally:
            release.set()
            holder.join(timeout=5)
        assert sleep_elapsed < SLEEP_BUDGET_SECONDS, sleep_elapsed
        assert cheap.status_code == 200
        assert elapsed < CHEAP_BUDGET_SECONDS, elapsed
        assert waiting, "the poll did not wait for the held lock"
