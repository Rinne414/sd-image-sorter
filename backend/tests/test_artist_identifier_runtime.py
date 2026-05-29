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


def test_prepare_artist_assets_prefers_modelscope_when_configured(monkeypatch, tmp_path: Path):
    runtime_dir = tmp_path / "runtime"
    runtime_dir.mkdir()
    checkpoint = tmp_path / "ms" / "best_checkpoint.pth"
    mapping = tmp_path / "ms" / "class_mapping.csv"
    checkpoint.parent.mkdir()
    checkpoint.write_bytes(b"ckpt")
    mapping.write_text("class\n", encoding="utf-8")
    calls = []

    monkeypatch.setattr(artist_identifier, "_resolve_lsnet_runtime_path", lambda: str(runtime_dir))
    monkeypatch.setattr(artist_identifier, "ARTIST_MODELSCOPE_MODEL_ID", "owner/kaloscope")
    monkeypatch.setattr(
        artist_identifier,
        "_ensure_kaloscope_modelscope_files",
        lambda: calls.append("modelscope") or (str(checkpoint), str(mapping)),
    )
    monkeypatch.setattr(
        artist_identifier,
        "_ensure_kaloscope_hf_files",
        lambda: (_ for _ in ()).throw(AssertionError("HF fallback should not be first when ModelScope is configured")),
    )

    result = artist_identifier.prepare_artist_assets("modelscope")

    assert calls == ["modelscope"]
    assert result["source"] == "modelscope"
    assert result["checkpoint_path"] == str(checkpoint)


def test_prepare_artist_assets_modelscope_without_repo_uses_hf_endpoint_order(monkeypatch, tmp_path: Path):
    runtime_dir = tmp_path / "runtime"
    runtime_dir.mkdir()
    checkpoint = tmp_path / "hf" / "best_checkpoint.pth"
    mapping = tmp_path / "hf" / "class_mapping.csv"
    checkpoint.parent.mkdir()
    checkpoint.write_bytes(b"ckpt")
    mapping.write_text("class\n", encoding="utf-8")
    calls = []

    monkeypatch.setattr(artist_identifier, "_resolve_lsnet_runtime_path", lambda: str(runtime_dir))
    monkeypatch.setattr(artist_identifier, "ARTIST_MODELSCOPE_MODEL_ID", "")
    monkeypatch.setattr(
        artist_identifier,
        "_ensure_kaloscope_hf_files",
        lambda: calls.append("huggingface") or (str(checkpoint), str(mapping)),
    )

    result = artist_identifier.prepare_artist_assets("modelscope")

    assert calls == ["huggingface"]
    assert result["source"] == "huggingface"
    assert result["checkpoint_path"] == str(checkpoint)


def test_verify_artist_file_digest_rejects_pinned_mismatch(tmp_path: Path):
    target = tmp_path / "checkpoint.pth"
    target.write_bytes(b"tampered bytes that will not match the pinned digest")
    pinned_name = next(iter(artist_identifier._EXPECTED_ARTIST_FILE_SHA256))
    with pytest.raises(RuntimeError, match="SHA-256 mismatch"):
        artist_identifier._verify_artist_file_digest(pinned_name, target)


def test_verify_artist_file_digest_skips_unpinned_file(tmp_path: Path):
    target = tmp_path / "class_mapping.csv"
    target.write_bytes(b"anything goes when no digest is pinned")
    # No pinned digest for this name -> no-op, must not raise.
    artist_identifier._verify_artist_file_digest("class_mapping.csv", target)
