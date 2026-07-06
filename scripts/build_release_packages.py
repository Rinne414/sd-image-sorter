#!/usr/bin/env python3
"""Build release archives for SD Image Sorter."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import traceback
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

# python-build-standalone (Astral) for Linux portable bundle.
# We pick the baseline ``x86_64-unknown-linux-gnu`` variant (33 MB) instead
# of the v2/v3/v4 micro-arch variants so the bundle runs on every x86_64
# CPU. The build links against an old enough glibc (2.17) that the same
# tarball works on RHEL 7 / Ubuntu 18.04 / Debian 9 and newer, which covers
# every distro we have ever shipped to. We pin to a specific PBS release
# date for reproducibility; bump these constants together when rolling
# forward.
#
# Phase 2 adds aarch64 alongside x86_64. Both architectures share the
# same PBS tag + cpython version so the bundle behaves identically across
# Raspberry Pi 5, ARM Linux servers, AWS Graviton, Apple Silicon under
# Linux, and traditional desktops/laptops.
LINUX_PORTABLE_PYTHON_PBS_TAG = "20260510"
LINUX_PORTABLE_PYTHON_VERSION = "3.13.13"

# Per-architecture bundle specs. Each entry is keyed by the asset name
# suffix (matches the `linux-portable-{arch}.tar.gz` artifact name) and
# carries the PBS triple, the public download URL, and the SHA256 we
# verify against before unpacking.
LINUX_PORTABLE_PYTHON_BUNDLES: dict[str, dict[str, str]] = {
    "x86_64": {
        "pbs_triple": "x86_64-unknown-linux-gnu",
        "url": (
            f"https://github.com/astral-sh/python-build-standalone/releases/download/"
            f"{LINUX_PORTABLE_PYTHON_PBS_TAG}/cpython-{LINUX_PORTABLE_PYTHON_VERSION}+"
            f"{LINUX_PORTABLE_PYTHON_PBS_TAG}-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz"
        ),
        "sha256": "bbe27549e475fe5f22d42a8e0d553dc79d80d8a00e05712599637857d287360e",
    },
    "aarch64": {
        "pbs_triple": "aarch64-unknown-linux-gnu",
        "url": (
            f"https://github.com/astral-sh/python-build-standalone/releases/download/"
            f"{LINUX_PORTABLE_PYTHON_PBS_TAG}/cpython-{LINUX_PORTABLE_PYTHON_VERSION}+"
            f"{LINUX_PORTABLE_PYTHON_PBS_TAG}-aarch64-unknown-linux-gnu-install_only_stripped.tar.gz"
        ),
        "sha256": "67c837838c56a7d16187d1be9fad326a617e0b1ee2687e1a0dda0c85053dac33",
    },
}

# Backwards-compat aliases. These are kept so older imports (and the v3.2.2
# release-build tests) keep working until the fields above are referenced
# directly everywhere. New code should use ``LINUX_PORTABLE_PYTHON_BUNDLES``.
LINUX_PORTABLE_PYTHON_URL = LINUX_PORTABLE_PYTHON_BUNDLES["x86_64"]["url"]
LINUX_PORTABLE_PYTHON_SHA256 = LINUX_PORTABLE_PYTHON_BUNDLES["x86_64"]["sha256"]
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
    # Internal working artifacts at the repo root — leaked into v3.5.0's
    # first build, caught by the pre-release package QA. (Prefixes match
    # whole path segments; loose root files go in EXCLUDED_FILES below.)
    "design_handoff_extract",
    "artifacts",
    "data",
    "backend/data",
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
    # Root-level working files that are not product content. (The packaged
    # release-notes.md is regenerated by write_release_notes; this entry only
    # blocks the stale repo-root copy from being swept in first.)
    "release-notes.md",
    "SD image sorter redesign.zip",
    "claude-code-sd-image-sorter-tagger-audit.md",
    "claude-code-sd-image-sorter-tagger-audit-REPORT.md",
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


def _remove_windows_only_files(stage_dir: Path) -> None:
    """Remove .bat files and other Windows-only artifacts from a Linux stage."""
    for bat in stage_dir.glob("*.bat"):
        bat.unlink()


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
            "REM -- Ask the backend to open the browser once it is ready (in-process).\n"
            "REM -- The launcher no longer spawns a hidden helper that makes HTTP calls\n"
            "REM -- in a loop, which some antivirus engines flag as suspicious behavior.\n"
            "set \"SD_IMAGE_SORTER_OPEN_BROWSER=1\"\n"
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


def write_linux_portable_launcher(stage_dir: Path) -> Path:
    """Write run-portable.sh with deterministic LF endings + executable bits.

    Mirrors run-portable.bat semantics for Linux:
    - Uses bundled Python from <root>/python/bin/python3
    - Same data layout (data/, update/, ...)
    - Same hash-based reinstall flow + lightweight rebuild marker
    - Same lightweight default + optional SD_IMAGE_SORTER_INSTALL_FULL_AI=1
    - Hands the running terminal off to ``main.py`` (no daemonization;
      Ctrl+C stays the natural stop signal, matching run.sh).

    The script is written with LF line endings only because /bin/sh on
    Linux refuses to parse CRLF heredocs — a CRLF here would surface as
    "$'\\r': command not found" on the user's terminal.
    """
    portable_sh = stage_dir / "run-portable.sh"
    body = """#!/usr/bin/env bash
# SD Image Sorter - Linux portable launcher.
# Uses the bundled Python under ./python/bin/python3, so the host distro's
# system Python (or its absence) does not matter. To run from source on a
# developer machine, use run.sh instead.
set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
cd "$ROOT_DIR"

DATA_DIR="$ROOT_DIR/data"
UPDATE_DIR="$ROOT_DIR/update"
TMP_DIR="$DATA_DIR/tmp"
CACHE_DIR="$DATA_DIR/cache"
MODELS_DIR="$DATA_DIR/models"
FAVORITES_DIR="$DATA_DIR/favorites"
CONFIG_DIR="$DATA_DIR/config"
STATE_DIR="$DATA_DIR/state"
THUMBNAIL_DIR="$DATA_DIR/thumbnails"
mkdir -p "$DATA_DIR" "$UPDATE_DIR" "$TMP_DIR" "$CACHE_DIR" \\
    "$MODELS_DIR" "$FAVORITES_DIR" "$CONFIG_DIR" "$STATE_DIR" "$THUMBNAIL_DIR"

export SD_IMAGE_SORTER_LAUNCHER="run-portable.sh"
export SD_IMAGE_SORTER_DATA_DIR="$DATA_DIR"
export SD_IMAGE_SORTER_CONFIG_DIR="$CONFIG_DIR"
export SD_IMAGE_SORTER_STATE_DIR="$STATE_DIR"
export SD_IMAGE_SORTER_TMP_DIR="$TMP_DIR"
export SD_IMAGE_SORTER_UPDATE_DIR="$UPDATE_DIR"
export SD_IMAGE_SORTER_THUMBNAIL_DIR="$THUMBNAIL_DIR"
export SD_IMAGE_SORTER_DB_PATH="$DATA_DIR/images.db"
export SD_IMAGE_SORTER_FAVORITES_PATH="$FAVORITES_DIR"
export SD_IMAGE_SORTER_WD14_MODEL_DIR="$MODELS_DIR/wd14-tagger"
export SD_IMAGE_SORTER_YOLO_MODEL_DIR="$MODELS_DIR/yolo"
export SD_IMAGE_SORTER_CLIP_MODEL_DIR="$MODELS_DIR/clip"
export SD_IMAGE_SORTER_ARTIST_MODEL_DIR="$MODELS_DIR/artist"
export SD_IMAGE_SORTER_SAM3_MODEL_DIR="$MODELS_DIR/sam3"
export SD_IMAGE_SORTER_NUDENET_MODEL_DIR="$MODELS_DIR/nudenet"
export SD_IMAGE_SORTER_TORIIGATE_MODEL_DIR="$MODELS_DIR/toriigate"
export SD_IMAGE_SORTER_CACHE_DIR="$CACHE_DIR"
export HF_HOME="$DATA_DIR/hf"
export TRANSFORMERS_CACHE="$DATA_DIR/hf/transformers"
export XDG_CACHE_HOME="$CACHE_DIR"
export TORCH_HOME="$DATA_DIR/torch"
export PIP_CACHE_DIR="$DATA_DIR/pip-cache"
export TMPDIR="$TMP_DIR"

echo "=========================================="
echo "   SD Image Sorter - Portable Launch (Linux)"
echo "=========================================="
echo

PYTHON_DIR="$ROOT_DIR/python"
PYTHON_CMD="$PYTHON_DIR/bin/python3"
if [ ! -x "$PYTHON_CMD" ]; then
    echo "[ERROR] Bundled Python not found or not executable at $PYTHON_CMD" >&2
    echo "        Re-extract the linux-portable archive (preserve permissions)." >&2
    exit 1
fi

# Make pip-installed entry points runnable without LD_LIBRARY_PATH dance.
# python-build-standalone uses RPATH so the interpreter finds its own libs.
export PATH="$PYTHON_DIR/bin:$PATH"

echo "[OK] Using bundled Python: $PYTHON_CMD"
"$PYTHON_CMD" --version

# Lightweight runtime rebuild marker (Setup Now -> Rebuild lightweight runtime).
# Mirrors run-portable.bat: only clears installed Python packages, never
# deletes data/, models, settings, or images.db.
RUNTIME_REBUILD_MARKER="$STATE_DIR/rebuild-core-venv.json"
if [ -f "$RUNTIME_REBUILD_MARKER" ]; then
    echo "[INFO] Lightweight runtime rebuild requested."
    echo "       Clearing bundled Python packages only; data, images.db, models, and caches stay untouched."
    SITE_PACKAGES="$PYTHON_DIR/lib/python3.13/site-packages"
    if [ -d "$SITE_PACKAGES" ]; then
        # Keep the standard library shims pip needs (pip, setuptools, wheel
        # land here on first install). Wiping the directory is fine: first
        # run will reinstall pip via ensurepip.
        rm -rf "$SITE_PACKAGES"
        mkdir -p "$SITE_PACKAGES"
    fi
    rm -f "$ROOT_DIR/backend/.requirements_hash" "$RUNTIME_REBUILD_MARKER"
    echo "       Core runtime packages will be reinstalled now."
    echo
fi

# Install pip if missing (python-build-standalone ships ensurepip).
if ! "$PYTHON_CMD" -c "import pip" >/dev/null 2>&1; then
    echo "[INFO] Bootstrapping pip via ensurepip..."
    "$PYTHON_CMD" -m ensurepip --upgrade --default-pip || {
        echo "[ERROR] ensurepip failed." >&2
        exit 1
    }
fi

INSTALL_REQUIREMENTS="backend/requirements-core.txt"
if [ "${SD_IMAGE_SORTER_INSTALL_FULL_AI:-0}" = "1" ]; then
    INSTALL_REQUIREMENTS="backend/requirements.txt"
fi

NEED_INSTALL=0
NEW_HASH=""
OLD_HASH=""

if [ ! -f "backend/.requirements_hash" ]; then
    NEED_INSTALL=1
elif command -v sha256sum >/dev/null 2>&1; then
    NEW_HASH="$(sha256sum "$INSTALL_REQUIREMENTS" | awk '{print $1}')"
    OLD_HASH="$(cat backend/.requirements_hash 2>/dev/null || true)"
    if [ "$NEW_HASH" != "$OLD_HASH" ]; then
        echo "[INFO] $INSTALL_REQUIREMENTS changed. Updating bundled dependencies..."
        NEED_INSTALL=1
    fi
elif command -v shasum >/dev/null 2>&1; then
    NEW_HASH="$(shasum -a 256 "$INSTALL_REQUIREMENTS" | awk '{print $1}')"
    OLD_HASH="$(cat backend/.requirements_hash 2>/dev/null || true)"
    if [ "$NEW_HASH" != "$OLD_HASH" ]; then
        echo "[INFO] $INSTALL_REQUIREMENTS changed. Updating bundled dependencies..."
        NEED_INSTALL=1
    fi
else
    echo "[INFO] sha256sum/shasum not found. Refreshing dependencies to stay in sync."
    NEED_INSTALL=1
fi

if [ "$NEED_INSTALL" = "0" ]; then
    if ! "$PYTHON_CMD" -c "import fastapi, PIL, numpy, onnxruntime" >/dev/null 2>&1; then
        echo "[INFO] Bundled packages look incomplete or inconsistent. Reinstalling..."
        NEED_INSTALL=1
    fi
fi

if [ "$NEED_INSTALL" = "1" ]; then
    echo "[INFO] Preparing Python build tools for source-only packages..."
    "$PYTHON_CMD" -m pip install --upgrade --no-warn-script-location pip setuptools wheel || {
        echo "[ERROR] Failed to install Python build tools." >&2
        exit 1
    }
    if [ "${SD_IMAGE_SORTER_INSTALL_FULL_AI:-0}" = "1" ]; then
        echo "[INFO] Installing full AI runtime dependencies - first run may take a while..."
    else
        echo "[INFO] Installing lightweight core dependencies. Heavy AI packages install on Prepare."
    fi
    "$PYTHON_CMD" -m pip install --no-build-isolation --no-warn-script-location \\
        -r "$INSTALL_REQUIREMENTS" || {
        echo "[ERROR] Failed to install dependencies." >&2
        exit 1
    }
    if [ -z "$NEW_HASH" ] && command -v sha256sum >/dev/null 2>&1; then
        NEW_HASH="$(sha256sum "$INSTALL_REQUIREMENTS" | awk '{print $1}')"
    elif [ -z "$NEW_HASH" ] && command -v shasum >/dev/null 2>&1; then
        NEW_HASH="$(shasum -a 256 "$INSTALL_REQUIREMENTS" | awk '{print $1}')"
    fi
    if [ -n "$NEW_HASH" ]; then
        printf '%s\\n' "$NEW_HASH" > backend/.requirements_hash
    else
        printf 'installed\\n' > backend/.requirements_hash
    fi
    echo "[OK] Dependencies installed."
fi

# ONNX Runtime GPU repair: Linux requirements pin the CPU-only onnxruntime
# (the GPU package cannot be selected by pip markers), so NVIDIA machines need
# this swap to onnxruntime-gpu[cuda,cudnn] for GPU WD14 tagging. Non-NVIDIA
# machines are a fast no-op. Mirrors the unconditional call in the Windows
# portable launcher.
echo "[Info] Checking ONNX Runtime package state..."
"$PYTHON_CMD" backend/repair_onnxruntime.py --auto || {
    echo "[WARN] Could not auto-repair ONNX Runtime package state."
    echo "       The app can still start, but WD14 tagging may stay on CPU."
}
echo

# repair_torch_runtime.py stays Windows-only: Linux CUDA torch wheels are
# already selected at the pip layer by platform markers in requirements.txt.

echo "[Info] Checking startup readiness..."
( cd backend && "$PYTHON_CMD" model_health.py --startup ) || true
echo

APP_PORT="${SD_IMAGE_SORTER_PORT:-8487}"
APP_URL_HOST="${SD_IMAGE_SORTER_URL_HOST:-127.0.0.1}"
APP_URL="http://${APP_URL_HOST}:${APP_PORT}"

cat <<EOF
==========================================
  SD Image Sorter is starting!

  Open browser: $APP_URL
  Press Ctrl+C to stop the server.
==========================================
EOF

# Best-effort browser open: try xdg-open in the background once the server
# is reachable. Failures here are silent (headless / SSH / no display).
(
    for _ in $(seq 1 30); do
        if curl -fsS --max-time 2 "$APP_URL" >/dev/null 2>&1; then
            command -v xdg-open >/dev/null 2>&1 && xdg-open "$APP_URL" >/dev/null 2>&1
            exit 0
        fi
        sleep 0.5
    done
) &

cd backend
exec "$PYTHON_CMD" main.py --port "$APP_PORT"
"""
    portable_sh.write_bytes(body.encode("utf-8"))
    # rwxr-xr-x — script must be executable inside the tarball or users see
    # "permission denied" after extracting.
    portable_sh.chmod(0o755)
    return portable_sh


def prune_bundled_linux_python_for_release(python_dir: Path) -> None:
    """Remove bundled Linux Python files that are unsafe or useless in release archives."""
    # The PBS tarball includes a full terminfo database with many alias
    # symlinks, including a few self-referential entries. They are irrelevant
    # for this browser-based app and can make tarfile.add() fail with
    # ELOOP ("Too many levels of symbolic links") when the release is built
    # from WSL on a Windows-mounted drive. Drop them before re-archiving.
    terminfo_dir = python_dir / "share" / "terminfo"
    if not (terminfo_dir.exists() or terminfo_dir.is_symlink()):
        return

    print(f"[release] Pruning bundled Linux terminfo aliases: {terminfo_dir}")

    def remove_no_follow(path: Path) -> None:
        try:
            with os.scandir(path) as entries:
                for entry in entries:
                    entry_path = Path(entry.path)
                    if entry.is_dir(follow_symlinks=False):
                        remove_no_follow(entry_path)
                        entry_path.rmdir()
                    else:
                        entry_path.unlink(missing_ok=True)
        except NotADirectoryError:
            path.unlink(missing_ok=True)
            return

    remove_no_follow(terminfo_dir)
    terminfo_dir.rmdir()


def is_linux_python_terminfo_member(member_name: str) -> bool:
    normalized = member_name.replace("\\", "/").lstrip("./")
    return normalized == "python/share/terminfo" or normalized.startswith("python/share/terminfo/")


def prepare_bundled_linux_python(stage_dir: Path, arch: str = "x86_64") -> None:
    """Download and extract python-build-standalone into ``<stage_dir>/python``.

    The ``install_only_stripped`` archive expands to a top-level ``python/``
    directory, so unpacking it in ``stage_dir`` yields ``stage_dir/python/
    bin/python3`` as expected by ``run-portable.sh``.

    ``arch`` selects the PBS triple to download. Currently supported:
    ``"x86_64"`` (Phase 1 default) and ``"aarch64"`` (Phase 2 — Raspberry
    Pi 5, AWS Graviton, ARM Linux servers). Both archs share the same
    cpython source so users get the same Python on both platforms.
    """
    bundle = LINUX_PORTABLE_PYTHON_BUNDLES.get(arch)
    if bundle is None:
        raise ValueError(
            f"Unsupported linux-portable arch: {arch!r}. "
            f"Known: {sorted(LINUX_PORTABLE_PYTHON_BUNDLES)}"
        )

    python_dir = stage_dir / "python"
    if python_dir.exists():
        shutil.rmtree(python_dir)

    pbs_triple = bundle["pbs_triple"]
    pbs_archive = (
        BOOTSTRAP_DOWNLOAD_ROOT
        / f"cpython-{LINUX_PORTABLE_PYTHON_VERSION}+{LINUX_PORTABLE_PYTHON_PBS_TAG}-{pbs_triple}-install_only_stripped.tar.gz"
    )
    download_file(
        bundle["url"],
        pbs_archive,
        expected_sha256=bundle["sha256"],
    )

    import tarfile
    with tarfile.open(pbs_archive, "r:gz") as tar:
        # python-build-standalone tarballs only contain a single top-level
        # ``python/`` entry; defensive validation keeps an arbitrarily-named
        # mirror archive from leaking files outside of stage_dir/python/.
        for member in tar.getmembers():
            top = member.name.split("/", 1)[0]
            if top != "python":
                raise RuntimeError(
                    f"Unexpected top-level entry in python-build-standalone tarball: {member.name!r}"
                )
            target = (stage_dir / member.name).resolve()
            try:
                target.relative_to(stage_dir.resolve())
            except ValueError:
                raise RuntimeError(
                    f"Tarball member escapes stage directory: {member.name!r}"
                )
        for member in tar.getmembers():
            if is_linux_python_terminfo_member(member.name):
                continue
            tar.extract(member, stage_dir)

    if not (python_dir / "bin" / "python3").exists():
        raise RuntimeError(
            f"Expected python-build-standalone to drop python/bin/python3 inside {python_dir}"
        )
    prune_bundled_linux_python_for_release(python_dir)


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
        _remove_windows_only_files(stage_dir)
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

    def _linux_source_tar_filter(info):
        """Force Unix mode bits in the source tarball.

        Built on Windows, every file stats as 0o666 with no execute bit, so
        `./run.sh` shipped un-runnable (caught by the v3.5.0 WSL boot QA).
        Same reasoning as ``_portable_tar_filter`` below: re-stamping inside
        the tarball is the only host-OS-independent fix.
        """
        if info.isdir():
            info.mode = 0o755
        elif info.name.endswith("/run.sh") or info.name == "sd-image-sorter/run.sh":
            info.mode = 0o755
        else:
            info.mode = 0o644
        info.uid = 0
        info.gid = 0
        info.uname = ""
        info.gname = ""
        return info

    tar_name = f"sd-image-sorter-v{version}-linux.tar.gz"
    tar_path = ARTIFACT_ROOT / tar_name
    with tarfile.open(tar_path, "w:gz") as tar:
        tar.add(linux_stage, arcname="sd-image-sorter", filter=_linux_source_tar_filter)
    assets.append(tar_path)

    # === Linux portable: app + bundled python-build-standalone, no models ===
    # Same first-run flow as Windows portable (lightweight install on first
    # launch; full AI gated behind SD_IMAGE_SORTER_INSTALL_FULL_AI=1).
    # Lets users on distros without Python 3.12+ in the package manager
    # (or with Python 3.14 as system default before our wheels catch up)
    # run the app without any extra setup.
    #
    # Phase 2 ships TWO architectures: x86_64 (Phase 1 baseline) and
    # aarch64 (Raspberry Pi 5, AWS Graviton, ARM Linux servers, Apple
    # Silicon under Linux). Same cpython 3.13.13 on both, same first-run
    # flow, same lightweight default — only the bundled interpreter
    # binaries differ. Asset naming embeds the arch suffix so the in-app
    # updater can pick the right tarball for the running machine.
    def populate_linux_portable_for_arch(stage_dir: Path, arch: str) -> None:
        copy_project(stage_dir)
        _remove_windows_only_files(stage_dir)
        write_release_notes(stage_dir, version)
        prepare_bundled_linux_python(stage_dir, arch=arch)
        write_linux_portable_launcher(stage_dir)
        write_package_manifest(stage_dir, version)

    def _portable_tar_filter(info):
        """Force Unix mode bits inside the tarball.

        The release build can run on Linux (CI / maintainer Linux box)
        OR on Windows (maintainer dev box). On Windows, file system mode
        bits are effectively 0o666 (no execute), and ``Path.chmod(0o755)``
        is a no-op, so the resulting tarball would land on the user's
        Linux machine with ``run-portable.sh`` and ``python/bin/python3``
        un-runnable. Re-stamping mode bits in the tarball itself is the
        only way to make this build reproducible across host OSes.

        Rules (relative paths inside the tarball):
        - ``sd-image-sorter/run-portable.sh`` → 0o755
        - everything under ``sd-image-sorter/python/bin/`` → 0o755
          (interpreters, pip, pip3, pip3.13, idle, etc.)
        - ``*.so`` / ``*.so.*`` / ``*.dylib`` → 0o755
          (CPython extensions; some loaders refuse non-executable .so)
        - directories → 0o755
        - everything else → 0o644
        """
        name = info.name
        if name == "sd-image-sorter/python/share/terminfo" or name.startswith(
            "sd-image-sorter/python/share/terminfo/"
        ):
            return None
        if info.isdir():
            info.mode = 0o755
            return info
        if name.endswith(("/run-portable.sh", "/run.sh")) or name in (
            "sd-image-sorter/run-portable.sh",
            "sd-image-sorter/run.sh",
        ):
            info.mode = 0o755
        elif "/python/bin/" in name:
            info.mode = 0o755
        elif name.endswith(".so") or ".so." in name or name.endswith(".dylib"):
            info.mode = 0o755
        else:
            info.mode = 0o644
        # uid/gid/uname/gname normalization keeps the archive deterministic
        # (every tar.add() on a developer machine would otherwise embed
        # whoever ran the build).
        info.uid = 0
        info.gid = 0
        info.uname = ""
        info.gname = ""
        return info

    for arch in ("x86_64", "aarch64"):
        linux_portable_stage = STAGING_ROOT / f"linux-portable-{arch}"
        if linux_portable_stage.exists():
            shutil.rmtree(linux_portable_stage)
        linux_portable_stage.mkdir(parents=True, exist_ok=True)
        populate_linux_portable_for_arch(linux_portable_stage, arch)

        linux_portable_tar_name = f"sd-image-sorter-v{version}-linux-portable-{arch}.tar.gz"
        linux_portable_tar_path = ARTIFACT_ROOT / linux_portable_tar_name
        with tarfile.open(linux_portable_tar_path, "w:gz") as tar:
            # Preserve mode bits so python/bin/python3 and run-portable.sh stay
            # executable after the user extracts the tarball.
            tar.add(linux_portable_stage, arcname="sd-image-sorter", filter=_portable_tar_filter)
        assets.append(linux_portable_tar_path)

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
        traceback.print_exc()
        return 1

    print("[release] Built assets:")
    for asset in assets:
        print(f"  - {asset.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
