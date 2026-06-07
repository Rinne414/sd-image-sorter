"""Tests for VLM provider proxy wiring (``get_proxies`` + ``make_async_client``).

These lock in the behaviour verified live during the v3.3.x proxy audit:

* HTTP / HTTPS proxies are actually applied to the httpx client (the proxy URL
  shows up on the mounted transport), and the same client is used by every VLM
  provider (OpenAI-compat, Anthropic, Gemini all call ``make_async_client``).
* A SOCKS proxy without the optional ``socksio`` backend now fails with a clear,
  actionable ``ProviderError`` instead of crashing with httpx's raw
  ``ImportError`` — the old fallback only caught ``TypeError``/``ValueError`` so
  the ImportError escaped and killed the request.

The mount-count assertions are the version-stable backstop; the proxy-URL
assertions dig into httpx internals best-effort so a future rename degrades to
the count check rather than a false failure.
"""
from __future__ import annotations

import asyncio
from typing import List

import httpx
import pytest

from vlm_providers.base import ProviderError, VLMConfig, make_async_client


def _proxy_urls(client: httpx.AsyncClient) -> List[str]:
    urls: List[str] = []
    for transport in (getattr(client, "_mounts", {}) or {}).values():
        pool = getattr(transport, "_pool", None)
        proxy_url = getattr(pool, "_proxy_url", None)
        if proxy_url is not None:
            urls.append(str(proxy_url))
    return urls


def _mount_count(client: httpx.AsyncClient) -> int:
    return len(getattr(client, "_mounts", {}) or {})


def _build_and_close(config: VLMConfig):
    """Build a client, snapshot its proxy wiring, then close it cleanly."""

    async def _run():
        client = make_async_client(config)
        try:
            return _mount_count(client), _proxy_urls(client)
        finally:
            await client.aclose()

    return asyncio.run(_run())


# --------------------------------------------------------------------------
# get_proxies() mapping
# --------------------------------------------------------------------------


def test_get_proxies_none_when_unset():
    assert VLMConfig(endpoint="https://api.openai.com/v1").get_proxies() is None


def test_get_proxies_http_only():
    cfg = VLMConfig(http_proxy="http://127.0.0.1:8080")
    assert cfg.get_proxies() == {"http://": "http://127.0.0.1:8080"}


def test_get_proxies_http_and_https():
    cfg = VLMConfig(
        http_proxy="http://127.0.0.1:8080", https_proxy="http://127.0.0.1:9090"
    )
    assert cfg.get_proxies() == {
        "http://": "http://127.0.0.1:8080",
        "https://": "http://127.0.0.1:9090",
    }


def test_get_proxies_socks_covers_both_schemes():
    cfg = VLMConfig(socks_proxy="socks5://127.0.0.1:1080")
    assert cfg.get_proxies() == {
        "http://": "socks5://127.0.0.1:1080",
        "https://": "socks5://127.0.0.1:1080",
    }


def test_get_proxies_socks_overrides_http_https():
    # SOCKS takes precedence: when set, the http/https proxy fields are ignored
    # (a SOCKS tunnel carries both schemes).
    cfg = VLMConfig(
        http_proxy="http://127.0.0.1:8080",
        https_proxy="http://127.0.0.1:9090",
        socks_proxy="socks5://127.0.0.1:1080",
    )
    assert cfg.get_proxies() == {
        "http://": "socks5://127.0.0.1:1080",
        "https://": "socks5://127.0.0.1:1080",
    }


# --------------------------------------------------------------------------
# make_async_client wiring
# --------------------------------------------------------------------------


def test_make_async_client_no_proxy_has_no_mounts():
    count, urls = _build_and_close(VLMConfig(endpoint="https://api.openai.com/v1"))
    assert count == 0
    assert urls == []


def test_make_async_client_http_proxy_is_wired():
    count, urls = _build_and_close(
        VLMConfig(endpoint="https://api.openai.com/v1", http_proxy="http://127.0.0.1:8080")
    )
    assert count >= 1
    assert any("8080" in u for u in urls), urls


def test_make_async_client_split_http_https_proxies_wired():
    count, urls = _build_and_close(
        VLMConfig(
            endpoint="https://api.openai.com/v1",
            http_proxy="http://127.0.0.1:8080",
            https_proxy="http://127.0.0.1:9090",
        )
    )
    assert count >= 2
    assert any("8080" in u for u in urls), urls
    assert any("9090" in u for u in urls), urls


def test_make_async_client_socks_proxy_wired_when_socksio_present():
    # socksio ships in requirements(-core).txt; when present the SOCKS proxy is
    # mounted on the transport just like an HTTP proxy.
    pytest.importorskip("socksio")
    count, urls = _build_and_close(
        VLMConfig(
            endpoint="https://api.openai.com/v1", socks_proxy="socks5://127.0.0.1:1080"
        )
    )
    assert count >= 1
    assert any("socks5" in u for u in urls), urls


def test_make_async_client_socks_missing_socksio_raises_clear_error(monkeypatch):
    """Regression: SOCKS proxy without socksio must raise an actionable
    ProviderError, not crash with httpx's raw ImportError."""
    import vlm_providers.base as base

    class _NoSocksAsyncClient:
        def __init__(self, *args, **kwargs):
            raise ImportError(
                "Using SOCKS proxy, but the 'socksio' package is not installed."
            )

    monkeypatch.setattr(base.httpx, "AsyncClient", _NoSocksAsyncClient)
    cfg = VLMConfig(
        endpoint="https://api.openai.com/v1", socks_proxy="socks5://127.0.0.1:1080"
    )
    with pytest.raises(ProviderError) as excinfo:
        make_async_client(cfg)
    message = str(excinfo.value).lower()
    assert "socksio" in message
    assert "httpx[socks]" in message
    assert excinfo.value.error_type == "config"
    assert excinfo.value.retryable is False


def test_make_async_client_malformed_proxy_falls_back_to_direct(monkeypatch):
    """A non-SOCKS proxy kwarg rejected by httpx degrades to a direct client
    instead of hard-failing captioning (a typo shouldn't break everything)."""
    import vlm_providers.base as base

    real_async_client = base.httpx.AsyncClient
    calls = {"n": 0}

    class _PickyAsyncClient:
        def __new__(cls, *args, **kwargs):
            calls["n"] += 1
            # First call (with proxy kwarg) is rejected; the retry without the
            # proxy must succeed and produce a real client.
            if "proxy" in kwargs or "mounts" in kwargs:
                raise TypeError("unexpected keyword argument 'proxy'")
            return real_async_client(*args, **kwargs)

    monkeypatch.setattr(base.httpx, "AsyncClient", _PickyAsyncClient)
    cfg = VLMConfig(
        endpoint="https://api.openai.com/v1", http_proxy="http://127.0.0.1:8080"
    )

    async def _run():
        client = make_async_client(cfg)
        try:
            assert isinstance(client, real_async_client)
        finally:
            await client.aclose()

    asyncio.run(_run())
    assert calls["n"] >= 2  # proxied attempt + direct fallback
