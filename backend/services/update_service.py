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
from urllib.parse import urlsplit

from app_info import (
    APP_VERSION,
    GITHUB_LATEST_RELEASE_API_URL,
    LINUX_FULL_ASSET_TEMPLATE,
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
from update_worker import PACKAGE_MANIFEST_RELATIVE_PATH, validate_update_manifest_managed_paths


logger = logging.getLogger(__name__)

_VERSION_SEGMENT_RE = re.compile(r"(\d+|[A-Za-z]+)")
_HTTP_HEADERS = {
    "Accept": "application/vnd.github+json",
    "User-Agent": f"sd-image-sorter/{APP_VERSION}",
}
_DOWNLOAD_CHUNK_SIZE = 1024 * 1024
_MAX_UPDATE_ARCHIVE_ENTRIES = 20000
_MAX_UPDATE_ARCHIVE_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024


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


def _package_manifest_member_name(name: str) -> str | None:
    """Return a validated package-manifest archive member name, if this is one."""
    normalized = str(name or "").replace("\\", "/").strip()
    parts = PurePosixPath(normalized).parts
    manifest_parts = PACKAGE_MANIFEST_RELATIVE_PATH.parts

    if parts == manifest_parts:
        return normalized
    if len(parts) == len(manifest_parts) + 1 and parts[1:] == manifest_parts:
        return normalized
    return None


def _load_single_package_manifest(
    *,
    current_manifest: dict[str, Any] | None,
    member_name: str,
    payload: bytes,
) -> dict[str, Any]:
    if current_manifest is not None:
        raise RuntimeError(f"Downloaded update contains multiple package manifests; duplicate near: {member_name}")
    return json.loads(payload.decode("utf-8"))


def _sha256sum(file_path: Path) -> str:
    digest = hashlib.sha256()
    with file_path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(_DOWNLOAD_CHUNK_SIZE), b""):
            digest.update(chunk)
    return digest.hexdigest()


# --- Update-channel SSRF hardening -------------------------------------------------
# The update channel can be overridden via update-channel.json (proxy-mirror
# feature) so users behind GitHub-blocking networks can still self-update. That
# override is attacker-influenceable if the config file is tampered with, so we
# refuse to fetch from arbitrary hosts: direct channel URLs must point at GitHub,
# and the opt-in proxy-prefix mirror must be https and must NOT resolve to an
# internal / loopback / link-local target. Invalid overrides are ignored and we
# fall back to the built-in GitHub channel instead of crashing.
_GITHUB_HOST_SUFFIXES = (
    "github.com",
    "api.github.com",
    "codeload.github.com",
    "objects.githubusercontent.com",
    "raw.githubusercontent.com",
    ".githubusercontent.com",
)
_INTERNAL_HOST_SUFFIXES = (
    ".internal",
    ".local",
)
_INTERNAL_HOST_EXACT = (
    "localhost",
    "ip6-localhost",
    "ip6-loopback",
)
_INTERNAL_HOST_PREFIXES = (
    "127.",
    "10.",
    "192.168.",
    "169.254.",
    "0.",
)


def _host_from_url(url: str) -> str:
    try:
        return (urlsplit(url).hostname or "").strip().lower()
    except ValueError:
        return ""


def _host_is_github(host: str) -> bool:
    if not host:
        return False
    for suffix in _GITHUB_HOST_SUFFIXES:
        base = suffix.lstrip(".")
        # Require an exact host match or a real subdomain boundary ("." + base).
        # A bare host.endswith(base) would also accept attacker-registrable
        # lookalikes such as "evilgithub.com" (ends with "github.com").
        if host == base or host.endswith("." + base):
            return True
    return False


def _host_is_internal(host: str) -> bool:
    """Reject loopback, RFC1918, link-local, and internal-only hostnames."""
    if not host:
        # An empty / unparseable host is treated as unsafe.
        return True
    bracketless = host.strip("[]")
    if bracketless in _INTERNAL_HOST_EXACT:
        return True
    # IPv6 loopback / link-local (fe80::/10) / unique-local (fc00::/7). Scope
    # these prefixes to actual IPv6 literals so hostnames like "fdn.example.com"
    # are not misclassified as internal.
    if ":" in bracketless:
        if bracketless in {"::1", "::"} or bracketless.startswith(("fe80:", "fc", "fd")):
            return True
    if any(bracketless == suffix.lstrip(".") or bracketless.endswith(suffix) for suffix in _INTERNAL_HOST_SUFFIXES):
        return True
    if any(bracketless.startswith(prefix) for prefix in _INTERNAL_HOST_PREFIXES):
        return True
    # 172.16.0.0 – 172.31.255.255 (private range) needs a numeric second octet check.
    if bracketless.startswith("172."):
        parts = bracketless.split(".")
        if len(parts) >= 2 and parts[1].isdigit() and 16 <= int(parts[1]) <= 31:
            return True
    return False


def _is_safe_proxy_prefix(prefix: str) -> bool:
    """A proxy/mirror prefix must be https and must not target an internal host."""
    normalized = str(prefix or "").strip()
    if not normalized.lower().startswith("https://"):
        return False
    return not _host_is_internal(_host_from_url(normalized))


def _is_safe_channel_url(url: str) -> bool:
    """Validate an api_url / web_url channel override.

    Accepts either a direct https GitHub URL, or a proxy-mirror form where a
    GitHub URL is appended after an https proxy prefix (e.g.
    ``https://mirror.example/https://github.com/...``). The proxy host itself
    must not be internal/loopback.
    """
    normalized = str(url or "").strip()
    if not normalized.lower().startswith("https://"):
        return False
    if _host_is_github(_host_from_url(normalized)):
        return True
    # Proxy-mirror form: an embedded https GitHub URL after the proxy prefix.
    embedded_index = normalized.find("https://", len("https://"))
    if embedded_index != -1:
        embedded = normalized[embedded_index:]
        if _host_is_github(_host_from_url(embedded)) and not _host_is_internal(
            _host_from_url(normalized)
        ):
            return True
    return False


class UpdateService:
    """Check for, download, and stage package-local application updates."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._cached_status: Optional[dict[str, Any]] = None
        self._checked_at = 0.0
        self._cache_ttl_seconds = 15 * 60

    def _platform_key(self) -> str:
        if sys.platform == "win32":
            return "windows"
        if sys.platform.startswith("linux"):
            return "linux"
        return "unsupported"

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
        if not isinstance(payload, dict):
            return {}
        return self._sanitize_channel_override(payload)

    def _sanitize_channel_override(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Drop any override URL that fails the SSRF host allowlist.

        Reading the override file is a trust boundary: a tampered config must
        never be able to redirect update fetches at an internal/loopback host
        or a non-GitHub origin. Invalid fields are dropped with a warning so we
        fall back to the built-in GitHub channel instead of crashing.
        """
        sanitized: dict[str, Any] = {}
        if "channel_name" in payload:
            sanitized["channel_name"] = payload.get("channel_name")

        api_url = str(payload.get("api_url") or "").strip()
        if api_url:
            if _is_safe_channel_url(api_url):
                sanitized["api_url"] = api_url
            else:
                logger.warning("Ignoring update channel override api_url (failed SSRF allowlist): %s", api_url)

        web_url = str(payload.get("web_url") or "").strip()
        if web_url:
            # web_url is only ever opened in the user's browser, but keep it on
            # the same allowlist so the displayed channel stays consistent.
            if _is_safe_channel_url(web_url):
                sanitized["web_url"] = web_url
            else:
                logger.warning("Ignoring update channel override web_url (failed SSRF allowlist): %s", web_url)

        if "download_url_prefix" in payload:
            prefix = str(payload.get("download_url_prefix") or "").strip()
            if not prefix:
                # An explicit empty prefix means "no mirror"; keep it as-is.
                sanitized["download_url_prefix"] = prefix
            elif _is_safe_proxy_prefix(prefix):
                sanitized["download_url_prefix"] = prefix
            else:
                logger.warning(
                    "Ignoring update channel override download_url_prefix (failed SSRF allowlist): %s",
                    prefix,
                )
        return sanitized

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
                "Your network may not be able to access GitHub directly. "
                "Please check your connection or enable VPN and try again."
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
        elif platform_key == "linux":
            preferred_names.append(("full", LINUX_FULL_ASSET_TEMPLATE.format(version=latest_version)))
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
        # SSRF guard: the proxy-mirror prefix must be https and must not point
        # at an internal/loopback target before we persist it as a channel.
        if not normalized.lower().startswith("https://"):
            raise RuntimeError("Update proxy prefix must start with https://")
        if not normalized.endswith(("/", "=", "?", "&")) and "?" not in normalized:
            normalized = normalized + "/"
        if not _is_safe_proxy_prefix(normalized):
            raise RuntimeError(
                "Update proxy prefix must be https and must not target an internal or loopback host"
            )

        base = self._base_channel_state()
        payload = {
            "channel_name": str(channel_name or "Custom Proxy").strip() or "Custom Proxy",
            "api_url": f"{normalized}{base['api_url']}",
            "web_url": f"{normalized}{base['web_url']}",
            "download_url_prefix": normalized,
        }
        # Re-validate the composed URLs so a hostile base channel value cannot
        # smuggle a non-GitHub / internal target past the prefix check.
        if not _is_safe_channel_url(payload["api_url"]):
            raise RuntimeError("Resulting update channel api_url failed the SSRF allowlist")

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
        # The GitHub asset name is used verbatim as the on-disk archive filename;
        # reject anything that is not a single path component so a hostile name
        # (e.g. "../run.bat" or "a/b") cannot escape the downloads directory.
        if Path(name).name != name or ".." in name or "/" in name or "\\" in name:
            raise RuntimeError(f"Refusing to download update asset with unsafe name: {name}")
        # Integrity is mandatory: without a verified SHA-256 we have no way to
        # know the downloaded archive is the one the maintainer published, so we
        # refuse to apply it rather than silently skipping the check.
        if not expected_sha256:
            raise RuntimeError(
                f"Refusing to apply update asset without a verified SHA-256 checksum: {name}"
            )

        target_dir = self._downloads_dir() / _safe_version_text(version)
        target_dir.mkdir(parents=True, exist_ok=True)
        archive_path = target_dir / name

        if archive_path.exists() and archive_path.stat().st_size > 0:
            size_matches = size_bytes <= 0 or archive_path.stat().st_size == size_bytes
            hash_matches = _sha256sum(archive_path) == expected_sha256
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
            if actual_sha256 != expected_sha256:
                raise RuntimeError(
                    f"Downloaded update checksum mismatch: expected {expected_sha256}, got {actual_sha256}"
                )
            temp_path.replace(archive_path)
        finally:
            # temp_path.replace() removes the temp file on success, so guard the
            # cleanup against the file already being gone (Windows raises here).
            temp_path.unlink(missing_ok=True)

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
            package_manifest: dict[str, Any] | None = None
            with zipfile.ZipFile(archive_path, "r") as archive:
                total_uncompressed_bytes = 0
                members = archive.infolist()
                if len(members) > _MAX_UPDATE_ARCHIVE_ENTRIES:
                    raise RuntimeError("Downloaded update archive contains too many entries")
                for member in members:
                    _validate_archive_member_name(member.filename)
                    if not member.is_dir():
                        total_uncompressed_bytes += member.file_size
                        if total_uncompressed_bytes > _MAX_UPDATE_ARCHIVE_UNCOMPRESSED_BYTES:
                            raise RuntimeError("Downloaded update archive uncompressed size exceeds the safe limit")
                    manifest_member_name = _package_manifest_member_name(member.filename)
                    if manifest_member_name is not None:
                        package_manifest = _load_single_package_manifest(
                            current_manifest=package_manifest,
                            member_name=manifest_member_name,
                            payload=archive.read(member),
                        )
                bad_member = archive.testzip()
            if bad_member is not None:
                raise RuntimeError(f"Downloaded patch is corrupted near: {bad_member}")
            if package_manifest is None:
                raise RuntimeError("Downloaded update is missing update/package-manifest.json")
            validate_update_manifest_managed_paths(package_manifest)
            return

        if archive_path.name.lower().endswith((".tar.gz", ".tgz")):
            if not tarfile.is_tarfile(archive_path):
                raise RuntimeError(f"Downloaded patch is not a valid tar archive: {archive_path.name}")
            package_manifest = None
            with tarfile.open(archive_path, "r:gz") as archive:
                total_uncompressed_bytes = 0
                members = archive.getmembers()
                if len(members) > _MAX_UPDATE_ARCHIVE_ENTRIES:
                    raise RuntimeError("Downloaded update archive contains too many entries")
                for member in members:
                    _validate_archive_member_name(member.name)
                    if not (member.isfile() or member.isdir()):
                        raise RuntimeError(f"Downloaded update contains unsupported archive entry: {member.name}")
                    if member.isfile():
                        total_uncompressed_bytes += member.size
                        if total_uncompressed_bytes > _MAX_UPDATE_ARCHIVE_UNCOMPRESSED_BYTES:
                            raise RuntimeError("Downloaded update archive uncompressed size exceeds the safe limit")
                    manifest_member_name = _package_manifest_member_name(member.name)
                    if member.isfile() and manifest_member_name is not None:
                        manifest_file = archive.extractfile(member)
                        if manifest_file is not None:
                            package_manifest = _load_single_package_manifest(
                                current_manifest=package_manifest,
                                member_name=manifest_member_name,
                                payload=manifest_file.read(),
                            )
            if package_manifest is None:
                raise RuntimeError("Downloaded update is missing update/package-manifest.json")
            validate_update_manifest_managed_paths(package_manifest)
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

    def _write_pending_manifest(
        self,
        *,
        archive_path: Path,
        version: str,
        relaunch: bool,
        current_pid: int | None = None,
    ) -> Path:
        launcher_path = self._resolve_launcher_path()
        timestamp = int(time.time())
        payload = {
            "created_at": timestamp,
            "current_pid": os.getpid() if current_pid is None else int(current_pid),
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
