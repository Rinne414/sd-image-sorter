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
        selection_token=None,
        with_artist=True,
    ):
        self.calls.append(
            (
                "start",
                space,
                image_ids,
                use_gpu,
                model_source,
                model_path,
                selection_token,
                with_artist,
            )
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

    def get_stats(self, space, model_path=None):
        self.calls.append(("stats", space, model_path))
        return {
            "space": space,
            "images": 3,
            "vectors": 1,
            "pending": 2,
            "stale": 0,
            "model_version": "fake" if not model_path else f"local:{model_path}",
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
        ("start", "kaloscope", [3, 4], False, "huggingface", None, None, True)
    ]


def test_start_defaults_to_kaloscope_and_whole_library(test_client, fake_service):
    response = test_client.post("/api/style-map/vectors/start", json={})
    assert response.status_code == 200, response.text
    assert fake_service.calls[0][1:3] == ("kaloscope", None)
    assert fake_service.calls[0][6] is None
    # the artist prediction rides along by default (same model, one forward)
    assert fake_service.calls[0][7] is True


def test_start_can_leave_the_artist_prediction_out(test_client, fake_service):
    response = test_client.post(
        "/api/style-map/vectors/start", json={"with_artist": False}
    )
    assert response.status_code == 200, response.text
    assert fake_service.calls[0][7] is False


def test_start_passes_the_selection_token_to_the_service(test_client, fake_service):
    """The style map page scopes the index to the current Gallery filter."""
    response = test_client.post(
        "/api/style-map/vectors/start", json={"selection_token": "tok.abc"}
    )
    assert response.status_code == 200, response.text
    assert fake_service.calls == [
        ("start", "kaloscope", None, None, "huggingface", None, "tok.abc", True)
    ]


def test_start_refuses_both_image_ids_and_a_selection_token(test_client, fake_service):
    response = test_client.post(
        "/api/style-map/vectors/start",
        json={"image_ids": [1], "selection_token": "tok.abc"},
    )
    assert response.status_code == 400, response.text
    assert fake_service.calls == []


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


def test_stats_pass_the_local_model_path_to_the_service(
    test_client, fake_service, tmp_path
):
    local = tmp_path / "weights.pth"
    local.write_bytes(b"w")
    response = test_client.get(
        "/api/style-map/vectors/stats",
        params={
            "space": "kaloscope",
            "model_source": "local",
            "model_path": str(local),
        },
    )
    assert response.status_code == 200, response.text
    assert fake_service.calls[-1] == ("stats", "kaloscope", str(local.resolve()))
    # the default (Hugging Face) settings pass no path
    test_client.get("/api/style-map/vectors/stats", params={"space": "kaloscope"})
    assert fake_service.calls[-1] == ("stats", "kaloscope", None)


class FakeStyleMapService:
    """Records the model path every map route hands the service."""

    def __init__(self):
        self.calls = []

    def points_json(
        self, space, selection_token=None, *, refresh=False, model_path=None
    ):
        self.calls.append(("points", space, model_path))
        return b'{"status":"ok","points":[]}'

    def layout_status(self, space, selection_token=None, *, model_path=None):
        self.calls.append(("layout", space, model_path))
        return {"space": space, "method": "pca", "umap": {"status": "not_started"}}

    def regions_json(
        self, space, selection_token=None, *, refresh=False, model_path=None
    ):
        self.calls.append(("regions", space, model_path))
        return b'{"status":"not_started","regions":[]}'


@pytest.fixture
def fake_map_service(test_client):
    from routers import style_map as style_map_router

    service = FakeStyleMapService()
    style_map_router.set_style_map_service(service)
    yield service
    style_map_router.set_style_map_service(None)


def test_map_routes_pass_the_users_model_settings(
    test_client, fake_map_service, tmp_path
):
    """points, layout-status and regions read the Style Finder's model
    settings, so a local-weights user sees the map of THEIR vectors."""
    local = tmp_path / "weights.pth"
    local.write_bytes(b"w")
    params = {"space": "kaloscope", "model_source": "local", "model_path": str(local)}
    for route in ("points", "layout-status", "regions"):
        response = test_client.get(f"/api/style-map/{route}", params=params)
        assert response.status_code == 200, (route, response.text)
    assert [call[2] for call in fake_map_service.calls] == [str(local.resolve())] * 3
    fake_map_service.calls.clear()
    for route in ("points", "layout-status", "regions"):
        assert (
            test_client.get(
                f"/api/style-map/{route}", params={"space": "kaloscope"}
            ).status_code
            == 200
        )
    assert [call[2] for call in fake_map_service.calls] == [None] * 3
    missing = {
        "space": "kaloscope",
        "model_source": "local",
        "model_path": str(tmp_path / "nope.pth"),
    }
    for route in ("points", "layout-status", "regions"):
        assert (
            test_client.get(f"/api/style-map/{route}", params=missing).status_code
            == 400
        )


def _record_filesystem_access(monkeypatch):
    """Every path probe the model settings validator (routers.artists, shared
    by every style-map route) makes lands in the returned list. (pydantic
    turns an AssertionError raised inside a validator into a 400, so a
    raising guard alone would not prove anything.)"""
    from routers import artists as artists_router

    touched = []

    class _RecordingPath(Path):
        def _touched(self, *_args, **_kwargs):
            touched.append(str(self))
            raise RuntimeError("model_path must not touch the filesystem")

        resolve = is_file = stat = exists = _touched

    monkeypatch.setattr(artists_router, "Path", _RecordingPath)
    return touched


MAP_ROUTES = ("points", "layout-status", "regions")


@pytest.mark.parametrize("route", MAP_ROUTES + ("vectors/stats",))
def test_routes_refuse_non_checkpoint_paths_before_touching_the_filesystem(
    test_client, fake_service, fake_map_service, monkeypatch, tmp_path, route
):
    """A local path that is not a .pth/.pt/.onnx checkpoint is refused by
    its name alone: no existence or content check, so the routes are no
    oracle for arbitrary files."""
    secret = tmp_path / "notes.txt"
    secret.write_text("x", encoding="utf-8")
    touched = _record_filesystem_access(monkeypatch)
    response = test_client.get(
        f"/api/style-map/{route}",
        params={"space": "kaloscope", "model_source": "local", "model_path": str(secret)},
    )
    assert response.status_code == 400, response.text
    assert ".onnx" in response.text  # the message names the accepted formats
    assert touched == []
    assert fake_service.calls == [] and fake_map_service.calls == []


@pytest.mark.parametrize("route", MAP_ROUTES + ("vectors/stats",))
@pytest.mark.parametrize("source", ["huggingface", "modelscope"])
def test_routes_ignore_the_model_path_unless_the_source_is_local(
    test_client, fake_service, fake_map_service, monkeypatch, route, source
):
    """Hugging Face / ModelScope settings carry no path; one sent anyway is
    dropped unread."""
    touched = _record_filesystem_access(monkeypatch)
    response = test_client.get(
        f"/api/style-map/{route}",
        params={"space": "kaloscope", "model_source": source, "model_path": "C:/secret/file.pth"},
    )
    assert response.status_code == 200, response.text
    assert touched == []
    calls = fake_service.calls + fake_map_service.calls
    assert [call[2] for call in calls] == [None]


@pytest.mark.parametrize("route", MAP_ROUTES)
def test_clip_space_needs_no_kaloscope_weights(
    test_client, fake_map_service, tmp_path, route
):
    """The CLIP map reads images.embedding, never Kaloscope vectors: a local
    checkpoint that was moved away must not take the CLIP map down."""
    response = test_client.get(
        f"/api/style-map/{route}",
        params={
            "space": "clip",
            "model_source": "local",
            "model_path": str(tmp_path / "gone.pth"),
        },
    )
    assert response.status_code == 200, response.text
    assert [call[1:] for call in fake_map_service.calls] == [("clip", None)]


def test_start_refuses_non_checkpoint_paths_before_touching_the_filesystem(
    test_client, fake_service, monkeypatch, tmp_path
):
    secret = tmp_path / "notes.txt"
    secret.write_text("x", encoding="utf-8")
    touched = _record_filesystem_access(monkeypatch)
    response = test_client.post(
        "/api/style-map/vectors/start",
        json={"model_source": "local", "model_path": str(secret)},
    )
    assert response.status_code == 400, response.text
    assert ".onnx" in response.text
    assert touched == []
    assert fake_service.calls == []


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
