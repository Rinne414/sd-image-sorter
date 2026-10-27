"""A failed video support install is said in words, never as the system's own error text."""

from __future__ import annotations

import http.client
import re
import socket
import urllib.error
from pathlib import Path

import pytest

from services.ffmpeg_install import InstallError, failure_code

LANG = Path(__file__).resolve().parents[2] / "frontend" / "js" / "lang"


@pytest.mark.parametrize(
    ("exc", "code", "params"),
    [
        (urllib.error.URLError(ConnectionRefusedError(10061, "[WinError 10061] 無法連線")), "video_install_unreachable", {}),
        (urllib.error.URLError(socket.timeout("timed out")), "video_install_timeout", {}),
        (socket.timeout("timed out"), "video_install_timeout", {}),
        (urllib.error.HTTPError("https://example.invalid", 404, "Not Found", {}, None), "video_install_site_refused", {"status": 404}),
        (ConnectionResetError(10054, "reset"), "video_install_connection_broken", {}),
        (http.client.IncompleteRead(b"part"), "video_install_connection_broken", {}),
        (InstallError("no checksum", "video_install_no_checksum"), "video_install_no_checksum", {"reason": "no checksum"}),
    ],
)
def test_install_failures_get_our_code(exc, code, params):
    assert failure_code(exc) == (code, params)


def test_an_unknown_failure_keeps_its_reason():
    assert failure_code(ValueError("odd")) == ("video_install_failed", {"reason": "odd"})


@pytest.mark.parametrize("pack", ["en.js", "zh-CN.js"])
def test_every_network_code_has_words_in_both_languages(pack):
    text = (LANG / pack).read_text(encoding="utf-8")
    keys = set(re.findall(r"^\s*'(apiError\.[a-z0-9_]+)'\s*:", text, re.M))
    for code in ("video_install_site_refused", "video_install_timeout", "video_install_unreachable", "video_install_connection_broken"):
        assert f"apiError.{code}" in keys, (pack, code)
