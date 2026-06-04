"""Tests for the in-process browser opener (main._maybe_open_browser_when_ready).

Replaces the old run.bat / run-portable.bat hidden-PowerShell probe that some
antivirus engines (Huorong / 火绒) flagged as trojan-like. The opener must:
  * stay silent unless a launcher opts in via SD_IMAGE_SORTER_OPEN_BROWSER, and
  * open the URL only once the server is actually accepting connections.
"""
import socket
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import main


def test_does_nothing_without_opt_in(monkeypatch):
    opened = []
    monkeypatch.setattr("webbrowser.open", lambda url: opened.append(url))
    monkeypatch.delenv("SD_IMAGE_SORTER_OPEN_BROWSER", raising=False)

    main._maybe_open_browser_when_ready("127.0.0.1", 59321)
    time.sleep(0.25)
    assert opened == []


def test_opens_when_server_ready(monkeypatch):
    # A real listening socket makes the connection probe succeed immediately.
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", 0))
    srv.listen(1)
    port = srv.getsockname()[1]

    opened = []
    monkeypatch.setattr("webbrowser.open", lambda url: opened.append(url))
    monkeypatch.setenv("SD_IMAGE_SORTER_OPEN_BROWSER", "1")
    try:
        main._maybe_open_browser_when_ready("127.0.0.1", port)
        deadline = time.time() + 4.0
        while time.time() < deadline and not opened:
            time.sleep(0.05)
    finally:
        srv.close()

    assert opened == [f"http://127.0.0.1:{port}"]


def test_wildcard_host_maps_to_loopback(monkeypatch):
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", 0))
    srv.listen(1)
    port = srv.getsockname()[1]

    opened = []
    monkeypatch.setattr("webbrowser.open", lambda url: opened.append(url))
    monkeypatch.setenv("SD_IMAGE_SORTER_OPEN_BROWSER", "1")
    try:
        main._maybe_open_browser_when_ready("0.0.0.0", port)
        deadline = time.time() + 4.0
        while time.time() < deadline and not opened:
            time.sleep(0.05)
    finally:
        srv.close()

    # Wildcard bind is not a connectable target; the browser URL uses loopback.
    assert opened == [f"http://127.0.0.1:{port}"]
