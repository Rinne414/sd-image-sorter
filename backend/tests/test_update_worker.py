from __future__ import annotations

import json
import zipfile
from pathlib import Path

import pytest
import update_worker


def test_safe_relative_path_rejects_archive_escape_entries():
    for name in ("../escape.txt", "..\\escape.txt", "/tmp/escape.txt", "C:/escape.txt"):
        with pytest.raises(ValueError):
            update_worker._safe_relative_path(name)

    assert update_worker._safe_relative_path("frontend/index.html") == Path("frontend") / "index.html"


def _write_text_files(root: Path, files: dict[str, str]) -> None:
    for relative, content in files.items():
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")


def _prepare_pending_update(
    tmp_path: Path,
    *,
    current_manifest_paths: list[str],
    new_manifest_paths: list[str],
    installed_files: dict[str, str],
    payload_files: dict[str, str],
    target_version: str = "3.1.1",
    nested_payload_root: str = "sd-image-sorter",
) -> tuple[Path, Path, Path, Path, Path]:
    package_root = tmp_path / "app"
    update_root = package_root / "update"
    data_root = package_root / "data"
    downloads = update_root / "downloads" / target_version
    state = update_root / "state"
    logs = update_root / "logs"

    downloads.mkdir(parents=True, exist_ok=True)
    state.mkdir(parents=True, exist_ok=True)
    logs.mkdir(parents=True, exist_ok=True)
    data_root.mkdir(parents=True, exist_ok=True)

    _write_text_files(package_root, installed_files)
    (data_root / "images.db").write_text("USERDATA\n", encoding="utf-8")
    (package_root / "run.sh").write_text("#!/bin/bash\necho relaunched\n", encoding="utf-8")

    current_manifest = {
        "version": "3.1.0",
        "managed_paths": current_manifest_paths,
    }
    (update_root / "package-manifest.json").write_text(json.dumps(current_manifest, indent=2), encoding="utf-8")

    payload_root = tmp_path / "payload"
    if nested_payload_root:
        payload_root = payload_root / nested_payload_root
    payload_root.mkdir(parents=True, exist_ok=True)
    _write_text_files(payload_root, payload_files)
    (payload_root / "update").mkdir(parents=True, exist_ok=True)

    new_manifest = {
        "version": target_version,
        "managed_paths": new_manifest_paths,
    }
    (payload_root / "update" / "package-manifest.json").write_text(
        json.dumps(new_manifest, indent=2),
        encoding="utf-8",
    )

    archive_path = downloads / f"sd-image-sorter-v{target_version}-linux-mac.tar.zip"
    with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED) as archive:
        for file_path in sorted((tmp_path / "payload").rglob("*")):
            if file_path.is_dir():
                continue
            archive.write(file_path, file_path.relative_to(tmp_path / "payload"))

    pending_manifest_path = state / f"pending-update-{target_version}.json"
    pending_manifest_path.write_text(
        json.dumps(
            {
                "created_at": 0,
                "current_pid": 123456789,
                "package_root": str(package_root),
                "archive_path": str(archive_path),
                "target_version": target_version,
                "launcher_path": str(package_root / "run.sh"),
                "relaunch": False,
                "log_path": str(logs / "update.log"),
                "update_root": str(update_root),
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    return pending_manifest_path, package_root, update_root, data_root, logs / "update.log"


def test_apply_update_accepts_nested_full_package_payload(monkeypatch, tmp_path: Path):
    pending_manifest_path, package_root, update_root, data_root, _ = _prepare_pending_update(
        tmp_path,
        current_manifest_paths=[
            "frontend/version.txt",
            "obsolete.txt",
            "update/package-manifest.json",
        ],
        new_manifest_paths=[
            "frontend/version.txt",
            "newfile.txt",
            "update/package-manifest.json",
        ],
        installed_files={
            "frontend/version.txt": "old-ui\n",
            "obsolete.txt": "remove me\n",
        },
        payload_files={
            "frontend/version.txt": "new-ui\n",
            "newfile.txt": "brand new\n",
        },
        nested_payload_root="sd-image-sorter",
    )

    monkeypatch.setattr(update_worker, "_wait_for_pid_exit", lambda pid, timeout_seconds, log_path: None)

    result = update_worker.apply_update(pending_manifest_path)

    assert result == 0
    assert (package_root / "frontend" / "version.txt").read_text(encoding="utf-8") == "new-ui\n"
    assert (package_root / "newfile.txt").read_text(encoding="utf-8") == "brand new\n"
    assert not (package_root / "obsolete.txt").exists()
    assert (data_root / "images.db").read_text(encoding="utf-8") == "USERDATA\n"
    assert not (package_root / "sd-image-sorter").exists()
    installed_manifest = json.loads((update_root / "installed-manifest.json").read_text(encoding="utf-8"))
    assert installed_manifest["version"] == "3.1.1"


def test_apply_update_rejects_manifest_that_targets_protected_runtime_paths(monkeypatch, tmp_path: Path):
    pending_manifest_path, package_root, update_root, data_root, _ = _prepare_pending_update(
        tmp_path,
        current_manifest_paths=[
            "frontend/version.txt",
            "update/package-manifest.json",
        ],
        new_manifest_paths=[
            "frontend/version.txt",
            "data/images.db",
            "update/package-manifest.json",
        ],
        installed_files={
            "frontend/version.txt": "old-ui\n",
        },
        payload_files={
            "frontend/version.txt": "new-ui\n",
            "data/images.db": "HACKED\n",
        },
        nested_payload_root="sd-image-sorter",
    )

    monkeypatch.setattr(update_worker, "_wait_for_pid_exit", lambda pid, timeout_seconds, log_path: None)

    with pytest.raises(ValueError, match="protected runtime path"):
        update_worker.apply_update(pending_manifest_path)

    assert (package_root / "frontend" / "version.txt").read_text(encoding="utf-8") == "old-ui\n"
    assert (data_root / "images.db").read_text(encoding="utf-8") == "USERDATA\n"
    assert not (update_root / "installed-manifest.json").exists()


def test_apply_update_ignores_protected_paths_from_current_manifest(monkeypatch, tmp_path: Path):
    pending_manifest_path, package_root, update_root, data_root, log_path = _prepare_pending_update(
        tmp_path,
        current_manifest_paths=[
            "frontend/version.txt",
            "obsolete.txt",
            "data/images.db",
            "update/package-manifest.json",
        ],
        new_manifest_paths=[
            "frontend/version.txt",
            "newfile.txt",
            "update/package-manifest.json",
        ],
        installed_files={
            "frontend/version.txt": "old-ui\n",
            "obsolete.txt": "remove me\n",
        },
        payload_files={
            "frontend/version.txt": "new-ui\n",
            "newfile.txt": "brand new\n",
        },
        nested_payload_root="sd-image-sorter",
    )

    monkeypatch.setattr(update_worker, "_wait_for_pid_exit", lambda pid, timeout_seconds, log_path: None)

    result = update_worker.apply_update(pending_manifest_path)

    assert result == 0
    assert (package_root / "frontend" / "version.txt").read_text(encoding="utf-8") == "new-ui\n"
    assert (package_root / "newfile.txt").read_text(encoding="utf-8") == "brand new\n"
    assert not (package_root / "obsolete.txt").exists()
    assert (data_root / "images.db").read_text(encoding="utf-8") == "USERDATA\n"
    assert "Ignored 1 protected runtime path(s) from current manifest" in log_path.read_text(encoding="utf-8")

    installed_manifest = json.loads((update_root / "installed-manifest.json").read_text(encoding="utf-8"))
    assert "data/images.db" not in installed_manifest["managed_paths"]
