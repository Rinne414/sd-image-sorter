"""Browser extension lane, pairing, and collecting pictures (S3/S4).

The /api/ext/ lane accepts an extension origin and nothing else that the
global guard refuses; every call but ping and the pairing request needs a
token the user approved inside the program. Collected pictures are saved to
<output root>/collected/<date>/, indexed in the background and keep their
source. A picture can also come from a paste or a pasted address, which the
program downloads (with the page as Referer when it has one).
"""

from __future__ import annotations

import io
import json
import threading
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from PIL import Image
from PIL.PngImagePlugin import PngInfo

import config
from app_security import api_request_rejection
from services import browser_extension_package as package
from services.collect_importer import get_collect_importer
from services.ext_pairing import (
    STATE_APPROVED,
    STATE_DENIED,
    STATE_PENDING,
    STATE_UNKNOWN,
    PairingError,
    PairingRegistry,
    get_pairing_registry,
)

BOUND = 8487
CHROME_ORIGIN = "chrome-extension://" + "abcdefghijklmnopabcdefghijklmnop"
OTHER_CHROME_ORIGIN = "chrome-extension://" + "ponmlkjihgfedcbaponmlkjihgfedcba"
FIREFOX_ORIGIN = "moz-extension://0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0"
TOKEN = "T" * 43
OTHER_TOKEN = "U" * 43
PROMPT = "1girl, solo, collected from the web"


def _reject(headers, *, path="/api/ext/collect", method="POST", check=None):
    return api_request_rejection(
        path=path,
        method=method,
        headers={
            "host": f"127.0.0.1:{BOUND}",
            **{k.lower(): v for k, v in headers.items()},
        },
        bound_port=BOUND,
        testing=False,
        ext_token_check=check,
    )


def _paired_check(origin=CHROME_ORIGIN, token=TOKEN):
    return lambda _path, got_origin, got_token: (
        got_token == token and got_origin in (origin, None)
    )


# The guard -------------------------------------------------------------------


class TestExtensionLaneGuard:
    def test_paired_origin_with_its_token_passes(self):
        headers = {"Origin": CHROME_ORIGIN, "X-SD-Ext-Token": TOKEN}
        assert _reject(headers, check=_paired_check()) is None

    def test_firefox_origin_with_its_token_passes(self):
        headers = {"Origin": FIREFOX_ORIGIN, "X-SD-Ext-Token": TOKEN}
        assert _reject(headers, check=_paired_check(origin=FIREFOX_ORIGIN)) is None

    def test_extension_origin_without_a_token_is_refused(self):
        assert _reject({"Origin": CHROME_ORIGIN}, check=_paired_check()) == "token"

    def test_unknown_extension_origin_is_refused(self):
        headers = {"Origin": OTHER_CHROME_ORIGIN, "X-SD-Ext-Token": TOKEN}
        assert _reject(headers, check=_paired_check()) == "token"

    def test_forged_origin_from_curl_without_token_is_refused(self):
        # A browser page cannot send this Origin, but any local process can.
        assert _reject({"Origin": CHROME_ORIGIN}) == "token"
        assert (
            _reject(
                {"Origin": CHROME_ORIGIN, "X-SD-Ext-Token": OTHER_TOKEN},
                check=_paired_check(),
            )
            == "token"
        )

    @pytest.mark.parametrize(
        "origin",
        [
            "https://evil.example",
            "http://127.0.0.1:3000",  # another local web app: not on this lane
            "http://127.0.0.1:8487",
            "chrome-extension://abc",
            "chrome-extension://" + "q" * 32,
            "moz-extension://not-a-uuid",
            CHROME_ORIGIN + "/path",
            "null",
        ],
    )
    def test_anything_but_an_extension_origin_is_refused(self, origin):
        headers = {"Origin": origin, "X-SD-Ext-Token": TOKEN}
        assert _reject(headers, check=_paired_check()) == "origin"
        assert _reject(headers, path="/api/ext/pair", check=_paired_check()) == "origin"

    def test_only_post_reaches_the_lane(self):
        # A link, an iframe or a GET form can never reach it.
        headers = {"X-SD-Ext-Token": TOKEN}
        assert _reject(headers, method="GET", check=_paired_check()) == "method"
        assert _reject({}, path="/api/ext/ping", method="GET") == "method"

    def test_ping_and_pair_request_are_open_but_not_to_web_pages(self):
        assert _reject({"Origin": CHROME_ORIGIN}, path="/api/ext/ping") is None
        assert _reject({"Origin": CHROME_ORIGIN}, path="/api/ext/pair") is None
        assert _reject({}, path="/api/ext/pair") is None

    def test_pair_status_needs_a_token(self):
        assert (
            _reject({"Origin": CHROME_ORIGIN}, path="/api/ext/pair/status") == "token"
        )

    def test_preflight_passes_without_a_token(self):
        assert _reject({"Origin": CHROME_ORIGIN}, method="OPTIONS") is None

    def test_host_rule_still_applies(self):
        headers = {
            "Origin": CHROME_ORIGIN,
            "X-SD-Ext-Token": TOKEN,
            "host": "attacker.example:8487",
        }
        assert _reject(headers, check=_paired_check()) == "host"

    def test_global_guard_is_unchanged_for_other_paths(self):
        headers = {"Origin": CHROME_ORIGIN, "X-SD-Ext-Token": TOKEN}
        assert (
            _reject(headers, path="/api/images", method="GET", check=_paired_check())
            == "origin"
        )
        assert (
            _reject(
                {"Origin": "http://localhost:3000"}, path="/api/images", method="GET"
            )
            is None
        )


# Pairing registry ------------------------------------------------------------------


@pytest.fixture
def registry(tmp_path):
    reg = get_pairing_registry()
    reg.reset_for_tests(tmp_path / "browser-extensions.json")
    yield reg
    reg.reset_for_tests(None)


def test_pairing_waits_for_the_user_then_the_token_works(registry, tmp_path):
    pairing = registry.request(
        origin=CHROME_ORIGIN,
        name="Chrome on this computer",
        browser="chrome",
        token=TOKEN,
    )
    assert registry.state_for(TOKEN, CHROME_ORIGIN) == STATE_PENDING
    assert registry.authorize(TOKEN, CHROME_ORIGIN) is None
    assert [p["id"] for p in registry.pending()] == [pairing.id]

    approved = registry.decide(pairing.id, True)

    assert approved["state"] == STATE_APPROVED and "token_hash" not in approved
    assert registry.authorize(TOKEN, CHROME_ORIGIN)["id"] == pairing.id
    assert registry.authorize(TOKEN, None) is not None  # a client that sends no Origin
    assert registry.authorize(TOKEN, OTHER_CHROME_ORIGIN) is None
    assert registry.authorize(OTHER_TOKEN, CHROME_ORIGIN) is None
    stored = (tmp_path / "browser-extensions.json").read_text(encoding="utf-8")
    assert TOKEN not in stored  # only the hash is kept
    # It survives a restart.
    fresh = PairingRegistry(tmp_path / "browser-extensions.json")
    assert fresh.authorize(TOKEN, CHROME_ORIGIN) is not None


def test_denied_and_revoked_pairings_do_not_work(registry):
    pairing = registry.request(
        origin=CHROME_ORIGIN, name="x", browser="chrome", token=TOKEN
    )
    registry.decide(pairing.id, False)
    assert registry.state_for(TOKEN, CHROME_ORIGIN) == STATE_DENIED
    assert registry.authorize(TOKEN, CHROME_ORIGIN) is None
    assert registry.decide(pairing.id, True) is None  # answered once

    again = registry.request(
        origin=CHROME_ORIGIN, name="x", browser="chrome", token=OTHER_TOKEN
    )
    registry.decide(again.id, True)
    assert registry.authorize(OTHER_TOKEN, CHROME_ORIGIN) is not None
    assert registry.revoke(again.id) is True
    assert registry.authorize(OTHER_TOKEN, CHROME_ORIGIN) is None
    assert registry.state_for(OTHER_TOKEN, CHROME_ORIGIN) == STATE_UNKNOWN


def test_pairing_request_rejects_bad_tokens_and_web_origins(registry):
    with pytest.raises(PairingError):
        registry.request(
            origin=CHROME_ORIGIN, name="x", browser="chrome", token="short"
        )
    with pytest.raises(PairingError):
        registry.request(
            origin="https://evil.example", name="x", browser="chrome", token=TOKEN
        )


# End to end over HTTP ---------------------------------------------------------------


def _sd_png_bytes(prompt=PROMPT) -> bytes:
    info = PngInfo()
    info.add_text(
        "parameters",
        f"{prompt}\nNegative prompt: lowres\nSteps: 20, Sampler: Euler a, CFG scale: 6, Seed: 7, Size: 64x64, Model: testmodel",
    )
    buffer = io.BytesIO()
    Image.new("RGB", (64, 64), (200, 80, 40)).save(buffer, format="PNG", pnginfo=info)
    return buffer.getvalue()


def _ext_headers(token=TOKEN, origin=CHROME_ORIGIN):
    headers = {"Origin": origin}
    if token:
        headers["X-SD-Ext-Token"] = token
    return headers


def _pair(client, registry, token=TOKEN, origin=CHROME_ORIGIN):
    answer = client.post(
        "/api/ext/pair",
        json={"token": token, "name": "Chrome on this computer", "browser": "chrome"},
        headers={"Origin": origin},
    )
    assert answer.status_code == 200, answer.text
    pending = client.get("/api/browser-extension/state").json()["pending"]
    assert pending and pending[0]["name"] == "Chrome on this computer"
    decided = client.post(
        f"/api/browser-extension/pairings/{answer.json()['id']}/decide",
        json={"allow": True},
    )
    assert decided.status_code == 200, decided.text


def _collect_bytes(client, data, *, headers, name="artwork.png", meta=None):
    meta = meta or {
        "source_url": "https://img.example/full/artwork.png",
        "page_url": "https://site.example/post/1",
        "page_title": "A post",
        "filename": name,
    }
    return client.post(
        "/api/ext/collect",
        files={"file": (name, data, "image/png")},
        data={"meta": json.dumps(meta)},
        headers=headers,
    )


def _wait_imported(path: str):
    import database as db

    assert get_collect_importer().wait_idle(30), get_collect_importer().status()
    row = db.get_image_by_path(path)
    assert row, f"{path} was not indexed"
    return row


def test_extension_pairs_collects_and_the_source_is_kept(test_client, registry):
    client = test_client
    assert (
        client.post("/api/ext/ping", headers={"Origin": CHROME_ORIGIN}).json()[
            "pairing"
        ]
        == STATE_UNKNOWN
    )
    refused = _collect_bytes(client, _sd_png_bytes(), headers=_ext_headers())
    assert refused.status_code == 403 and refused.json()["code"] == "ext_not_paired"

    _pair(client, registry)
    status = client.post("/api/ext/pair/status", headers=_ext_headers()).json()
    assert status["state"] == STATE_APPROVED

    saved = _collect_bytes(client, _sd_png_bytes(), headers=_ext_headers())
    assert saved.status_code == 200, saved.text
    body = saved.json()
    day = datetime.now().strftime("%Y-%m-%d")
    assert Path(body["folder"]) == config.output_root() / "collected" / day
    assert body["filename"] == "artwork.png"
    assert saved.headers["access-control-allow-origin"] == CHROME_ORIGIN

    row = _wait_imported(body["path"])
    assert PROMPT in (row.get("prompt") or "")  # generation metadata was read
    source = client.get(f"/api/collect/source/{row['id']}").json()["source"]
    assert source["page_url"] == "https://site.example/post/1"
    assert source["source_url"] == "https://img.example/full/artwork.png"
    assert source["page_title"] == "A post" and source["via"] == "extension"

    second = _collect_bytes(client, _sd_png_bytes("second"), headers=_ext_headers())
    assert second.json()["filename"] == "artwork_2.png"  # name_2 on a clash


def test_revoked_extension_is_refused_and_cors_is_only_for_known_origins(
    test_client, registry
):
    client = test_client
    _pair(client, registry)
    preflight = client.options(
        "/api/ext/collect",
        headers={
            "Origin": CHROME_ORIGIN,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "x-sd-ext-token",
        },
    )
    assert preflight.status_code == 204
    assert preflight.headers["access-control-allow-origin"] == CHROME_ORIGIN
    assert "X-SD-Ext-Token" in preflight.headers["access-control-allow-headers"]
    stranger = client.options(
        "/api/ext/collect",
        headers={
            "Origin": OTHER_CHROME_ORIGIN,
            "Access-Control-Request-Method": "POST",
        },
    )
    assert "access-control-allow-origin" not in stranger.headers
    web_page = client.options(
        "/api/ext/collect",
        headers={
            "Origin": "https://evil.example",
            "Access-Control-Request-Method": "POST",
        },
    )
    assert web_page.status_code == 403

    paired_id = client.get("/api/browser-extension/paired").json()["paired"][0]["id"]
    assert (
        client.delete(f"/api/browser-extension/pairings/{paired_id}").status_code == 200
    )
    after = _collect_bytes(client, _sd_png_bytes(), headers=_ext_headers())
    assert after.status_code == 403 and after.json()["code"] == "ext_not_paired"


def test_pairing_cannot_be_answered_from_another_site(test_client, registry):
    pairing = registry.request(
        origin=CHROME_ORIGIN, name="x", browser="chrome", token=TOKEN
    )
    cross = test_client.post(
        f"/api/browser-extension/pairings/{pairing.id}/decide",
        json={"allow": True},
        headers={"Origin": "http://localhost:3000", "Sec-Fetch-Site": "cross-site"},
    )
    assert cross.status_code == 403
    assert registry.authorize(TOKEN, CHROME_ORIGIN) is None


def test_a_file_that_is_not_a_picture_is_refused(test_client, registry):
    _pair(test_client, registry)
    answer = _collect_bytes(
        test_client,
        b"<html>login required</html>",
        headers=_ext_headers(),
        name="x.png",
    )
    assert answer.status_code == 415
    folder = config.output_root() / "collected" / datetime.now().strftime("%Y-%m-%d")
    assert not [p for p in folder.glob("*") if p.is_file()] if folder.exists() else True


# Downloading by address ------------------------------------------------------------------


class _RefererServer:
    """Serves one PNG, but only to a request whose Referer is the page."""

    def __init__(self, png: bytes, page: str):
        handler = self._handler(png, page)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @staticmethod
    def _handler(png: bytes, page: str):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802 - http.server API
                if self.headers.get("Referer") != page:
                    self.send_response(403)
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header("Content-Type", "image/png")
                self.send_header("Content-Length", str(len(png)))
                self.end_headers()
                self.wfile.write(png)

            def log_message(self, *_args):
                return

        return Handler

    def __enter__(self):
        self.thread.start()
        return f"http://127.0.0.1:{self.server.server_address[1]}"

    def __exit__(self, *_exc):
        self.server.shutdown()
        self.server.server_close()


def test_collect_by_url_sends_the_page_as_referer(test_client, registry):
    page = "https://www.pixiv.example/artworks/123"
    _pair(test_client, registry)
    with _RefererServer(_sd_png_bytes("from the web"), page) as base:
        image_url = f"{base}/img-original/123_p0.png"
        answer = test_client.post(
            "/api/ext/collect-url",
            json={"image_url": image_url, "page_url": page, "page_title": "Pixiv post"},
            headers=_ext_headers(),
        )
        assert answer.status_code == 200, answer.text
        assert answer.json()["filename"] == "123_p0.png"
        row = _wait_imported(answer.json()["path"])
        source = test_client.get(f"/api/collect/source/{row['id']}").json()["source"]
        assert source == {
            **source,
            "source_url": image_url,
            "page_url": page,
            "via": "extension",
        }

        # Pasted inside the program there is no page: the program sends the
        # picture's own site as Referer, which this site does not accept.
        refused = test_client.post("/api/collect/url", json={"url": image_url})
        assert refused.status_code == 502
        assert "403" in refused.json()["error"]


def test_paste_saves_into_collected_and_converts_unknown_formats(test_client):
    buffer = io.BytesIO()
    Image.new("RGB", (32, 32), (10, 120, 200)).save(buffer, format="ICO")
    answer = test_client.post(
        "/api/collect/paste",
        files={"file": ("image.ico", buffer.getvalue(), "image/x-icon")},
    )
    assert answer.status_code == 200, answer.text
    assert (
        answer.json()["filename"] == "image.png"
        and answer.json()["converted_from"] == "ICO"
    )
    row = _wait_imported(answer.json()["path"])
    source = test_client.get(f"/api/collect/source/{row['id']}").json()["source"]
    assert source["via"] == "paste" and source["page_url"] is None

    plain = test_client.post(
        "/api/collect/paste",
        files={"file": ("pasted.png", _sd_png_bytes(), "image/png")},
    )
    assert plain.json()["converted_from"] is None
    assert (
        test_client.post(
            "/api/collect/url", json={"url": "file:///C:/Windows/win.ini"}
        ).status_code
        == 400
    )


def test_source_of_a_picture_that_was_not_collected_is_null(test_client):
    assert test_client.get("/api/collect/source/999999").json() == {"source": None}


def test_source_row_goes_with_the_picture(test_db, tmp_path):
    import database as db
    from db_collected_sources import get_collected_source, record_collected_source
    from db_core import get_db

    picture = tmp_path / "p.png"
    picture.write_bytes(_sd_png_bytes())
    from image_manager import scan_folder

    scan_folder(str(tmp_path), only_paths=[str(picture)])
    image_id = db.get_image_by_path(str(picture))["id"]
    record_collected_source(
        image_id,
        source_url="https://a/b.png",
        page_url=None,
        page_title=None,
        collected_at="2026-10-23T10:00:00",
        via="url",
    )
    assert get_collected_source(image_id)["source_url"] == "https://a/b.png"
    with get_db() as conn:
        conn.execute("DELETE FROM images WHERE id = ?", (image_id,))
    assert get_collected_source(image_id) is None


# The extension folders ---------------------------------------------------------------------


def test_extension_folders_differ_only_in_the_manifest(tmp_path):
    chrome = package.build_target("chrome", tmp_path / "chrome")
    firefox = package.build_target("firefox", tmp_path / "firefox")
    chrome_manifest = json.loads((chrome / "manifest.json").read_text(encoding="utf-8"))
    firefox_manifest = json.loads(
        (firefox / "manifest.json").read_text(encoding="utf-8")
    )

    assert chrome_manifest["manifest_version"] == 3
    assert chrome_manifest["background"] == {"service_worker": "background.js"}
    assert firefox_manifest["background"]["scripts"][-1] == "background.js"
    assert firefox_manifest["browser_specific_settings"]["gecko"]["id"]
    # Firefox bug 2052000: a host pattern with a port matches nothing.
    for manifest in (chrome_manifest, firefox_manifest):
        assert "http://127.0.0.1/*" in manifest["host_permissions"]
        assert not [p for p in manifest["host_permissions"] if ":8487" in p]
    files = sorted(
        p.relative_to(chrome).as_posix() for p in chrome.rglob("*") if p.is_file()
    )
    assert files == sorted(
        p.relative_to(firefox).as_posix() for p in firefox.rglob("*") if p.is_file()
    )
    for required in (
        "background.js",
        "content.js",
        "program.js",
        "options.html",
        "popup.html",
        "_locales/en/messages.json",
        "_locales/zh_CN/messages.json",
    ):
        assert required in files


def test_extension_locales_have_the_same_keys():
    root = package.source_dir() / "src" / "_locales"
    en = json.loads((root / "en" / "messages.json").read_text(encoding="utf-8"))
    zh = json.loads((root / "zh_CN" / "messages.json").read_text(encoding="utf-8"))
    assert set(en) == set(zh)
