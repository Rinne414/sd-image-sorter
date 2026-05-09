from __future__ import annotations

import importlib.util
import json
import re
import hashlib
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
BUILD_SCRIPT = ROOT / "scripts" / "build_release_packages.py"


def _read_app_version() -> str:
    match = re.search(
        r'^APP_VERSION\s*=\s*["\']([^"\']+)["\']',
        (ROOT / "backend" / "app_info.py").read_text(encoding="utf-8"),
        re.MULTILINE,
    )
    assert match is not None
    return match.group(1)


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
    assert b"set \"SD_IMAGE_SORTER_STATE_DIR=!STATE_DIR!\"" in launcher_bytes
    assert b"set \"SD_IMAGE_SORTER_LAUNCHER=run-portable.bat\"" in launcher_bytes
    assert b"set \"TEMP=!TMP_DIR!\"" in launcher_bytes
    assert b"if not exist \"!PYTHON_CMD!\" (" in launcher_bytes
    assert b"import fastapi, PIL, numpy, onnxruntime" in launcher_bytes
    assert b"requirements-core.txt" in launcher_bytes
    assert b"RUNTIME_REBUILD_MARKER=!STATE_DIR!\\rebuild-core-venv.json" in launcher_bytes
    assert b"Clearing embedded Python packages only" in launcher_bytes
    assert b"Could not clear embedded Python site-packages" in launcher_bytes
    assert b"Could not clear embedded Python Scripts" in launcher_bytes
    assert b"!PYTHON_DIR!\\Lib\\site-packages" in launcher_bytes
    assert b"Heavy AI packages install on Prepare" in launcher_bytes
    assert b"backend\\launcher_pip.py install setuptools wheel" in launcher_bytes
    assert b"Installing lightweight core dependencies" in launcher_bytes
    assert b"-m pip install -r backend\\requirements.txt" not in launcher_bytes
    assert b"backend\\launcher_port.py --format cmd > \"!PORT_ENV_FILE!\"" in launcher_bytes
    assert b"SD_IMAGE_SORTER_PORT_STATUS" in launcher_bytes
    assert b"SD_IMAGE_SORTER_URL_HOST" in launcher_bytes
    assert b"PORT_CHECK_EXIT" in launcher_bytes
    assert b"http://!APP_URL_HOST!:!APP_PORT!" in launcher_bytes
    assert b"http://localhost:!APP_PORT!" not in launcher_bytes
    assert b"main.py --port !APP_PORT!" in launcher_bytes
    assert b"Server exited with code !SERVER_EXIT_CODE!" in launcher_bytes
    assert b"Error output above" not in launcher_bytes
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


def test_release_copy_project_prunes_excluded_directory_trees(monkeypatch, tmp_path):
    release_builder = load_release_builder()
    fake_root = tmp_path / "repo"
    stage_root = tmp_path / "stage"

    files = {
        "README.md": "readme\n",
        "backend/main.py": "print('ok')\n",
        "frontend/index.html": "<html></html>\n",
        "models/yolo/README.md": "model docs\n",
        "models/yolo/model.onnx": "model payload\n",
        "backend/venv/Lib/site-packages/huge.py": "must not copy\n",
        "artifacts/release/staging/recursive.txt": "must not copy\n",
        "data/images.db": "must not copy\n",
        "update/downloads/patch.zip": "must not copy\n",
        ".git/config": "must not copy\n",
    }
    for relative_path, content in files.items():
        target = fake_root / relative_path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")

    monkeypatch.setattr(release_builder, "ROOT", fake_root)

    release_builder.copy_project(stage_root)

    assert (stage_root / "README.md").exists()
    assert (stage_root / "backend/main.py").exists()
    assert (stage_root / "frontend/index.html").exists()
    assert (stage_root / "models/yolo/README.md").exists()
    assert not (stage_root / "models/yolo/model.onnx").exists()
    assert not (stage_root / "backend/venv/Lib/site-packages/huge.py").exists()
    assert not (stage_root / "artifacts/release/staging/recursive.txt").exists()
    assert not (stage_root / "data/images.db").exists()
    assert not (stage_root / "update/downloads/patch.zip").exists()
    assert not (stage_root / ".git/config").exists()


def test_rescue_batch_files_are_release_managed(tmp_path):
    release_builder = load_release_builder()

    assert release_builder.should_skip_path(Path("fix.bat")) is False
    assert release_builder.should_skip_path(Path("update.bat")) is False
    assert release_builder.should_skip_path(Path("backend") / "update_cli.py") is False

    fix_text = (ROOT / "fix.bat").read_text(encoding="utf-8")
    update_text = (ROOT / "update.bat").read_text(encoding="utf-8")

    assert "fix.bat is for rare repair/diagnostics only" in fix_text
    assert "main.py" not in fix_text
    assert "--diagnose --format text" in fix_text
    assert r"backend\update_cli.py" in update_text
    assert "--check-only" in update_text
    assert "%*" in update_text
    assert "run-portable.bat" in update_text

    staged_files = {
        "fix.bat": fix_text,
        "update.bat": update_text,
        "backend/update_cli.py": "print('update cli')\n",
    }
    for relative_path, content in staged_files.items():
        target = tmp_path / relative_path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")

    manifest_path = release_builder.write_package_manifest(tmp_path, "9.9.9")
    managed_paths = set(json.loads(manifest_path.read_text(encoding="utf-8"))["managed_paths"])

    assert "fix.bat" in managed_paths
    assert "update.bat" in managed_paths
    assert "backend/update_cli.py" in managed_paths


def test_release_default_version_follows_app_info():
    release_builder = load_release_builder()

    assert release_builder.DEFAULT_VERSION == _read_app_version()


def test_release_public_docs_versions_follow_app_info():
    app_version = _read_app_version()
    readme_text = (ROOT / "README.md").read_text(encoding="utf-8")
    changelog_text = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")

    assert f"version-{app_version}-ff8a00" in readme_text
    assert f"sd-image-sorter-v{app_version}-windows-portable.zip" in readme_text
    assert f"sd-image-sorter-v{app_version}-linux.tar.gz" in readme_text
    assert re.search(
        rf"^## \[{re.escape(app_version)}\] - \d{{4}}-\d{{2}}-\d{{2}}$",
        changelog_text,
        re.MULTILINE,
    )


def test_release_bootstrap_downloads_are_pinned_to_immutable_sources():
    release_builder = load_release_builder()

    assert release_builder.PYTHON_EMBED_VERSION in release_builder.PYTHON_EMBED_URL
    assert re.fullmatch(r"[0-9a-f]{64}", release_builder.PYTHON_EMBED_SHA256)
    assert re.fullmatch(r"[0-9a-f]{40}", release_builder.GET_PIP_COMMIT)
    assert release_builder.GET_PIP_COMMIT in release_builder.GET_PIP_URL
    assert "raw.githubusercontent.com/pypa/get-pip/" in release_builder.GET_PIP_URL
    assert "/main/" not in release_builder.GET_PIP_URL
    assert release_builder.GET_PIP_URL != "https://bootstrap.pypa.io/get-pip.py"
    assert re.fullmatch(r"[0-9a-f]{64}", release_builder.GET_PIP_SHA256)


def test_release_bootstrap_download_cache_stays_under_staging_root():
    release_builder = load_release_builder()

    assert release_builder.BOOTSTRAP_DOWNLOAD_ROOT.parent == release_builder.STAGING_ROOT
    assert release_builder.BOOTSTRAP_DOWNLOAD_ROOT.name.startswith("_")


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


def _assert_platform_specific_wheels_guarded(requirements_path: Path):
    requirement_lines: dict[str, list[str]] = {}
    for line in requirements_path.read_text(encoding="utf-8").splitlines():
        if not line or line.startswith(("#", " ")) or "==" not in line:
            continue
        package_name = line.split("==", 1)[0].split("[", 1)[0]
        requirement_lines.setdefault(package_name, []).append(line)

    linux_only_packages = {
        "cuda-bindings",
        "cuda-pathfinder",
        "cuda-toolkit",
        "nvidia-cublas",
        "nvidia-cuda-cupti",
        "nvidia-cuda-nvrtc",
        "nvidia-cuda-runtime",
        "nvidia-cudnn-cu13",
        "nvidia-cufft",
        "nvidia-cufile",
        "nvidia-curand",
        "nvidia-cusolver",
        "nvidia-cusparse",
        "nvidia-cusparselt-cu13",
        "nvidia-nccl-cu13",
        "nvidia-nvjitlink",
        "nvidia-nvshmem-cu13",
        "nvidia-nvtx",
        "triton",
    }
    for package_name in linux_only_packages:
        assert any('; sys_platform == "linux"' in line for line in requirement_lines[package_name])

    assert any('; sys_platform != "win32"' in line for line in requirement_lines["uvloop"])
    assert any('onnxruntime==1.25.0 ; sys_platform == "linux"' in line for line in requirement_lines["onnxruntime"])
    assert any('; sys_platform == "win32"' in line for line in requirement_lines["onnxruntime-gpu"])
    assert any(line.startswith("triton-windows==3.6.0.post") for line in requirement_lines["triton-windows"])
    assert any('; sys_platform == "win32"' in line for line in requirement_lines["triton-windows"])
    assert any(line.startswith("websocket-client==") for line in requirement_lines["websocket-client"])
    assert any(line.startswith("sniffio==") for line in requirement_lines["sniffio"])
    assert any(line.startswith("sortedcontainers==") for line in requirement_lines["sortedcontainers"])
    assert any(
        line.startswith("cffi==")
        and '; sys_platform == "win32"' in line
        and 'platform_python_implementation != "PyPy"' in line
        for line in requirement_lines["cffi"]
    )
    assert any(
        line.startswith("pycparser==")
        and '; sys_platform == "win32"' in line
        and 'platform_python_implementation != "PyPy"' in line
        for line in requirement_lines["pycparser"]
    )


def test_runtime_requirements_keep_platform_specific_wheels_guarded():
    """The optional full-AI requirements file keeps platform-specific wheels guarded."""
    requirements_path = ROOT / "backend" / "requirements.txt"
    _assert_platform_specific_wheels_guarded(requirements_path)
    requirements_text = requirements_path.read_text(encoding="utf-8")
    for package_name in (
        "sam3==0.1.3",
        "einops==",
        "hydra-core==",
        "omegaconf==",
        "pycocotools==",
        "decord==",
        "iopath==",
    ):
        assert package_name not in requirements_text
    assert "transformers==" in requirements_text
    assert "safetensors==" in requirements_text
    assert "opencv-python==" in requirements_text


def test_core_requirements_exclude_heavy_ai_packages():
    requirements_text = (ROOT / "backend" / "requirements-core.txt").read_text(encoding="utf-8")
    for package_name in (
        "torch==",
        "torchvision==",
        "sam3==",
        "ultralytics==",
        "fastembed==",
        "open-clip-torch==",
        "transformers==",
        "timm==",
        "nudenet==",
        "onnxruntime-gpu==",
        "nvidia-",
        "cuda-",
        "triton==",
    ):
        assert package_name not in requirements_text
    assert 'onnxruntime==1.25.0 ; sys_platform == "linux"' in requirements_text
    assert 'onnxruntime==1.19.2 ; sys_platform == "darwin"' in requirements_text
    assert 'onnxruntime==1.20.1 ; sys_platform == "win32"' in requirements_text
    assert 'uvloop==0.22.1 ; sys_platform != "win32"' in requirements_text
    assert 'cffi==2.0.0 ; sys_platform == "win32"' in requirements_text
    assert "fastapi==" in requirements_text


def test_prepare_flow_frontend_warns_when_restart_is_needed():
    app_js = (ROOT / "frontend" / "js" / "app.js").read_text(encoding="utf-8")
    en_js = (ROOT / "frontend" / "js" / "lang" / "en.js").read_text(encoding="utf-8")
    zh_js = (ROOT / "frontend" / "js" / "lang" / "zh-CN.js").read_text(encoding="utf-8")

    assert "withRestartReminder" in app_js
    assert "restart_recommended" in app_js
    assert "installed_packages" in app_js
    assert "models.restartAfterInstallWithPackages" in en_js
    assert "使用这个功能前请重启应用" in zh_js


def test_dev_requirements_keep_platform_specific_wheels_guarded():
    """The dev lock must not regress to a Linux-only runtime closure."""
    _assert_platform_specific_wheels_guarded(ROOT / "backend" / "requirements-dev.txt")


def test_linux_release_package_uses_linux_only_name():
    release_builder = load_release_builder()

    assert release_builder.build_release_assets.__name__ == "build_release_assets"
    app_info = (ROOT / "backend" / "app_info.py").read_text(encoding="utf-8")
    build_script = (ROOT / "scripts" / "build_release_packages.py").read_text(encoding="utf-8")

    assert "linux.tar.gz" in app_info
    assert "linux.tar.gz" in build_script
    assert "linux-mac.tar.gz" not in app_info
    assert "linux-mac.tar.gz" not in build_script


def test_portable_python_version_matches_runtime_lock_header():
    release_builder = load_release_builder()
    requirements_text = (ROOT / "backend" / "requirements.txt").read_text(encoding="utf-8")
    compiled_with = re.search(r"pip-compile with Python (\d+\.\d+)", requirements_text)

    assert compiled_with is not None
    embed_minor = ".".join(release_builder.PYTHON_EMBED_VERSION.split(".")[:2])
    assert embed_minor == compiled_with.group(1)


def test_launchers_reject_python_older_than_runtime_lock():
    run_sh = (ROOT / "run.sh").read_text(encoding="utf-8")
    run_bat = (ROOT / "run.bat").read_text(encoding="utf-8")

    assert "Python 3.12" in run_sh
    assert "PY_MINOR\" -lt 12" in run_sh
    assert "Python 3.9" not in run_sh
    assert "Python 3.12" in run_bat
    assert "LSS 12" in run_bat
    assert "Python 3.9" not in run_bat
    assert "backend/launcher_pip.py install setuptools wheel" in run_sh
    assert 'INSTALL_REQUIREMENTS="backend/requirements-core.txt"' in run_sh
    assert 'SD_IMAGE_SORTER_INSTALL_FULL_AI' in run_sh
    assert 'backend/launcher_pip.py install --no-build-isolation -r "${INSTALL_REQUIREMENTS}"' in run_sh
    assert "macOS is not supported by this release package" in run_sh
    assert "--index-url https://download.pytorch.org/whl/cpu torch==2.11.0 torchvision==0.26.0" in run_sh
    assert "requirements-linux-runtime.txt" in run_sh
    assert "HASH_REQUIREMENTS=\"${INSTALL_REQUIREMENTS}\"" in run_sh
    assert "md5sum \"${HASH_REQUIREMENTS}\"" in run_sh
    assert '"nvidia-"' in run_sh
    assert '"cuda-"' in run_sh
    assert "Skipping ONNX GPU repair for lightweight startup" in run_sh
    assert 'VENV_REBUILD_MARKER="${STATE_DIR}/rebuild-core-venv.json"' in run_sh
    assert 'rm -rf "backend/venv"' in run_sh
    assert 'rm -f "backend/.requirements_hash"' in run_sh
    assert "backend\\venv\\Scripts\\python.exe backend\\launcher_pip.py install setuptools wheel" in run_bat
    assert 'backend\\venv\\Scripts\\python.exe backend\\launcher_pip.py install --no-build-isolation -r "!INSTALL_REQUIREMENTS!"' in run_bat
    assert 'VENV_REBUILD_MARKER=%STATE_DIR%\\rebuild-core-venv.json' in run_bat
    assert 'rmdir /s /q "backend\\venv"' in run_bat
    assert 'del "backend\\.requirements_hash"' in run_bat
    assert "requirements-core.txt" in run_bat


def test_current_install_docs_match_python_312_floor():
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    release_packs = (ROOT / "docs" / "RELEASE_PACKS.md").read_text(encoding="utf-8")
    current_docs = "\n".join([readme, release_packs])

    assert "python-3.12%2B" in readme
    assert "Windows 便携版自带 Python 3.12" in readme
    assert "Python 3.12+" in release_packs
    assert "python-3.9%2B" not in current_docs
    assert "Python 3.9+" not in current_docs
    assert "Python 3.11" not in current_docs


def test_release_ci_keeps_security_audit_and_windows_linux_guardrails():
    run_ci = (ROOT / "scripts" / "run_ci.py").read_text(encoding="utf-8")
    workflow = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")

    security_check = (ROOT / "scripts" / "security_check.py").read_text(encoding="utf-8")

    assert "scripts/security_check.py" in run_ci
    assert "dependency security audit" in run_ci
    assert "frontend js syntax" in run_ci
    assert "--check" in run_ci
    assert "FRONTEND_JS_FILES" in run_ci
    assert "--no-deps" in security_check
    assert "--disable-pip" in security_check
    assert "ubuntu-latest" in workflow
    assert "windows-latest" in workflow
    assert "Release and updater tests" in workflow
    assert "macos-latest" not in workflow
    assert "macOS dependency import and release guard tests" not in workflow
    assert "cache: \"pip\"" in workflow


def test_playwright_specs_are_not_an_empty_ci_shell():
    specs_dir = ROOT / "tests" / "e2e" / "specs"
    specs = sorted(specs_dir.glob("*.spec.ts"))

    assert len(specs) >= 1
    assert any(path.name == "smoke.spec.ts" for path in specs)


def test_playwright_ci_inputs_are_tracked_or_generated():
    run_ci = (ROOT / "scripts" / "run_ci.py").read_text(encoding="utf-8")
    config = (ROOT / "tests" / "e2e" / "playwright.config.ts").read_text(encoding="utf-8")
    reader_live = (ROOT / "tests" / "e2e" / "specs" / "reader-live.spec.ts").read_text(encoding="utf-8")

    assert (ROOT / "scripts" / "build_review_dataset.py").exists()
    assert "REVIEW_DATASET_BUILDER" in run_ci
    assert "build_review_dataset.py" in run_ci
    assert "storage/onboarding-complete.json" not in config
    assert "onboardingStorageState" in config
    assert "scripts/build_review_dataset.py" in reader_live


def test_frontend_i18n_and_censor_css_keep_safety_contracts():
    i18n_js = (ROOT / "frontend" / "js" / "i18n.js").read_text(encoding="utf-8")
    styles_css = (ROOT / "frontend" / "css" / "styles.css").read_text(encoding="utf-8")
    css_text = "\n".join(path.read_text(encoding="utf-8") for path in (ROOT / "frontend" / "css").glob("*.css"))
    censor_css = (ROOT / "frontend" / "css" / "censor-v2.css").read_text(encoding="utf-8")

    assert "innerHTML = this.t" not in i18n_js
    assert "height: calc(100vh - 60px);" not in styles_css
    assert "height: calc(100vh - var(--nav-height))" in styles_css
    for hardcoded_accent in ("rgba(168, 85, 247", "rgba(124, 58, 237", "#a855f7", "#7c3aed", "#e9d5ff"):
        assert hardcoded_accent not in css_text
    assert "var(--censor-accent" in censor_css

def test_model_manager_sam3_setup_copy_matches_lazy_prepare_policy():
    model_service = (ROOT / "backend" / "services" / "model_service.py").read_text(encoding="utf-8")

    assert "First launch installs SAM3 Python runtime packages" not in model_service
    assert "Click Prepare / Download to install SAM3 Python runtime packages if they are missing." in model_service
    assert "Restart SD Image Sorter if the Prepare result says Python packages were installed." in model_service
