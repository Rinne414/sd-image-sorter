"""POST /api/open-path: opens an existing folder in the file manager, nothing else.

The launcher is always mocked: a real call would open Explorer on the test machine.
"""

import os
from unittest.mock import MagicMock

import pytest

from routers import file_manager as file_manager_router
from services.file_manager_service import file_manager_command


@pytest.fixture
def launches(monkeypatch):
    calls = []
    monkeypatch.setattr(
        file_manager_router.subprocess,
        "Popen",
        lambda args: calls.append(args) or MagicMock(),
    )
    return calls


@pytest.mark.parametrize(
    ("platform", "launcher"),
    [("win32", "explorer"), ("darwin", "open"), ("linux", "xdg-open")],
)
def test_opens_an_existing_folder_with_the_platform_file_manager(
    test_client, tmp_path, monkeypatch, launches, platform, launcher
):
    folder = tmp_path / "exports" / "pixiv 01"
    folder.mkdir(parents=True)
    monkeypatch.setattr(file_manager_router.sys, "platform", platform)

    response = test_client.post("/api/open-path", json={"path": str(folder)})

    assert response.status_code == 200
    expected = os.path.normpath(os.path.realpath(folder))
    assert response.json() == {"success": True, "path": expected}
    # one argument list, the folder as a single argument: no shell, no splitting on the space
    assert launches == [[launcher, expected]]


def test_a_missing_folder_is_404_and_launches_nothing(test_client, tmp_path, launches):
    response = test_client.post("/api/open-path", json={"path": str(tmp_path / "gone")})

    assert response.status_code == 404
    assert launches == []


def test_a_file_is_refused_so_explorer_never_runs_it(test_client, tmp_path, launches):
    script = tmp_path / "run-me.bat"
    script.write_text("echo hi", encoding="utf-8")

    response = test_client.post("/api/open-path", json={"path": str(script)})

    assert response.status_code == 400
    assert launches == []


@pytest.mark.parametrize("bad", ["folder\x00name", "../../etc", "   "])
def test_suspicious_paths_are_refused(test_client, tmp_path, launches, bad):
    response = test_client.post(
        "/api/open-path", json={"path": str(tmp_path / bad) if bad.strip() else bad}
    )

    assert response.status_code == 400
    assert launches == []


def test_an_empty_path_fails_validation(test_client, launches):
    response = test_client.post("/api/open-path", json={"path": ""})

    # the app reports request validation errors as 400
    assert response.status_code == 400
    assert launches == []


def test_a_launcher_failure_is_reported(test_client, tmp_path, monkeypatch):
    def broken(_args):
        raise FileNotFoundError("xdg-open")

    monkeypatch.setattr(file_manager_router.subprocess, "Popen", broken)

    response = test_client.post("/api/open-path", json={"path": str(tmp_path)})

    assert response.status_code == 500
    assert "Failed to open folder" in response.json().get("detail", response.text)


def test_command_is_an_argument_list_per_platform():
    assert file_manager_command("win32", r"D:\out") == ["explorer", r"D:\out"]
    assert file_manager_command("darwin", "/out") == ["open", "/out"]
    assert file_manager_command("linux", "/out") == ["xdg-open", "/out"]
