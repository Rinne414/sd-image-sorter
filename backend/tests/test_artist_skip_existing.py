"""Artist batch: skip images that already have a result, and a light progress poll.

``skip_existing`` (default False, so V3.5 is unchanged) drops the images that
already have a row in ``artist_predictions`` before the batch starts, and the
response says how many were skipped. When every image is skipped nothing
starts. The progress poll can leave out the per-image result list, which grows
with every image and made each poll of a large run heavier than the last.
"""

from __future__ import annotations

import pytest


def _add_images(test_db, count: int) -> list[int]:
    return [
        test_db.add_image(
            path=f"/tmp/artist-skip-{i}.png",
            filename=f"artist-skip-{i}.png",
            metadata_json="{}",
        )
        for i in range(count)
    ]


def _predict(
    test_db, image_id: int, artist: str = "someone", confidence: float = 0.5
) -> None:
    with test_db.get_db() as conn:
        conn.execute(
            "INSERT INTO artist_predictions (image_id, artist, confidence, top_predictions) VALUES (?, ?, ?, '[]')",
            (image_id, artist, confidence),
        )


@pytest.fixture
def batch_calls(monkeypatch):
    """Record the ids each started batch receives instead of running the model."""
    from routers import artists as artists_router

    service = artists_router.get_artist_service()
    service.set_batch_progress_state({"running": False})
    calls: list[list[int]] = []

    def fake_run_batch(
        image_ids, threshold, top_k, model_source, model_path, use_gpu=None
    ):
        calls.append(list(image_ids))
        service.set_batch_progress_state(
            {
                "running": False,
                "total": len(image_ids),
                "processed": len(image_ids),
                "step": "done",
            }
        )

    monkeypatch.setattr(artists_router, "_run_batch_identification", fake_run_batch)
    yield calls
    service.set_batch_progress_state({"running": False})


def test_skip_existing_leaves_out_images_with_a_result_and_says_how_many(
    test_client, test_db, batch_calls
):
    ids = _add_images(test_db, 4)
    _predict(test_db, ids[1])
    _predict(test_db, ids[3], artist="undefined", confidence=0.01)

    response = test_client.post(
        "/api/artists/identify-batch", json={"image_ids": ids, "skip_existing": True}
    )

    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 2
    assert body["skipped"] == 2
    assert batch_calls == [[ids[0], ids[2]]]


def test_without_skip_existing_every_image_runs_again(
    test_client, test_db, batch_calls
):
    ids = _add_images(test_db, 3)
    _predict(test_db, ids[0])

    response = test_client.post("/api/artists/identify-batch", json={"image_ids": ids})

    assert response.status_code == 200
    assert response.json()["total"] == 3
    assert response.json()["skipped"] == 0
    assert batch_calls == [ids]


def test_when_every_image_has_a_result_nothing_starts(
    test_client, test_db, batch_calls
):
    from routers import artists as artists_router

    ids = _add_images(test_db, 2)
    for image_id in ids:
        _predict(test_db, image_id)

    response = test_client.post(
        "/api/artists/identify-batch", json={"image_ids": ids, "skip_existing": True}
    )

    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 0
    assert body["skipped"] == 2
    assert body["started"] is False
    assert batch_calls == []
    assert artists_router.get_artist_service().is_batch_running() is False


def test_skip_existing_still_refuses_while_a_batch_runs(
    test_client, test_db, batch_calls
):
    from routers import artists as artists_router

    ids = _add_images(test_db, 1)
    artists_router.get_artist_service().set_batch_progress_state(
        {"running": True, "total": 5}
    )

    response = test_client.post(
        "/api/artists/identify-batch", json={"image_ids": ids, "skip_existing": True}
    )

    assert response.status_code == 409
    assert batch_calls == []


def test_progress_can_leave_out_the_result_list(test_client):
    from routers import artists as artists_router

    results = [{"image_id": i, "artist": "a", "confidence": 0.5} for i in range(3)]
    artists_router.get_artist_service().set_batch_progress_state(
        {
            "running": True,
            "total": 10,
            "processed": 3,
            "errors": 1,
            "results": results,
            "step": "identifying",
        }
    )
    try:
        light = test_client.get(
            "/api/artists/batch-progress", params={"include_results": "false"}
        ).json()
        full = test_client.get("/api/artists/batch-progress").json()
    finally:
        artists_router.get_artist_service().set_batch_progress_state({"running": False})

    assert light["results"] == []
    assert (
        light["processed"] == 3
        and light["errors"] == 1
        and light["total"] == 10
        and light["running"] is True
    )
    assert len(full["results"]) == 3
