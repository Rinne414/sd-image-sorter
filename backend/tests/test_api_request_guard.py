"""SEC1a: /api/* only answers requests that come from this app's own page or
a local non-browser client.

Host must name a loopback host on the port the socket is bound to (DNS
rebinding sends the attacker's hostname), Origin, when present, must be a
loopback origin on any port, and a browser-declared cross-site request passes
only with such an Origin: another local web app (localhost:3000 calling
127.0.0.1:8487 is cross-site to the browser) keeps working, while a hidden
iframe, a GET form or a top-level link, which carry no Origin, are refused.
Under SD_SORTER_TESTING=1 the pytest TestClient's ``testserver`` host and a
port-less loopback host are accepted.
"""

from __future__ import annotations

import logging
from urllib.parse import urlsplit

import pytest
from starlette.routing import WebSocketRoute
from starlette.testclient import TestClient

import app_security
from app_security import api_request_rejection

BOUND = 8487


def _reject(headers, *, path="/api/updates/boot-id", method="GET", testing=False):
    return api_request_rejection(
        path=path,
        method=method,
        headers={key.lower(): value for key, value in headers.items()},
        bound_port=BOUND,
        testing=testing,
    )


class TestHost:
    @pytest.mark.parametrize(
        "host",
        [
            "127.0.0.1:8487",
            "localhost:8487",
            "LOCALHOST:8487",
            "[::1]:8487",
            "127.0.0.2:8487",
        ],
    )
    def test_loopback_hosts_on_the_bound_port_pass(self, host):
        assert _reject({"Host": host}) is None

    @pytest.mark.parametrize(
        "host",
        [
            "attacker.example:8487",  # DNS rebinding: the name resolves to 127.0.0.1
            "127.0.0.1:9999",  # another port: another local server's name
            "127.0.0.1",  # port-less means 80
            "localhost",
            "192.168.1.10:8487",
            "",
            "[::1]:not-a-port",
            "testserver",  # pytest's default, outside the test gate
            # a Host header is only host[:port]; anything urlsplit would read
            # past (userinfo, path, query, fragment) is refused, not parsed
            "evil.com@127.0.0.1:8487",
            "127.0.0.1:8487/x",
            "127.0.0.1:8487?x",
            "127.0.0.1:8487#x",
            "127.0.0.1:8487,localhost:8487",
            "127.0.0.1 :8487",
        ],
    )
    def test_everything_else_is_refused(self, host):
        assert _reject({"Host": host}) == "host"

    def test_missing_host_is_refused(self):
        assert _reject({}) == "host"

    def test_the_test_gate_accepts_testserver_and_a_portless_loopback(self):
        assert _reject({"Host": "testserver"}, testing=True) is None
        assert _reject({"Host": "127.0.0.1"}, testing=True) is None
        assert _reject({"Host": "attacker.example:8487"}, testing=True) == "host"

    def test_a_bound_port_of_80_accepts_a_portless_loopback_host(self):
        assert (
            api_request_rejection(
                path="/api/x",
                method="GET",
                headers={"host": "localhost"},
                bound_port=80,
                testing=False,
            )
            is None
        )


class TestOrigin:
    @pytest.mark.parametrize(
        "origin",
        [
            "http://127.0.0.1:8487",
            "http://localhost:8487",
            "http://localhost:8188",  # another local web app, any port
            "https://[::1]:3000",
        ],
    )
    def test_loopback_origins_on_any_port_pass(self, origin):
        assert _reject({"Host": "127.0.0.1:8487", "Origin": origin}) is None

    @pytest.mark.parametrize(
        "origin",
        [
            "https://attacker.example",
            "http://192.168.1.10:8487",
            "null",
            "file://",
            "not a url",
            # an Origin is exactly scheme://host[:port], one value, no extras
            "http://evil.com@127.0.0.1:8487",
            "http://127.0.0.1:8487/",
            "http://127.0.0.1:8487/x",
            "http://127.0.0.1:8487?x",
            "http://127.0.0.1:8487#x",
            "http://127.0.0.1:8487 http://evil.com",
            "http://127.0.0.1:8487, http://localhost:3000",
            "ftp://127.0.0.1:8487",
        ],
    )
    def test_other_origins_are_refused(self, origin):
        assert _reject({"Host": "127.0.0.1:8487", "Origin": origin}) == "origin"


class TestSecFetchSite:
    @pytest.mark.parametrize("site", ["same-origin", "same-site", "none"])
    def test_same_site_and_user_navigation_pass(self, site):
        assert _reject({"Host": "127.0.0.1:8487", "Sec-Fetch-Site": site}) is None

    def test_absent_header_passes(self):
        assert _reject({"Host": "127.0.0.1:8487"}) is None

    @pytest.mark.parametrize("method", ["GET", "POST", "DELETE"])
    def test_cross_site_fetch_is_refused(self, method):
        assert (
            _reject(
                {
                    "Host": "127.0.0.1:8487",
                    "Sec-Fetch-Site": "cross-site",
                    "Sec-Fetch-Mode": "cors",
                },
                method=method,
            )
            == "sec-fetch-site"
        )

    @pytest.mark.parametrize("method", ["GET", "HEAD", "POST"])
    @pytest.mark.parametrize("dest", ["document", "iframe", "frame", "empty"])
    def test_cross_site_navigation_without_an_origin_is_refused(self, method, dest):
        """A link, a GET form, window.open, location= and a hidden <iframe>
        are all navigations and none carries an Origin: a page on any site
        could make the browser GET /api/... with a chosen query string."""
        navigate = {
            "Host": "127.0.0.1:8487",
            "Sec-Fetch-Site": "cross-site",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Dest": dest,
        }
        assert _reject(navigate, method=method) == "sec-fetch-site"

    @pytest.mark.parametrize("method", ["GET", "POST"])
    @pytest.mark.parametrize(
        "origin",
        ["http://localhost:3000", "http://127.0.0.1:8188", "https://[::1]:5173"],
    )
    def test_cross_site_from_another_local_web_app_passes(self, method, origin):
        """localhost:3000 calling 127.0.0.1:8487 is cross-site to the browser;
        the loopback Origin it sends is what lets it through."""
        request = {
            "Host": "127.0.0.1:8487",
            "Origin": origin,
            "Sec-Fetch-Site": "cross-site",
            "Sec-Fetch-Mode": "cors",
        }
        assert _reject(request, method=method) is None

    def test_cross_site_with_a_foreign_origin_is_refused(self):
        request = {
            "Host": "127.0.0.1:8487",
            "Origin": "http://evil.com",
            "Sec-Fetch-Site": "cross-site",
            "Sec-Fetch-Mode": "cors",
        }
        assert _reject(request, method="POST") == "origin"


class TestScope:
    @pytest.mark.parametrize(
        "path", ["/", "/static/js/app.js", "/docs", "/openapi.json"]
    )
    def test_only_api_paths_are_guarded(self, path):
        hostile = {
            "Host": "attacker.example:8487",
            "Origin": "https://attacker.example",
            "Sec-Fetch-Site": "cross-site",
        }
        assert _reject(hostile, path=path) is None
        assert _reject(hostile, path="/api/images") == "host"


def test_the_mcp_server_talks_to_an_accepted_host(monkeypatch):
    """backend/mcp_server.py is the one local non-browser client; its base
    URL must name a host the guard accepts on the bound port."""
    import mcp_server

    monkeypatch.setenv("SD_IMAGE_SORTER_PORT", str(BOUND))
    netloc = urlsplit(mcp_server._api_base()).netloc
    assert _reject({"Host": netloc}) is None


@pytest.fixture
def production_client(test_client, monkeypatch):
    """A client outside the test gate: loopback peer, bound port 8487."""
    from main import app

    monkeypatch.delenv("SD_SORTER_TESTING", raising=False)
    monkeypatch.setenv("SD_IMAGE_SORTER_PORT", str(BOUND))
    return TestClient(
        app, base_url=f"http://127.0.0.1:{BOUND}", client=("127.0.0.1", 50000)
    )


class TestWiring:
    def test_own_page_requests_are_answered(self, production_client):
        response = production_client.get(
            "/api/updates/boot-id",
            headers={
                "Origin": f"http://127.0.0.1:{BOUND}",
                "Sec-Fetch-Site": "same-origin",
            },
        )
        assert response.status_code == 200, response.text

    def test_a_rebound_hostname_is_refused_with_403(self, production_client):
        response = production_client.get(
            "/api/updates/boot-id", headers={"Host": "attacker.example:8487"}
        )
        assert response.status_code == 403
        assert response.json()["type"] == "Forbidden"

    def test_a_cross_site_fetch_is_refused_with_403(self, production_client):
        response = production_client.get(
            "/api/updates/boot-id",
            headers={
                "Origin": "https://attacker.example",
                "Sec-Fetch-Site": "cross-site",
                "Sec-Fetch-Mode": "cors",
            },
        )
        assert response.status_code == 403

    def test_a_hidden_iframe_from_another_site_is_refused_with_403(
        self, production_client
    ):
        response = production_client.get(
            "/api/updates/boot-id",
            headers={
                "Sec-Fetch-Site": "cross-site",
                "Sec-Fetch-Mode": "navigate",
                "Sec-Fetch-Dest": "iframe",
            },
        )
        assert response.status_code == 403

    def test_a_cross_site_link_to_the_page_still_opens(self, production_client):
        response = production_client.get(
            "/",
            headers={
                "Sec-Fetch-Site": "cross-site",
                "Sec-Fetch-Mode": "navigate",
                "Sec-Fetch-Dest": "document",
            },
        )
        assert response.status_code == 200

    def test_the_port_the_socket_is_bound_to_wins_over_the_env(
        self, test_client, monkeypatch
    ):
        """Started another way (uvicorn CLI, a launcher that forgot the env),
        the env names 8487 while the page lives on 9000: the socket's port
        (request.scope["server"], which no client can set) is the truth, and
        the app's own page must not be locked out."""
        from main import app

        monkeypatch.delenv("SD_SORTER_TESTING", raising=False)
        monkeypatch.setenv("SD_IMAGE_SORTER_PORT", str(BOUND))
        page_on_9000 = TestClient(
            app, base_url="http://127.0.0.1:9000", client=("127.0.0.1", 50000)
        )
        assert page_on_9000.get("/api/updates/boot-id").status_code == 200
        # and a Host naming the env's port is now the wrong port
        response = page_on_9000.get(
            "/api/updates/boot-id", headers={"Host": f"127.0.0.1:{BOUND}"}
        )
        assert response.status_code == 403

    def test_the_pytest_client_passes_through_the_test_gate(self, test_client):
        # Host: testserver, SD_SORTER_TESTING=1 (the conftest fixture sets it)
        assert test_client.get("/api/updates/boot-id").status_code == 200


def test_no_websocket_routes_exist():
    """The guard is an HTTP middleware; a websocket scope would bypass it.
    Before adding the first WebSocketRoute, teach api_request_guard_middleware
    (or an ASGI wrapper) to apply the same Host / Origin rules to the
    websocket handshake."""
    from main import app

    websocket_routes = [
        route for route in app.routes if isinstance(route, WebSocketRoute)
    ]
    assert websocket_routes == [], (
        "WebSocket routes bypass api_request_guard_middleware: extend the guard "
        "to the websocket scope before adding one"
    )


class TestRejectionLog:
    def test_one_warning_per_reason_per_interval_with_a_skipped_count(
        self, monkeypatch, caplog
    ):
        clock = {"now": 1000.0}
        monkeypatch.setattr(app_security.time, "monotonic", lambda: clock["now"])
        monkeypatch.setattr(app_security, "_rejection_log_state", {})
        interval = app_security.REJECTION_LOG_INTERVAL_SECONDS
        with caplog.at_level(logging.WARNING, logger="sd-image-sorter"):
            app_security._log_rejection("host", "GET", "/api/images", "evil:8487")
            clock["now"] += interval / 2
            app_security._log_rejection("host", "GET", "/api/images", "evil:8487")
            app_security._log_rejection("host", "GET", "/api/images", "evil:8487")
            # another reason has its own budget
            app_security._log_rejection("origin", "POST", "/api/x", "http://evil")
            clock["now"] += interval
            app_security._log_rejection("host", "GET", "/api/images", "evil:8487")
        messages = [record.getMessage() for record in caplog.records]
        host_messages = [m for m in messages if "host header" in m]
        assert len(host_messages) == 2
        assert "skipped 2" in host_messages[1]
        assert "skipped" not in host_messages[0]
        assert len([m for m in messages if "origin header" in m]) == 1
