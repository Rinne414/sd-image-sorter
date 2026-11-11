"""The Eagle import over HTTP: look, start, follow, and the refusals."""

from __future__ import annotations

import json
import time

import pytest

from routers import eagle as eagle_router


@pytest.fixture(autouse=True)
def _idle():
    eagle_router.reset_for_tests()
    yield
    eagle_router.reset_for_tests()


def _library(tmp_path):
    from PIL import Image

    root = tmp_path / "Art.library"
    info = root / "images" / "A1.info"
    info.mkdir(parents=True)
    (root / "metadata.json").write_text(json.dumps({"folders": []}), encoding="utf-8")
    (info / "metadata.json").write_text(
        json.dumps(
            {"id": "A1", "name": "one", "ext": "png", "star": 3, "tags": ["kept"]}
        ),
        encoding="utf-8",
    )
    Image.new("RGB", (16, 16), (200, 30, 30)).save(info / "one.png")
    return root


def _wait_done(test_client):
    for _ in range(100):
        state = test_client.get("/api/eagle/import").json()
        if state["status"] != "running":
            return state
        time.sleep(0.05)
    raise AssertionError("the import did not end")


def test_preview_counts_and_refuses_a_folder_that_is_no_library(test_client, tmp_path):
    root = _library(tmp_path)

    found = test_client.post("/api/eagle/preview", json={"path": str(root)})
    assert found.status_code == 200
    assert found.json()["items"] == 1 and found.json()["with_stars"] == 1

    refused = test_client.post("/api/eagle/preview", json={"path": str(tmp_path)})
    assert refused.status_code == 400
    assert "Eagle" in refused.text


def test_import_runs_in_the_background_and_reports_what_it_did(
    test_client, test_db, tmp_path
):
    root = _library(tmp_path)
    assert test_client.get("/api/eagle/import").json() == {"status": "idle"}

    started = test_client.post("/api/eagle/import", json={"path": str(root)})
    assert started.status_code == 200
    state = _wait_done(test_client)

    assert state["status"] == "done", state
    assert state["result"]["indexed"] == 1
    assert state["result"]["stars_set"] == 1 and state["result"]["tags_added"] == 1
    row = test_db.get_image_by_path(str(root / "images" / "A1.info" / "one.png"))
    assert row and row["user_rating"] == 3


def test_a_second_start_is_refused_while_one_runs(test_client, tmp_path):
    root = _library(tmp_path)
    eagle_router.reset_for_tests(
        {"status": "running", "step": "index", "current": 0, "total": 9}
    )

    refused = test_client.post("/api/eagle/import", json={"path": str(root)})

    assert refused.status_code == 409
    assert "already running" in refused.text
