"""A port typed once carries every download; local addresses never use it."""

from __future__ import annotations

import json
import os
import sys
import types
import urllib.request
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import config
import network_proxy
from routers import network


@pytest.fixture(autouse=True)
def clean_proxy_env(monkeypatch, tmp_path):
    """Each test starts with no proxy, its own settings file, and leaves the process as it found it."""
    names = (*network_proxy.PROXY_ENV_NAMES, *network_proxy.NO_PROXY_ENV_NAMES)
    # apply_proxy writes os.environ itself, which monkeypatch would not undo.
    before = {name: os.environ.get(name) for name in names}
    for name in names:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(network_proxy, "_launch_env", {})
    monkeypatch.setattr(
        config, "APP_SETTINGS_CONFIG_PATH", tmp_path / "app-settings.json"
    )
    monkeypatch.setattr(config, "CONFIG_DIR", tmp_path)
    monkeypatch.setattr(network_proxy.urllib.request, "getproxies_registry", lambda: {}, raising=False)
    yield
    for name, value in before.items():
        if value is None:
            os.environ.pop(name, None)
        else:
            os.environ[name] = value
    urllib.request.install_opener(urllib.request.build_opener())


@pytest.mark.parametrize(
    ("typed", "expected"),
    [
        ("", ""),
        ("   ", ""),
        (None, ""),
        ("7890", "http://127.0.0.1:7890"),
        (" 7890 ", "http://127.0.0.1:7890"),
        ("127.0.0.1:7897", "http://127.0.0.1:7897"),
        ("localhost:10809", "http://localhost:10809"),
        ("http://127.0.0.1:7890/", "http://127.0.0.1:7890"),
        ("HTTP://proxy.lan:8080", "http://proxy.lan:8080"),
        ("http://me:secret@proxy.lan:8080", "http://me:secret@proxy.lan:8080"),
    ],
)
def test_what_people_type_becomes_one_address(typed, expected):
    assert network_proxy.normalize_proxy(typed) == expected


@pytest.mark.parametrize(
    "typed",
    [
        "0",
        "70000",
        "abc",
        "127.0.0.1",
        "http://",
        "ftp://127.0.0.1:21",
        "127.0.0.1:port",
        "http://a:80/path",
        "1 2",
        "socks5://127.0.0.1:1080",
    ],
)
def test_anything_else_is_refused_with_a_sentence(typed):
    with pytest.raises(network_proxy.InvalidProxyError, match="7890"):
        network_proxy.normalize_proxy(typed)


@pytest.mark.parametrize("typed", ["socks5://127.0.0.1:7897", "SOCKS5H://127.0.0.1:1080", "socks4://h:1080"])
def test_a_socks_address_says_socks_is_not_supported_and_why(typed):
    # A Clash or v2rayN user who copies the SOCKS line must learn what to type instead.
    with pytest.raises(network_proxy.InvalidProxyError) as caught:
        network_proxy.normalize_proxy(typed)
    english, chinese = str(caught.value).split(" / ")
    assert "SOCKS" in english and "pip" in english and "7890" in english
    assert "SOCKS" in chinese and "7890" in chinese


def test_saving_points_downloads_and_child_programs_at_it():
    network_proxy.save_proxy("7890")
    for name in network_proxy.PROXY_ENV_NAMES:
        assert os.environ[name] == "http://127.0.0.1:7890"
    assert urllib.request.getproxies()["https"] == "http://127.0.0.1:7890"
    assert network_proxy.saved_proxy() == "http://127.0.0.1:7890"


@pytest.mark.parametrize("address", ["localhost", "127.0.0.1", "::1"])
def test_local_addresses_never_go_through_it(address):
    network_proxy.save_proxy("7890")
    assert address in os.environ["NO_PROXY"].split(",")


def test_httpx_uses_it_for_the_internet_and_not_for_this_computer():
    import httpx

    network_proxy.save_proxy("7890")
    with httpx.Client() as client:
        internet = client._transport_for_url(httpx.URL("https://huggingface.co/x"))
        local = client._transport_for_url(httpx.URL("http://127.0.0.1:8188/prompt"))
    assert internet is not client._transport
    assert local is client._transport


def test_urllib_stops_using_a_proxy_it_already_saw():
    network_proxy.save_proxy("7890")
    urllib.request.install_opener(urllib.request.build_opener())
    network_proxy.save_proxy("7897")
    handlers = urllib.request._opener.handlers
    proxy_handler = next(
        h for h in handlers if isinstance(h, urllib.request.ProxyHandler)
    )
    assert proxy_handler.proxies["https"] == "http://127.0.0.1:7897"


def test_clearing_goes_back_to_how_the_program_was_started(monkeypatch):
    monkeypatch.setenv("HTTPS_PROXY", "http://from-the-shell:3128")
    monkeypatch.setenv("NO_PROXY", "intranet.example")
    network_proxy.save_proxy("7890")
    assert "intranet.example" in os.environ["NO_PROXY"].split(",")
    network_proxy.save_proxy("")
    assert os.environ["HTTPS_PROXY"] == "http://from-the-shell:3128"
    assert os.environ["NO_PROXY"] == "intranet.example"
    assert "HTTP_PROXY" not in os.environ
    assert network_proxy.saved_proxy() == ""


def test_the_saved_proxy_is_back_after_a_restart():
    network_proxy.save_proxy("7890")
    for name in network_proxy.PROXY_ENV_NAMES:
        os.environ.pop(name, None)
    network_proxy.apply_saved_proxy()
    assert os.environ["HTTP_PROXY"] == "http://127.0.0.1:7890"


def test_launchers_read_the_saved_proxy_from_the_file(tmp_path):
    (tmp_path / network_proxy.SETTINGS_FILE_NAME).write_text(
        json.dumps({network_proxy.SETTING_KEY: "7890"}), encoding="utf-8"
    )
    network_proxy.apply_from_settings_file(str(tmp_path))
    assert os.environ["HTTPS_PROXY"] == "http://127.0.0.1:7890"


@pytest.mark.parametrize(
    "content", ["not json", "[]", json.dumps({network_proxy.SETTING_KEY: "nonsense"})]
)
def test_a_launcher_is_never_stopped_by_a_bad_settings_file(tmp_path, content):
    (tmp_path / network_proxy.SETTINGS_FILE_NAME).write_text(content, encoding="utf-8")
    network_proxy.apply_from_settings_file(str(tmp_path))
    assert "HTTP_PROXY" not in os.environ


def test_a_bad_saved_value_is_ignored():
    config._write_app_settings({network_proxy.SETTING_KEY: "nonsense"})
    assert network_proxy.saved_proxy() == ""


def test_the_system_proxy_is_offered_when_there_is_one(monkeypatch):
    monkeypatch.setattr(
        network_proxy.urllib.request,
        "getproxies_registry",
        lambda: {"https": "127.0.0.1:7897"},
        raising=False,
    )
    # Only network_proxy sees Windows: patching the shared sys module would make
    # ssl read the Windows certificate store on Linux and macOS.
    fake_sys = types.SimpleNamespace(platform="win32", modules=sys.modules)
    monkeypatch.setattr(network_proxy, "sys", fake_sys)
    assert network_proxy.proxy_status() == {
        "proxy": "",
        "system_proxy": "http://127.0.0.1:7897",
    }


def test_our_own_proxy_is_not_offered_back_as_the_system_one():
    network_proxy.save_proxy("7890")
    assert network_proxy.proxy_status()["system_proxy"] == ""


def test_passwords_stay_out_of_logs():
    assert (
        network_proxy.masked("http://me:secret@proxy.lan:8080")
        == "http://***@proxy.lan:8080"
    )


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(network.router)
    return TestClient(app)


def test_saving_through_the_page(client):
    answer = client.post("/api/network/proxy", json={"proxy": "7890"})
    assert answer.status_code == 200
    assert answer.json()["proxy"] == "http://127.0.0.1:7890"
    assert client.get("/api/network/proxy").json()["proxy"] == "http://127.0.0.1:7890"


def test_a_bad_address_is_a_400_that_says_what_to_type(client):
    answer = client.post("/api/network/proxy", json={"proxy": "nonsense"})
    assert answer.status_code == 400
    assert "7890" in answer.json()["detail"]
    assert network_proxy.saved_proxy() == ""


def test_the_proxy_cannot_change_under_a_running_install(client, monkeypatch):
    from routers import models as models_router

    monkeypatch.setitem(models_router._prepare_result, "active", True)
    answer = client.post("/api/network/proxy", json={"proxy": "7890"})
    assert answer.status_code == 409
    assert "安装" in answer.json()["detail"]
    assert network_proxy.saved_proxy() == ""


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        ("http://127.0.0.1:11434/v1", True),
        ("http://192.168.1.20:1234/v1", True),
        ("http://10.0.0.5:8000", True),
        ("http://localhost:1234", True),
        ("http://[::1]:1234", True),
        ("https://api.openai.com/v1", False),
        ("https://8.8.8.8/", False),
        ("", False),
        (None, False),
    ],
)
def test_what_counts_as_a_local_address(url, expected):
    assert network_proxy.is_local_address(url) is expected


def test_a_captioning_server_at_home_skips_the_proxy_and_a_cloud_one_uses_it():
    import httpx

    from vlm_providers.base import VLMConfig, make_async_client

    network_proxy.save_proxy("7890")
    at_home = make_async_client(VLMConfig(endpoint="http://192.168.1.20:1234/v1"))
    cloud = make_async_client(VLMConfig(endpoint="https://api.openai.com/v1"))
    url = httpx.URL("https://example.com/")
    assert at_home._transport_for_url(url) is at_home._transport
    assert cloud._transport_for_url(url) is not cloud._transport


def test_other_web_pages_cannot_change_it():
    app = FastAPI()
    app.include_router(network.router)
    other_site = TestClient(
        app, headers={"Origin": "http://evil.example", "Host": "127.0.0.1:8487"}
    )
    assert other_site.get("/api/network/proxy").status_code == 403
    assert (
        other_site.post("/api/network/proxy", json={"proxy": "7890"}).status_code == 403
    )
    assert (
        other_site.post("/api/network/proxy/test", json={"proxy": "7890"}).status_code
        == 403
    )
    assert network_proxy.saved_proxy() == ""


def test_the_test_says_which_site_answered_and_saves_nothing(client, monkeypatch):
    seen = []

    def fake_probe(proxy, name, url):
        seen.append((proxy, url))
        return {
            "name": name,
            "ok": name == "PyPI",
            "ms": 12,
            "error": "" if name == "PyPI" else "unreachable",
        }

    monkeypatch.setattr(network_proxy, "_probe", fake_probe)
    answer = client.post("/api/network/proxy/test", json={"proxy": "7890"}).json()
    assert answer["proxy"] == "http://127.0.0.1:7890"
    assert {r["name"]: r["ok"] for r in answer["results"]} == {
        "Hugging Face": False,
        "PyPI": True,
    }
    assert all(proxy == "http://127.0.0.1:7890" for proxy, _url in seen)
    assert network_proxy.saved_proxy() == ""


def test_a_real_closed_port_reads_as_unreachable():
    result = network_proxy._probe(
        "http://127.0.0.1:9", "PyPI", "http://example.invalid/"
    )
    assert result["ok"] is False
    assert result["error"] in {"unreachable", "timeout"}


def test_the_module_can_load_before_packages_exist():
    tree = Path(network_proxy.__file__).read_text(encoding="utf-8")
    top_level = [
        line for line in tree.splitlines() if line.startswith(("import ", "from "))
    ]
    assert not any("httpx" in line or "config" in line for line in top_level)
