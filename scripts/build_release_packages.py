#!/usr/bin/env python3
"""Build release archives for SD Image Sorter."""

from __future__ import annotations

import argparse
import hashlib
import json
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
DEFAULT_VERSION = "2.4.0"
DEFAULT_SPLIT_SIZE_MB = 1900

# Python embeddable package URL template (Windows amd64)
PYTHON_EMBED_VERSION = "3.11.9"
PYTHON_EMBED_URL = f"https://www.python.org/ftp/python/{PYTHON_EMBED_VERSION}/python-{PYTHON_EMBED_VERSION}-embed-amd64.zip"
GET_PIP_URL = "https://bootstrap.pypa.io/get-pip.py"

DOC_FILES = {
    "models/README.md",
    "models/yolo/README.md",
    "models/artist/README.md",
    "docs/RELEASE_PACKS.md",
}

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
    "tests",
    "test-results",
    "reference",
    "testimage",
    "example",
    "scripts",
    "docs/DELETION_LOG",
    "docs/IMPROVEMENT_PLAN",
    "docs/SECURITY_ARCHITECTURE",
    "docs/architecture",
)

EXCLUDED_NAMES = {
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".coverage",
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


def should_skip_path(relative_path: Path) -> bool:
    rel = relative_path.as_posix()
    if rel in EXCLUDED_FILES:
        return True
    if any(rel == prefix or rel.startswith(prefix + "/") for prefix in EXCLUDED_PREFIXES):
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
    return False


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
    for item in ROOT.rglob("*"):
        if item.is_dir():
            continue
        relative = item.relative_to(ROOT)
        if should_skip_path(relative):
            continue
        destination = destination_root / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(item, destination)


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
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download_file(url: str, dest: Path) -> None:
    """Download a file from a URL to a local path."""
    print(f"[release] Downloading {url} ...")
    dest.parent.mkdir(parents=True, exist_ok=True)
    urllib.request.urlretrieve(url, dest)
    print(f"[release] Downloaded to {dest} ({dest.stat().st_size / 1024 / 1024:.1f} MB)")


def prepare_embedded_python(stage_dir: Path) -> None:
    """Download and prepare an embedded Python for portable distribution."""
    python_dir = stage_dir / "python"
    python_dir.mkdir(parents=True, exist_ok=True)

    # Download embeddable Python
    embed_zip = ARTIFACT_ROOT / f"python-{PYTHON_EMBED_VERSION}-embed-amd64.zip"
    if not embed_zip.exists():
        download_file(PYTHON_EMBED_URL, embed_zip)

    # Extract
    import zipfile
    with zipfile.ZipFile(embed_zip, "r") as zf:
        zf.extractall(python_dir)

    # Enable pip: uncomment "import site" in python3XX._pth
    pth_files = list(python_dir.glob("python*._pth"))
    for pth_file in pth_files:
        content = pth_file.read_text(encoding="utf-8")
        content = content.replace("#import site", "import site")
        pth_file.write_text(content, encoding="utf-8")

    # Download get-pip.py
    get_pip = python_dir / "get-pip.py"
    if not get_pip.exists():
        download_file(GET_PIP_URL, get_pip)

    # Write a portable run.bat that uses the embedded Python
    portable_bat = stage_dir / "run-portable.bat"
    portable_bat.write_text(
        '@echo off\r\n'
        'setlocal enabledelayedexpansion\r\n'
        '\r\n'
        'echo ==========================================\r\n'
        'echo    SD Image Sorter - Portable Launch\r\n'
        'echo ==========================================\r\n'
        'echo.\r\n'
        '\r\n'
        'cd /d "%~dp0"\r\n'
        '\r\n'
        'set "PYTHON_CMD=%~dp0python\\python.exe"\r\n'
        '\r\n'
        'if not exist "%PYTHON_CMD%" (\r\n'
        '    echo [ERROR] Embedded Python not found at %PYTHON_CMD%\r\n'
        '    echo         Please re-download the portable package.\r\n'
        '    pause\r\n'
        '    exit /b 1\r\n'
        ')\r\n'
        '\r\n'
        'echo [OK] Using embedded Python: %PYTHON_CMD%\r\n'
        '\r\n'
        'REM -- Install pip if not present\r\n'
        'if not exist "%~dp0python\\Scripts\\pip.exe" (\r\n'
        '    echo [INFO] Installing pip...\r\n'
        '    "%PYTHON_CMD%" "%~dp0python\\get-pip.py" --no-warn-script-location\r\n'
        '    if errorlevel 1 (\r\n'
        '        echo [ERROR] Failed to install pip.\r\n'
        '        pause\r\n'
        '        exit /b 1\r\n'
        '    )\r\n'
        ')\r\n'
        '\r\n'
        'REM -- Install dependencies\r\n'
        'if not exist "backend\\.requirements_hash" (\r\n'
        '    set NEED_INSTALL=1\r\n'
        ') else (\r\n'
        '    set NEED_INSTALL=0\r\n'
        ')\r\n'
        '\r\n'
        'if !NEED_INSTALL! EQU 1 (\r\n'
        '    echo [INFO] Installing dependencies (first run, may take a few minutes)...\r\n'
        '    "%~dp0python\\Scripts\\pip.exe" install -r backend\\requirements.txt --no-warn-script-location\r\n'
        '    if errorlevel 1 (\r\n'
        '        echo [ERROR] Failed to install dependencies.\r\n'
        '        pause\r\n'
        '        exit /b 1\r\n'
        '    )\r\n'
        '    echo installed > backend\\.requirements_hash\r\n'
        '    echo [OK] Dependencies installed.\r\n'
        ')\r\n'
        '\r\n'
        'echo.\r\n'
        'echo ==========================================\r\n'
        'echo   SD Image Sorter is starting!\r\n'
        'echo.\r\n'
        'echo   Open browser: http://localhost:8487\r\n'
        'echo   Press Ctrl+C to stop the server.\r\n'
        'echo ==========================================\r\n'
        'echo.\r\n'
        '\r\n'
        'start "" http://localhost:8487\r\n'
        '\r\n'
        'cd backend\r\n'
        '"%~dp0python\\python.exe" main.py\r\n'
        '\r\n'
        'echo.\r\n'
        'echo Server stopped.\r\n'
        'pause\r\n',
        encoding="utf-8",
    )


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
        prepare_embedded_python(stage_dir)

    assets.append(stage_archive("windows-portable", version, seven_zip, populate=populate_windows_portable))

    # === Linux/Mac: app only, no models, no Python (uses system Python) ===
    def populate_linux_mac(stage_dir: Path) -> None:
        copy_project(stage_dir)

    # Build as tar.gz for Linux/Mac
    linux_stage = STAGING_ROOT / "linux-mac"
    if linux_stage.exists():
        shutil.rmtree(linux_stage)
    linux_stage.mkdir(parents=True, exist_ok=True)
    populate_linux_mac(linux_stage)

    import tarfile
    tar_name = f"sd-image-sorter-v{version}-linux-mac.tar.gz"
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
