"""Route tests for routers/style_map.py (style map slice S1: vector jobs)."""

from __future__ import annotations

from pathlib import Path

import pytest

from exceptions import OperationInProgressError


class FakeStyleVectorService:
    def __init__(self):
        self.calls = []
        self.running = False
        self.progress = {
            "running": False,
            "paused": False,
            "space": None,
            "total": 0,
            "processed": 0,
            "written": 0,
            "errors": 0,
            "step": "idle",
            "message": "",
            "current_item": None,
            "started_at": None,
            "updated_at": None,
            "recent_issues": [],
        }

    def start_extraction(
        self,
        background_tasks,
        *,
        space,
        image_ids=None,
        use_gpu=None,
        model_source="huggingface",
        model_path=None,
    ):
        self.calls.append(
            ("start", space, image_ids, use_gpu, model_source, model_path)
        )
        if self.running:
            raise OperationInProgressError("Style vector extraction")
        return {"status": "started", "total": 5, "space": space}

    def get_progress(self):
        return dict(self.progress)

    def request_pause(self):
        self.calls.append(("pause",))
        return self.running

    def request_resume(self):
        self.calls.append(("resume",))
        return self.running

    def request_cancel(self):
        self.calls.append(("cancel",))
        return self.running

    def get_stats(self, space):
        return {
            "space": space,
            "images": 3,
            "vectors": 1,
            "pending": 2,
            "stale": 0,
            "model_version": "fake",
        }


@pytest.fixture
def fake_service(test_client):
    from routers import style_map as style_map_router

    service = FakeStyleVectorService()
    style_map_router.set_style_vector_service(service)
    yield service
    style_map_router.set_style_vector_service(None)


def test_router_is_mounted_with_expected_routes(test_client):
    from main import app

    paths = {route.path for route in app.routes}
    for path in (
        "/api/style-map/vectors/start",
        "/api/style-map/vectors/progress",
        "/api/style-map/vectors/pause",
        "/api/style-map/vectors/resume",
        "/api/style-map/vectors/cancel",
        "/api/style-map/vectors/stats",
    ):
        assert path in paths


def test_router_does_not_import_database_directly():
    source = Path(__file__).resolve().parents[1] / "routers" / "style_map.py"
    text = source.read_text(encoding="utf-8")
    assert "import database" not in text
    assert "from database" not in text


def test_start_passes_request_to_service(test_client, fake_service):
    response = test_client.post(
        "/api/style-map/vectors/start",
        json={"space": "kaloscope", "image_ids": [3, 4], "use_gpu": False},
    )
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "started"
    assert response.json()["total"] == 5
    assert fake_service.calls == [
        ("start", "kaloscope", [3, 4], False, "huggingface", None)
    ]


def test_start_defaults_to_kaloscope_and_whole_library(test_client, fake_service):
    response = test_client.post("/api/style-map/vectors/start", json={})
    assert response.status_code == 200, response.text
    assert fake_service.calls[0][1:3] == ("kaloscope", None)


@pytest.mark.parametrize(
    "payload",
    [
        {"space": "clip"},
        {"image_ids": []},
        {"image_ids": [0]},
        {"model_source": "local"},
        {"model_source": "local", "model_path": "C:/missing/artist.pth"},
    ],
)
def test_start_rejects_bad_payloads(test_client, fake_service, payload):
    response = test_client.post("/api/style-map/vectors/start", json=payload)
    assert response.status_code == 400, response.text
    assert fake_service.calls == []


def test_start_while_running_is_a_conflict(test_client, fake_service):
    fake_service.running = True
    response = test_client.post("/api/style-map/vectors/start", json={})
    assert response.status_code == 409


def test_progress_returns_the_service_snapshot(test_client, fake_service):
    fake_service.progress.update(
        {"running": True, "total": 9, "processed": 2, "step": "extracting"}
    )
    response = test_client.get("/api/style-map/vectors/progress")
    assert response.status_code == 200
    body = response.json()
    assert (body["running"], body["total"], body["processed"], body["step"]) == (
        True,
        9,
        2,
        "extracting",
    )
    assert body["recent_issues"] == []


@pytest.mark.parametrize("action", ["pause", "resume", "cancel"])
def test_controls_report_not_running(test_client, fake_service, action):
    response = test_client.post(f"/api/style-map/vectors/{action}")
    assert response.status_code == 200
    assert response.json() == {"status": "not_running"}


@pytest.mark.parametrize(
    "action, expected",
    [("pause", "paused"), ("resume", "resumed"), ("cancel", "cancelled")],
)
def test_controls_report_their_effect(test_client, fake_service, action, expected):
    fake_service.running = True
    response = test_client.post(f"/api/style-map/vectors/{action}")
    assert response.status_code == 200
    assert response.json() == {"status": expected}


def test_stats_endpoint(test_client, fake_service):
    response = test_client.get(
        "/api/style-map/vectors/stats", params={"space": "kaloscope"}
    )
    assert response.status_code == 200
    assert response.json()["pending"] == 2


def test_stats_rejects_unknown_space(test_client, fake_service):
    response = test_client.get("/api/style-map/vectors/stats", params={"space": "clip"})
    assert response.status_code == 400


def test_progress_reports_kept_vectors(test_client, fake_service):
    fake_service.progress["kept"] = 4
    response = test_client.get("/api/style-map/vectors/progress")
    assert response.status_code == 200
    assert response.json()["kept"] == 4


def test_start_request_reuses_the_artist_model_config():
    """One model-config contract for Style Finder and the style map (expanduser/resolve included)."""
    from routers.artists import ArtistModelConfig
    from routers.style_map import StartVectorsRequest

    assert issubclass(StartVectorsRequest, ArtistModelConfig)


def test_db_backed_endpoints_are_sync_like_the_aesthetic_router():
    import inspect

    from routers import style_map

    assert not inspect.iscoroutinefunction(style_map.start_vectors)
    assert not inspect.iscoroutinefunction(style_map.vectors_stats)
