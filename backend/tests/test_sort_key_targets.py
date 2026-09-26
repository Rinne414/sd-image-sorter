"""A sort key on a collection, and on the built-in Favorites collection.

A key pointed at Favorites favorites the image the way the heart does
(``favorite_paths``), not a ``collection_items`` row the heart never reads.
Undoing a key takes out only what that key added: an image that was already
a favorite (or already in the collection) keeps its place. History entries
written before this was recorded undo as they always did.
"""

from pathlib import Path

import pytest


def _add_image(db, tmp_path: Path, name: str) -> int:
    from PIL import Image

    folder = tmp_path / "key_targets"
    folder.mkdir(exist_ok=True)
    path = folder / name
    Image.new("RGB", (32, 32), color="teal").save(path)
    return db.add_image(
        path=str(path),
        filename=name,
        generator="unknown",
        prompt=name,
        metadata_json="{}",
    )


def _start_with_key(client, collection_id: int) -> None:
    client.delete("/api/sort/session")
    started = client.post("/api/sort/start?generators=unknown")
    assert started.status_code == 200
    assigned = client.post(
        "/api/sort/set-folders",
        json={"folders": {}, "collection_slots": {"w": collection_id}},
    )
    assert assigned.status_code == 200


def _favorite_ids(client) -> set[int]:
    return set(client.get("/api/collections/favorites/ids").json()["image_ids"])


def _press(client, action: str) -> dict:
    query = "action=collect&folder_key=w" if action == "collect" else f"action={action}"
    response = client.post(f"/api/sort/action?{query}")
    assert response.status_code == 200
    body = response.json()
    assert "error" not in body, body
    return body


@pytest.fixture
def one_image(test_client, tmp_path):
    db = test_client.test_db
    return db, _add_image(db, tmp_path, "key_target.png")


def test_a_favorites_key_really_favorites_the_image(test_client, one_image):
    db, image_id = one_image
    _start_with_key(test_client, db.get_favorites_collection_id())

    _press(test_client, "collect")
    assert image_id in _favorite_ids(test_client)
    assert db.is_favorited(image_id)

    _press(test_client, "undo")
    assert image_id not in _favorite_ids(test_client)

    _press(test_client, "redo")
    assert image_id in _favorite_ids(test_client)


def test_undo_keeps_an_image_that_was_a_favorite_before_the_key(test_client, one_image):
    db, image_id = one_image
    assert (
        test_client.post(
            "/api/collections/favorites", json={"image_id": image_id, "favorited": True}
        ).status_code
        == 200
    )
    _start_with_key(test_client, db.get_favorites_collection_id())

    _press(test_client, "collect")
    assert image_id in _favorite_ids(test_client)
    _press(test_client, "undo")
    assert image_id in _favorite_ids(test_client)


def test_undo_keeps_an_image_that_was_in_the_collection_before_the_key(
    test_client, one_image
):
    db, image_id = one_image
    collection_id = test_client.post(
        "/api/collections", json={"name": "Keepers"}
    ).json()["id"]
    assert (
        test_client.post(
            f"/api/collections/{collection_id}/items", json={"image_id": image_id}
        ).status_code
        == 200
    )
    _start_with_key(test_client, collection_id)

    _press(test_client, "collect")
    _press(test_client, "undo")
    assert image_id in db.get_collection_image_ids(collection_id)


def test_undo_of_a_collection_key_still_takes_out_what_it_added(test_client, one_image):
    db, image_id = one_image
    collection_id = test_client.post("/api/collections", json={"name": "Fresh"}).json()[
        "id"
    ]
    _start_with_key(test_client, collection_id)

    _press(test_client, "collect")
    assert image_id in db.get_collection_image_ids(collection_id)
    _press(test_client, "undo")
    assert image_id not in db.get_collection_image_ids(collection_id)


def test_a_history_entry_from_before_undoes_as_it_always_did(test_client, one_image):
    """An entry saved without ``was_member`` (an older session) removes the membership on undo."""
    from routers.sorting import get_sorting_service

    db, image_id = one_image
    collection_id = test_client.post(
        "/api/collections", json={"name": "Old session"}
    ).json()["id"]
    assert (
        test_client.post(
            f"/api/collections/{collection_id}/items", json={"image_id": image_id}
        ).status_code
        == 200
    )
    _start_with_key(test_client, collection_id)
    _press(test_client, "collect")

    entry = get_sorting_service()._sort_session["history"][-1]
    for key in ("was_member", "favorites"):
        entry.pop(key, None)
    assert entry == {
        "action": "collect",
        "image_id": image_id,
        "collection_id": collection_id,
        "folder_key": "w",
    }

    _press(test_client, "undo")
    assert image_id not in db.get_collection_image_ids(collection_id)
