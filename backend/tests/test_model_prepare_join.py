"""A second model download request joins the one already running.

Two V4 tabs can both continue a saved model download list after a restart
(features/jobs/installResume.ts). The backend runs one prepare at a time: while
one runs, POST /api/models/prepare answers with the running download's model
and starts nothing, and V4's startInstall follows that download instead of
starting its own.

The endpoint is driven on its own event loop: a TestClient without a context
waits for the background prepare before it returns, so no second request
could ever meet a running one.
"""

from __future__ import annotations

import asyncio
import threading
import time

import pytest

from routers import models as models_router
from routers.models import PrepareModelRequest, prepare_model

WAIT_S = 5.0


class BlockingModelService:
    """Holds each prepare until the test lets it finish."""

    def __init__(self) -> None:
        self.calls: list[str] = []
        self.started = threading.Event()
        self.release = threading.Event()

    def prepare_model(self, model_id, source=None, variant=None):
        self.calls.append(model_id)
        self.started.set()
        self.release.wait(WAIT_S)
        return {"status": "ready", "message": "ok"}


@pytest.fixture
def prepare():
    service = BlockingModelService()
    loop = asyncio.new_event_loop()
    with models_router._prepare_lock:
        models_router._prepare_result.update(active=False, model_id="", status="")

    def post(model_id: str) -> dict:
        return loop.run_until_complete(
            prepare_model(PrepareModelRequest(model_id=model_id), service=service)
        )

    yield service, post
    service.release.set()
    _wait_until_idle()
    loop.close()


def _wait_until_idle() -> dict:
    deadline = time.monotonic() + WAIT_S
    while time.monotonic() < deadline:
        with models_router._prepare_lock:
            result = dict(models_router._prepare_result)
        if not result["active"]:
            return result
        time.sleep(0.02)
    raise AssertionError("prepare never finished")


def test_a_second_request_for_the_running_model_joins_it(prepare):
    service, post = prepare
    assert post("clip") == {
        "status": "downloading",
        "model_id": "clip",
        "message": "Download started in background.",
    }
    assert service.started.wait(WAIT_S)

    assert post("clip") == {
        "status": "downloading",
        "model_id": "clip",
        "message": "A download is already in progress.",
    }
    service.release.set()
    assert _wait_until_idle()["status"] == "done"
    assert service.calls == ["clip"]


def test_a_request_for_another_model_names_the_running_one_and_starts_nothing(prepare):
    service, post = prepare
    post("clip")
    assert service.started.wait(WAIT_S)

    # V4's startInstall compares model_id with its own card and says another download runs
    assert post("artist")["model_id"] == "clip"
    service.release.set()
    _wait_until_idle()
    assert service.calls == ["clip"]
