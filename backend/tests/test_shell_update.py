"""The in-app updater and the desktop shell: the shell is a separate layer.

An app-patch never replaces the shell's files (they are locked while it
runs). A release manifest names the oldest shell it works with
(``min_shell_version``); when the running shell is older the update is held
back with a message to download the full package.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

import update_worker
from services.shell_compat import SHELL_VERSION_ENV, shell_is_older, shell_requirement
from services.update_service import UpdateService

MANIFEST_URL = "https://example.com/sd-image-sorter-v9.9.9-release-manifest.json"


def _release() -> dict:
    return {
        "tag_name": "v9.9.9",
        "html_url": "https://example.com/release",
        "body": "notes",
        "assets": [
            {
                "name": "sd-image-sorter-v9.9.9-app-patch.zip",
                "size": 123,
                "browser_download_url": "https://example.com/patch.zip",
            },
            {
                "name": "sd-image-sorter-v9.9.9-release-manifest.json",
                "size": 10,
                "browser_download_url": MANIFEST_URL,
            },
        ],
    }


def _service(
    monkeypatch, manifest: dict | Exception
) -> tuple[UpdateService, list[str]]:
    service = UpdateService()
    monkeypatch.setattr(service, "_read_release_json", _release)
    reads: list[str] = []

    def read_manifest(url: str) -> dict:
        reads.append(url)
        if isinstance(manifest, Exception):
            raise manifest
        return manifest

    monkeypatch.setattr(service, "_read_release_manifest", read_manifest)
    return service, reads


@pytest.mark.parametrize(
    ("shell", "minimum", "older"),
    [
        ("0.1.0", "0.1.0", False),
        ("0.1.0", "0.2.0", True),
        ("0.10.0", "0.9.0", False),
        ("1.0", "1.0.0", False),
        ("0.9.9", "1", True),
        ("v0.2.0-beta.1", "0.2.0", False),
    ],
)
def test_shell_is_older(shell, minimum, older):
    assert shell_is_older(shell, minimum) is older


def test_requirement_ignores_missing_or_garbage_minimum():
    assert shell_requirement({}, "0.1.0", "9.9.9") is None
    assert shell_requirement({"min_shell_version": "soon"}, "0.1.0", "9.9.9") is None
    assert shell_requirement({"min_shell_version": ""}, "0.1.0", "9.9.9") is None


def test_old_shell_holds_the_patch_back(monkeypatch):
    monkeypatch.setenv(SHELL_VERSION_ENV, "0.1.0")
    service, reads = _service(
        monkeypatch, {"shell_version": "0.3.0", "min_shell_version": "0.2.0"}
    )

    status = service.get_status(force=True)

    assert reads == [MANIFEST_URL]
    assert status["has_update"] is False
    assert status["shell_update_required"] is True
    assert status["shell_version"] == "0.1.0"
    assert status["min_shell_version"] == "0.2.0"
    assert status["latest_shell_version"] == "0.3.0"
    assert "full package" in status["update_unavailable_reason"]
    assert "0.2.0" in status["update_unavailable_reason"]
    assert status["asset"]["kind"] == "patch"


def test_prepare_update_refuses_when_the_shell_must_change(monkeypatch):
    monkeypatch.setenv(SHELL_VERSION_ENV, "0.1.0")
    monkeypatch.setattr("services.update_service.ensure_directories", lambda: None)
    service, _ = _service(monkeypatch, {"min_shell_version": "0.2.0"})
    monkeypatch.setattr(
        service, "_download_asset", lambda *a, **k: pytest.fail("must not download")
    )

    with pytest.raises(RuntimeError, match="full package"):
        service.prepare_update(force_check=True)


def test_current_shell_gets_the_patch(monkeypatch):
    monkeypatch.setenv(SHELL_VERSION_ENV, "0.2.0")
    service, _ = _service(
        monkeypatch, {"shell_version": "0.2.0", "min_shell_version": "0.2.0"}
    )

    status = service.get_status(force=True)

    assert status["has_update"] is True
    assert status["shell_update_required"] is False
    assert status["update_unavailable_reason"] is None


def test_browser_launchers_never_read_the_manifest(monkeypatch):
    monkeypatch.delenv(SHELL_VERSION_ENV, raising=False)
    service, reads = _service(monkeypatch, {"min_shell_version": "9.0.0"})

    status = service.get_status(force=True)

    assert reads == []
    assert status["has_update"] is True
    assert status["shell_version"] is None


def test_unreadable_manifest_does_not_block(monkeypatch):
    monkeypatch.setenv(SHELL_VERSION_ENV, "0.1.0")
    service, _ = _service(monkeypatch, OSError("offline"))

    status = service.get_status(force=True)

    assert status["has_update"] is True
    assert status["shell_update_required"] is False


def test_release_without_shell_fields_works_with_any_shell(monkeypatch):
    monkeypatch.setenv(SHELL_VERSION_ENV, "0.0.1")
    service, _ = _service(monkeypatch, {"version": "9.9.9", "assets": []})

    assert service.get_status(force=True)["has_update"] is True


def _pending(monkeypatch, tmp_path: Path, relaunch: bool) -> dict:
    service = UpdateService()
    launcher = tmp_path / "run-portable.bat"
    launcher.write_text("@echo off\n", encoding="utf-8")
    monkeypatch.setattr(service, "_resolve_launcher_path", lambda: launcher)
    monkeypatch.setattr(service, "_state_dir", lambda: tmp_path)
    monkeypatch.setattr(service, "_logs_dir", lambda: tmp_path)
    path = service._write_pending_manifest(
        archive_path=tmp_path / "p.zip", version="9.9.9", relaunch=relaunch
    )
    return json.loads(path.read_text(encoding="utf-8"))


def test_shell_update_is_not_relaunched_through_a_launcher(monkeypatch, tmp_path):
    monkeypatch.setenv(SHELL_VERSION_ENV, "0.1.0")

    payload = _pending(monkeypatch, tmp_path, relaunch=True)

    assert payload["shell_managed"] is True
    assert payload["relaunch"] is False


def test_browser_update_still_relaunches(monkeypatch, tmp_path):
    monkeypatch.delenv(SHELL_VERSION_ENV, raising=False)

    payload = _pending(monkeypatch, tmp_path, relaunch=True)

    assert payload["shell_managed"] is False
    assert payload["relaunch"] is True


def test_failed_shell_update_stops_looking_pending(tmp_path):
    manifest = tmp_path / "pending-update-9.9.9.json"
    manifest.write_text(json.dumps({"shell_managed": True}), encoding="utf-8")

    update_worker._mark_failed_for_shell(manifest)

    assert not manifest.exists()
    assert (tmp_path / "pending-update-9.9.9.json.failed").exists()


def test_failed_browser_update_keeps_its_manifest(tmp_path):
    manifest = tmp_path / "pending-update-9.9.9.json"
    manifest.write_text(json.dumps({"shell_managed": False}), encoding="utf-8")

    update_worker._mark_failed_for_shell(manifest)

    assert manifest.exists()
