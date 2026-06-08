"""Tests for GET / cache-bust query injection on static asset URLs.

Goal: when a user upgrades the app, the browser must refetch ``lang/*.js``
on a normal F5 instead of silently serving the old cached language pack.
The mechanism is an ``?v=APP_VERSION`` suffix on every ``/static/*.js``
and ``/static/*.css`` URL inside index.html, injected at request time.

These tests are deliberately *cheap*: we mock the index.html file off
disk so they run on any platform without depending on the real bundled
frontend.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))


@pytest.fixture()
def fake_index_app(tmp_path, monkeypatch):
    """Spin up a fresh FastAPI app whose frontend_path points at tmp_path.

    We re-import ``main`` after patching so the module-level
    ``frontend_path`` constant resolves to our fixture directory.
    """
    frontend_dir = tmp_path / "frontend"
    frontend_dir.mkdir()
    css_dir = frontend_dir / "css"
    css_dir.mkdir()
    js_dir = frontend_dir / "js"
    js_dir.mkdir()
    lang_dir = js_dir / "lang"
    lang_dir.mkdir()

    sample_html = """<!DOCTYPE html>
<html>
<head>
    <link rel="stylesheet" href="/static/css/styles.css">
    <link rel="stylesheet" href="/static/css/already-busted.css?v=1">
    <script src="/static/js/lang/en.js"></script>
    <script src="/static/js/lang/zh-CN.js"></script>
    <script src="/static/js/already-busted.js?foo=bar"></script>
    <img src="/static/img/logo.png">
</head>
<body></body>
</html>
"""
    (frontend_dir / "index.html").write_text(sample_html, encoding="utf-8")
    (css_dir / "styles.css").write_text("body{}", encoding="utf-8")
    (js_dir / "app.js").write_text("/*app*/", encoding="utf-8")
    (lang_dir / "en.js").write_text("/*en*/", encoding="utf-8")
    (lang_dir / "zh-CN.js").write_text("/*zh*/", encoding="utf-8")

    # Patch BEFORE importing main so the module-level frontend_path is set
    # to our tmp_path layout.
    monkeypatch.setenv("SD_IMAGE_SORTER_DB_PATH", str(tmp_path / "test.db"))
    monkeypatch.setenv("SD_IMAGE_SORTER_RATE_LIMIT_ENABLED", "0")
    # Bypass the localhost-only middleware for TestClient (it sees a non-loopback
    # remote_addr); other tests in the suite use the same flag via conftest.
    monkeypatch.setenv("SD_SORTER_TESTING", "1")
    monkeypatch.setenv("TESTING", "1")
    monkeypatch.chdir(tmp_path)

    # Drop a cached import of main so the next import re-runs the module
    # with our patched cwd / env.
    for name in [m for m in list(sys.modules) if m == "main" or m.startswith("main.")]:
        del sys.modules[name]

    import main as main_module
    monkeypatch.setattr(main_module, "frontend_path", str(frontend_dir))
    yield main_module
    for name in [m for m in list(sys.modules) if m == "main" or m.startswith("main.")]:
        del sys.modules[name]


def test_root_injects_app_version_on_static_js_urls(fake_index_app):
    """Bare /static/*.js URLs get a versioned cache-bust suffix on GET /."""
    main_module = fake_index_app
    client = TestClient(main_module.app)

    response = client.get("/")
    assert response.status_code == 200
    body = response.text

    assert re.search(rf'src="/static/js/lang/en\.js\?v={re.escape(main_module.APP_VERSION)}\.[0-9a-f]{{8}}"', body), body
    assert re.search(rf'src="/static/js/lang/zh-CN\.js\?v={re.escape(main_module.APP_VERSION)}\.[0-9a-f]{{8}}"', body), body


def test_root_injects_app_version_on_static_css_urls(fake_index_app):
    """Bare /static/*.css URLs also get the cache-bust suffix."""
    main_module = fake_index_app
    client = TestClient(main_module.app)

    response = client.get("/")
    assert re.search(rf'href="/static/css/styles\.css\?v={re.escape(main_module.APP_VERSION)}\.[0-9a-f]{{8}}"', response.text)


def test_static_cache_bust_token_changes_when_asset_changes(fake_index_app):
    """Same-version release rebuilds must still invalidate stale JS/CSS."""
    main_module = fake_index_app
    css_path = Path(main_module.frontend_path) / "css" / "styles.css"

    first = main_module._static_cache_bust_token("/static/css/styles.css")
    css_path.write_text("body{color:red}", encoding="utf-8")
    second = main_module._static_cache_bust_token("/static/css/styles.css")

    assert first.startswith(f"{main_module.APP_VERSION}.")
    assert second.startswith(f"{main_module.APP_VERSION}.")
    assert first != second


def test_root_does_not_double_append_on_existing_query(fake_index_app):
    """If a URL already has ``?...`` we must leave it alone, never append twice."""
    main_module = fake_index_app
    client = TestClient(main_module.app)

    body = client.get("/").text
    # Already has ?v=1 — must stay literal, no second ?v= appended.
    assert 'href="/static/css/already-busted.css?v=1"' in body
    # Already has ?foo=bar — must stay literal.
    assert 'src="/static/js/already-busted.js?foo=bar"' in body
    # A bad regex would have produced "...?v=1?v=3.2.1" or similar.
    assert "?v=1?v=" not in body
    assert "?foo=bar?v=" not in body


def test_root_does_not_touch_non_js_css_assets(fake_index_app):
    """Image / font / generic asset URLs must remain unmodified."""
    main_module = fake_index_app
    client = TestClient(main_module.app)

    body = client.get("/").text
    assert 'src="/static/img/logo.png"' in body
    assert 'src="/static/img/logo.png?v=' not in body


def test_root_returns_html_content_type(fake_index_app):
    """We swap FileResponse for HTMLResponse, so content-type must be text/html."""
    main_module = fake_index_app
    client = TestClient(main_module.app)

    response = client.get("/")
    assert response.headers["content-type"].startswith("text/html")


def test_root_falls_back_when_index_is_unreadable(fake_index_app, monkeypatch):
    """If reading index.html fails, the handler falls back to FileResponse.

    We don't crash the app just because of a transient read error.
    """
    main_module = fake_index_app
    client = TestClient(main_module.app)

    real_open = open

    def boom(path, *args, **kwargs):
        mode = args[0] if args else kwargs.get("mode", "r")
        # Only fail the text-mode read inside ``root()``; let FileResponse
        # fall back via its own binary read.
        if str(path).endswith("index.html") and mode == "r":
            raise OSError("simulated read failure")
        return real_open(path, *args, **kwargs)

    monkeypatch.setattr("builtins.open", boom)
    response = client.get("/")
    # The fallback path is FileResponse, which still returns the file (and
    # should still 200), even though the cache-bust will be missing.
    assert response.status_code == 200


def test_root_sets_no_cache_header(fake_index_app):
    """The shell HTML must revalidate so its freshly-injected ?v= hashes are
    never served stale from a previously-cached version."""
    main_module = fake_index_app
    client = TestClient(main_module.app)

    response = client.get("/")
    assert response.status_code == 200
    assert response.headers.get("cache-control") == "no-cache"


def test_static_assets_set_no_cache_header(fake_index_app):
    """Static JS/CSS must revalidate instead of serving a stale cached bundle.

    This covers scripts appended dynamically at runtime (e.g. the Dataset Maker
    sub-modules via ``_appendOrderedScript``) that bypass the GET / ``?v=``
    injection. The mount serves from the real bundled frontend, so app.js is a
    safe, always-present asset to probe.
    """
    main_module = fake_index_app
    client = TestClient(main_module.app)

    response = client.get("/static/js/app.js")
    assert response.status_code == 200
    assert response.headers.get("cache-control") == "no-cache"


def test_cache_bust_regex_is_anchored_to_static_paths():
    """Sanity-check the regex itself — must not match arbitrary src= matches.

    This locks in the regex contract so a future careless edit of
    _STATIC_CACHE_BUST_RE in main.py doesn't accidentally start
    rewriting unrelated URLs.
    """
    import main as main_module
    pattern = main_module._STATIC_CACHE_BUST_RE

    yes = [
        '<script src="/static/js/foo.js">',
        '<script src="/static/js/lang/zh-CN.js"></script>',
        '<link rel="stylesheet" href="/static/css/styles.css">',
        '<link href="/static/css/sub/dir/file.css">',
    ]
    no = [
        '<script src="https://cdn.example.com/foo.js">',
        '<script src="/static/js/foo.js?v=1">',
        '<img src="/static/img/foo.png">',
        '<a href="/api/something">',
    ]

    for line in yes:
        assert pattern.search(line), f"expected match: {line}"
    for line in no:
        assert not pattern.search(line), f"unexpected match: {line}"
