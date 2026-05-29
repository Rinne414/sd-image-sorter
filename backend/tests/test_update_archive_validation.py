"""Test the updater archive validation with malicious zip payloads.

The updater downloads a zip from a release URL and validates it before
launching the worker that applies it. If any of these validations fail
silently, an attacker who can host a fake release manifest could plant
code on the user's machine. So we test:

  1. Path traversal in zip member name
  2. Absolute path in zip member name
  3. Windows drive letter in zip member name
  4. Zip with too many entries (>20k)
  5. Zip bomb: tiny compressed, huge uncompressed
  6. Zip with no package-manifest.json
  7. Zip with TWO package-manifest.json entries
  8. Corrupt zip
  9. Zip with absolute symlinks (tar only - skip for zip)
  10. Empty zip
"""
from __future__ import annotations

import json
import zipfile
from pathlib import Path

import pytest


def _build_zip(members: list[tuple[str, bytes]], dest: Path) -> Path:
    with zipfile.ZipFile(dest, "w") as zf:
        for name, data in members:
            zf.writestr(name, data)
    return dest


VALID_MANIFEST = json.dumps({
    "version": "999.0.0",
    "target_version": "999.0.0",
    "managed_paths": ["backend/", "frontend/"],
}).encode("utf-8")


def test_validate_rejects_path_traversal_in_zip(tmp_path: Path):
    from services.update_service import UpdateService
    bad_zip = _build_zip([
        ("update/package-manifest.json", VALID_MANIFEST),
        ("../../../etc/evil.txt", b"hacked"),
    ], tmp_path / "evil.zip")
    svc = UpdateService.__new__(UpdateService)
    with pytest.raises(RuntimeError, match="unsafe archive entry"):
        UpdateService._validate_archive(svc, bad_zip)


def test_validate_rejects_absolute_path_in_zip(tmp_path: Path):
    from services.update_service import UpdateService
    bad_zip = _build_zip([
        ("update/package-manifest.json", VALID_MANIFEST),
        ("/etc/passwd", b"root:x:0:0::/root:/bin/sh"),
    ], tmp_path / "evil-absolute.zip")
    svc = UpdateService.__new__(UpdateService)
    with pytest.raises(RuntimeError, match="unsafe archive entry"):
        UpdateService._validate_archive(svc, bad_zip)


def test_validate_rejects_windows_drive_letter_in_zip(tmp_path: Path):
    from services.update_service import UpdateService
    bad_zip = _build_zip([
        ("update/package-manifest.json", VALID_MANIFEST),
        ("C:/Windows/System32/evil.dll", b"malware"),
    ], tmp_path / "evil-driveletter.zip")
    svc = UpdateService.__new__(UpdateService)
    with pytest.raises(RuntimeError, match="unsafe archive entry"):
        UpdateService._validate_archive(svc, bad_zip)


def test_validate_rejects_too_many_entries(tmp_path: Path):
    """A zip with > 20,000 entries should be refused."""
    from services.update_service import UpdateService, _MAX_UPDATE_ARCHIVE_ENTRIES
    members = [("update/package-manifest.json", VALID_MANIFEST)]
    members.extend(
        (f"backend/file_{i}.txt", b"x") for i in range(_MAX_UPDATE_ARCHIVE_ENTRIES + 5)
    )
    bad_zip = _build_zip(members, tmp_path / "too-many.zip")
    svc = UpdateService.__new__(UpdateService)
    with pytest.raises(RuntimeError, match="too many entries"):
        UpdateService._validate_archive(svc, bad_zip)


def test_validate_rejects_zip_bomb(tmp_path: Path):
    """A zip whose uncompressed size exceeds the limit must be refused."""
    from services.update_service import UpdateService, _MAX_UPDATE_ARCHIVE_UNCOMPRESSED_BYTES

    # Build a zip with a single entry whose uncompressed size exceeds the limit.
    # Use deflate so the compressed size is small.
    big_payload = b"A" * (_MAX_UPDATE_ARCHIVE_UNCOMPRESSED_BYTES + 1000)
    bomb_zip = tmp_path / "bomb.zip"
    with zipfile.ZipFile(bomb_zip, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("update/package-manifest.json", VALID_MANIFEST)
        zf.writestr("backend/huge.bin", big_payload)
    svc = UpdateService.__new__(UpdateService)
    with pytest.raises(RuntimeError, match="uncompressed size exceeds the safe limit"):
        UpdateService._validate_archive(svc, bomb_zip)


def test_validate_rejects_missing_package_manifest(tmp_path: Path):
    """A zip without update/package-manifest.json must be refused."""
    from services.update_service import UpdateService
    bad_zip = _build_zip([
        ("backend/file.txt", b"data"),
    ], tmp_path / "no-manifest.zip")
    svc = UpdateService.__new__(UpdateService)
    with pytest.raises(RuntimeError, match="missing update/package-manifest.json"):
        UpdateService._validate_archive(svc, bad_zip)


def test_validate_rejects_double_manifest(tmp_path: Path):
    """Two package-manifest.json entries must be refused."""
    from services.update_service import UpdateService
    bad_zip = _build_zip([
        ("update/package-manifest.json", VALID_MANIFEST),
        ("sd-image-sorter/update/package-manifest.json", VALID_MANIFEST),
    ], tmp_path / "double-manifest.zip")
    svc = UpdateService.__new__(UpdateService)
    with pytest.raises(RuntimeError, match="multiple package manifests"):
        UpdateService._validate_archive(svc, bad_zip)


def test_validate_rejects_corrupt_zip(tmp_path: Path):
    """A truncated/corrupt zip must be refused."""
    from services.update_service import UpdateService
    good_zip = _build_zip([
        ("update/package-manifest.json", VALID_MANIFEST),
        ("backend/file.txt", b"data" * 100),
    ], tmp_path / "good.zip")
    # Truncate the last 20 bytes - corrupts the central directory
    raw = good_zip.read_bytes()
    good_zip.write_bytes(raw[:-20])
    svc = UpdateService.__new__(UpdateService)
    with pytest.raises(RuntimeError):
        UpdateService._validate_archive(svc, good_zip)


def test_validate_rejects_non_zip_extension(tmp_path: Path):
    """A file masquerading as zip but not actually a zip must be refused."""
    from services.update_service import UpdateService
    fake = tmp_path / "fake.zip"
    fake.write_bytes(b"This is not a zip file at all")
    svc = UpdateService.__new__(UpdateService)
    with pytest.raises(RuntimeError, match="not a valid zip archive"):
        UpdateService._validate_archive(svc, fake)


def test_validate_accepts_well_formed_zip(tmp_path: Path):
    """A well-formed zip with valid manifest and safe entries must pass."""
    from services.update_service import UpdateService
    good_zip = _build_zip([
        ("update/package-manifest.json", VALID_MANIFEST),
        ("backend/foo.py", b"x = 1\n"),
        ("frontend/index.html", b"<html></html>"),
    ], tmp_path / "good.zip")
    svc = UpdateService.__new__(UpdateService)
    # Should not raise
    UpdateService._validate_archive(svc, good_zip)
