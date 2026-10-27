from __future__ import annotations

import asyncio


def test_colors_pause_and_resume_need_a_running_analysis(test_client):
    assert test_client.post("/api/colors/pause").status_code == 400
    assert test_client.post("/api/colors/resume").status_code == 400


def test_colors_pause_shows_in_progress_and_resume_clears_it(test_client):
    import routers.colors as colors_router

    with colors_router._state_lock:
        original = dict(colors_router._state)
        colors_router._state["running"] = True
    try:
        assert test_client.post("/api/colors/pause").json() == {"status": "paused"}
        assert test_client.get("/api/colors/progress").json()["paused"] is True
        assert test_client.post("/api/colors/resume").json() == {"status": "resumed"}
        assert test_client.get("/api/colors/progress").json()["paused"] is False
        # A stop while paused must not leave the run held.
        test_client.post("/api/colors/pause")
        assert test_client.post("/api/colors/cancel").status_code == 200
        assert test_client.get("/api/colors/progress").json()["paused"] is False
    finally:
        with colors_router._state_lock:
            colors_router._state.update(original)


def test_colors_run_holds_while_paused_and_goes_on_after_resume(monkeypatch):
    import database as db
    import routers.colors as colors_router

    seen: list[int] = []

    def fake_get_image(image_id):
        seen.append(image_id)
        return None

    monkeypatch.setattr(db, "get_image_by_id", fake_get_image)
    monkeypatch.setattr(colors_router, "_PAUSE_POLL_SECONDS", 0.01)

    async def scenario():
        with colors_router._state_lock:
            colors_router._state.update(
                {
                    "running": True,
                    "paused": True,
                    "cancel_requested": False,
                    "failed": 0,
                }
            )
        task = asyncio.create_task(colors_router._run_analysis([1, 2]))
        await asyncio.sleep(0.1)
        held = list(seen)
        with colors_router._state_lock:
            colors_router._state["paused"] = False
        await asyncio.wait_for(task, timeout=2)
        return held

    try:
        held = asyncio.run(scenario())
    finally:
        with colors_router._state_lock:
            colors_router._state.update(
                {"running": False, "paused": False, "failed": 0}
            )

    assert held == []
    assert seen == [1, 2]
