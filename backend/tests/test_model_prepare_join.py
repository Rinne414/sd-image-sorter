"""Model prepares run one at a time, numbered, and keep how they ended.

Two V4 tabs can both continue a saved model download list after a restart
(features/jobs/installResume.ts). The backend runs one prepare at a time: while
one runs, POST /api/models/prepare answers with the running download's model
and run id and starts nothing, and V4's startInstall follows that download
instead of starting its own.

A tab that follows a download can miss the moment one run hands over to the
next. Every started prepare gets a run id, and the result of each finished run
stays readable by that id in GET /api/models/download-progress
(``finished_prepares``), so the tab still learns how its own run ended.

The endpoints are driven on their own event loop: a TestClient without a
context waits for the background prepare before it returns, so no second
request could ever meet a running one.
"""

from __future__ import annotations

import asyncio
import threading
import time

import pytest

from routers import models as models_router
from routers.models import PrepareModelRequest, get_download_progress, prepare_model

WAIT_S = 5.0


class BlockingModelService:
    """Holds each prepare until `release` is set; answers from `results` per model."""

    def __init__(self) -> None:
        self.calls: list[str] = []
        self.started = threading.Event()
        self.release = threading.Event()
        self.results: dict[str, dict] = {}

    def prepare_model(self, model_id, source=None, variant=None):
        self.calls.append(model_id)
        self.started.set()
        self.release.wait(WAIT_S)
        return self.results.get(model_id, {"status": "ready", "message": "ok"})


@pytest.fixture
def prepare():
    service = BlockingModelService()
    loop = asyncio.new_event_loop()
    with models_router._prepare_lock:
        models_router._prepare_result.update(active=False, model_id="", status="")
        models_router._finished_prepares.clear()

    def post(model_id: str) -> dict:
        return loop.run_until_complete(
            prepare_model(PrepareModelRequest(model_id=model_id), service=service)
        )

    def progress() -> dict:
        return loop.run_until_complete(get_download_progress())

    yield service, post, progress
    service.release.set()
    _wait_until_idle()
    loop.close()
    with models_router._prepare_lock:
        models_router._finished_prepares.clear()


def _wait_until_idle() -> dict:
    deadline = time.monotonic() + WAIT_S
    while time.monotonic() < deadline:
        with models_router._prepare_lock:
            result = dict(models_router._prepare_result)
        if not result["active"]:
            return result
        time.sleep(0.02)
    raise AssertionError("prepare never finished")


def _run_to_end(service: BlockingModelService, post, model_id: str) -> int:
    service.release.set()
    run_id = post(model_id)["run_id"]
    _wait_until_idle()
    return run_id


def test_a_second_request_for_the_running_model_joins_it(prepare):
    service, post, _ = prepare
    first = post("clip")
    assert first["status"] == "downloading"
    assert first["model_id"] == "clip"
    assert first["message"] == "Download started in background."
    assert isinstance(first["run_id"], int) and first["run_id"] > 0
    assert service.started.wait(WAIT_S)

    assert post("clip") == {
        "status": "downloading",
        "model_id": "clip",
        "run_id": first["run_id"],
        "message": "A download is already in progress.",
    }
    service.release.set()
    assert _wait_until_idle()["status"] == "done"
    assert service.calls == ["clip"]


def test_a_request_for_another_model_names_the_running_one_and_starts_nothing(prepare):
    service, post, _ = prepare
    first = post("clip")
    assert service.started.wait(WAIT_S)

    # V4's startInstall compares model_id with its own card and says another download runs
    other = post("artist")
    assert other["model_id"] == "clip"
    assert other["run_id"] == first["run_id"]
    service.release.set()
    _wait_until_idle()
    assert service.calls == ["clip"]


def test_every_started_prepare_gets_a_new_run_id(prepare):
    service, post, progress = prepare
    first = _run_to_end(service, post, "clip")
    second = _run_to_end(service, post, "clip")

    assert second > first
    assert progress()["prepare_result"]["run_id"] == second


def test_a_finished_run_keeps_its_result_after_the_next_one_starts(prepare):
    """The hand-over a following tab can miss: its run is over, and says how."""
    service, post, progress = prepare
    service.results["clip"] = {
        "status": "needs_restart",
        "message": "Restart to finish setting up CLIP.",
        "restart_recommended": True,
        "installed_packages": ["fastembed"],
    }
    clip_run = _run_to_end(service, post, "clip")

    service.release.clear()
    service.started.clear()
    artist_run = post("artist")["run_id"]
    assert service.started.wait(WAIT_S)
    seen = progress()

    live = seen["prepare_result"]
    assert (live["run_id"], live["model_id"], live["active"]) == (
        artist_run,
        "artist",
        True,
    )
    finished = seen["finished_prepares"][str(clip_run)]
    assert finished["run_id"] == clip_run
    assert finished["model_id"] == "clip"
    assert finished["active"] is False
    assert finished["status"] == "needs_restart"
    assert finished["message"] == "Restart to finish setting up CLIP."
    assert finished["restart_recommended"] is True
    assert finished["installed_packages"] == ["fastembed"]
    assert str(artist_run) not in seen["finished_prepares"]


def test_a_failed_run_keeps_its_error(prepare):
    service, post, progress = prepare

    class Refused(Exception):
        pass

    def refuse(model_id, source=None, variant=None):
        raise Refused("HTTP 403")

    service.prepare_model = refuse
    run_id = _run_to_end(service, post, "cl-tagger-v2")

    finished = progress()["finished_prepares"][str(run_id)]
    assert finished["model_id"] == "cl-tagger-v2"
    assert finished["status"] == "error"
    assert finished["error"] == "HTTP 403"


def test_only_the_last_finished_runs_are_kept(prepare, monkeypatch):
    service, post, progress = prepare
    monkeypatch.setattr(models_router, "FINISHED_PREPARES_KEPT", 2)
    runs = [_run_to_end(service, post, model) for model in ("clip", "artist", "lucida")]

    assert sorted(progress()["finished_prepares"]) == sorted(
        str(run) for run in runs[1:]
    )
