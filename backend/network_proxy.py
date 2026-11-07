"""One proxy setting for everything that goes online.

Model downloads, pip, update checks and cloud captioning all read the standard
proxy environment variables, so setting those is the whole job: people who run
Clash or v2rayN enter a port once and do not need TUN mode. httpx, which Hugging
Face downloads use, ignores the Windows system proxy, so turning on "system
proxy" in such a tool is not enough without this. Local addresses never go
through the proxy. HTTP proxies only: urllib, which downloads many of the models
and checks for updates, and pip cannot use SOCKS, while Clash and v2rayN all offer
an HTTP or mixed port. Standard library only at import time: launchers use it too.
"""

from __future__ import annotations

import ipaddress
import json
import logging
import os
import re
import sys
import threading
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

SETTING_KEY = "network_proxy"
SETTINGS_FILE_NAME = "app-settings.json"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_SCHEME = "http"
ALLOWED_SCHEMES = ("http", "https")
HIGHEST_PORT = 65535
PROXY_ENV_NAMES = (
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
)
NO_PROXY_ENV_NAMES = ("NO_PROXY", "no_proxy")
LOCAL_ADDRESSES = (
    "localhost",
    "127.0.0.1",
    "::1",
    "192.168.0.0/16",
    "10.0.0.0/8",
    "172.16.0.0/12",
)
TEST_TARGETS = (
    ("Hugging Face", "https://huggingface.co"),
    ("PyPI", "https://pypi.org/simple/pip/"),
)
TEST_TIMEOUT_SECONDS = 8.0
HTTP_SERVER_ERROR = 500

_lock = threading.Lock()
_launch_env: Dict[str, Optional[str]] = {}


WHAT_TO_TYPE = (
    "Enter an HTTP or mixed port such as 7890, or an address such as 127.0.0.1:7890. / "
    "请填 HTTP 或混合端口（如 7890）或地址（如 127.0.0.1:7890）。"
)
SOCKS_REFUSED = (
    "SOCKS is not supported: pip and some downloads cannot use it. Enter the HTTP or "
    "mixed port of your proxy tool instead, such as 7890. / "
    "不支持 SOCKS：pip 和部分下载用不了。请改填代理工具的 HTTP 或混合端口，如 7890。"
)


class InvalidProxyError(ValueError):
    """What was typed is not a port or a proxy address; str() is the sentence to show."""

    def __init__(self, sentence: str = WHAT_TO_TYPE) -> None:
        super().__init__(sentence)


def _valid_port(port: Optional[int]) -> bool:
    return port is not None and 1 <= port <= HIGHEST_PORT


def normalize_proxy(value: Any) -> str:
    """'7890', 'host:7890' and full URLs become one URL; empty stays empty (no proxy)."""
    text = str(value or "").strip()
    if not text:
        return ""
    if text.isdigit():
        text = f"{DEFAULT_HOST}:{text}"
    if "://" not in text:
        text = f"{DEFAULT_SCHEME}://{text}"
    try:
        parts = urllib.parse.urlsplit(text)
        port = parts.port
    except ValueError as error:
        raise InvalidProxyError() from error
    if parts.scheme.lower().startswith("socks"):
        raise InvalidProxyError(SOCKS_REFUSED)
    has_extra = parts.path not in ("", "/") or parts.query or parts.fragment
    if (
        parts.scheme.lower() not in ALLOWED_SCHEMES
        or not parts.hostname
        or not _valid_port(port)
        or has_extra
        or re.search(r"\s", text)
    ):
        raise InvalidProxyError()
    return f"{parts.scheme.lower()}://{parts.netloc}"


def is_local_address(url: Any) -> bool:
    """This computer or the home network, written as an IP address or localhost.

    httpx ignores the address ranges in NO_PROXY, so its callers ask this instead.
    """
    host = urllib.parse.urlsplit(str(url or "")).hostname or ""
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_private
    except ValueError:
        return False


def masked(proxy: str) -> str:
    """The address without its password, for logs."""
    return re.sub(r"(\w+://)[^/@\s]+@", r"\1***@", proxy)


def _remember_launch_env() -> None:
    if not _launch_env:
        for name in (*PROXY_ENV_NAMES, *NO_PROXY_ENV_NAMES):
            _launch_env[name] = os.environ.get(name)


def _no_proxy_value() -> str:
    addresses: List[str] = list(LOCAL_ADDRESSES)
    for name in NO_PROXY_ENV_NAMES:
        for address in (_launch_env.get(name) or "").split(","):
            if address.strip() and address.strip() not in addresses:
                addresses.append(address.strip())
    return ",".join(addresses)


def _forget_cached_connections() -> None:
    """urllib and the Hugging Face client keep the proxy they first saw; make them look again."""
    urllib.request.install_opener(urllib.request.build_opener())
    hub_http = sys.modules.get("huggingface_hub.utils._http")
    if hub_http is not None:
        hub_http.close_session()


def apply_proxy(proxy: str) -> None:
    """Point this process and the programs it starts at ``proxy``; empty goes back to how it started."""
    with _lock:
        _remember_launch_env()
        if proxy:
            for name in PROXY_ENV_NAMES:
                os.environ[name] = proxy
            for name in NO_PROXY_ENV_NAMES:
                os.environ[name] = _no_proxy_value()
        else:
            for name, original in _launch_env.items():
                if original is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = original
        _forget_cached_connections()


def saved_proxy() -> str:
    import config

    try:
        return normalize_proxy(config._read_app_settings().get(SETTING_KEY))
    except InvalidProxyError:
        logger.warning("The saved network proxy is not valid; going without it")
        return ""


def save_proxy(value: Any) -> str:
    """Check, store and start using the proxy; returns it as stored."""
    import config

    proxy = normalize_proxy(value)
    settings = config._read_app_settings()
    settings[SETTING_KEY] = proxy
    config._write_app_settings(settings)
    apply_proxy(proxy)
    logger.info("Network proxy is now %s", masked(proxy) or "off")
    return proxy


def apply_saved_proxy() -> None:
    """At startup, before anything goes online."""
    proxy = saved_proxy()
    if proxy:
        apply_proxy(proxy)
        logger.info("Using the saved network proxy %s", masked(proxy))


def apply_from_settings_file(config_dir: Optional[str]) -> None:
    """For launchers, which run before the config module can be imported."""
    if not config_dir:
        return
    try:
        settings = json.loads(
            (Path(config_dir) / SETTINGS_FILE_NAME).read_text(encoding="utf-8-sig")
        )
        proxy = normalize_proxy(settings.get(SETTING_KEY))
    except (OSError, ValueError, AttributeError) as error:
        logger.debug("No saved proxy for the launcher: %s", error)
        return
    if proxy:
        apply_proxy(proxy)


def detect_system_proxy() -> str:
    """The proxy the system or the launching shell already names, to offer in one click."""
    with _lock:
        _remember_launch_env()
        named = _launch_env.get("HTTPS_PROXY") or _launch_env.get("HTTP_PROXY")
    if not named and sys.platform == "win32":
        registry = getattr(urllib.request, "getproxies_registry", dict)()
        named = registry.get("https") or registry.get("http")
    try:
        return normalize_proxy(named)
    except InvalidProxyError:
        return ""


def proxy_status() -> Dict[str, str]:
    return {"proxy": saved_proxy(), "system_proxy": detect_system_proxy()}


def _probe(proxy: str, name: str, url: str) -> Dict[str, Any]:
    import httpx

    started = time.perf_counter()
    error = ""
    try:
        with httpx.Client(
            proxy=proxy or None,
            trust_env=False,
            timeout=TEST_TIMEOUT_SECONDS,
            follow_redirects=True,
        ) as client:
            response = client.head(url)
        if response.status_code >= HTTP_SERVER_ERROR:
            error = "failed"
    except httpx.TimeoutException:
        error = "timeout"
    except (httpx.ProxyError, httpx.ConnectError):
        error = "unreachable"
    except (httpx.HTTPError, ValueError, ImportError) as exc:
        logger.debug("Proxy test against %s failed: %s", name, exc)
        error = "failed"
    return {
        "name": name,
        "ok": not error,
        "ms": round((time.perf_counter() - started) * 1000),
        "error": error,
    }


def test_proxy(value: Any) -> Dict[str, Any]:
    """Try the download sites through this proxy (or directly when empty); nothing is saved."""
    proxy = normalize_proxy(value)
    with ThreadPoolExecutor(max_workers=len(TEST_TARGETS)) as pool:
        results: List[Dict[str, Any]] = list(
            pool.map(lambda target: _probe(proxy, *target), TEST_TARGETS)
        )
    return {"proxy": proxy, "results": results}
