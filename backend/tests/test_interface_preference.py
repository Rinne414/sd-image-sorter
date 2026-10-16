"""Which interface opens at ``/``: the classic one (default) or Vopus.

The choice is made in either interface's Settings and kept on the backend, so
every browser and every launch opens the same one. Vopus is only offered when
its build exists; ``/?ui=classic`` always opens the classic interface.
"""

from __future__ import annotations

import logging
import os
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


def _hold_the_choice_file(monkeypatch, times=None):
    """Make ``os.replace`` onto interface.json refuse like a held file on
    Windows: ``times`` refusals, or every one when ``times`` is None."""
    real_replace = os.replace
    left = {"count": times}

    def held(src, dst):
        if Path(dst).name == "interface.json" and left["count"] != 0:
            if left["count"] is not None:
                left["count"] -= 1
            raise PermissionError(13, "in use")
        real_replace(src, dst)

    monkeypatch.setattr(interface_preference, "_REPLACE_RETRY_SECONDS", 0.0)
    monkeypatch.setattr(interface_preference.os, "replace", held)
    return left


def test_a_file_held_for_a_moment_is_still_replaced(tmp_path, monkeypatch):
    """Windows refuses the replace while a reader holds the file (the ``/``
    route, an antivirus scan); the save waits that moment out."""
    monkeypatch.setattr(interface_preference, "CONFIG_DIR", tmp_path)
    left = _hold_the_choice_file(monkeypatch, times=2)
    assert interface_preference.set_preferred_interface("vopus") == "vopus"
    assert left["count"] == 0
    assert (tmp_path / "interface.json").read_text(encoding="utf-8") == (
        '{"interface": "vopus"}'
    )
    assert not list(tmp_path.glob("*.tmp"))


def test_a_file_that_stays_held_answers_503_with_a_reason(
    test_client, vopus_built, monkeypatch
):
    test_client.put("/api/interface", json={"interface": "vopus"})
    _hold_the_choice_file(monkeypatch)
    res = test_client.put("/api/interface", json={"interface": "classic"})
    assert res.status_code == 503
    assert res.json()["error"] == interface_preference.INTERFACE_FILE_BUSY_ERROR
    assert interface_preference.get_preferred_interface() == "vopus"
    folder = interface_preference._preference_path().parent
    assert not list(folder.glob("*.tmp"))


def test_a_held_temp_file_does_not_hide_the_reason(tmp_path, monkeypatch):
    monkeypatch.setattr(interface_preference, "CONFIG_DIR", tmp_path)
    _hold_the_choice_file(monkeypatch)
    real_unlink = Path.unlink

    def held_unlink(self, *args, **kwargs):
        if self.name == "interface.json.tmp":
            raise PermissionError(13, "in use")
        return real_unlink(self, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", held_unlink)
    with pytest.raises(interface_preference.InterfaceChoiceBusyError) as exc:
        interface_preference.set_preferred_interface("vopus")
    assert str(exc.value) == interface_preference.INTERFACE_FILE_BUSY_ERROR


def test_any_other_write_failure_stays_a_plain_server_error(
    test_client, vopus_built, monkeypatch
):
    """Only a held file is "busy": a full disk is not, and no path reaches
    the page."""
    from fastapi.testclient import TestClient

    real_write_text = Path.write_text

    def disk_full(self, *args, **kwargs):
        if self.name == "interface.json.tmp":
            raise OSError(28, "No space left on device", str(self))
        return real_write_text(self, *args, **kwargs)

    monkeypatch.setattr(Path, "write_text", disk_full)
    client = TestClient(test_client.app, raise_server_exceptions=False)
    res = client.put("/api/interface", json={"interface": "vopus"})
    assert res.status_code == 500
    assert res.json()["error"] == "Internal server error"
    assert "interface.json" not in res.text
    assert interface_preference.get_preferred_interface() == "classic"


@pytest.mark.skipif(
    os.name != "nt", reason="an open handle blocks os.replace on Windows only"
)
def test_a_real_open_handle_keeps_the_old_choice_and_logs_the_path(
    tmp_path, monkeypatch, caplog
):
    monkeypatch.setattr(interface_preference, "CONFIG_DIR", tmp_path)
    monkeypatch.setattr(interface_preference, "_REPLACE_RETRY_SECONDS", 0.0)
    interface_preference.set_preferred_interface("vopus")
    path = tmp_path / "interface.json"
    with path.open("r", encoding="utf-8"):  # a handle without delete sharing
        with caplog.at_level(logging.WARNING, logger=interface_preference.__name__):
            with pytest.raises(interface_preference.InterfaceChoiceBusyError) as exc:
                interface_preference.set_preferred_interface("classic")
    message = str(exc.value)
    assert message == interface_preference.INTERFACE_FILE_BUSY_ERROR
    assert str(tmp_path) not in message
    assert any(
        str(path) in r.getMessage() and "errno" in r.getMessage().lower()
        for r in caplog.records
    )
    assert interface_preference.get_preferred_interface() == "vopus"
    assert not list(tmp_path.glob("*.tmp"))
