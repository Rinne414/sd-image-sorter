"""V4 frontend is served at /v4/ next to the V3.5 app, from frontend-v4/dist."""

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
    res = client.get("/v4/")
    assert res.status_code == 200
    assert "id=root" in res.text
    assert res.headers["cache-control"] == "no-cache"


def test_bare_v4_redirects_to_trailing_slash(tmp_path):
    client = _client(_build(tmp_path))
    res = client.get("/v4", follow_redirects=False)
    assert res.status_code in (307, 308)
    assert res.headers["location"] == "/v4/"


def test_client_routes_fall_back_to_index(tmp_path):
    client = _client(_build(tmp_path))
    res = client.get("/v4/library/anything")
    assert res.status_code == 200
    assert "id=root" in res.text


def test_hashed_assets_are_cached_forever(tmp_path):
    client = _client(_build(tmp_path))
    res = client.get("/v4/assets/index-abc123.js")
    assert res.status_code == 200
    assert "immutable" in res.headers["cache-control"]


def test_missing_asset_is_404_not_index(tmp_path):
    client = _client(_build(tmp_path))
    res = client.get("/v4/assets/nope.js")
    assert res.status_code == 404


def test_traversal_outside_dist_is_refused(tmp_path):
    dist = _build(tmp_path)
    (tmp_path / "secret.txt").write_text("secret", encoding="utf-8")
    client = _client(dist)
    for path in ("/v4/assets/../../secret.txt", "/v4/assets/%2e%2e/%2e%2e/secret.txt"):
        res = client.get(path)
        assert "secret" not in res.text


def test_unbuilt_v4_explains_how_to_build(tmp_path):
    client = _client(tmp_path / "missing-dist")
    res = client.get("/v4/")
    assert res.status_code == 503
    assert "npm run build" in res.text
