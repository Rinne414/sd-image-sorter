"""rembg (U2Net) subject-mask engine: model location, health and setup.

rembg is the default auto-mask engine. Its Python package installs through the
optional ``rembg`` dependency group; the u2net ONNX weights (~170 MB) live in
the app's data dir instead of the user profile, like every other model.

The URL and md5 are the ones rembg 2.0.69 itself uses
(``rembg/sessions/u2net.py``), so a file fetched here is the file rembg would
fetch on first use, and rembg skips its own download when it finds it.
"""

from __future__ import annotations

import hashlib
import importlib.util
from pathlib import Path
from typing import Any, Callable, Dict

import config

U2NET_URL = "https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net.onnx"
U2NET_MD5 = "60024c5c889badc19c04ad937298a77b"
U2NET_FILENAME = "u2net.onnx"
DOWNLOAD_TIMEOUT_SECONDS = 600


def _model_dir() -> Path:
    return Path(config.DATA_DIR) / "models" / "rembg"


def model_home() -> Path:
    """Folder rembg reads through ``U2NET_HOME``, created on first use."""
    home = _model_dir()
    home.mkdir(parents=True, exist_ok=True)
    return home


def model_path() -> Path:
    return _model_dir() / U2NET_FILENAME


def _runtime_installed() -> bool:
    try:
        return importlib.util.find_spec("rembg") is not None
    except (ImportError, ValueError):
        return False


def _md5(path: Path) -> str:
    digest = hashlib.md5(usedforsecurity=False)
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def health() -> Dict[str, Any]:
    runtime = _runtime_installed()
    path = model_path()
    downloaded = path.is_file() and path.stat().st_size > 0
    if runtime and downloaded:
        message_key, message = (
            "models.rembg.ready",
            "rembg and the u2net model are ready.",
        )
    elif downloaded:
        message_key, message = (
            "models.rembg.missingRuntime",
            "The u2net model is downloaded, but the rembg package is not installed. Click Prepare / Download.",
        )
    else:
        message_key, message = (
            "models.rembg.missing",
            "rembg is not set up yet. Click Prepare / Download to get it (~170 MB).",
        )
    return {
        "available": runtime and downloaded,
        "runtime_available": runtime,
        "model_path": str(path) if downloaded else None,
        "expected_path": str(path),
        "message_key": message_key,
        "message": message,
    }


def prepare(download_file: Callable[..., Path]) -> str:
    """Download and verify the u2net weights unless a verified copy exists."""
    path = model_path()
    if path.is_file() and _md5(path) == U2NET_MD5:
        return str(path)
    download_file(U2NET_URL, path, timeout=DOWNLOAD_TIMEOUT_SECONDS)
    if _md5(path) != U2NET_MD5:
        path.unlink(missing_ok=True)
        raise RuntimeError(
            "The u2net download was incomplete or corrupt. Click Prepare / Download to try again."
        )
    return str(path)
