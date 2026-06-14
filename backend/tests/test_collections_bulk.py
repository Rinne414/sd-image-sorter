"""Tests for the v3.4.3 P4 bulk collection membership endpoint.

POST /api/collections/{collection_id}/items/bulk — batch add/remove by
explicit id list or gallery filtered-selection token, including the
path-anchored Favorites routing.
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image


def _add_image(tmp_path: Path, name: str = "bulk.png"):
    import database as db

    p = tmp_path / name
    Image.new("RGB", (16, 16), color="blue").save(p)
    return db.add_image(path=str(p), filename=name)


def _add_images(tmp_path: Path, count: int, prefix: str = "bulk"):
    return [_add_image(tmp_path, f"{prefix}_{i}.png") for i in range(count)]


def _make_collection(test_client, name: str = "Bulk Set") -> int:
    return test_client.post("/api/collections", json={"name": name}).json()["id"]


def test_bulk_add_many_images(test_client, test_db, tmp_path: Path):
    ids = _add_images(tmp_path, 3)
    cid = _make_collection(test_client)

    response = test_client.post(
        f"/api/collections/{cid}/items/bulk",
        json={"image_ids": ids, "member": True},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["success"] is True
    assert body["added"] == 3
    assert body["removed"] == 0
    assert body["requested"] == 3

    listed = test_client.get(f"/api/collections/{cid}/images").json()["image_ids"]
    assert set(listed) == set(ids)


def test_bulk_add_is_idempotent(test_client, test_db, tmp_path: Path):
    ids = _add_images(tmp_path, 3, prefix="idem")
    cid = _make_collection(test_client, "Idempotent Set")

    first = test_client.post(
        f"/api/collections/{cid}/items/bulk", json={"image_ids": ids, "member": True}
    ).json()
    second = test_client.post(
        f"/api/collections/{cid}/items/bulk", json={"image_ids": ids, "member": True}
    ).json()
    # Re-adding upserts the same rows (added counts the upserts), and the
    # collection must not grow duplicates.
    assert first["added"] == 3
    assert second["added"] == 3
    listed = test_client.get(f"/api/collections/{cid}/images").json()["image_ids"]
    assert sorted(listed) == sorted(ids)


def test_bulk_add_dedupes_input_and_skips_missing_ids(test_client, test_db, tmp_path: Path):
    image_id = _add_image(tmp_path, "only.png")
    cid = _make_collection(test_client, "Dedupe Set")

    response = test_client.post(
        f"/api/collections/{cid}/items/bulk",
        json={"image_ids": [image_id, image_id, 999999], "member": True},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["requested"] == 3
    assert body["added"] == 1  # duplicate collapsed, missing id silently skipped
    listed = test_client.get(f"/api/collections/{cid}/images").json()["image_ids"]
    assert listed == [image_id]


def test_bulk_remove(test_client, test_db, tmp_path: Path):
    ids = _add_images(tmp_path, 3, prefix="rm")
    cid = _make_collection(test_client, "Remove Set")
    test_client.post(f"/api/collections/{cid}/items/bulk", json={"image_ids": ids, "member": True})

    response = test_client.post(
        f"/api/collections/{cid}/items/bulk",
        json={"image_ids": ids[:2], "member": False},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["added"] == 0
    assert body["removed"] == 2

    listed = test_client.get(f"/api/collections/{cid}/images").json()["image_ids"]
    assert listed == [ids[2]]

    # Removing again is a no-op and reports 0 actual deletions.
    again = test_client.post(
        f"/api/collections/{cid}/items/bulk", json={"image_ids": ids[:2], "member": False}
    ).json()
    assert again["removed"] == 0


def test_bulk_add_via_selection_token(test_client, test_db, tmp_path: Path, monkeypatch):
    import routers.collections as collections_router

    ids = _add_images(tmp_path, 4, prefix="tok")
    cid = _make_collection(test_client, "Token Set")

    def fake_chunks(selection_token, chunk_size=500):
        assert selection_token == "tok-abc"
        yield ids[:2]
        yield ids[2:]

    monkeypatch.setattr(collections_router, "iter_selection_token_id_chunks", fake_chunks)

    response = test_client.post(
        f"/api/collections/{cid}/items/bulk",
        json={"selection_token": "tok-abc", "member": True},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["added"] == 4
    assert body["requested"] == 4

    listed = test_client.get(f"/api/collections/{cid}/images").json()["image_ids"]
    assert set(listed) == set(ids)


def test_bulk_missing_collection_returns_404(test_client, test_db, tmp_path: Path):
    image_id = _add_image(tmp_path, "orphan_bulk.png")
    response = test_client.post(
        "/api/collections/999999/items/bulk",
        json={"image_ids": [image_id], "member": True},
    )
    assert response.status_code == 404


def test_bulk_empty_scope_rejected(test_client, test_db):
    # Neither image_ids nor selection_token → validation error (400/422 family,
    # same convention as test_create_collection_rejects_blank_name).
    response = test_client.post("/api/collections/1/items/bulk", json={"member": True})
    assert response.status_code in (400, 422)


def test_bulk_favorites_routes_to_path_anchored_storage(test_client, test_db, tmp_path: Path):
    """Bulk add/remove on Favorites must hit favorite_paths, not collection_items."""
    import database as db

    fav_id = db.get_favorites_collection_id()
    ids = _add_images(tmp_path, 3, prefix="fav")

    added = test_client.post(
        f"/api/collections/{fav_id}/items/bulk",
        json={"image_ids": ids, "member": True},
    )
    assert added.status_code == 200
    assert added.json()["added"] == 3

    # Heart hydration + counts read favorite_paths — bulk add must land there.
    fav_body = test_client.get("/api/collections/favorites/ids").json()
    assert set(ids) <= set(fav_body["image_ids"])
    for image_id in ids:
        assert db.is_favorited(image_id)

    removed = test_client.post(
        f"/api/collections/{fav_id}/items/bulk",
        json={"image_ids": ids, "member": False},
    )
    assert removed.status_code == 200
    assert removed.json()["removed"] == 3
    remaining = set(test_client.get("/api/collections/favorites/ids").json()["image_ids"])
    assert not (set(ids) & remaining)
