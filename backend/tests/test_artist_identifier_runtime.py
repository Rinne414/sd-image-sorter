from __future__ import annotations

import shutil
import zipfile
from pathlib import Path

import pytest

import artist_identifier


def _write_zip(path: Path, files: dict[str, bytes]) -> None:
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, payload in files.items():
            archive.writestr(name, payload)


def _fake_urlretrieve(source_zip: Path):
    def fake_urlretrieve(url: str, destination: Path):
        shutil.copyfile(source_zip, destination)
        return str(destination), None

    return fake_urlretrieve


def test_artist_runtime_zip_uses_pinned_commit_url():
    assert artist_identifier.ARTIST_LSNET_RUNTIME_REVISION in artist_identifier.ARTIST_LSNET_RUNTIME_ZIP_URL
    assert "refs/heads/main" not in artist_identifier.ARTIST_LSNET_RUNTIME_ZIP_URL
    assert artist_identifier.ARTIST_LSNET_RUNTIME_REVISION != "main"


def test_download_and_extract_github_zip_extracts_single_safe_root(monkeypatch, tmp_path: Path):
    source_zip = tmp_path / "runtime.zip"
    _write_zip(source_zip, {"comfyui-lsnet-main/lsnet_model/__init__.py": b"ok"})
    target_dir = tmp_path / "models" / "artist" / "runtime"

    monkeypatch.setattr(artist_identifier.urllib.request, "urlretrieve", _fake_urlretrieve(source_zip))

    result = artist_identifier._download_and_extract_github_zip("https://example.test/runtime.zip", target_dir)

    assert result == target_dir
    assert (target_dir / "lsnet_model" / "__init__.py").read_bytes() == b"ok"


@pytest.mark.parametrize("member_name", ["../escape.py", "..\\escape.py", "/tmp/escape.py", "C:/escape.py"])
def test_download_and_extract_github_zip_rejects_path_traversal(monkeypatch, tmp_path: Path, member_name: str):
    source_zip = tmp_path / "runtime.zip"
    _write_zip(source_zip, {member_name: b"bad"})
    target_dir = tmp_path / "models" / "artist" / "runtime"

    monkeypatch.setattr(artist_identifier.urllib.request, "urlretrieve", _fake_urlretrieve(source_zip))

    with pytest.raises(ValueError, match="path traversal"):
        artist_identifier._download_and_extract_github_zip("https://example.test/runtime.zip", target_dir)

    assert not (tmp_path / "escape.py").exists()


def test_download_and_extract_github_zip_rejects_empty_zip(monkeypatch, tmp_path: Path):
    source_zip = tmp_path / "runtime.zip"
    _write_zip(source_zip, {})
    target_dir = tmp_path / "models" / "artist" / "runtime"

    monkeypatch.setattr(artist_identifier.urllib.request, "urlretrieve", _fake_urlretrieve(source_zip))

    with pytest.raises(ValueError, match="exactly one runtime root"):
        artist_identifier._download_and_extract_github_zip("https://example.test/runtime.zip", target_dir)


def test_download_and_extract_github_zip_rejects_oversized_zip(monkeypatch, tmp_path: Path):
    source_zip = tmp_path / "runtime.zip"
    _write_zip(source_zip, {"comfyui-lsnet-main/lsnet_model/__init__.py": b"12345"})
    target_dir = tmp_path / "models" / "artist" / "runtime"

    monkeypatch.setattr(artist_identifier, "_MAX_ARTIST_RUNTIME_UNCOMPRESSED_BYTES", 4)
    monkeypatch.setattr(artist_identifier.urllib.request, "urlretrieve", _fake_urlretrieve(source_zip))

    with pytest.raises(ValueError, match="safe extraction limit"):
        artist_identifier._download_and_extract_github_zip("https://example.test/runtime.zip", target_dir)

    assert not (target_dir / "lsnet_model" / "__init__.py").exists()
