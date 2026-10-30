"""Settings > Desktop learns whether this install holds the desktop program.

The in-app updater never installs the desktop program, so an install made
before 3.8.0 and updated in place has none; GET /api/updates/desktop-program
tells the page, which then says how to get it.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

from services import shell_compat
from services.shell_compat import desktop_program_state

ROOT = Path(__file__).resolve().parents[2]


def _install(root: Path, launcher: bool, shell: bool) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    if launcher:
        (root / shell_compat.LAUNCHER_EXE_NAME).write_bytes(b"MZ")
    if shell:
        (root / shell_compat.SHELL_DIRNAME).mkdir(exist_ok=True)
        (root / shell_compat.SHELL_DIRNAME / shell_compat.SHELL_EXE_NAME).write_bytes(
            b"MZ"
        )
    return root


def test_a_full_windows_package_has_the_desktop_program(tmp_path):
    state = desktop_program_state(_install(tmp_path, True, True), is_windows=True)
    assert state["installed"] is True
    assert state["windows"] is True
    assert state["launcher"] == "SD Image Sorter.exe"
    assert state["download_url"].endswith("/releases/latest")


def test_an_install_updated_in_place_from_before_the_shell_has_none(tmp_path):
    assert desktop_program_state(tmp_path, is_windows=True)["installed"] is False
    launcher_only = _install(tmp_path / "a", True, False)
    assert desktop_program_state(launcher_only, is_windows=True)["installed"] is False
    shell_only = _install(tmp_path / "b", False, True)
    assert desktop_program_state(shell_only, is_windows=True)["installed"] is False


def test_the_names_match_what_the_release_build_writes():
    spec = importlib.util.spec_from_file_location(
        "release_shell_for_state_test", ROOT / "scripts" / "release_shell.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["release_shell_for_state_test"] = module
    spec.loader.exec_module(module)
    assert shell_compat.LAUNCHER_EXE_NAME == module.LAUNCHER_EXE_NAME
    assert shell_compat.SHELL_DIRNAME == module.SHELL_DIRNAME
    assert shell_compat.SHELL_EXE_NAME == module.SHELL_EXE_NAME


def test_the_endpoint_reports_the_running_install(test_client, tmp_path, monkeypatch):
    import services.update_service as update_module

    monkeypatch.setattr(update_module, "PACKAGE_ROOT", _install(tmp_path, True, True))
    answer = test_client.get("/api/updates/desktop-program")
    assert answer.status_code == 200
    body = answer.json()
    assert body["installed"] is True
    assert set(body) == {"windows", "installed", "portable", "launcher", "download_url"}

    monkeypatch.setattr(update_module, "PACKAGE_ROOT", tmp_path / "empty")
    assert test_client.get("/api/updates/desktop-program").json()["installed"] is False


def test_only_a_portable_package_may_be_told_to_extract_over_its_folder(tmp_path):
    # A portable package runs its own Python; a source checkout (with .git, even
    # when a python folder sits in it) must never be told to extract over itself.
    portable = tmp_path / "portable"
    (portable / "python").mkdir(parents=True)
    (portable / "python" / "python.exe").write_bytes(b"MZ")
    assert desktop_program_state(portable, is_windows=True)["portable"] is True
    checkout = tmp_path / "checkout"
    (checkout / "python").mkdir(parents=True)
    (checkout / "python" / "python.exe").write_bytes(b"MZ")
    (checkout / ".git").mkdir()
    assert desktop_program_state(checkout, is_windows=True)["portable"] is False
    assert desktop_program_state(tmp_path / "source-zip", is_windows=True)["portable"] is False
