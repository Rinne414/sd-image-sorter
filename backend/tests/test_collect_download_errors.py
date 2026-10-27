"""A failed picture download is said in words, never as the system's own error text."""

from __future__ import annotations

import httpx
import pytest

from services.collect_download import network_error

REQUEST = httpx.Request("GET", "https://example.invalid/picture.png")


@pytest.mark.parametrize(
    ("exc", "code"),
    [
        (httpx.ConnectError("[WinError 10061] 無法連線", request=REQUEST), "collect_site_unreachable"),
        (httpx.ConnectTimeout("timed out", request=REQUEST), "collect_download_timeout"),
        (httpx.ReadTimeout("timed out", request=REQUEST), "collect_download_timeout"),
        (httpx.TooManyRedirects("redirects", request=REQUEST), "collect_too_many_redirects"),
        (httpx.RemoteProtocolError("peer closed", request=REQUEST), "collect_connection_broken"),
        (httpx.ReadError("reset", request=REQUEST), "collect_connection_broken"),
    ],
)
def test_network_failures_get_a_code_and_no_system_text(exc, code):
    error = network_error(exc)
    assert error.code == code
    assert "WinError" not in error.message and "無法" not in error.message
    assert error.params == {}


def test_an_unknown_failure_keeps_its_reason():
    error = network_error(httpx.DecodingError("bad gzip", request=REQUEST))
    assert error.code == "collect_download_failed"
    assert error.params["reason"] == "bad gzip"
