"""One-click "Install video support": the LGPL shared ffmpeg build.

Downloads the newest release build (``ffmpeg-nX.Y-latest-<platform>-lgpl-shared``)
from https://github.com/BtbN/FFmpeg-Builds, checks it against the release's
``checksums.sha256`` (refused on mismatch), and unpacks it to
``<data>/tools/ffmpeg``. Nothing else is downloaded or sent: one GitHub API
request for the release listing, the checksum file and the archive. The LGPL
build has no GPL encoders (x264/x265); the archive carries its own licence.

Runs in a background thread; ``status()`` reports progress for the UI.
"""

from __future__ import annotations

import hashlib
import http.client
import json
import logging
import platform
import re
import shutil
import socket
import sys
import tarfile
import threading
import urllib.error
import urllib.request
import zipfile
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from config import get_tools_dir
from services import video_tools

logger = logging.getLogger(__name__)


class InstallError(RuntimeError):
    """A known reason the install stopped; ``code`` names it for the page."""

    def __init__(self, message: str, code: str) -> None:
        super().__init__(message)
        self.code = code


def failure_code(exc: Exception) -> Tuple[str, Dict[str, Any]]:
    """The code and params the page says a failed install with, in its language.

    Network failures get their own codes: the system's text (``<urlopen error
    [WinError 10061] ...>``, in the system's language) stays in the log. An
    HTTP error's ``code`` is its status number, not one of ours.
    """
    if isinstance(exc, InstallError):
        return exc.code, {"reason": str(exc)}
    if isinstance(exc, urllib.error.HTTPError):
        return "video_install_site_refused", {"status": exc.code}
    reason = exc.reason if isinstance(exc, urllib.error.URLError) else exc
    if isinstance(reason, (socket.timeout, TimeoutError)):
        return "video_install_timeout", {}
    if isinstance(exc, urllib.error.URLError):
        return "video_install_unreachable", {}
    if isinstance(exc, (ConnectionError, http.client.IncompleteRead)):
        return "video_install_connection_broken", {}
    return "video_install_failed", {"reason": str(exc)}

RELEASE_API = "https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/tags/latest"
HTTP_TIMEOUT_SECONDS = 60
CHUNK_BYTES = 1024 * 1024
# Shown before anything is downloaded, in MB of 1,000,000 bytes (the n9.0
# builds measured 2026-10: win64 77.2, linux64 63.5, the arm64 builds 54).
ESTIMATED_MB = {"win64": 77, "winarm64": 54, "linux64": 64, "linuxarm64": 54}
_USER_AGENT = "sd-image-sorter (video support install)"


def platform_tag() -> Optional[str]:
    machine = platform.machine().lower()
    arm = machine in ("arm64", "aarch64")
    if sys.platform == "win32":
        return "winarm64" if arm else "win64"
    if sys.platform.startswith("linux"):
        return "linuxarm64" if arm else "linux64"
    return None


def pick_asset(assets: list, tag: str) -> Optional[Dict[str, Any]]:
    """The newest numbered LGPL shared build for ``tag`` (not the nightly master)."""
    pattern = re.compile(
        rf"^ffmpeg-n(\d+)\.(\d+)(?:\.(\d+))?-latest-{re.escape(tag)}-lgpl-shared-[\d.]+\.(zip|tar\.xz)$"
    )
    best: Optional[Tuple[Tuple[int, int, int], Dict[str, Any]]] = None
    for asset in assets:
        match = pattern.match(str(asset.get("name") or ""))
        if not match:
            continue
        version = (int(match.group(1)), int(match.group(2)), int(match.group(3) or 0))
        if best is None or version > best[0]:
            best = (version, asset)
    return best[1] if best else None


def expected_sha256(checksums_text: str, asset_name: str) -> Optional[str]:
    for line in checksums_text.splitlines():
        parts = line.strip().split()
        if len(parts) >= 2 and parts[-1].lstrip("*") == asset_name:
            return parts[0].lower()
    return None


def _open(url: str):
    request = urllib.request.Request(url, headers={"User-Agent": _USER_AGENT})
    return urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_SECONDS)  # noqa: S310 - fixed https host


def _extract(archive: Path, target: Path) -> None:
    target_resolved = target.resolve()
    if archive.name.endswith(".zip"):
        with zipfile.ZipFile(archive) as bundle:
            for member in bundle.namelist():
                destination = (target / member).resolve()
                if (
                    target_resolved not in destination.parents
                    and destination != target_resolved
                ):
                    raise InstallError(
                        f"Unsafe path in archive: {member}", "video_install_bad_archive"
                    )
            bundle.extractall(target)
        return
    with tarfile.open(archive, "r:xz") as bundle:
        bundle.extractall(target, filter="data")


def _bin_folder(unpacked: Path) -> Path:
    exe = ".exe" if sys.platform == "win32" else ""
    for candidate in unpacked.rglob(f"ffprobe{exe}"):
        if (
            candidate.parent.name == "bin"
            and (candidate.parent / f"ffmpeg{exe}").is_file()
        ):
            return candidate.parent.parent
    raise InstallError(
        "The download did not contain ffmpeg and ffprobe", "video_install_bad_archive"
    )


class FfmpegInstaller:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._thread: Optional[threading.Thread] = None
        self._state: Dict[str, Any] = {"state": "idle"}

    def status(self) -> Dict[str, Any]:
        with self._lock:
            return dict(self._state)

    def _set(self, **values: Any) -> None:
        with self._lock:
            self._state.update(values)

    def start(self) -> Dict[str, Any]:
        tag = platform_tag()
        if tag is None:
            raise InstallError(
                "No ready-made ffmpeg for this system; install ffmpeg with your package manager",
                "video_install_unsupported",
            )
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return dict(self._state)
            self._state = {
                "state": "running",
                "phase": "looking",
                "downloaded": 0,
                "total": None,
            }
            self._thread = threading.Thread(
                target=self._run, args=(tag,), name="ffmpeg-install", daemon=True
            )
            self._thread.start()
            return dict(self._state)

    def _run(self, tag: str) -> None:
        tools_dir = Path(get_tools_dir())
        work = tools_dir / "ffmpeg-download"
        try:
            shutil.rmtree(work, ignore_errors=True)
            work.mkdir(parents=True)
            archive = self._download(tag, work)
            self._set(phase="unpacking")
            unpacked = work / "unpacked"
            _extract(archive, unpacked)
            self._install(_bin_folder(unpacked), tools_dir / "ffmpeg")
            video_tools.forget_tools()
            if video_tools.find_tools(refresh=True) is None:
                raise InstallError(
                    "ffmpeg was unpacked but could not be found", "video_install_bad_archive"
                )
            self._set(state="done", phase="done")
            from services.video_index import get_video_indexer

            get_video_indexer().kick()
        except Exception as exc:
            logger.warning("Video support install failed: %s", exc)
            # error_code + error_params let the page say it in its language.
            code, params = failure_code(exc)
            self._set(
                state="failed",
                error=str(exc),
                error_code=code,
                error_params=params,
            )
        finally:
            shutil.rmtree(work, ignore_errors=True)

    def _download(self, tag: str, work: Path) -> Path:
        with _open(RELEASE_API) as response:
            release = json.loads(response.read().decode("utf-8"))
        assets = release.get("assets") or []
        asset = pick_asset(assets, tag)
        checksums = next(
            (a for a in assets if a.get("name") == "checksums.sha256"), None
        )
        if asset is None or checksums is None:
            raise InstallError(
                "The ffmpeg release has no LGPL build for this system", "video_install_no_build"
            )
        with _open(checksums["browser_download_url"]) as response:
            expected = expected_sha256(response.read().decode("utf-8"), asset["name"])
        if not expected:
            raise InstallError(
                "The release lists no checksum for the download", "video_install_no_checksum"
            )
        self._set(
            phase="downloading", file=asset["name"], total=int(asset.get("size") or 0)
        )
        archive = work / asset["name"]
        digest = hashlib.sha256()
        downloaded = 0
        with (
            _open(asset["browser_download_url"]) as response,
            open(archive, "wb") as out,
        ):
            while chunk := response.read(CHUNK_BYTES):
                out.write(chunk)
                digest.update(chunk)
                downloaded += len(chunk)
                self._set(downloaded=downloaded)
        if digest.hexdigest().lower() != expected:
            raise InstallError(
                "The download does not match its published SHA256; not installed",
                "video_install_checksum_mismatch",
            )
        return archive

    @staticmethod
    def _install(build_root: Path, destination: Path) -> None:
        old = destination.with_name("ffmpeg-old")
        shutil.rmtree(old, ignore_errors=True)
        if destination.exists():
            destination.rename(old)
        shutil.move(str(build_root), str(destination))
        shutil.rmtree(old, ignore_errors=True)


_installer = FfmpegInstaller()


def get_installer() -> FfmpegInstaller:
    return _installer
