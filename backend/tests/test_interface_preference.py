"""Which interface opens at ``/``: the classic one (default) or Vopus.

The choice is made in either interface's Settings and kept on the backend, so
every browser and every launch opens the same one. Vopus is only offered when
its build exists; ``/?ui=classic`` always opens the classic interface.
"""

from __future__ import annotations

from pathlib import Path

import pytest

import app_static
from services import interface_preference


@pytest.fixture
def vopus_built(tmp_path, monkeypatch) -> Path:
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text(
        "<!doctype html><div id=root></div>", encoding="utf-8"
    )
    monkeypatch.setattr(app_static, "FRONTEND_V4_DIST_PATH", dist)
    return dist


@pytest.fixture
def vopus_missing(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(app_static, "FRONTEND_V4_DIST_PATH", tmp_path / "no-dist")


def test_the_classic_interface_is_the_default(test_client, vopus_built):
    assert test_client.get("/api/interface").json() == {
        "interface": "classic",
        "vopus_built": True,
    }
    res = test_client.get("/", follow_redirects=False)
    assert res.status_code == 200
    assert "/static/js/app.js" in res.text


def test_choosing_vopus_is_remembered_and_opens_it_at_root(test_client, vopus_built):
    res = test_client.put("/api/interface", json={"interface": "vopus"})
    assert res.status_code == 200
    assert res.json()["interface"] == "vopus"
    assert test_client.get("/api/interface").json()["interface"] == "vopus"
    assert interface_preference.get_preferred_interface() == "vopus"

    root = test_client.get("/?library=lib_2", follow_redirects=False)
    assert root.status_code == 307
    assert root.headers["location"] == "/vopus/?library=lib_2"


def test_the_classic_interface_stays_reachable_after_choosing_vopus(
    test_client, vopus_built
):
    test_client.put("/api/interface", json={"interface": "vopus"})
    res = test_client.get("/?ui=classic", follow_redirects=False)
    assert res.status_code == 200
    assert "/static/js/app.js" in res.text


def test_switching_back_to_classic(test_client, vopus_built):
    test_client.put("/api/interface", json={"interface": "vopus"})
    res = test_client.put("/api/interface", json={"interface": "classic"})
    assert res.json()["interface"] == "classic"
    assert test_client.get("/", follow_redirects=False).status_code == 200


def test_vopus_cannot_be_chosen_before_it_is_built(test_client, vopus_missing):
    assert test_client.get("/api/interface").json() == {
        "interface": "classic",
        "vopus_built": False,
    }
    res = test_client.put("/api/interface", json={"interface": "vopus"})
    assert res.status_code == 409
    assert interface_preference.get_preferred_interface() == "classic"


def test_a_remembered_vopus_without_a_build_opens_the_classic_interface(
    test_client, vopus_built, monkeypatch, tmp_path
):
    test_client.put("/api/interface", json={"interface": "vopus"})
    monkeypatch.setattr(app_static, "FRONTEND_V4_DIST_PATH", tmp_path / "gone")
    res = test_client.get("/", follow_redirects=False)
    assert res.status_code == 200
    assert "/static/js/app.js" in res.text


def test_an_unknown_interface_is_refused(test_client, vopus_built):
    res = test_client.put("/api/interface", json={"interface": "v4"})
    # The app answers every malformed request with 400 (main.py validation handler).
    assert res.status_code == 400
    assert interface_preference.get_preferred_interface() == "classic"


def test_an_unreadable_choice_means_classic(tmp_path, monkeypatch):
    monkeypatch.setattr(interface_preference, "CONFIG_DIR", tmp_path)
    (tmp_path / "interface.json").write_text("{not json", encoding="utf-8")
    assert interface_preference.get_preferred_interface() == "classic"
    (tmp_path / "interface.json").write_text('{"interface": "v4"}', encoding="utf-8")
    assert interface_preference.get_preferred_interface() == "classic"


def test_the_choice_is_written_whole(tmp_path, monkeypatch):
    monkeypatch.setattr(interface_preference, "CONFIG_DIR", tmp_path / "config")
    interface_preference.set_preferred_interface("vopus")
    assert (tmp_path / "config" / "interface.json").read_text(encoding="utf-8") == (
        '{"interface": "vopus"}'
    )
    assert not list((tmp_path / "config").glob("*.tmp"))
    with pytest.raises(ValueError):
        interface_preference.set_preferred_interface("v4")
