"""A restart asks first when something is running, and never blocks.

A restart stops scans, tagging, file moves and downloads mid-way. The restart
endpoint therefore answers ``busy`` with plain job ids unless the user already
confirmed (``force``), and the page words those ids for people.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

import app_lifecycle
import services.update_service as us
from routers import sorting as sorting_router
from routers import updates as updates_router
from services import busy_jobs
from services.update_service import UpdateService


@pytest.fixture
def client(monkeypatch, tmp_path: Path):
    monkeypatch.setattr(us, "PACKAGE_ROOT", tmp_path)
    monkeypatch.setattr(us, "UPDATE_DIR", tmp_path / "update")
    monkeypatch.delenv("SD_IMAGE_SORTER_LAUNCHER", raising=False)
    (tmp_path / ("run.bat" if us.sys.platform == "win32" else "run.sh")).write_text(
        "echo\n", encoding="utf-8"
    )
    monkeypatch.setenv(app_lifecycle.RESTART_LOOP_ENV, "1")
    monkeypatch.setenv("SD_SORTER_TESTING", "1")
    monkeypatch.setattr(updates_router, "get_update_service", lambda: UpdateService())
    exits: list[bool] = []
    monkeypatch.setattr(
        updates_router, "_schedule_process_exit", lambda *a, **k: exits.append(True)
    )
    app = FastAPI()
    app.include_router(updates_router.router)
    return SimpleNamespace(http=TestClient(app), exits=exits)


def test_restart_while_jobs_run_asks_instead_of_stopping_them(client, monkeypatch):
    monkeypatch.setattr(
        updates_router, "collect_busy_jobs", lambda: ["scan", "tagging"]
    )

    response = client.http.post(
        "/api/updates/restart", json={"reason": "model_dependency_install"}
    )

    assert response.status_code == 200
    assert response.json()["status"] == "busy"
    assert response.json()["jobs"] == ["scan", "tagging"]
    assert client.exits == []


def test_a_confirmed_restart_goes_ahead_while_jobs_run(client, monkeypatch):
    monkeypatch.setattr(updates_router, "collect_busy_jobs", lambda: ["scan"])

    response = client.http.post(
        "/api/updates/restart",
        json={"reason": "model_dependency_install", "force": True},
    )

    assert response.json()["status"] == "scheduled"
    assert client.exits == [True]


def test_idle_app_restarts_without_asking(client, monkeypatch):
    monkeypatch.setattr(updates_router, "collect_busy_jobs", lambda: [])

    response = client.http.post(
        "/api/updates/restart", json={"reason": "model_dependency_install"}
    )

    assert response.json()["status"] == "scheduled"


def test_one_unreadable_source_does_not_hide_the_others(monkeypatch):
    def broken() -> list[str]:
        raise RuntimeError("service not ready")

    monkeypatch.setattr(
        busy_jobs, "_SOURCES", (broken, lambda: ["file_moves"], lambda: ["model_setup"])
    )

    assert busy_jobs.collect_busy_jobs() == ["file_moves", "model_setup"]


def test_ai_work_already_named_is_not_listed_twice(monkeypatch):
    monkeypatch.setattr(busy_jobs, "_SOURCES", (lambda: ["tagging"], lambda: ["ai"]))
    assert busy_jobs.collect_busy_jobs() == ["tagging"]

    monkeypatch.setattr(busy_jobs, "_SOURCES", (lambda: ["ai"],))
    assert busy_jobs.collect_busy_jobs() == ["ai"]


def test_gallery_job_names_become_plain_ids(monkeypatch):
    def report_running(*_services):
        raise HTTPException(
            status_code=409,
            detail={"jobs": ["smart_tag", "vlm_caption", "delete_selected"]},
        )

    monkeypatch.setattr(
        sorting_router, "_require_clear_gallery_jobs_idle", report_running
    )
    for getter in (
        "get_sorting_service",
        "_get_tagging_service_for_clear",
        "get_tagging_pipeline_service",
        "_get_aesthetic_service_for_clear",
    ):
        monkeypatch.setattr(sorting_router, getter, lambda: object())

    assert busy_jobs._gallery_jobs() == ["tagging", "captions", "background_jobs"]


def test_every_source_is_readable_in_a_running_app(test_client):
    """A source that always fails would silently switch the warning off."""
    for source in busy_jobs._SOURCES:
        assert source() == [], source.__name__
