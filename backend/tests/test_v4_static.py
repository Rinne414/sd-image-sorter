"""Vopus, the second interface: served at /vopus/ from frontend-v4/dist.

``/`` stays the classic interface; the old /v4/ addresses lead to /vopus/.
"""

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app_static import mount_frontend_v4


def _client(dist_path):
    app = FastAPI()
    mount_frontend_v4(app, dist_path=str(dist_path))
    return TestClient(app)


def _build(tmp_path):
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text(
        "<!doctype html><div id=root></div>", encoding="utf-8"
    )
    (dist / "assets" / "index-abc123.js").write_text(
        "console.info('v4')", encoding="utf-8"
    )
    return dist


def test_index_is_served_without_cache(tmp_path):
    client = _client(_build(tmp_path))
    res = client.get("/vopus/")
    assert res.status_code == 200
    assert "id=root" in res.text
    assert res.headers["cache-control"] == "no-cache"


def test_the_vopus_mount_leaves_root_alone(tmp_path):
    client = _client(_build(tmp_path))
    assert client.get("/", follow_redirects=False).status_code == 404


def test_the_app_serves_the_classic_ui_at_root_and_vopus_beside_it(test_client):
    res = test_client.get("/", follow_redirects=False)
    assert res.status_code == 200
    assert "/static/js/app.js" in res.text
    assert test_client.get("/static/js/app.js").status_code == 200
    bare = test_client.get("/vopus", follow_redirects=False)
    assert bare.headers["location"] == "/vopus/"


def test_bare_vopus_redirects_to_trailing_slash(tmp_path):
    client = _client(_build(tmp_path))
    res = client.get("/vopus", follow_redirects=False)
    assert res.status_code in (307, 308)
    assert res.headers["location"] == "/vopus/"


def test_old_v4_addresses_lead_to_vopus_with_their_path_and_query(tmp_path):
    client = _client(_build(tmp_path))
    for old, new in (
        ("/v4", "/vopus/"),
        ("/v4/", "/vopus/"),
        ("/v4/?library=lib_2", "/vopus/?library=lib_2"),
        ("/v4/library/anything?x=a%20b", "/vopus/library/anything?x=a%20b"),
        ("/v4/assets/index-abc123.js", "/vopus/assets/index-abc123.js"),
    ):
        res = client.get(old, follow_redirects=False)
        assert res.status_code == 308, old
        assert res.headers["location"] == new, old


def test_client_routes_fall_back_to_index(tmp_path):
    client = _client(_build(tmp_path))
    res = client.get("/vopus/library/anything")
    assert res.status_code == 200
    assert "id=root" in res.text


def test_hashed_assets_are_cached_forever(tmp_path):
    client = _client(_build(tmp_path))
    res = client.get("/vopus/assets/index-abc123.js")
    assert res.status_code == 200
    assert "immutable" in res.headers["cache-control"]


def test_missing_asset_is_404_not_index(tmp_path):
    client = _client(_build(tmp_path))
    res = client.get("/vopus/assets/nope.js")
    assert res.status_code == 404


def test_traversal_outside_dist_is_refused(tmp_path):
    dist = _build(tmp_path)
    (tmp_path / "secret.txt").write_text("secret", encoding="utf-8")
    client = _client(dist)
    for path in (
        "/vopus/assets/../../secret.txt",
        "/vopus/assets/%2e%2e/%2e%2e/secret.txt",
    ):
        res = client.get(path)
        assert "secret" not in res.text


def test_unbuilt_vopus_explains_how_to_build(tmp_path):
    client = _client(tmp_path / "missing-dist")
    res = client.get("/vopus/")
    assert res.status_code == 503
    assert "charset=utf-8" in res.headers["content-type"]
    # Both languages: the launchers build it once Node.js is installed, and
    # the classic interface stays at /.
    for text in (
        "Node.js",
        "run.bat",
        "run.sh",
        "npm run build",
        "自动构建",
        "automatically",
        "经典界面",
        "classic interface",
    ):
        assert text in res.text
    assert "Vopus" in res.text
    assert "V4" not in res.text


# The new interface (docs/DESIGN.md §redesign-2026-10) is a second page of the
# same build: next.html, served at /next/ beside /vopus/.


def _build_with_next(tmp_path):
    dist = _build(tmp_path)
    (dist / "next.html").write_text(
        "<!doctype html><div id=root data-next></div>", encoding="utf-8"
    )
    return dist


def test_the_new_interface_is_served_at_next_without_cache(tmp_path):
    client = _client(_build_with_next(tmp_path))
    res = client.get("/next/")
    assert res.status_code == 200
    assert "data-next" in res.text
    assert res.headers["cache-control"] == "no-cache"
    # its own routes live in the address hash; any path under /next/ is the page
    assert "data-next" in client.get("/next/library").text
    # Vopus is untouched
    assert "data-next" not in client.get("/vopus/").text


def test_bare_next_redirects_to_trailing_slash(tmp_path):
    client = _client(_build_with_next(tmp_path))
    res = client.get("/next", follow_redirects=False)
    assert res.status_code in (307, 308)
    assert res.headers["location"] == "/next/"


def test_unbuilt_new_interface_says_how_to_build_it(tmp_path):
    client = _client(_build(tmp_path))
    res = client.get("/next/")
    assert res.status_code == 503
    assert "npm run build" in res.text
    assert "经典界面" in res.text
