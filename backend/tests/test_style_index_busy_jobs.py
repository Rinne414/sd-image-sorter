"""The style index is a running job like the others: Clear Gallery waits
for it, a restart asks about it, and the stats endpoint takes the user's
model settings (slice S1b, the two S1 review leftovers)."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from services import busy_jobs


def _idle_gallery(monkeypatch):
    """Fakes for the four services the Clear Gallery gate already probes, all idle."""
    from routers import sorting as sorting_router
    from services.tagging_pipeline_service import GalleryMutationActivity

    monkeypatch.setattr(sorting_router, "get_gallery_job_activity", lambda: ())
    sorting = SimpleNamespace(
        get_scan_progress=lambda: {"status": "idle"},
        is_scan_worker_active=lambda: False,
    )
    pipeline = SimpleNamespace(
        get_gallery_mutation_activity=lambda *, legacy_service: GalleryMutationActivity(
            state="idle", jobs=(), detail=""
        )
    )
    aesthetic = SimpleNamespace(get_scoring_progress=lambda: {"running": False})
    return sorting, object(), pipeline, aesthetic


def test_clear_gallery_waits_for_a_running_style_index(monkeypatch):
    from routers import sorting as sorting_router

    sorting, tagging, pipeline, aesthetic = _idle_gallery(monkeypatch)
    running = SimpleNamespace(is_running=lambda: True)
    with pytest.raises(HTTPException) as caught:
        sorting_router._require_clear_gallery_jobs_idle(
            sorting, tagging, pipeline, aesthetic, style_vector_service=running
        )
    assert caught.value.status_code == 409
    assert caught.value.detail["jobs"] == ["style_index"]

    idle = SimpleNamespace(is_running=lambda: False)
    sorting_router._require_clear_gallery_jobs_idle(
        sorting, tagging, pipeline, aesthetic, style_vector_service=idle
    )


def test_a_malformed_style_index_state_blocks_the_clear(monkeypatch):
    from routers import sorting as sorting_router

    sorting, tagging, pipeline, aesthetic = _idle_gallery(monkeypatch)
    broken = SimpleNamespace(is_running=lambda: "yes")
    with pytest.raises(HTTPException) as caught:
        sorting_router._require_clear_gallery_jobs_idle(
            sorting, tagging, pipeline, aesthetic, style_vector_service=broken
        )
    assert caught.value.status_code == 503
    assert caught.value.detail["job"] == "style_index"


def test_the_gate_reads_the_router_owned_style_vector_service(monkeypatch):
    """Without an explicit service the gate asks the style-map router for
    the live one (the Clear Gallery endpoint and busy_jobs both go this way)."""
    from routers import sorting as sorting_router
    from routers import style_map as style_map_router

    sorting, tagging, pipeline, aesthetic = _idle_gallery(monkeypatch)
    style_map_router.set_style_vector_service(SimpleNamespace(is_running=lambda: True))
    try:
        with pytest.raises(HTTPException) as caught:
            sorting_router._require_clear_gallery_jobs_idle(
                sorting, tagging, pipeline, aesthetic
            )
        assert caught.value.detail["jobs"] == ["style_index"]
    finally:
        style_map_router.set_style_vector_service(None)


def test_restart_names_the_style_index(monkeypatch):
    from routers import sorting as sorting_router

    def report_running(*_services, **_kwargs):
        raise HTTPException(status_code=409, detail={"jobs": ["style_index"]})

    monkeypatch.setattr(
        sorting_router, "_require_clear_gallery_jobs_idle", report_running
    )
    for getter in (
        "get_sorting_service",
        "_get_tagging_service_for_clear",
        "get_tagging_pipeline_service",
        "_get_aesthetic_service_for_clear",
    ):
        monkeypatch.setattr(sorting_router, getter, lambda: object())
    assert busy_jobs._gallery_jobs() == ["style_index"]
    # The index holds the AI runtime while it runs; "ai" is not listed twice.
    monkeypatch.setattr(
        busy_jobs, "_SOURCES", (busy_jobs._gallery_jobs, lambda: ["ai"])
    )
    assert busy_jobs.collect_busy_jobs() == ["style_index"]


def test_restart_dialog_words_the_style_index(tmp_path):
    """The page maps every plain id to words in both language packs."""
    from pathlib import Path

    root = Path(__file__).resolve().parents[2] / "frontend"
    script = (root / "js" / "app" / "model-restart.js").read_text(encoding="utf-8")
    assert "style_index: ['restartBusy.job.styleIndex'" in script
    for pack in ("zh-CN", "en"):
        text = (root / "js" / "lang" / f"{pack}.js").read_text(encoding="utf-8")
        assert "'restartBusy.job.styleIndex'" in text


def test_vectors_stats_take_the_users_model_settings(test_client, tmp_path):
    local = tmp_path / "weights.pth"
    local.write_bytes(b"w")
    default = test_client.get(
        "/api/style-map/vectors/stats", params={"space": "kaloscope"}
    )
    assert default.status_code == 200, default.text
    mine = test_client.get(
        "/api/style-map/vectors/stats",
        params={
            "space": "kaloscope",
            "model_source": "local",
            "model_path": str(local),
        },
    )
    assert mine.status_code == 200, mine.text
    assert mine.json()["model_version"] != default.json()["model_version"]
    missing = test_client.get(
        "/api/style-map/vectors/stats",
        params={
            "space": "kaloscope",
            "model_source": "local",
            "model_path": str(tmp_path / "nope.pth"),
        },
    )
    assert missing.status_code == 400
