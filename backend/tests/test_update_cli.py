from __future__ import annotations

import io
from pathlib import Path

import update_cli


class FakeUpdateService:
    def __init__(self, *, status: dict):
        self.status = status
        self.download_calls: list[tuple[dict, str]] = []
        self.pending_kwargs: dict | None = None

    def get_status(self, *, force: bool = False) -> dict:
        return {**self.status, "force_seen": force}

    def _download_asset(self, asset: dict, version: str) -> Path:
        self.download_calls.append((asset, version))
        return Path("update/downloads") / version / str(asset["name"])

    def _write_pending_manifest(self, **kwargs) -> Path:
        self.pending_kwargs = kwargs
        return Path("update/state/pending-update.json")


def test_apply_external_update_reports_up_to_date(monkeypatch):
    monkeypatch.setattr(update_cli, "ensure_directories", lambda: None)
    stdout = io.StringIO()
    stderr = io.StringIO()
    service = FakeUpdateService(
        status={
            "current_version": "3.1.2",
            "latest_version": "3.1.2",
            "has_update": False,
            "error": None,
        }
    )

    result = update_cli.apply_external_update(service=service, stdout=stdout, stderr=stderr)

    assert result == 0
    assert "Already up to date" in stdout.getvalue()
    assert stderr.getvalue() == ""


def test_apply_external_update_downloads_and_applies_with_external_pid(monkeypatch):
    monkeypatch.setattr(update_cli, "ensure_directories", lambda: None)
    stdout = io.StringIO()
    stderr = io.StringIO()
    service = FakeUpdateService(
        status={
            "current_version": "3.1.1",
            "latest_version": "3.1.2",
            "has_update": True,
            "error": None,
            "asset": {
                "name": "sd-image-sorter-v3.1.2-app-patch.zip",
                "download_url": "https://example.com/patch.zip",
                "size_bytes": 123,
            },
        }
    )
    applied: list[Path] = []

    result = update_cli.apply_external_update(
        service=service,
        update_applier=lambda manifest_path: applied.append(manifest_path) or 0,
        stdout=stdout,
        stderr=stderr,
    )

    assert result == 0
    assert service.download_calls == [
        (
            {
                "name": "sd-image-sorter-v3.1.2-app-patch.zip",
                "download_url": "https://example.com/patch.zip",
                "size_bytes": 123,
            },
            "3.1.2",
        )
    ]
    assert service.pending_kwargs is not None
    assert service.pending_kwargs["current_pid"] == 0
    assert service.pending_kwargs["relaunch"] is True
    assert applied == [Path("update/state/pending-update.json")]
    assert "Updated to 3.1.2" in stdout.getvalue()
    assert stderr.getvalue() == ""


def test_apply_external_update_check_only_does_not_download(monkeypatch):
    monkeypatch.setattr(update_cli, "ensure_directories", lambda: None)
    stdout = io.StringIO()
    stderr = io.StringIO()
    service = FakeUpdateService(
        status={
            "current_version": "3.1.1",
            "latest_version": "3.1.2",
            "has_update": True,
            "error": None,
            "asset": {"name": "sd-image-sorter-v3.1.2-app-patch.zip"},
        }
    )

    result = update_cli.apply_external_update(
        service=service,
        check_only=True,
        update_applier=lambda manifest_path: (_ for _ in ()).throw(AssertionError("must not apply")),
        stdout=stdout,
        stderr=stderr,
    )

    assert result == 0
    assert service.download_calls == []
    assert service.pending_kwargs is None
    assert "Update available" in stdout.getvalue()
    assert stderr.getvalue() == ""


def test_apply_external_update_returns_error_on_worker_failure(monkeypatch):
    monkeypatch.setattr(update_cli, "ensure_directories", lambda: None)
    stdout = io.StringIO()
    stderr = io.StringIO()
    service = FakeUpdateService(
        status={
            "current_version": "3.1.1",
            "latest_version": "3.1.2",
            "has_update": True,
            "error": None,
            "asset": {"name": "sd-image-sorter-v3.1.2-app-patch.zip"},
        }
    )

    result = update_cli.apply_external_update(
        service=service,
        update_applier=lambda manifest_path: 23,
        stdout=stdout,
        stderr=stderr,
    )

    assert result == 1
    assert "Update worker exited with status 23" in stderr.getvalue()
