"""
Update service for package-local self-updates.
"""

from __future__ import annotations

import json
import hashlib
import logging
import os
import re
import subprocess
import sys
import tarfile
import threading
import time
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any, Optional

from app_info import (
    APP_VERSION,
    GITHUB_LATEST_RELEASE_API_URL,
    LINUX_MAC_FULL_ASSET_TEMPLATE,
    PATCH_ASSET_TEMPLATE,
    WINDOWS_FULL_ASSET_TEMPLATE,
)
from config import (
    CONFIG_DIR,
    DATA_DIR,
    PACKAGE_ROOT,
    UPDATE_API_URL,
    UPDATE_DIR,
    UPDATE_DOWNLOAD_URL_PREFIX,
    UPDATE_WEB_URL,
    ensure_directories,
)


logger = logging.getLogger(__name__)

_VERSION_SEGMENT_RE = re.compile(r"(\d+|[A-Za-z]+)")
_HTTP_HEADERS = {
    "Accept": "application/vnd.github+json",
    "User-Agent": f"sd-image-sorter/{APP_VERSION}",
}
_DOWNLOAD_CHUNK_SIZE = 1024 * 1024


def _normalize_version(text: Optional[str]) -> str:
    return str(text or "").strip().lstrip("vV")


def _version_key(version: str) -> tuple[Any, ...]:
    normalized = _normalize_version(version)
    parts: list[Any] = []
    for segment in re.split(r"[.\-+_]", normalized):
        for token in _VERSION_SEGMENT_RE.findall(segment):
            parts.append(int(token) if token.isdigit() else token.lower())
    return tuple(parts)


def _version_is_newer(candidate: str, current: str) -> bool:
    return _version_key(candidate) > _version_key(current)


def _safe_version_text(version: str) -> str:
    return re.sub(r"[^0-9A-Za-z._-]+", "-", _normalize_version(version)) or "latest"


def _validate_archive_member_name(name: str) -> None:
    normalized = str(name or "").replace("\\", "/").strip()
    relative = PurePosixPath(normalized)
    if (
        not normalized
        or relative.is_absolute()
        or re.match(r"^[A-Za-z]:", normalized)
        or ".." in relative.parts
    ):
        raise RuntimeError(f"Downloaded update contains unsafe archive entry: {name}")


def _sha256sum(file_path: Path) -> str:
    digest = hashlib.sha256()
    with file_path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(_DOWNLOAD_CHUNK_SIZE), b""):
            digest.update(chunk)
    return digest.hexdigest()


class UpdateService:
    """Check for, download, and stage package-local application updates."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._cached_status: Optional[dict[str, Any]] = None
        self._checked_at = 0.0
        self._cache_ttl_seconds = 15 * 60

    def _platform_key(self) -> str:
        return "windows" if sys.platform == "win32" else "linux-mac"

    def _clear_cache(self) -> None:
        with self._lock:
            self._cached_status = None
            self._checked_at = 0.0

    def _channel_config_path(self) -> Path:
        return Path(CONFIG_DIR) / "update-channel.json"

    def _base_channel_state(self) -> dict[str, str]:
        return {
            "api_url": UPDATE_API_URL,
            "web_url": UPDATE_WEB_URL,
            "download_url_prefix": UPDATE_DOWNLOAD_URL_PREFIX,
        }

    def _read_channel_override(self) -> dict[str, Any]:
        path = self._channel_config_path()
        if not path.exists():
            return {}
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:
            logger.warning("Failed to read update channel override: %s", exc)
            return {}
        return payload if isinstance(payload, dict) else {}

    def _channel_state(self) -> dict[str, Any]:
        base = self._base_channel_state()
        override = self._read_channel_override()

        api_url = str(base["api_url"] or "").strip()
        web_url = str(base["web_url"] or "").strip()
        download_url_prefix = str(base["download_url_prefix"] or "").strip()

        if "api_url" in override:
            api_url = str(override.get("api_url") or "").strip() or api_url
        if "web_url" in override:
            web_url = str(override.get("web_url") or "").strip() or web_url
        if "download_url_prefix" in override:
            download_url_prefix = str(override.get("download_url_prefix") or "").strip()

        has_override = bool(override)
        is_default_github_channel = api_url.rstrip("/") == GITHUB_LATEST_RELEASE_API_URL.rstrip("/")

        return {
            "channel_name": str(override.get("channel_name") or "").strip() or (
                "GitHub Default" if is_default_github_channel and not has_override else "Custom Channel"
            ),
            "api_url": api_url,
            "web_url": web_url,
            "download_url_prefix": download_url_prefix,
            "has_override": has_override,
            "config_path": str(self._channel_config_path()),
            "is_default_github_channel": is_default_github_channel,
            "base_api_url": base["api_url"],
            "base_web_url": base["web_url"],
            "base_download_url_prefix": base["download_url_prefix"],
        }

    def _is_default_github_channel(self) -> bool:
        return bool(self._channel_state()["is_default_github_channel"])

    def _rewrite_download_url(self, url: str, prefix: str) -> str:
        normalized = str(url or "").strip()
        if not normalized:
            return ""
        if not prefix:
            return normalized
        if normalized.startswith(prefix):
            return normalized
        return f"{prefix}{normalized}"

    def _format_update_error(self, exc: Exception) -> str:
        detail = str(exc).strip() or exc.__class__.__name__
        if self._is_default_github_channel():
            return (
                f"Failed to reach the default GitHub update channel: {detail}. "
                "Mainland China users may not be able to access GitHub directly. "
                "Please enable VPN and try again. Advanced users can still configure "
                "SD_IMAGE_SORTER_UPDATE_API_URL, SD_IMAGE_SORTER_UPDATE_WEB_URL, or "
                "SD_IMAGE_SORTER_UPDATE_DOWNLOAD_URL_PREFIX in the package-local .env."
            )
        return f"Failed to reach the configured update channel: {detail}"

    def _read_release_json(self) -> dict[str, Any]:
        channel = self._channel_state()
        req = urllib.request.Request(channel["api_url"], headers=_HTTP_HEADERS)
        with urllib.request.urlopen(req, timeout=20) as response:
            raw = response.read()
        payload = json.loads(raw.decode("utf-8"))
        if not isinstance(payload, dict):
            raise RuntimeError("Update API returned an unexpected payload")
        return payload

    def _read_release_manifest(self, manifest_url: str) -> dict[str, Any]:
        req = urllib.request.Request(manifest_url, headers=_HTTP_HEADERS)
        with urllib.request.urlopen(req, timeout=20) as response:
            raw = response.read()
        payload = json.loads(raw.decode("utf-8"))
        if not isinstance(payload, dict):
            raise RuntimeError("Release checksum manifest returned an unexpected payload")
        return payload

    def _resolve_asset_sha256(self, asset: dict[str, Any]) -> str:
        direct_sha256 = str(asset.get("sha256") or "").strip().lower()
        if direct_sha256:
            return direct_sha256

        manifest_url = str(asset.get("manifest_download_url") or "").strip()
        if not manifest_url:
            return ""

        manifest_payload = self._read_release_manifest(manifest_url)
        manifest_assets = manifest_payload.get("assets") or []
        if not isinstance(manifest_assets, list):
            raise RuntimeError("Release checksum manifest assets payload is invalid")

        target_name = str(asset.get("name") or "").strip()
        for entry in manifest_assets:
            if not isinstance(entry, dict):
                continue
            if str(entry.get("name") or "").strip() != target_name:
                continue
            sha256_value = str(entry.get("sha256") or "").strip().lower()
            if sha256_value:
                return sha256_value
            break

        raise RuntimeError(f"Release checksum manifest is missing sha256 for asset: {target_name}")

    def _select_update_asset(self, release: dict[str, Any], latest_version: str) -> Optional[dict[str, Any]]:
        channel = self._channel_state()
        assets = release.get("assets") or []
        if not isinstance(assets, list):
            return None

        platform_key = self._platform_key()
        preferred_names = [
            ("patch", PATCH_ASSET_TEMPLATE.format(version=latest_version)),
        ]
        if platform_key == "windows":
            preferred_names.append(("full", WINDOWS_FULL_ASSET_TEMPLATE.format(version=latest_version)))
        else:
            preferred_names.append(("full", LINUX_MAC_FULL_ASSET_TEMPLATE.format(version=latest_version)))
        manifest_name = f"sd-image-sorter-v{latest_version}-release-manifest.json"
        manifest_download_url = ""
        for asset in assets:
            if not isinstance(asset, dict):
                continue
            if str(asset.get("name") or "") != manifest_name:
                continue
            manifest_download_url = self._rewrite_download_url(
                asset.get("browser_download_url") or "",
                channel["download_url_prefix"],
            )
            break

        for asset_kind, preferred_name in preferred_names:
            for asset in assets:
                if not isinstance(asset, dict):
                    continue
                name = str(asset.get("name") or "")
                if name != preferred_name:
                    continue
                return {
                    "kind": asset_kind,
                    "name": asset.get("name") or "",
                    "size_bytes": int(asset.get("size") or 0),
                    "download_url": self._rewrite_download_url(
                        asset.get("browser_download_url") or "",
                        channel["download_url_prefix"],
                    ),
                    "manifest_download_url": manifest_download_url,
                    "content_type": asset.get("content_type") or "",
                    "updated_at": asset.get("updated_at"),
                }
        return None

    def _build_status(self, release: Optional[dict[str, Any]], *, error: Optional[str] = None) -> dict[str, Any]:
        current_version = APP_VERSION
        channel = self._channel_state()
        status: dict[str, Any] = {
            "updater_enabled": True,
            "package_root": str(PACKAGE_ROOT),
            "data_root": str(DATA_DIR),
            "update_root": str(UPDATE_DIR),
            "platform": self._platform_key(),
            "current_version": current_version,
            "latest_version": current_version,
            "has_update": False,
            "release_url": channel["web_url"],
            "release_notes": "",
            "asset": None,
            "error": error,
            "update_unavailable_reason": None,
            "channel_name": channel["channel_name"],
            "channel_api_url": channel["api_url"],
            "channel_web_url": channel["web_url"],
            "channel_download_url_prefix": channel["download_url_prefix"],
            "has_channel_override": channel["has_override"],
            "channel_config_path": channel["config_path"],
            "is_default_github_channel": channel["is_default_github_channel"],
            "base_channel_api_url": channel["base_api_url"],
            "base_channel_web_url": channel["base_web_url"],
            "checked_at": time.time(),
        }

        if not release:
            return status

        latest_version = _normalize_version(
            release.get("tag_name")
            or release.get("name")
            or current_version
        ) or current_version
        asset = self._select_update_asset(release, latest_version)
        newer_than_current = _version_is_newer(latest_version, current_version)
        status.update(
            {
                "latest_version": latest_version,
                "has_update": bool(asset and newer_than_current),
                "release_url": release.get("html_url") or status["release_url"],
                "release_notes": release.get("body") or "",
                "published_at": release.get("published_at"),
                "asset": asset,
                "update_unavailable_reason": (
                    (
                        f"Latest release {latest_version} exists, but this update channel does not provide "
                        "a compatible in-app update package for your platform. "
                        "Please open the release page and download the full package manually."
                    )
                    if newer_than_current and asset is None
                    else None
                ),
            }
        )
        return status

    def get_status(self, *, force: bool = False) -> dict[str, Any]:
        now = time.time()
        with self._lock:
            if (
                not force
                and self._cached_status is not None
                and now - self._checked_at < self._cache_ttl_seconds
            ):
                return dict(self._cached_status)

        try:
            release = self._read_release_json()
            status = self._build_status(release)
        except Exception as exc:
            logger.warning("Failed to check for updates: %s", exc)
            status = self._build_status(None, error=self._format_update_error(exc))

        with self._lock:
            self._cached_status = dict(status)
            self._checked_at = status["checked_at"]

        return status

    def get_channel_settings(self) -> dict[str, Any]:
        channel = self._channel_state()
        return {
            "channel_name": channel["channel_name"],
            "channel_api_url": channel["api_url"],
            "channel_web_url": channel["web_url"],
            "download_url_prefix": channel["download_url_prefix"],
            "has_channel_override": channel["has_override"],
            "channel_config_path": channel["config_path"],
            "is_default_github_channel": channel["is_default_github_channel"],
            "base_channel_api_url": channel["base_api_url"],
            "base_channel_web_url": channel["base_web_url"],
        }

    def save_proxy_channel(self, proxy_prefix: str, *, channel_name: str = "Custom Proxy") -> dict[str, Any]:
        normalized = str(proxy_prefix or "").strip()
        if not normalized:
            return self.reset_channel_settings()
        if not normalized.startswith(("http://", "https://")):
            raise RuntimeError("Update proxy prefix must start with http:// or https://")
        if not normalized.endswith(("/", "=", "?", "&")) and "?" not in normalized:
            normalized = normalized + "/"

        base = self._base_channel_state()
        payload = {
            "channel_name": str(channel_name or "Custom Proxy").strip() or "Custom Proxy",
            "api_url": f"{normalized}{base['api_url']}",
            "web_url": f"{normalized}{base['web_url']}",
            "download_url_prefix": normalized,
        }

        path = self._channel_config_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        self._clear_cache()
        return self.get_channel_settings()

    def reset_channel_settings(self) -> dict[str, Any]:
        path = self._channel_config_path()
        path.unlink(missing_ok=True)
        self._clear_cache()
        return self.get_channel_settings()

    def _downloads_dir(self) -> Path:
        path = Path(UPDATE_DIR) / "downloads"
        path.mkdir(parents=True, exist_ok=True)
        return path

    def _state_dir(self) -> Path:
        path = Path(UPDATE_DIR) / "state"
        path.mkdir(parents=True, exist_ok=True)
        return path

    def _logs_dir(self) -> Path:
        path = Path(UPDATE_DIR) / "logs"
        path.mkdir(parents=True, exist_ok=True)
        return path

    def _download_asset(self, asset: dict[str, Any], version: str) -> Path:
        name = str(asset.get("name") or "").strip()
        url = str(asset.get("download_url") or "").strip()
        size_bytes = int(asset.get("size_bytes") or 0)
        expected_sha256 = self._resolve_asset_sha256(asset)
        if not name or not url:
            raise RuntimeError("Release does not include a downloadable update asset")

        target_dir = self._downloads_dir() / _safe_version_text(version)
        target_dir.mkdir(parents=True, exist_ok=True)
        archive_path = target_dir / name

        if archive_path.exists() and archive_path.stat().st_size > 0:
            size_matches = size_bytes <= 0 or archive_path.stat().st_size == size_bytes
            hash_matches = not expected_sha256 or _sha256sum(archive_path) == expected_sha256
            if size_matches and hash_matches:
                self._validate_archive(archive_path)
                return archive_path

        temp_path = archive_path.with_name(archive_path.name + ".tmp")
        if temp_path.exists():
            temp_path.unlink()
        req = urllib.request.Request(url, headers=_HTTP_HEADERS)
        digest = hashlib.sha256()
        try:
            with urllib.request.urlopen(req, timeout=60) as response, temp_path.open("wb") as handle:
                while True:
                    chunk = response.read(_DOWNLOAD_CHUNK_SIZE)
                    if not chunk:
                        break
                    handle.write(chunk)
                    digest.update(chunk)
            actual_sha256 = digest.hexdigest()
            if expected_sha256 and actual_sha256 != expected_sha256:
                raise RuntimeError(
                    f"Downloaded update checksum mismatch: expected {expected_sha256}, got {actual_sha256}"
                )
            temp_path.replace(archive_path)
        finally:
            if temp_path.exists():
                temp_path.unlink()

        if size_bytes > 0 and archive_path.stat().st_size != size_bytes:
            raise RuntimeError(
                f"Downloaded update size mismatch: expected {size_bytes}, got {archive_path.stat().st_size}"
            )
        self._validate_archive(archive_path)
        return archive_path

    def _validate_archive(self, archive_path: Path) -> None:
        if archive_path.suffix.lower() == ".zip":
            if not zipfile.is_zipfile(archive_path):
                raise RuntimeError(f"Downloaded patch is not a valid zip archive: {archive_path.name}")
            with zipfile.ZipFile(archive_path, "r") as archive:
                for member in archive.infolist():
                    _validate_archive_member_name(member.filename)
                bad_member = archive.testzip()
            if bad_member is not None:
                raise RuntimeError(f"Downloaded patch is corrupted near: {bad_member}")
            return

        if archive_path.name.lower().endswith((".tar.gz", ".tgz")):
            if not tarfile.is_tarfile(archive_path):
                raise RuntimeError(f"Downloaded patch is not a valid tar archive: {archive_path.name}")
            with tarfile.open(archive_path, "r:gz") as archive:
                for member in archive.getmembers():
                    _validate_archive_member_name(member.name)
                    if not (member.isfile() or member.isdir()):
                        raise RuntimeError(f"Downloaded update contains unsupported archive entry: {member.name}")
            return

        raise RuntimeError(f"Unsupported update archive type: {archive_path.name}")

    def _resolve_launcher_path(self) -> Path:
        launcher_name = str(os.environ.get("SD_IMAGE_SORTER_LAUNCHER") or "").strip()
        candidates = []
        if launcher_name:
            candidates.append(PACKAGE_ROOT / launcher_name)
        if sys.platform == "win32":
            candidates.extend(
                [
                    PACKAGE_ROOT / "run-portable.bat",
                    PACKAGE_ROOT / "run.bat",
                ]
            )
        else:
            candidates.append(PACKAGE_ROOT / "run.sh")

        for candidate in candidates:
            if candidate.exists():
                return candidate

        raise RuntimeError("Could not locate a launcher script for restarting the app")

    def _pending_manifest_path(self, version: str) -> Path:
        safe_version = re.sub(r"[^0-9A-Za-z._-]+", "-", version) or "latest"
        return self._state_dir() / f"pending-update-{safe_version}.json"

    def _write_pending_manifest(self, *, archive_path: Path, version: str, relaunch: bool) -> Path:
        launcher_path = self._resolve_launcher_path()
        timestamp = int(time.time())
        payload = {
            "created_at": timestamp,
            "current_pid": os.getpid(),
            "package_root": str(PACKAGE_ROOT),
            "archive_path": str(archive_path),
            "target_version": version,
            "launcher_path": str(launcher_path),
            "relaunch": bool(relaunch),
            "log_path": str(self._logs_dir() / f"update-{timestamp}.log"),
            "update_root": str(UPDATE_DIR),
        }
        manifest_path = self._pending_manifest_path(version)
        manifest_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        return manifest_path

    def _worker_command(self, manifest_path: Path) -> list[str]:
        return [
            sys.executable,
            str(PACKAGE_ROOT / "backend" / "update_worker.py"),
            "--manifest",
            str(manifest_path),
        ]

    def _launch_worker(self, manifest_path: Path) -> None:
        command = self._worker_command(manifest_path)
        kwargs: dict[str, Any] = {
            "cwd": str(PACKAGE_ROOT),
            "stdin": subprocess.DEVNULL,
            "stdout": subprocess.DEVNULL,
            "stderr": subprocess.DEVNULL,
            "close_fds": True,
        }
        if sys.platform == "win32":
            creationflags = 0
            creationflags |= getattr(subprocess, "DETACHED_PROCESS", 0)
            creationflags |= getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
            kwargs["creationflags"] = creationflags
        else:
            kwargs["start_new_session"] = True
        subprocess.Popen(command, **kwargs)

    def prepare_update(self, *, force_check: bool = False, relaunch: bool = True) -> dict[str, Any]:
        ensure_directories()
        status = self.get_status(force=force_check)
        if status.get("error"):
            raise RuntimeError(str(status["error"]))
        if status.get("update_unavailable_reason"):
            raise RuntimeError(str(status["update_unavailable_reason"]))
        if not status.get("has_update"):
            return {**status, "status": "up_to_date"}
        asset = status.get("asset") or {}
        latest_version = str(status.get("latest_version") or APP_VERSION)
        archive_path = self._download_asset(asset, latest_version)
        manifest_path = self._write_pending_manifest(
            archive_path=archive_path,
            version=latest_version,
            relaunch=relaunch,
        )
        self._launch_worker(manifest_path)
        return {
            **status,
            "status": "scheduled",
            "downloaded_archive": str(archive_path),
            "pending_manifest": str(manifest_path),
            "restart_required": True,
        }
