#!/usr/bin/env python3
"""Build release archives for SD Image Sorter."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path
from typing import Iterable
from zipfile import ZIP_DEFLATED, ZipFile


ROOT = Path(__file__).resolve().parent.parent
ARTIFACT_ROOT = ROOT / "artifacts" / "release"
STAGING_ROOT = ARTIFACT_ROOT / "staging"
BOOTSTRAP_DOWNLOAD_ROOT = STAGING_ROOT / "_downloads"
DEFAULT_SPLIT_SIZE_MB = 1900

BACKEND_ROOT = ROOT / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from update_worker import (  # noqa: E402
    INSTALLED_MANIFEST_RELATIVE_PATH,
    PACKAGE_MANIFEST_RELATIVE_PATH,
    PROTECTED_RUNTIME_PREFIXES,
    is_protected_runtime_path,
)


def _read_default_version() -> str:
    app_info_path = ROOT / "backend" / "app_info.py"
    match = re.search(
        r'^APP_VERSION\s*=\s*["\']([^"\']+)["\']',
        app_info_path.read_text(encoding="utf-8"),
        re.MULTILINE,
    )
    return match.group(1) if match else "0.0.0"


DEFAULT_VERSION = _read_default_version()

# Python embeddable package URL template (Windows amd64)
PYTHON_EMBED_VERSION = "3.12.8"
PYTHON_EMBED_URL = f"https://www.python.org/ftp/python/{PYTHON_EMBED_VERSION}/python-{PYTHON_EMBED_VERSION}-embed-amd64.zip"
PYTHON_EMBED_SHA256 = "8d3f33be9eb810f23c102f08475af2854e50484b8e4e06275e937be61ce3d2fb"
GET_PIP_COMMIT = "1c1d362758a70f85b9c9b12417c0c6f0ca3da4aa"
GET_PIP_URL = f"https://raw.githubusercontent.com/pypa/get-pip/{GET_PIP_COMMIT}/public/get-pip.py"
GET_PIP_SHA256 = "106ae019e371c7d8cb3699c75607a9b7a4d31e2b95c575362c8bcfe3d41353fd"
DOWNLOAD_CHUNK_SIZE = 1024 * 1024
DOWNLOAD_TIMEOUT_SECONDS = 120
DOWNLOAD_HEADERS = {
    "User-Agent": f"sd-image-sorter-release-builder/{DEFAULT_VERSION}",
}

DOC_FILES = {
    "models/README.md",
    "models/yolo/README.md",
    "models/artist/README.md",
}
MODEL_ARTIFACT_POLICY_VERSION = 1

EXCLUDED_PREFIXES = (
    ".git",
    ".tmp",
    ".plans",
    ".claude",
    ".vscode",
    "artifacts",
    "backend/venv",
    "backend/favorites",
    "backend/thumbnails",
    "backend/test-path",
    "backend/tests",
    "backend/test_",
    "node_modules",
    "python",
    "update",
    "tests",
    "test-results",
    "docs",
    "tmp",
    "reference",
    "testimage",
    "example",
    "scripts",
    "docs/DELETION_LOG",
    "docs/IMPROVEMENT_PLAN",
    "docs/SECURITY_ARCHITECTURE",
    "docs/architecture",
)

RUNTIME_EXCLUDED_PREFIXES = tuple(prefix.as_posix() for prefix in PROTECTED_RUNTIME_PREFIXES)

EXCLUDED_NAMES = {
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".coverage",
    "coverage.xml",
    "htmlcov",
    "nul",
}

EXCLUDED_SUFFIXES = {
    ".pyc",
    ".pyo",
    ".log",
}

EXCLUDED_FILES = {
    "backend/images.db",
    "backend/.requirements_hash",
    "backend/lora_debug.txt",
    "backend/sort_session.json",
    "backend/pytest.ini",
    "backend/verify_sorting.py",
    "backend/fix_db_ratings.py",
    "backend/test_censor_logic.py",
    "backend/test_functionality.py",
    "backend/test_images_thumbnail.py",
    "backend/test_metadata_parser_params.py",
    "AGENTS.md",
    "CLAUDE.md",
    "THIRD_PARTY_MODELS.md",
    "SECURITY.md",
    "CHANGELOG.md",
    "package.json",
    "package-lock.json",
    "docs/DELETION_LOG.md",
    "docs/IMPROVEMENT_PLAN.md",
    "docs/SECURITY_ARCHITECTURE.md",
    "docs/architecture.md",
    "docs/API.md",
    "run-portable.bat",
    "v3-2-1.md",
    "v3_audit_prompt.md",
}

ALLOWED_HIDDEN_FILES = {
    ".env.example",
}

CORE_MODEL_FILES = (
    "models/README.md",
    "models/yolo/README.md",
    "models/artist/README.md",
    "models/yolo/wenaka_yolov8s-seg.onnx",
    "models/yolo/wenaka_yolov8s-seg.pt",
    "models/yolo/yolo26s-seg.onnx",
    "models/yolo/yolo26s-seg.pt",
    "models/yolo/yolov8s-seg.onnx",
    "models/yolo/yolov8s-seg.pt",
    "models/nudenet/320n.onnx",
    "models/clip/Qdrant-clip-ViT-B-32-vision/config.json",
    "models/clip/Qdrant-clip-ViT-B-32-vision/model.onnx",
    "models/clip/Qdrant-clip-ViT-B-32-vision/preprocessor_config.json",
    "models/clip/Qdrant-clip-ViT-B-32-vision/README.md",
    "models/wd14-tagger/wd-swinv2-tagger-v3/model.onnx",
    "models/wd14-tagger/wd-swinv2-tagger-v3/selected_tags.csv",
)

EVA_MODEL_FILES = (
    "models/README.md",
    "models/wd14-tagger/wd-eva02-large-tagger-v3/model.onnx",
    "models/wd14-tagger/wd-eva02-large-tagger-v3/selected_tags.csv",
)

ARTIST_RUNTIME_FILES = (
    "models/README.md",
    "models/artist/README.md",
    "models/artist/kaloscope2.0/class_mapping.csv",
)

LARGE_MODEL_FILES = {
    "kaloscope": "models/artist/kaloscope2.0/448-90.13/best_checkpoint.pth",
    "sam3": "models/sam3/facebook-sam3-modelscope/sam3.pt",
}

SEVEN_ZIP_CANDIDATES = (
    Path(r"C:\Program Files\7-Zip\7z.exe"),
    Path(r"C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\IDE\Extensions\Xamarin.VisualStudio\7-Zip\7z.exe"),
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", default=DEFAULT_VERSION, help="Release version string, default: %(default)s")
    parser.add_argument(
        "--split-size-mb",
        type=int,
        default=DEFAULT_SPLIT_SIZE_MB,
        help="Maximum size for split zip volumes, default: %(default)s",
    )
    return parser.parse_args()


def find_seven_zip() -> Path | None:
    for candidate in SEVEN_ZIP_CANDIDATES:
        if candidate.exists():
            return candidate
    found = shutil.which("7z")
    return Path(found) if found else None


def is_model_payload_path(relative_path: str | Path) -> bool:
    """Return True for model binaries/config payloads that default app packages must not manage."""
    rel = relative_path.as_posix() if isinstance(relative_path, Path) else str(relative_path).replace("\\", "/")
    return rel.startswith("models/") and rel not in DOC_FILES


def build_model_artifact_policy(managed_paths: Iterable[str], *, include_model_payloads: bool = False) -> dict:
    """Describe release model delivery so packages do not pretend bundled models exist."""
    managed_model_paths = sorted(path for path in managed_paths if is_model_payload_path(path))
    return {
        "version": MODEL_ARTIFACT_POLICY_VERSION,
        "default_packages_include_model_payloads": bool(include_model_payloads),
        "runtime_model_root": "data/models",
        "managed_model_payload_paths": managed_model_paths,
        "auto_download_model_paths": sorted(path for path in CORE_MODEL_FILES if is_model_payload_path(path)),
        "optional_release_assets": [
            {
                "name": "wd14-eva02-model",
                "paths": sorted(path for path in EVA_MODEL_FILES if is_model_payload_path(path)),
            },
            {
                "name": "artist-runtime",
                "paths": sorted(path for path in ARTIST_RUNTIME_FILES if is_model_payload_path(path)),
            },
            {
                "name": "kaloscope-checkpoint",
                "paths": [LARGE_MODEL_FILES["kaloscope"]],
                "split": True,
            },
            {
                "name": "sam3-modelscope-sam3pt",
                "paths": [LARGE_MODEL_FILES["sam3"]],
                "split": True,
            },
        ],
    }


def _matches_prefix(relative_path: Path, prefixes: Iterable[str]) -> bool:
    rel = relative_path.as_posix()
    return any(rel == prefix or rel.startswith(prefix + "/") for prefix in prefixes)


def should_prune_directory(relative_path: Path) -> bool:
    rel = relative_path.as_posix()
    if any(part.startswith(".") for part in relative_path.parts):
        return True
    if _matches_prefix(relative_path, RUNTIME_EXCLUDED_PREFIXES):
        return True
    if _matches_prefix(relative_path, EXCLUDED_PREFIXES):
        return True
    if rel.startswith("backend/test_"):
        return True
    if any(part in EXCLUDED_NAMES for part in relative_path.parts):
        return True
    return False


def should_skip_path(relative_path: Path) -> bool:
    rel = relative_path.as_posix()
    if any(part.startswith(".") for part in relative_path.parts) and rel not in ALLOWED_HIDDEN_FILES:
        return True
    if rel in EXCLUDED_FILES:
        return True
    if _matches_prefix(relative_path, RUNTIME_EXCLUDED_PREFIXES):
        return True
    if _matches_prefix(relative_path, EXCLUDED_PREFIXES):
        return True
    # Exclude loose test files in backend/
    if rel.startswith("backend/test_"):
        return True
    if any(part in EXCLUDED_NAMES for part in relative_path.parts):
        return True
    if relative_path.suffix.lower() in EXCLUDED_SUFFIXES:
        return True
    if relative_path.parts and relative_path.parts[0] == "models" and rel not in DOC_FILES:
        return True
    # Repo root is for launcher scripts and core docs only — never images.
    # Real product screenshots live under docs/screenshots/. Loose images
    # at the root almost always come from ad-hoc playwright/E2E runs that
    # forgot a tmp directory; bundling them into the public release is
    # both a privacy and a "what is this random test screenshot doing in
    # my download" concern. Block them defensively even if a future
    # contributor accidentally tracks one.
    if (
        len(relative_path.parts) == 1
        and relative_path.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}
    ):
        return True
    return False


def iter_project_files() -> Iterable[tuple[Path, Path]]:
    stack = [ROOT]
    while stack:
        current = stack.pop()
        for item in sorted(current.iterdir(), key=lambda path: path.name):
            relative = item.relative_to(ROOT)
            if item.is_dir():
                if not should_prune_directory(relative):
                    stack.append(item)
                continue
            if not should_skip_path(relative):
                yield item, relative


def copy_file(relative_path: str | Path, destination_root: Path) -> None:
    source = ROOT / relative_path
    if not source.exists():
        raise FileNotFoundError(f"Required file is missing: {source}")
    destination = destination_root / relative_path
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)


def copy_tree(source_root: Path, destination_root: Path, target_relative_root: str) -> None:
    for item in source_root.rglob("*"):
        if item.is_dir():
            continue
        relative_inside = item.relative_to(source_root)
        if any(part in EXCLUDED_NAMES for part in relative_inside.parts):
            continue
        if item.suffix.lower() in EXCLUDED_SUFFIXES:
            continue
        destination = destination_root / target_relative_root / relative_inside
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(item, destination)


def copy_project(destination_root: Path) -> None:
    for item, relative in iter_project_files():
        destination = destination_root / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(item, destination)


def write_release_notes(stage_dir: Path, version: str) -> Path:
    """Copy the version-specific release notes into the package root."""
    source = ROOT / "docs" / f"RELEASE_NOTES_v{version}.md"
    if not source.exists():
        raise FileNotFoundError(f"Release notes are missing for v{version}: {source}")
    destination = stage_dir / "release-notes.md"
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)
    return destination


def write_package_manifest(stage_dir: Path, version: str, *, include_model_payloads: bool = False) -> Path:
    managed_paths: list[str] = []
    installed_manifest_relative = INSTALLED_MANIFEST_RELATIVE_PATH.as_posix()
    for file_path in sorted(stage_dir.rglob("*")):
        if file_path.is_dir():
            continue
        relative = file_path.relative_to(stage_dir).as_posix()
        if relative.startswith("python/"):
            continue
        if relative == installed_manifest_relative:
            continue
        if is_protected_runtime_path(relative):
            continue
        if is_model_payload_path(relative) and not include_model_payloads:
            continue
        managed_paths.append(relative)

    manifest_relative = PACKAGE_MANIFEST_RELATIVE_PATH.as_posix()
    if manifest_relative not in managed_paths:
        managed_paths.append(manifest_relative)

    manifest_path = stage_dir / manifest_relative
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(
        json.dumps(
            {
                "version": version,
                "managed_paths": managed_paths,
                "model_artifact_policy": build_model_artifact_policy(
                    managed_paths,
                    include_model_payloads=include_model_payloads,
                ),
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    return manifest_path


def create_zip_with_python(source_dir: Path, archive_path: Path) -> None:
    with ZipFile(archive_path, "w", compression=ZIP_DEFLATED, compresslevel=6, allowZip64=True) as zf:
        for file_path in sorted(source_dir.rglob("*")):
            if file_path.is_dir():
                continue
            zf.write(file_path, file_path.relative_to(source_dir))


def create_zip(source_dir: Path, archive_path: Path, seven_zip: Path | None) -> None:
    if archive_path.exists():
        archive_path.unlink()
    if seven_zip:
        subprocess.run(
            [
                str(seven_zip),
                "a",
                "-tzip",
                str(archive_path),
                str(source_dir / "*"),
            ],
            check=True,
            cwd=ROOT,
        )
        return
    create_zip_with_python(source_dir, archive_path)


def create_split_zip(source_file: Path, archive_path: Path, split_size_mb: int, seven_zip: Path) -> list[Path]:
    for existing in archive_path.parent.glob(archive_path.name + "*"):
        existing.unlink()
    subprocess.run(
        [
            str(seven_zip),
            "a",
            "-tzip",
            "-mx=0",
            f"-v{split_size_mb}m",
            str(archive_path),
            str(source_file),
        ],
        check=True,
        cwd=ROOT,
    )
    return sorted(archive_path.parent.glob(archive_path.name + "*"))


def sha256sum(file_path: Path) -> str:
    digest = hashlib.sha256()
    with file_path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(DOWNLOAD_CHUNK_SIZE), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download_file(url: str, dest: Path, *, expected_sha256: str | None = None) -> None:
    """Download a file from a URL to a local path with optional hash verification."""
    print(f"[release] Downloading {url} ...")
    dest.parent.mkdir(parents=True, exist_ok=True)
    normalized_expected = str(expected_sha256 or "").strip().lower()

    if dest.exists():
        if normalized_expected:
            existing_hash = sha256sum(dest)
            if existing_hash == normalized_expected:
                print(f"[release] Reusing verified download at {dest}")
                return
            print(f"[release] Existing file hash mismatch for {dest.name}; re-downloading.")
        else:
            print(f"[release] Reusing existing download at {dest}")
            return

    tmp_dest = dest.with_name(dest.name + ".tmp")
    if tmp_dest.exists():
        tmp_dest.unlink()

    digest = hashlib.sha256()
    request = urllib.request.Request(url, headers=DOWNLOAD_HEADERS)
    try:
        with urllib.request.urlopen(request, timeout=DOWNLOAD_TIMEOUT_SECONDS) as response, tmp_dest.open("wb") as handle:
            while True:
                chunk = response.read(DOWNLOAD_CHUNK_SIZE)
                if not chunk:
                    break
                handle.write(chunk)
                digest.update(chunk)
        actual_hash = digest.hexdigest()
        if normalized_expected and actual_hash != normalized_expected:
            raise RuntimeError(
                f"Downloaded file checksum mismatch for {dest.name}: "
                f"expected {normalized_expected}, got {actual_hash}"
            )
        tmp_dest.replace(dest)
    finally:
        if tmp_dest.exists():
            tmp_dest.unlink()
    print(f"[release] Downloaded to {dest} ({dest.stat().st_size / 1024 / 1024:.1f} MB)")


def write_portable_launcher(stage_dir: Path) -> Path:
    """Write the Windows portable launcher with deterministic CRLF endings."""
    portable_bat = stage_dir / "run-portable.bat"
    with portable_bat.open("w", encoding="utf-8", newline="\r\n") as handle:
        handle.write(
            "@echo off\n"
            "setlocal enabledelayedexpansion\n"
            "\n"
            "echo ==========================================\n"
            "echo    SD Image Sorter - Portable Launch\n"
            "echo ==========================================\n"
            "echo.\n"
            "\n"
            "set \"ROOT_DIR=%~dp0\"\n"
            "cd /d \"!ROOT_DIR!\"\n"
            "\n"
            "set \"DATA_DIR=!ROOT_DIR!data\"\n"
            "set \"UPDATE_DIR=!ROOT_DIR!update\"\n"
            "set \"TMP_DIR=!DATA_DIR!\\tmp\"\n"
            "set \"CACHE_DIR=!DATA_DIR!\\cache\"\n"
            "set \"MODELS_DIR=!DATA_DIR!\\models\"\n"
            "set \"FAVORITES_DIR=!DATA_DIR!\\favorites\"\n"
            "set \"CONFIG_DIR=!DATA_DIR!\\config\"\n"
            "set \"STATE_DIR=!DATA_DIR!\\state\"\n"
            "set \"THUMBNAIL_DIR=!DATA_DIR!\\thumbnails\"\n"
            "for %%D in (\"!DATA_DIR!\" \"!UPDATE_DIR!\" \"!TMP_DIR!\" \"!CACHE_DIR!\" \"!MODELS_DIR!\" \"!FAVORITES_DIR!\" \"!CONFIG_DIR!\" \"!STATE_DIR!\" \"!THUMBNAIL_DIR!\") do (\n"
            "    if not exist \"%%~D\" mkdir \"%%~D\"\n"
            ")\n"
            "set \"SD_IMAGE_SORTER_LAUNCHER=run-portable.bat\"\n"
            "set \"SD_IMAGE_SORTER_DATA_DIR=!DATA_DIR!\"\n"
            "set \"SD_IMAGE_SORTER_CONFIG_DIR=!CONFIG_DIR!\"\n"
            "set \"SD_IMAGE_SORTER_STATE_DIR=!STATE_DIR!\"\n"
            "set \"SD_IMAGE_SORTER_TMP_DIR=!TMP_DIR!\"\n"
            "set \"SD_IMAGE_SORTER_UPDATE_DIR=!UPDATE_DIR!\"\n"
            "set \"SD_IMAGE_SORTER_THUMBNAIL_DIR=!THUMBNAIL_DIR!\"\n"
            "set \"SD_IMAGE_SORTER_DB_PATH=!DATA_DIR!\\images.db\"\n"
            "set \"SD_IMAGE_SORTER_FAVORITES_PATH=!FAVORITES_DIR!\"\n"
            "set \"SD_IMAGE_SORTER_WD14_MODEL_DIR=!MODELS_DIR!\\wd14-tagger\"\n"
            "set \"SD_IMAGE_SORTER_YOLO_MODEL_DIR=!MODELS_DIR!\\yolo\"\n"
            "set \"SD_IMAGE_SORTER_CLIP_MODEL_DIR=!MODELS_DIR!\\clip\"\n"
            "set \"SD_IMAGE_SORTER_ARTIST_MODEL_DIR=!MODELS_DIR!\\artist\"\n"
            "set \"SD_IMAGE_SORTER_SAM3_MODEL_DIR=!MODELS_DIR!\\sam3\"\n"
            "set \"SD_IMAGE_SORTER_NUDENET_MODEL_DIR=!MODELS_DIR!\\nudenet\"\n"
            "set \"SD_IMAGE_SORTER_TORIIGATE_MODEL_DIR=!MODELS_DIR!\\toriigate\"\n"
            "set \"SD_IMAGE_SORTER_CACHE_DIR=!CACHE_DIR!\"\n"
            "set \"HF_HOME=!DATA_DIR!\\hf\"\n"
            "set \"TRANSFORMERS_CACHE=!DATA_DIR!\\hf\\transformers\"\n"
            "set \"XDG_CACHE_HOME=!CACHE_DIR!\"\n"
            "set \"TORCH_HOME=!DATA_DIR!\\torch\"\n"
            "set \"PIP_CACHE_DIR=!DATA_DIR!\\pip-cache\"\n"
            "set \"TEMP=!TMP_DIR!\"\n"
            "set \"TMP=!TMP_DIR!\"\n"
            "\n"
            "set \"PYTHON_DIR=!ROOT_DIR!python\"\n"
            "set \"PYTHON_CMD=!PYTHON_DIR!\\python.exe\"\n"
            "set \"PIP_CMD=!PYTHON_DIR!\\Scripts\\pip.exe\"\n"
            "\n"
            "if not exist \"!PYTHON_CMD!\" (\n"
            "    echo [ERROR] Embedded Python not found at !PYTHON_CMD!\n"
            "    echo         Please re-download the portable package.\n"
            "    pause\n"
            "    exit /b 1\n"
            ")\n"
            "\n"
            "REM -- Put embedded Python and its Scripts on PATH so DLLs and\n"
            "REM    compiled extensions (numpy, pillow, onnxruntime) resolve.\n"
            "set \"PATH=!PYTHON_DIR!;!PYTHON_DIR!\\Scripts;!PYTHON_DIR!\\Lib\\site-packages;%PATH%\"\n"
            "\n"
            "echo [OK] Using embedded Python: !PYTHON_CMD!\n"
            "\n"
            "REM -- If Feature Setup requested a lightweight runtime reset, clear only pip-installed packages.\n"
            "set \"RUNTIME_REBUILD_MARKER=!STATE_DIR!\\rebuild-core-venv.json\"\n"
            "if exist \"!RUNTIME_REBUILD_MARKER!\" (\n"
            "    echo [INFO] Lightweight runtime rebuild requested.\n"
            "    echo        Clearing embedded Python packages only; data, images.db, models, and caches stay untouched.\n"
            "    if exist \"!PYTHON_DIR!\\Lib\\site-packages\" rmdir /s /q \"!PYTHON_DIR!\\Lib\\site-packages\"\n"
            "    if exist \"!PYTHON_DIR!\\Lib\\site-packages\" (\n"
            "        echo [ERROR] Could not clear embedded Python site-packages.\n"
            "        echo         Close every SD Image Sorter / Python window, then run run-portable.bat again.\n"
            "        pause\n"
            "        exit /b 1\n"
            "    )\n"
            "    if exist \"!PYTHON_DIR!\\Scripts\" rmdir /s /q \"!PYTHON_DIR!\\Scripts\"\n"
            "    if exist \"!PYTHON_DIR!\\Scripts\" (\n"
            "        echo [ERROR] Could not clear embedded Python Scripts.\n"
            "        echo         Close every SD Image Sorter / Python window, then run run-portable.bat again.\n"
            "        pause\n"
            "        exit /b 1\n"
            "    )\n"
            "    if exist \"backend\\.requirements_hash\" del \"backend\\.requirements_hash\" >nul 2>&1\n"
            "    del \"!RUNTIME_REBUILD_MARKER!\" >nul 2>&1\n"
            "    echo        Core runtime packages will be reinstalled now.\n"
            "    echo.\n"
            ")\n"
            "\n"
            "REM -- Install pip if not present\n"
            "if not exist \"!PIP_CMD!\" (\n"
            "    echo [INFO] Installing pip...\n"
            "    \"!PYTHON_CMD!\" \"!PYTHON_DIR!\\get-pip.py\" --no-warn-script-location\n"
            "    if errorlevel 1 (\n"
            "        echo [ERROR] Failed to install pip.\n"
            "        pause\n"
            "        exit /b 1\n"
            "    )\n"
            ")\n"
            "\n"
            "REM -- Install dependencies\n"
            "set NEED_INSTALL=0\n"
            "set \"NEW_HASH=\"\n"
            "set \"OLD_HASH=\"\n"
            "\n"
            "if not exist \"backend\\.requirements_hash\" (\n"
            "    set NEED_INSTALL=1\n"
            ") else (\n"
            "    where certutil >nul 2>&1\n"
            "    if errorlevel 1 (\n"
            "        echo [INFO] certutil not found. Refreshing dependencies to stay in sync.\n"
            "        set NEED_INSTALL=1\n"
            "    ) else (\n"
            "        set \"INSTALL_REQUIREMENTS=backend\\requirements-core.txt\"\n"
            "        if \"!SD_IMAGE_SORTER_INSTALL_FULL_AI!\"==\"1\" set \"INSTALL_REQUIREMENTS=backend\\requirements.txt\"\n"
            "        for /f \"skip=1 tokens=* delims=\" %%H in ('certutil -hashfile \"!INSTALL_REQUIREMENTS!\" MD5 ^| findstr /r /v \"hash of file CertUtil\"') do (\n"
            "            if not defined NEW_HASH set \"NEW_HASH=%%H\"\n"
            "        )\n"
            "        set \"NEW_HASH=!NEW_HASH: =!\"\n"
            "        set /p OLD_HASH=<backend\\.requirements_hash\n"
            "        if /I not \"!NEW_HASH!\"==\"!OLD_HASH!\" (\n"
            "            echo [INFO] !INSTALL_REQUIREMENTS! changed. Updating embedded dependencies...\n"
            "            set NEED_INSTALL=1\n"
            "        )\n"
            "    )\n"
            ")\n"
            "\n"
            "if !NEED_INSTALL! EQU 0 (\n"
            "    \"!PYTHON_CMD!\" -c \"import fastapi, PIL, numpy, onnxruntime\" >nul 2>&1\n"
            "    if errorlevel 1 (\n"
            "        echo [INFO] Embedded packages look incomplete or inconsistent. Reinstalling dependencies...\n"
            "        set NEED_INSTALL=1\n"
            "    )\n"
            ")\n"
            "\n"
            "if !NEED_INSTALL! EQU 1 (\n"
            "    echo [INFO] Preparing Python build tools for source-only packages...\n"
            "    \"!PYTHON_CMD!\" backend\\launcher_pip.py install setuptools wheel --no-warn-script-location\n"
            "    if errorlevel 1 (\n"
            "        echo [ERROR] Failed to install Python build tools.\n"
            "        pause\n"
            "        exit /b 1\n"
            "    )\n"
            "    set \"INSTALL_REQUIREMENTS=backend\\requirements-core.txt\"\n"
            "    if \"!SD_IMAGE_SORTER_INSTALL_FULL_AI!\"==\"1\" set \"INSTALL_REQUIREMENTS=backend\\requirements.txt\"\n"
            "    if \"!SD_IMAGE_SORTER_INSTALL_FULL_AI!\"==\"1\" (\n"
            "        echo [INFO] Installing full AI runtime dependencies - first run may take a while...\n"
            "    ) else (\n"
            "        echo [INFO] Installing lightweight core dependencies. Heavy AI packages install on Prepare.\n"
            "    )\n"
            "    \"!PYTHON_CMD!\" backend\\launcher_pip.py install --no-build-isolation -r \"!INSTALL_REQUIREMENTS!\" --no-warn-script-location\n"
            "    if errorlevel 1 (\n"
            "        echo [ERROR] Failed to install dependencies.\n"
            "        pause\n"
            "        exit /b 1\n"
            "    )\n"
            "    if not defined NEW_HASH (\n"
            "        where certutil >nul 2>&1\n"
            "        if not errorlevel 1 (\n"
            "            for /f \"skip=1 tokens=* delims=\" %%H in ('certutil -hashfile \"!INSTALL_REQUIREMENTS!\" MD5 ^| findstr /r /v \"hash of file CertUtil\"') do (\n"
            "                if not defined NEW_HASH set \"NEW_HASH=%%H\"\n"
            "            )\n"
            "            set \"NEW_HASH=!NEW_HASH: =!\"\n"
            "        )\n"
            "    )\n"
            "    if defined NEW_HASH (\n"
            "        > backend\\.requirements_hash echo !NEW_HASH!\n"
            "    ) else (\n"
            "        > backend\\.requirements_hash echo installed\n"
            "    )\n"
            "    echo [OK] Dependencies installed.\n"
            ")\n"
            "\n"
            "echo [Info] Checking Windows ONNX Runtime package state...\n"
            "\"!PYTHON_CMD!\" backend\\repair_onnxruntime.py --auto\n"
            "if errorlevel 1 (\n"
            "    echo [WARN] Could not auto-repair ONNX Runtime package state.\n"
            "    echo        The app can still start, but WD14 tagging may stay on CPU.\n"
            ")\n"
            "echo.\n"
            "\n"
            "if \"!SD_IMAGE_SORTER_INSTALL_FULL_AI!\"==\"1\" (\n"
            "    echo [Info] Checking Windows PyTorch / SAM3 runtime package state...\n"
            "    \"!PYTHON_CMD!\" backend\\repair_torch_runtime.py --auto\n"
            "    if errorlevel 1 (\n"
            "        echo [WARN] Could not auto-repair PyTorch / SAM3 runtime package state.\n"
            "        echo        The app can still start, but SAM3 and CUDA Torch features may stay unavailable.\n"
            "    )\n"
            ") else (\n"
            "    echo [Info] Skipping Windows PyTorch / SAM3 repair for lightweight startup.\n"
            "    echo        Set SD_IMAGE_SORTER_INSTALL_FULL_AI=1 or use Model Manager Prepare when needed.\n"
            ")\n"
            "echo.\n"
            "\n"
            "echo [Info] Checking startup readiness...\n"
            "pushd backend\n"
            "\"!PYTHON_CMD!\" model_health.py --startup\n"
            "popd\n"
            "echo.\n"
            "\n"
            "REM -- Honor SD_IMAGE_SORTER_PORT override for the browser URL; default 8487.\n"
            "set \"APP_PORT=!SD_IMAGE_SORTER_PORT!\"\n"
            "if \"!APP_PORT!\"==\"\" set \"APP_PORT=8487\"\n"
            "set \"PORT_ENV_FILE=!TEMP!\\sd-image-sorter-port-!RANDOM!.tmp\"\n"
            "\"!PYTHON_CMD!\" backend\\launcher_port.py --format cmd > \"!PORT_ENV_FILE!\"\n"
            "set \"PORT_CHECK_EXIT=!ERRORLEVEL!\"\n"
            "for /f \"usebackq tokens=1,* delims==\" %%A in (\"!PORT_ENV_FILE!\") do (\n"
            "    set \"%%A=%%B\"\n"
            ")\n"
            "del \"!PORT_ENV_FILE!\" >nul 2>&1\n"
            "if \"!SD_IMAGE_SORTER_PORT_STATUS!\"==\"\" (\n"
            "    echo [ERROR] Could not check localhost port availability.\n"
            "    pause\n"
            "    exit /b 1\n"
            ")\n"
            "if /I \"!SD_IMAGE_SORTER_PORT_STATUS!\"==\"error\" (\n"
            "    echo [ERROR] !SD_IMAGE_SORTER_PORT_MESSAGE!\n"
            "    echo.\n"
            "    echo If Windows reserved port !APP_PORT!, either reboot or run:\n"
            "    echo   netsh interface ipv4 show excludedportrange protocol=tcp\n"
            "    echo Then choose another port, for example:\n"
            "    echo   set SD_IMAGE_SORTER_PORT=8587\n"
            "    echo   run-portable.bat\n"
            "    pause\n"
            "    exit /b 1\n"
            ")\n"
            "if not \"!PORT_CHECK_EXIT!\"==\"0\" (\n"
            "    echo [ERROR] Could not check localhost port availability.\n"
            "    pause\n"
            "    exit /b 1\n"
            ")\n"
            "set \"APP_PORT=!SD_IMAGE_SORTER_PORT!\"\n"
            "set \"APP_URL_HOST=!SD_IMAGE_SORTER_URL_HOST!\"\n"
            "if \"!APP_URL_HOST!\"==\"\" set \"APP_URL_HOST=127.0.0.1\"\n"
            "if /I \"!SD_IMAGE_SORTER_PORT_STATUS!\"==\"changed\" (\n"
            "    echo [WARN] !SD_IMAGE_SORTER_PORT_MESSAGE!\n"
            ")\n"
            "set \"APP_URL=http://!APP_URL_HOST!:!APP_PORT!\"\n"
            "\n"
            "echo.\n"
            "echo ==========================================\n"
            "echo   SD Image Sorter is starting!\n"
            "echo.\n"
            "echo   Open browser: !APP_URL!\n"
            "echo   Press Ctrl+C to stop the server.\n"
            "echo ==========================================\n"
            "echo.\n"
            "\n"
            "REM -- Open browser after server is ready (background probe)\n"
            "start /b \"\" powershell -NoProfile -WindowStyle Hidden -Command ^\n"
            "    \"$url='!APP_URL!'; for($i=0;$i -lt 30;$i++){try{Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop|Out-Null;Start-Process $url;exit}catch{Start-Sleep -Milliseconds 500}}\" >nul 2>&1\n"
            "\n"
            "cd backend\n"
            "\"!PYTHON_CMD!\" main.py --port !APP_PORT!\n"
            "set \"SERVER_EXIT_CODE=!ERRORLEVEL!\"\n"
            "\n"
            "echo.\n"
            "echo ==========================================\n"
            "if \"!SERVER_EXIT_CODE!\"==\"0\" (\n"
            "    echo   Server stopped normally.\n"
            ") else (\n"
            "    echo   [ERROR] Server exited with code !SERVER_EXIT_CODE!.\n"
            "    echo           If startup failed immediately, check whether another SD Image Sorter window is already using port !APP_PORT!.\n"
            "    echo           You can run fix.bat for port/runtime diagnostics.\n"
            ")\n"
            "echo ==========================================\n"
            "pause\n"
        )
    return portable_bat


def prepare_embedded_python(stage_dir: Path) -> None:
    """Download and prepare an embedded Python for portable distribution."""
    python_dir = stage_dir / "python"
    python_dir.mkdir(parents=True, exist_ok=True)

    # Download embeddable Python
    embed_zip = BOOTSTRAP_DOWNLOAD_ROOT / f"python-{PYTHON_EMBED_VERSION}-embed-amd64.zip"
    download_file(PYTHON_EMBED_URL, embed_zip, expected_sha256=PYTHON_EMBED_SHA256)

    # Extract
    import zipfile
    with zipfile.ZipFile(embed_zip, "r") as zf:
        zf.extractall(python_dir)

    # Enable pip and add Lib\site-packages to the search path in python3XX._pth.
    # Embedded Python only searches paths listed in the ._pth file; without the
    # explicit site-packages entry, pip-installed packages are invisible.
    pth_files = list(python_dir.glob("python*._pth"))
    for pth_file in pth_files:
        content = pth_file.read_text(encoding="utf-8")
        content = content.replace("#import site", "import site")
        # Ensure Lib\site-packages is on the search path
        if "Lib\\site-packages" not in content and "Lib/site-packages" not in content:
            content = content.rstrip("\r\n") + "\nLib\\site-packages\n"
        pth_file.write_text(content, encoding="utf-8")

    # Download get-pip.py
    get_pip = python_dir / "get-pip.py"
    download_file(GET_PIP_URL, get_pip, expected_sha256=GET_PIP_SHA256)

    # Keep exact CRLF endings for cmd.exe; newline translation can corrupt batch files.
    write_portable_launcher(stage_dir)


def stage_archive(name: str, version: str, seven_zip: Path | None, *, populate) -> Path:
    stage_dir = STAGING_ROOT / name
    if stage_dir.exists():
        shutil.rmtree(stage_dir)
    stage_dir.mkdir(parents=True, exist_ok=True)
    populate(stage_dir)

    archive_name = f"sd-image-sorter-v{version}-{name}.zip"
    archive_path = ARTIFACT_ROOT / archive_name
    create_zip(stage_dir, archive_path, seven_zip)
    return archive_path


def build_release_assets(version: str, split_size_mb: int) -> list[Path]:
    seven_zip = find_seven_zip()
    if ARTIFACT_ROOT.exists():
        shutil.rmtree(ARTIFACT_ROOT)
    STAGING_ROOT.mkdir(parents=True, exist_ok=True)

    assets: list[Path] = []

    # === Windows portable: app + embedded Python, no models (auto-download) ===
    def populate_windows_portable(stage_dir: Path) -> None:
        copy_project(stage_dir)
        write_release_notes(stage_dir, version)
        prepare_embedded_python(stage_dir)
        write_package_manifest(stage_dir, version)

    assets.append(stage_archive("windows-portable", version, seven_zip, populate=populate_windows_portable))

    # === Linux: app only, no models, no Python (uses system Python) ===
    def populate_linux(stage_dir: Path) -> None:
        copy_project(stage_dir)
        write_release_notes(stage_dir, version)
        write_package_manifest(stage_dir, version)

    # === App patch: app files only, safe for in-app updater ===
    def populate_app_patch(stage_dir: Path) -> None:
        copy_project(stage_dir)
        write_release_notes(stage_dir, version)
        write_portable_launcher(stage_dir)
        write_package_manifest(stage_dir, version)

    assets.append(stage_archive("app-patch", version, seven_zip, populate=populate_app_patch))

    # Build as tar.gz for Linux
    linux_stage = STAGING_ROOT / "linux"
    if linux_stage.exists():
        shutil.rmtree(linux_stage)
    linux_stage.mkdir(parents=True, exist_ok=True)
    populate_linux(linux_stage)

    import tarfile
    tar_name = f"sd-image-sorter-v{version}-linux.tar.gz"
    tar_path = ARTIFACT_ROOT / tar_name
    with tarfile.open(tar_path, "w:gz") as tar:
        tar.add(linux_stage, arcname="sd-image-sorter")
    assets.append(tar_path)

    manifest_entries = []
    for asset in assets:
        manifest_entries.append(
            {
                "name": asset.name,
                "size_bytes": asset.stat().st_size,
                "sha256": sha256sum(asset),
            }
        )

    manifest_path = ARTIFACT_ROOT / f"sd-image-sorter-v{version}-release-manifest.json"
    manifest_path.write_text(json.dumps({"version": version, "assets": manifest_entries}, indent=2), encoding="utf-8")
    assets.append(manifest_path)
    shutil.rmtree(STAGING_ROOT, ignore_errors=True)
    return assets


def main() -> int:
    args = parse_args()
    try:
        assets = build_release_assets(args.version, args.split_size_mb)
    except Exception as exc:  # pragma: no cover - release script should fail loudly
        print(f"[release] FAILED: {exc}", file=sys.stderr)
        return 1

    print("[release] Built assets:")
    for asset in assets:
        print(f"  - {asset.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
