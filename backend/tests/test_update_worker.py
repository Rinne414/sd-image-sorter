from __future__ import annotations

import io
import json
import tarfile
import zipfile
from pathlib import Path

import pytest
import update_worker
from services import update_service
from services.update_service import UpdateService


def test_safe_relative_path_rejects_archive_escape_entries():
    for name in ("../escape.txt", "..\\escape.txt", "/tmp/escape.txt", "C:/escape.txt"):
        with pytest.raises(ValueError):
            update_worker._safe_relative_path(name)

    assert update_worker._safe_relative_path("frontend/index.html") == Path("frontend") / "index.html"


def test_pid_exists_uses_windows_process_api_without_signal_zero(monkeypatch):
    monkeypatch.setattr(update_worker.sys, "platform", "win32")
    monkeypatch.setattr(update_worker, "_windows_pid_exists", lambda pid: pid == 1234)

    def fail_kill(pid: int, signal: int) -> None:
        raise AssertionError("Windows PID checks must not call os.kill(pid, 0)")

    monkeypatch.setattr(update_worker.os, "kill", fail_kill)

    assert update_worker._pid_exists(1234) is True
    assert update_worker._pid_exists(4321) is False


def test_pid_exists_treats_posix_permission_error_as_existing(monkeypatch):
    monkeypatch.setattr(update_worker.sys, "platform", "linux")

    def deny_signal(pid: int, signal: int) -> None:
        raise PermissionError

    monkeypatch.setattr(update_worker.os, "kill", deny_signal)

    assert update_worker._pid_exists(1234) is True


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


@pytest.mark.parametrize(
    "protected_path",
    [
        "data/images.db",
        "data/models/wd14/model.onnx",
        "update/backups/old-file.txt",
        "update/downloads/patch.zip",
        "update/logs/update.log",
        "update/state/pending-update.json",
        "update/worker/update_worker.py",
    ],
)
def test_apply_update_rejects_each_protected_runtime_prefix(
    monkeypatch,
    tmp_path: Path,
    protected_path: str,
):
    pending_manifest_path, package_root, update_root, data_root, _ = _prepare_pending_update(
        tmp_path,
        current_manifest_paths=[
            "frontend/version.txt",
            "update/package-manifest.json",
        ],
        new_manifest_paths=[
            "frontend/version.txt",
            protected_path,
            "update/package-manifest.json",
        ],
        installed_files={
            "frontend/version.txt": "old-ui\n",
        },
        payload_files={
            "frontend/version.txt": "new-ui\n",
            protected_path: "HACKED\n",
        },
        nested_payload_root="sd-image-sorter",
    )

    monkeypatch.setattr(update_worker, "_wait_for_pid_exit", lambda pid, timeout_seconds, log_path: None)

    with pytest.raises(ValueError, match="protected runtime path"):
        update_worker.apply_update(pending_manifest_path)

    assert (package_root / "frontend" / "version.txt").read_text(encoding="utf-8") == "old-ui\n"
    assert (data_root / "images.db").read_text(encoding="utf-8") == "USERDATA\n"
    assert not (update_root / "installed-manifest.json").exists()


def test_validate_update_manifest_managed_paths_rejects_invalid_entries():
    with pytest.raises(ValueError, match="invalid managed path"):
        update_worker.validate_update_manifest_managed_paths(
            {"managed_paths": ["frontend/index.html", "../escape.txt"]}
        )


def test_validate_update_manifest_managed_paths_rejects_protected_entries():
    with pytest.raises(ValueError, match="protected runtime path"):
        update_worker.validate_update_manifest_managed_paths(
            {"managed_paths": ["frontend/index.html", "data/images.db"]}
        )


def test_validate_update_manifest_managed_paths_allows_manifest_files():
    managed_paths = update_worker.validate_update_manifest_managed_paths(
        {
            "managed_paths": [
                "frontend/index.html",
                "update/package-manifest.json",
                "update/installed-manifest.json",
            ]
        }
    )

    assert managed_paths == {
        "frontend/index.html",
        "update/package-manifest.json",
        "update/installed-manifest.json",
    }


def test_protected_runtime_prefixes_stay_in_sync_with_release_docs():
    docs_text = (Path(__file__).resolve().parents[2] / "docs" / "RELEASE_PACKS.md").read_text(encoding="utf-8")

    for prefix in update_worker.PROTECTED_RUNTIME_PREFIXES:
        assert f"`{prefix.as_posix()}`" in docs_text


def test_update_service_validate_zip_rejects_protected_manifest_entry(tmp_path: Path):
    service = UpdateService()
    archive_path = tmp_path / "patch.zip"
    with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("frontend/index.html", "<html></html>\n")
        archive.writestr(
            "update/package-manifest.json",
            json.dumps({"managed_paths": ["frontend/index.html", "data/images.db"]}),
        )

    with pytest.raises(ValueError, match="protected runtime path"):
        service._validate_archive(archive_path)


def test_update_service_validate_zip_requires_package_manifest(tmp_path: Path):
    service = UpdateService()
    archive_path = tmp_path / "patch.zip"
    with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("frontend/index.html", "<html></html>\n")

    with pytest.raises(RuntimeError, match="missing update/package-manifest.json"):
        service._validate_archive(archive_path)


def test_update_service_validate_zip_rejects_oversized_uncompressed_payload(monkeypatch, tmp_path: Path):
    service = UpdateService()
    archive_path = tmp_path / "patch.zip"
    manifest = json.dumps({"managed_paths": ["frontend/index.html", "update/package-manifest.json"]})
    monkeypatch.setattr(update_service, "_MAX_UPDATE_ARCHIVE_UNCOMPRESSED_BYTES", len(manifest) + 4)

    with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("update/package-manifest.json", manifest)
        archive.writestr("frontend/index.html", "<html></html>\n")

    with pytest.raises(RuntimeError, match="uncompressed size exceeds"):
        service._validate_archive(archive_path)


def test_update_service_validate_zip_rejects_too_many_entries(monkeypatch, tmp_path: Path):
    service = UpdateService()
    archive_path = tmp_path / "patch.zip"
    monkeypatch.setattr(update_service, "_MAX_UPDATE_ARCHIVE_ENTRIES", 1)

    with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("update/package-manifest.json", json.dumps({"managed_paths": ["update/package-manifest.json"]}))
        archive.writestr("frontend/index.html", "<html></html>\n")

    with pytest.raises(RuntimeError, match="too many entries"):
        service._validate_archive(archive_path)


def test_update_service_validate_zip_accepts_single_payload_root_manifest(tmp_path: Path):
    service = UpdateService()
    archive_path = tmp_path / "patch.zip"
    with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("sd-image-sorter/frontend/index.html", "<html></html>\n")
        archive.writestr(
            "sd-image-sorter/update/package-manifest.json",
            json.dumps({"managed_paths": ["frontend/index.html", "update/package-manifest.json"]}),
        )

    service._validate_archive(archive_path)


def test_update_service_validate_zip_ignores_manifest_name_inside_badupdate_prefix(tmp_path: Path):
    service = UpdateService()
    archive_path = tmp_path / "patch.zip"
    with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(
            "badupdate/package-manifest.json",
            json.dumps({"managed_paths": ["data/images.db"]}),
        )
        archive.writestr(
            "update/package-manifest.json",
            json.dumps({"managed_paths": ["frontend/index.html", "update/package-manifest.json"]}),
        )

    service._validate_archive(archive_path)


def test_update_service_validate_zip_rejects_multiple_real_package_manifests(tmp_path: Path):
    service = UpdateService()
    archive_path = tmp_path / "patch.zip"
    manifest = json.dumps({"managed_paths": ["frontend/index.html", "update/package-manifest.json"]})
    with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("update/package-manifest.json", manifest)
        archive.writestr("sd-image-sorter/update/package-manifest.json", manifest)

    with pytest.raises(RuntimeError, match="multiple package manifests"):
        service._validate_archive(archive_path)


def test_update_service_validate_tar_rejects_protected_manifest_entry(tmp_path: Path):
    service = UpdateService()
    archive_path = tmp_path / "patch.tar.gz"
    manifest_bytes = json.dumps({"managed_paths": ["frontend/index.html", "update/downloads/patch.zip"]}).encode("utf-8")

    with tarfile.open(archive_path, "w:gz") as archive:
        member = tarfile.TarInfo("update/package-manifest.json")
        member.size = len(manifest_bytes)
        archive.addfile(member, io.BytesIO(manifest_bytes))

    with pytest.raises(ValueError, match="protected runtime path"):
        service._validate_archive(archive_path)


def test_update_service_validate_tar_requires_package_manifest(tmp_path: Path):
    service = UpdateService()
    archive_path = tmp_path / "patch.tar.gz"
    payload = b"<html></html>\n"

    with tarfile.open(archive_path, "w:gz") as archive:
        member = tarfile.TarInfo("frontend/index.html")
        member.size = len(payload)
        archive.addfile(member, io.BytesIO(payload))

    with pytest.raises(RuntimeError, match="missing update/package-manifest.json"):
        service._validate_archive(archive_path)


def test_update_service_validate_tar_rejects_oversized_uncompressed_payload(monkeypatch, tmp_path: Path):
    service = UpdateService()
    archive_path = tmp_path / "patch.tar.gz"
    manifest_bytes = json.dumps({"managed_paths": ["frontend/index.html", "update/package-manifest.json"]}).encode("utf-8")
    payload = b"<html></html>\n"
    monkeypatch.setattr(update_service, "_MAX_UPDATE_ARCHIVE_UNCOMPRESSED_BYTES", len(manifest_bytes) + 4)

    with tarfile.open(archive_path, "w:gz") as archive:
        manifest_member = tarfile.TarInfo("update/package-manifest.json")
        manifest_member.size = len(manifest_bytes)
        archive.addfile(manifest_member, io.BytesIO(manifest_bytes))
        payload_member = tarfile.TarInfo("frontend/index.html")
        payload_member.size = len(payload)
        archive.addfile(payload_member, io.BytesIO(payload))

    with pytest.raises(RuntimeError, match="uncompressed size exceeds"):
        service._validate_archive(archive_path)


def test_update_service_validate_tar_ignores_manifest_name_inside_badupdate_prefix(tmp_path: Path):
    service = UpdateService()
    archive_path = tmp_path / "patch.tar.gz"
    fake_manifest = json.dumps({"managed_paths": ["data/images.db"]}).encode("utf-8")

    with tarfile.open(archive_path, "w:gz") as archive:
        member = tarfile.TarInfo("badupdate/package-manifest.json")
        member.size = len(fake_manifest)
        archive.addfile(member, io.BytesIO(fake_manifest))

    with pytest.raises(RuntimeError, match="missing update/package-manifest.json"):
        service._validate_archive(archive_path)


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


def test_apply_update_ignores_all_protected_paths_from_current_manifest(monkeypatch, tmp_path: Path):
    protected_paths = [
        "data/images.db",
        "data/models/wd14/model.onnx",
        "update/backups/old-file.txt",
        "update/downloads/patch.zip",
        "update/logs/update.log",
        "update/state/pending-update.json",
        "update/worker/update_worker.py",
    ]
    pending_manifest_path, package_root, update_root, data_root, log_path = _prepare_pending_update(
        tmp_path,
        current_manifest_paths=[
            "frontend/version.txt",
            "obsolete.txt",
            *protected_paths,
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
    assert f"Ignored {len(protected_paths)} protected runtime path(s) from current manifest" in log_path.read_text(encoding="utf-8")

    installed_manifest = json.loads((update_root / "installed-manifest.json").read_text(encoding="utf-8"))
    for protected_path in protected_paths:
        assert protected_path not in installed_manifest["managed_paths"]
