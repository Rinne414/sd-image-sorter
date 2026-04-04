#!/usr/bin/env python3
"""Build release archives for SD Image Sorter."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Iterable
from zipfile import ZIP_DEFLATED, ZipFile


ROOT = Path(__file__).resolve().parent.parent
ARTIFACT_ROOT = ROOT / "artifacts" / "release"
STAGING_ROOT = ARTIFACT_ROOT / "staging"
DEFAULT_VERSION = "2.1.0"
DEFAULT_SPLIT_SIZE_MB = 1900

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
    ".vscode",
    "artifacts",
    "backend/venv",
    "backend/favorites",
    "backend/thumbnails",
    "backend/test-path",
    "tests/e2e/node_modules",
    "tests/e2e/test-results",
    "tests/e2e/.pw-out",
    "test-results",
    "reference",
    "testimage",
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

    assets.append(
        stage_archive(
            "app",
            version,
            seven_zip,
            populate=copy_project,
        )
    )

    def populate_portable(stage_dir: Path) -> None:
        copy_project(stage_dir)
        for relative in CORE_MODEL_FILES:
            copy_file(relative, stage_dir)

    assets.append(stage_archive("portable-core-models", version, seven_zip, populate=populate_portable))

    def populate_eva(stage_dir: Path) -> None:
        for relative in EVA_MODEL_FILES:
            copy_file(relative, stage_dir)

    assets.append(stage_archive("wd14-eva02-model", version, seven_zip, populate=populate_eva))

    def populate_artist_runtime(stage_dir: Path) -> None:
        for relative in ARTIST_RUNTIME_FILES:
            copy_file(relative, stage_dir)
        copy_tree(
            ROOT / "models" / "artist" / "comfyui-lsnet-runtime",
            stage_dir,
            "models/artist/comfyui-lsnet-runtime",
        )

    assets.append(stage_archive("artist-runtime", version, seven_zip, populate=populate_artist_runtime))

    if seven_zip is None:
        print("[release] 7z was not found; skipping split archives for Kaloscope and SAM3.")
    else:
        kaloscope_parts = create_split_zip(
            ROOT / LARGE_MODEL_FILES["kaloscope"],
            ARTIFACT_ROOT / f"sd-image-sorter-v{version}-kaloscope-checkpoint.zip",
            split_size_mb,
            seven_zip,
        )
        assets.extend(kaloscope_parts)

        sam3_parts = create_split_zip(
            ROOT / LARGE_MODEL_FILES["sam3"],
            ARTIFACT_ROOT / f"sd-image-sorter-v{version}-sam3-modelscope-sam3pt.zip",
            split_size_mb,
            seven_zip,
        )
        assets.extend(sam3_parts)

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
