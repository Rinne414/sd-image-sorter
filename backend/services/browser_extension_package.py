"""Build the browser extension folders users load into Chrome/Edge and Firefox.

One source (``browser-extension/src`` + ``manifest.base.json``) becomes two
ready-to-load folders that differ only in the manifest: Chrome and Edge run
the background script as a service worker; Firefox runs it as an event page,
needs its add-on id, and gets host permissions without a port (Firefox bug
2052000: a pattern with a port matches nothing). The program builds them on
demand into its data folder, so a release needs no build step; the
``browser-extension/build.py`` script does the same for developers and zips
them.
"""

from __future__ import annotations

import json
import zipfile
from pathlib import Path
from typing import Dict

import config
from app_info import APP_VERSION

TARGETS = ("chrome", "firefox")
FIREFOX_ADDON_ID = "sd-image-sorter@rinne414.github.io"
FIREFOX_MIN_VERSION = "128.0"


def source_dir() -> Path:
    return Path(config.PROJECT_ROOT) / "browser-extension"


def install_root() -> Path:
    return Path(config.DATA_DIR) / "browser-extension"


def _extension_version() -> str:
    """The program version as the dotted numbers a manifest accepts (3.7.0-beta.1 -> 3.7.0)."""
    core = APP_VERSION.split("-", 1)[0].split("+", 1)[0]
    parts = [part for part in core.split(".") if part.isdigit()]
    return ".".join(parts[:4]) or "0.0.0"


def manifest_for(target: str) -> Dict:
    if target not in TARGETS:
        raise ValueError(f"Unknown browser target: {target!r}")
    base = json.loads((source_dir() / "manifest.base.json").read_text(encoding="utf-8"))
    manifest = dict(base)
    manifest["version"] = _extension_version()
    if target == "chrome":
        manifest["background"] = {"service_worker": "background.js"}
    else:
        # An event page, not a worker: it loads the shared helper itself.
        manifest["background"] = {"scripts": ["program.js", "background.js"]}
        manifest["browser_specific_settings"] = {
            "gecko": {"id": FIREFOX_ADDON_ID, "strict_min_version": FIREFOX_MIN_VERSION}
        }
    return manifest


def _write_if_changed(path: Path, data: bytes) -> None:
    if path.is_file() and path.read_bytes() == data:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def build_target(target: str, out_dir: Path) -> Path:
    """Write one loadable extension folder; unchanged files are left untouched."""
    src = source_dir() / "src"
    wanted = {"manifest.json"}
    manifest = json.dumps(manifest_for(target), indent=2, ensure_ascii=False) + "\n"
    _write_if_changed(out_dir / "manifest.json", manifest.encode("utf-8"))
    for file in sorted(p for p in src.rglob("*") if p.is_file()):
        relative = file.relative_to(src).as_posix()
        wanted.add(relative)
        _write_if_changed(out_dir / relative, file.read_bytes())
    for stale in [p for p in out_dir.rglob("*") if p.is_file()]:
        if stale.relative_to(out_dir).as_posix() not in wanted:
            stale.unlink()
    return out_dir


def zip_target(folder: Path, zip_path: Path) -> Path:
    zip_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as archive:
        for file in sorted(p for p in folder.rglob("*") if p.is_file()):
            archive.write(file, file.relative_to(folder).as_posix())
    return zip_path


def prepare_install_folders() -> Dict[str, str]:
    """Build both folders under the data folder and return their paths."""
    root = install_root()
    folders = {target: str(build_target(target, root / target)) for target in TARGETS}
    return {**folders, "version": _extension_version()}

