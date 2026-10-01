"""Artist batch progress carries a message_key so the UI can localise it.

The English ``message`` stays for API compatibility; ``processed`` /
``total`` / ``errors`` / ``current_item`` are already progress fields.
"""

from __future__ import annotations

from services.artist_service import ArtistService


def test_idle_progress_has_an_empty_key():
    assert ArtistService().get_batch_progress()["message_key"] == ""


def test_start_state_has_the_preparing_key():
    service = ArtistService()
    service.start_batch_progress(total=3)

    assert service.get_batch_progress()["message_key"] == "preparing"


def test_progress_updates_carry_their_key():
    service = ArtistService()
    service.start_batch_progress(total=3)

    service.apply_batch_progress_update(
        {
            "step": "loading_runtime",
            "message": "Loading artist runtime...",
            "message_key": "loading_runtime",
        }
    )
    assert service.get_batch_progress()["message_key"] == "loading_runtime"

    service.apply_batch_progress_update(
        {
            "step": "identifying",
            "message": "Identifying 3 image(s)...",
            "message_key": "identifying",
        }
    )
    assert service.get_batch_progress()["message_key"] == "identifying"


def test_done_and_error_states_have_keys():
    service = ArtistService()
    service.start_batch_progress(total=2)

    service.finish_batch_progress_done({"processed": 1, "total": 2, "errors": 1})
    done = service.get_batch_progress()
    assert done["message_key"] == "done"
    assert (
        done["processed"] == 0
    )  # counters come from the worker updates, not the summary

    service.start_batch_progress(total=2)
    service.finish_batch_progress_error(RuntimeError("model missing"))
    failed = service.get_batch_progress()
    assert failed["message_key"] == "error"
    assert failed["message_detail"] == "model missing"


def test_batch_run_emits_keys_for_each_stage(test_db, tmp_path):
    from PIL import Image

    path = tmp_path / "a.png"
    Image.new("RGB", (16, 16), color="red").save(path)
    image_id = test_db.add_image(path=str(path), filename="a.png", metadata_json="{}")

    class _Identifier:
        def identify_with_threshold(self, image_path, top_k, threshold):
            return {"error": "no model"}

    service = ArtistService(identifier_getter=lambda **kwargs: _Identifier())
    updates = []

    service.run_batch_identification(
        image_ids=[image_id],
        threshold=0.5,
        top_k=3,
        progress_callback=updates.append,
    )

    keys = [update["message_key"] for update in updates if "message_key" in update]
    assert keys[:2] == ["loading_runtime", "identifying"]
    assert "identifying_item" in keys


def test_progress_endpoint_exposes_the_key(test_client):
    from routers import artists as artists_router

    service = artists_router.get_artist_service()
    service.start_batch_progress(total=1)
    try:
        body = test_client.get("/api/artists/batch-progress").json()
    finally:
        service.finish_batch_progress_done({"processed": 0, "total": 1, "errors": 0})

    assert body["message_key"] == "preparing"
