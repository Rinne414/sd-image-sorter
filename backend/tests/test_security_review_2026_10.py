"""Security review findings (2026-10-23): own-page-only endpoints, ComfyUI
error echo, extension identity in the pairing prompt, collected-file formats."""

from __future__ import annotations

import io

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

import config
from services import collect_service
from services.comfyui_client import ERROR_LINE_MAX_CHARS, _rejected
from services.ext_pairing import PairingRegistry

OTHER_PORT = {"Origin": "http://127.0.0.1:7860", "Sec-Fetch-Site": "same-site"}
CROSS_SITE = {"Origin": "http://localhost:8188", "Sec-Fetch-Site": "cross-site"}
OWN_PAGE = {"Origin": "http://127.0.0.1:8487", "Sec-Fetch-Site": "same-origin"}
TOKEN = "t" * 40
CHROME_ORIGIN = "chrome-extension://" + "abcdefghijklmnopabcdefghijklmnop"


@pytest.fixture
def own_page_client(test_client, tmp_path):
    """A client whose socket port is 8487, like the app's own page."""
    from main import app
    from services.ext_pairing import get_pairing_registry

    get_pairing_registry().reset_for_tests(tmp_path / "browser-extensions.json")
    yield TestClient(app, base_url="http://127.0.0.1:8487", client=("127.0.0.1", 50000))
    get_pairing_registry().reset_for_tests(None)


# Own page only ------------------------------------------------------------------


@pytest.mark.parametrize("headers", [OTHER_PORT, CROSS_SITE])
def test_comfyui_address_cannot_be_changed_by_another_page(own_page_client, headers):
    before = config.get_comfyui_url_setting()
    refused = own_page_client.patch(
        "/api/settings/comfyui",
        json={"url": "http://192.168.1.9:8188"},
        headers=headers,
    )
    assert refused.status_code == 403, refused.text
    assert config.get_comfyui_url_setting() == before


@pytest.mark.parametrize("headers", [OTHER_PORT, CROSS_SITE])
def test_comfyui_queue_cannot_be_triggered_by_another_page(own_page_client, headers):
    refused = own_page_client.post(
        "/api/images/1/comfyui/queue", json={}, headers=headers
    )
    assert refused.status_code == 403, refused.text


def test_own_page_and_scripts_still_reach_the_comfyui_endpoints(own_page_client):
    changed = own_page_client.patch(
        "/api/settings/comfyui", json={"url": "127.0.0.1:9000"}, headers=OWN_PAGE
    )
    assert (
        changed.status_code == 200 and changed.json()["url"] == "http://127.0.0.1:9000"
    )
    cleared = own_page_client.patch("/api/settings/comfyui", json={"url": ""})
    assert cleared.status_code == 200
    # Past the own-page check the call reaches the picture lookup.
    missing = own_page_client.post(
        "/api/images/999999/comfyui/queue", json={}, headers=OWN_PAGE
    )
    assert missing.status_code == 404


@pytest.mark.parametrize("headers", [OTHER_PORT, CROSS_SITE])
def test_pausing_the_watcher_needs_the_own_page(own_page_client, headers):
    refused = own_page_client.post(
        "/api/watch/pause", json={"paused": True}, headers=headers
    )
    assert refused.status_code == 403, refused.text
    assert not own_page_client.get("/api/watch/status").json()["paused"]
    own = own_page_client.post(
        "/api/watch/pause", json={"paused": True}, headers=OWN_PAGE
    )
    assert own.status_code == 200 and own.json()["paused"] is True
    assert (
        own_page_client.post("/api/watch/pause", json={"paused": False}).status_code
        == 200
    )


@pytest.mark.parametrize("headers", [OTHER_PORT, CROSS_SITE])
def test_revoking_a_pairing_needs_the_own_page(own_page_client, headers):
    from services.ext_pairing import get_pairing_registry

    registry = get_pairing_registry()
    pairing = registry.request(
        origin=CHROME_ORIGIN, name="x", browser="chrome", token=TOKEN
    )
    registry.decide(pairing.id, True)
    refused = own_page_client.delete(
        f"/api/browser-extension/pairings/{pairing.id}", headers=headers
    )
    assert refused.status_code == 403, refused.text
    assert registry.authorize(TOKEN, CHROME_ORIGIN) is not None
    own = own_page_client.delete(
        f"/api/browser-extension/pairings/{pairing.id}", headers=OWN_PAGE
    )
    assert own.status_code == 200
    assert registry.authorize(TOKEN, CHROME_ORIGIN) is None


# ComfyUI error text ---------------------------------------------------------------


def test_comfyui_refusal_never_echoes_a_raw_body():
    page = "<html>" + "secret page text " * 100 + "</html>"
    error = _rejected(httpx.Response(400, text=page), "http://x:1")
    assert "secret" not in error.message and "HTTP 400" in error.message


def test_comfyui_refusal_keeps_node_messages_short():
    payload = {
        "error": {"message": "Prompt outputs failed validation"},
        "node_errors": {
            "4": {"class_type": "Loader", "errors": [{"details": "x " * 900}]}
        },
    }
    error = _rejected(httpx.Response(400, json=payload), "http://x:1")
    assert "Prompt outputs failed validation" in error.message
    assert error.details and all(
        len(line) <= ERROR_LINE_MAX_CHARS + 30 for line in error.details
    )
    assert error.details[0].startswith("Loader #4: x x")


# Pairing identity -----------------------------------------------------------------


def test_pending_request_shows_origin_and_says_when_it_replaces_a_pairing(tmp_path):
    registry = PairingRegistry(tmp_path / "browser-extensions.json")
    first = registry.request(
        origin=CHROME_ORIGIN, name="Pics", browser="chrome", token=TOKEN
    )
    waiting = registry.pending()[0]
    assert waiting["origin"] == CHROME_ORIGIN and waiting["replaces_existing"] is False
    registry.decide(first.id, True)
    registry.request(
        origin=CHROME_ORIGIN, name="Pics", browser="chrome", token="u" * 40
    )
    again = registry.pending()[0]
    assert again["replaces_existing"] is True and "token_hash" not in again
    other = "chrome-extension://" + "ponmlkjihgfedcbaponmlkjihgfedcba"
    registry.request(origin=other, name="Other", browser="chrome", token="v" * 40)
    flags = {p["origin"]: p["replaces_existing"] for p in registry.pending()}
    assert flags == {CHROME_ORIGIN: True, other: False}


# Collected file formats -------------------------------------------------------------


EPS = (
    b"%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 10 10\n"
    b"newpath 0 0 moveto 10 10 lineto stroke\n"
)


def test_an_eps_file_is_not_a_picture_for_collecting(own_page_client):
    answer = own_page_client.post(
        "/api/collect/paste", files={"file": ("art.png", EPS, "image/png")}
    )
    assert answer.status_code == 415, answer.text


def test_eps_is_not_opened_when_converting(tmp_path):
    path = tmp_path / "x.part"
    path.write_bytes(EPS)
    with pytest.raises(collect_service.CollectError) as raised:
        collect_service.store_collected_file(path, "x")
    assert raised.value.status_code == 415
    assert not path.exists()


@pytest.mark.parametrize("fmt", ["ICO", "BMP", "TIFF"])
def test_formats_the_program_converts_or_keeps_still_work(
    fmt, tmp_path, own_page_client
):
    buffer = io.BytesIO()
    Image.new("RGB", (32, 32), (10, 120, 200)).save(buffer, format=fmt)
    answer = own_page_client.post(
        "/api/collect/paste",
        files={
            "file": (f"p.{fmt.lower()}", buffer.getvalue(), "application/octet-stream")
        },
    )
    assert answer.status_code == 200, answer.text


@pytest.mark.parametrize(
    "method, path, kwargs",
    [
        ("post", "/api/collect/url", {"json": {"url": "https://example.com/a.png"}}),
        ("post", "/api/collect/paste", {"files": {"file": ("a.png", b"x", "image/png")}}),
        ("post", "/api/browser-extension/install-folders", {"json": {}}),
        ("post", "/api/browser-extension/open-folder", {"json": {"browser": "chrome"}}),
    ],
)
def test_collect_and_extension_folder_endpoints_refuse_other_local_pages(
    test_client, method, path, kwargs
):
    """Another web app on a different loopback port cannot drive these."""
    response = getattr(test_client, method)(
        path, headers={"Origin": "http://127.0.0.1:3000"}, **kwargs
    )
    assert response.status_code == 403
