from __future__ import annotations

import importlib.util
import json
import re
import hashlib
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
BUILD_SCRIPT = ROOT / "scripts" / "build_release_packages.py"


def load_release_builder():
    spec = importlib.util.spec_from_file_location("build_release_packages", BUILD_SCRIPT)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_write_portable_launcher_uses_clean_crlf_endings(tmp_path):
    release_builder = load_release_builder()

    launcher_path = release_builder.write_portable_launcher(tmp_path)
    launcher_bytes = launcher_path.read_bytes()

    assert b"\r\r\n" not in launcher_bytes
    assert b"setlocal enabledelayedexpansion\r\n" in launcher_bytes
    assert b"set \"PIP_CMD=!PYTHON_DIR!\\Scripts\\pip.exe\"" in launcher_bytes
    assert b"set \"SD_IMAGE_SORTER_DATA_DIR=!DATA_DIR!\"" in launcher_bytes
    assert b"set \"SD_IMAGE_SORTER_LAUNCHER=run-portable.bat\"" in launcher_bytes
    assert b"set \"TEMP=!TMP_DIR!\"" in launcher_bytes
    assert b"if not exist \"!PYTHON_CMD!\" (" in launcher_bytes
    assert b"import fastapi, PIL" in launcher_bytes
    assert b"Installing dependencies - first run may take a few minutes" in launcher_bytes
    assert launcher_bytes.endswith(b"pause\r\n")


def test_release_skip_rules_drop_hidden_and_docs_files():
    release_builder = load_release_builder()

    assert release_builder.should_skip_path(Path(".gitignore")) is True
    assert release_builder.should_skip_path(Path(".tmp_probe_browse.py")) is True
    assert release_builder.should_skip_path(Path(".tmp_move_target") / "note.txt") is True
    assert release_builder.should_skip_path(Path("docs") / "screenshots" / "gallery.png") is True
    assert release_builder.should_skip_path(Path("data") / "images.db") is True
    assert release_builder.should_skip_path(Path("update") / "downloads" / "patch.zip") is True
    assert release_builder.should_skip_path(Path(".env.example")) is False
    assert release_builder.should_skip_path(Path("README.md")) is False


def test_release_default_version_follows_app_info():
    release_builder = load_release_builder()
    match = re.search(
        r'^APP_VERSION\s*=\s*["\']([^"\']+)["\']',
        (ROOT / "backend" / "app_info.py").read_text(encoding="utf-8"),
        re.MULTILINE,
    )

    assert match is not None
    assert release_builder.DEFAULT_VERSION == match.group(1)


def test_write_package_manifest_excludes_runtime_files(tmp_path):
    release_builder = load_release_builder()

    (tmp_path / "backend").mkdir()
    (tmp_path / "backend" / "main.py").write_text("print('ok')\n", encoding="utf-8")
    (tmp_path / "frontend").mkdir()
    (tmp_path / "frontend" / "index.html").write_text("<html></html>\n", encoding="utf-8")
    (tmp_path / "python").mkdir()
    (tmp_path / "python" / "python.exe").write_text("binary\n", encoding="utf-8")

    manifest_path = release_builder.write_package_manifest(tmp_path, "9.9.9")
    payload = json.loads(manifest_path.read_text(encoding="utf-8"))

    assert payload["version"] == "9.9.9"
    assert "backend/main.py" in payload["managed_paths"]
    assert "frontend/index.html" in payload["managed_paths"]
    assert "python/python.exe" not in payload["managed_paths"]
    assert "update/package-manifest.json" in payload["managed_paths"]


def test_write_package_manifest_declares_model_artifact_policy(tmp_path):
    release_builder = load_release_builder()

    staged_files = {
        "backend/main.py": "print('ok')\n",
        "models/README.md": "models docs\n",
        "models/wd14-tagger/wd-swinv2-tagger-v3/model.onnx": "model\n",
    }
    for relative_path, content in staged_files.items():
        target = tmp_path / relative_path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")

    manifest_path = release_builder.write_package_manifest(tmp_path, "9.9.9")
    payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    policy = payload["model_artifact_policy"]

    assert policy["version"] == release_builder.MODEL_ARTIFACT_POLICY_VERSION
    assert policy["default_packages_include_model_payloads"] is False
    assert policy["runtime_model_root"] == "data/models"
    assert "models/README.md" in payload["managed_paths"]
    assert "models/wd14-tagger/wd-swinv2-tagger-v3/model.onnx" not in payload["managed_paths"]
    assert "models/wd14-tagger/wd-swinv2-tagger-v3/model.onnx" in policy["auto_download_model_paths"]
    assert policy["managed_model_payload_paths"] == []
    assert {asset["name"] for asset in policy["optional_release_assets"]} >= {
        "wd14-eva02-model",
        "artist-runtime",
        "kaloscope-checkpoint",
        "sam3-modelscope-sam3pt",
    }


def test_write_package_manifest_filters_protected_runtime_paths_even_if_staged(tmp_path):
    release_builder = load_release_builder()

    staged_files = {
        "backend/main.py": "print('ok')\n",
        "data/images.db": "database\n",
        "data/models/wd14/model.onnx": "model\n",
        "update/backups/old-file.txt": "backup\n",
        "update/downloads/patch.zip": "zip\n",
        "update/logs/update.log": "log\n",
        "update/state/pending-update.json": "state\n",
        "update/worker/update_worker.py": "worker\n",
    }
    for relative_path, content in staged_files.items():
        target = tmp_path / relative_path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")

    manifest_path = release_builder.write_package_manifest(tmp_path, "9.9.9")
    managed_paths = set(json.loads(manifest_path.read_text(encoding="utf-8"))["managed_paths"])

    assert "backend/main.py" in managed_paths
    assert "update/package-manifest.json" in managed_paths
    for protected_path in staged_files:
        if protected_path != "backend/main.py":
            assert protected_path not in managed_paths


def test_copy_project_then_manifest_excludes_all_protected_runtime_prefixes(monkeypatch, tmp_path):
    release_builder = load_release_builder()

    source_root = tmp_path / "source"
    stage_dir = tmp_path / "stage"
    (source_root / "backend").mkdir(parents=True)
    (source_root / "backend" / "main.py").write_text("print('ok')\n", encoding="utf-8")

    protected_files = {
        "data/images.db": "database\n",
        "data/models/wd14/model.onnx": "model\n",
        "update/backups/old-file.txt": "backup\n",
        "update/downloads/patch.zip": "zip\n",
        "update/logs/update.log": "log\n",
        "update/state/pending-update.json": "state\n",
        "update/worker/update_worker.py": "worker\n",
    }
    for relative_path, content in protected_files.items():
        target = source_root / relative_path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")

    monkeypatch.setattr(release_builder, "ROOT", source_root)

    release_builder.copy_project(stage_dir)
    manifest_path = release_builder.write_package_manifest(stage_dir, "9.9.9")
    managed_paths = set(json.loads(manifest_path.read_text(encoding="utf-8"))["managed_paths"])

    assert "backend/main.py" in managed_paths
    assert "update/package-manifest.json" in managed_paths
    for protected_path in protected_files:
        assert protected_path not in managed_paths


def test_download_file_verifies_sha256(monkeypatch, tmp_path):
    release_builder = load_release_builder()
    payload = b"verified-download"
    expected_sha256 = hashlib.sha256(payload).hexdigest()

    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def read(self, size=-1):
            nonlocal payload
            if not payload:
                return b""
            if size < 0:
                chunk, payload = payload, b""
                return chunk
            chunk, payload = payload[:size], payload[size:]
            return chunk

    monkeypatch.setattr(release_builder.urllib.request, "urlopen", lambda request, timeout=0: FakeResponse())

    dest = tmp_path / "payload.bin"
    release_builder.download_file("https://example.com/payload.bin", dest, expected_sha256=expected_sha256)

    assert dest.read_bytes() == b"verified-download"


def test_download_file_rejects_sha256_mismatch(monkeypatch, tmp_path):
    release_builder = load_release_builder()

    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def read(self, size=-1):
            if hasattr(self, "_done"):
                return b""
            self._done = True
            return b"wrong-download"

    monkeypatch.setattr(release_builder.urllib.request, "urlopen", lambda request, timeout=0: FakeResponse())

    dest = tmp_path / "payload.bin"
    expected_sha256 = hashlib.sha256(b"expected").hexdigest()

    try:
        release_builder.download_file("https://example.com/payload.bin", dest, expected_sha256=expected_sha256)
    except RuntimeError as exc:
        assert "checksum mismatch" in str(exc)
    else:
        raise AssertionError("Expected checksum mismatch")

    assert not dest.exists()
    assert not (tmp_path / "payload.bin.tmp").exists()
