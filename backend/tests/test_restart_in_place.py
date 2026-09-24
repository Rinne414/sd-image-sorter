"""Restart after a feature install happens in the launcher's own window.

On Windows the old restart sent SIGINT to itself, which is TerminateProcess
(exit code 2): the launcher printed "Server exited with code 2" and paused,
a detached worker opened a second console and a second browser tab, and the
original tab stayed on "Restarting..." forever. Launchers now loop on exit
code 75, the server stops gracefully, and the page reloads when /boot-id
changes.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import app_lifecycle
import services.update_service as us
from routers import updates as updates_router
from services.update_service import UpdateService


class _FakeServer:
    should_exit = False


@pytest.fixture(autouse=True)
def _reset_lifecycle(monkeypatch):
    monkeypatch.setattr(app_lifecycle, "_server", None)
    monkeypatch.setattr(app_lifecycle, "_restart_requested", False)
    # The watchdog would os._exit the test process after 20 s.
    monkeypatch.setattr(app_lifecycle, "_start_exit_watchdog", lambda exit_code: None)


def _launcher_package(monkeypatch, tmp_path: Path) -> str:
    monkeypatch.setattr(us, "PACKAGE_ROOT", tmp_path)
    monkeypatch.setattr(us, "UPDATE_DIR", tmp_path / "update")
    monkeypatch.delenv("SD_IMAGE_SORTER_LAUNCHER", raising=False)
    launcher_name = "run.bat" if us.sys.platform == "win32" else "run.sh"
    (tmp_path / launcher_name).write_text("echo restart\n", encoding="utf-8")
    return launcher_name


def test_restart_request_stops_the_server_gracefully_with_the_restart_code():
    server = _FakeServer()
    app_lifecycle.attach_server(server)

    app_lifecycle.request_exit(restart=True)

    assert server.should_exit is True
    assert (
        app_lifecycle.exit_code_after_shutdown()
        == app_lifecycle.RESTART_EXIT_CODE
        == 75
    )


def test_plain_stop_exits_with_zero_so_the_launcher_says_stopped_normally():
    server = _FakeServer()
    app_lifecycle.attach_server(server)

    app_lifecycle.request_exit(restart=False)

    assert server.should_exit is True
    assert app_lifecycle.exit_code_after_shutdown() == 0


def test_looping_launcher_restarts_in_place_without_a_worker(
    monkeypatch, tmp_path: Path
):
    launcher_name = _launcher_package(monkeypatch, tmp_path)
    monkeypatch.setenv(app_lifecycle.RESTART_LOOP_ENV, "1")
    launched: list = []
    monkeypatch.setattr(
        UpdateService, "_launch_worker", lambda *args, **kwargs: launched.append(args)
    )

    result = UpdateService().restart_app(reason="model_dependency_install")

    assert result == {
        "status": "scheduled",
        "launcher": launcher_name,
        "mode": "in_place",
    }
    assert launched == []
    assert not (tmp_path / "update" / "state" / "pending-restart.json").exists()


def test_launcher_without_the_loop_still_restarts_through_the_worker(
    monkeypatch, tmp_path: Path
):
    launcher_name = _launcher_package(monkeypatch, tmp_path)
    monkeypatch.delenv(app_lifecycle.RESTART_LOOP_ENV, raising=False)
    monkeypatch.delenv("SD_SORTER_TESTING", raising=False)
    launched: list = []
    monkeypatch.setattr(
        UpdateService,
        "_launch_worker",
        lambda self, manifest_path, *, restart_only=False: launched.append(
            restart_only
        ),
    )

    result = UpdateService().restart_app(reason="model_dependency_install")

    assert result == {"status": "scheduled", "launcher": launcher_name}
    assert launched == [True]


def test_restart_endpoint_returns_the_boot_id_the_page_waits_to_change(
    monkeypatch, tmp_path: Path
):
    _launcher_package(monkeypatch, tmp_path)
    monkeypatch.setenv(app_lifecycle.RESTART_LOOP_ENV, "1")
    monkeypatch.setenv("SD_SORTER_TESTING", "1")
    monkeypatch.setattr(updates_router, "get_update_service", lambda: UpdateService())
    app = FastAPI()
    app.include_router(updates_router.router)
    client = TestClient(app)

    restart = client.post(
        "/api/updates/restart", json={"reason": "model_dependency_install"}
    )
    boot = client.get("/api/updates/boot-id")

    assert restart.status_code == 200
    assert restart.json()["status"] == "scheduled"
    assert restart.json()["boot_id"] == app_lifecycle.BOOT_ID
    assert boot.json() == {"boot_id": app_lifecycle.BOOT_ID}
