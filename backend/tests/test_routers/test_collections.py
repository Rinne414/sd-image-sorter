"""Tests for the v3.3.0 Collections & Favorites router."""
from __future__ import annotations

from pathlib import Path

from PIL import Image


def _add_image(tmp_path: Path, name: str = "c.png"):
    import database as db

    p = tmp_path / name
    Image.new("RGB", (16, 16), color="red").save(p)
    return db.add_image(path=str(p), filename=name)


def test_favorites_collection_seeded(test_client):
    response = test_client.get("/api/collections")
    assert response.status_code == 200
    slugs = {c["slug"] for c in response.json()["collections"]}
    assert "favorites" in slugs


def test_toggle_favorite_roundtrip(test_client, test_db, tmp_path: Path):
    image_id = _add_image(tmp_path)

    on = test_client.post("/api/collections/favorites", json={"image_id": image_id, "favorited": True})
    assert on.status_code == 200
    assert on.json()["favorited"] is True

    ids = test_client.get("/api/collections/favorites/ids").json()
    assert image_id in ids["image_ids"]
    assert ids["count"] >= 1

    off = test_client.post("/api/collections/favorites", json={"image_id": image_id, "favorited": False})
    assert off.status_code == 200
    assert off.json()["favorited"] is False
    assert image_id not in test_client.get("/api/collections/favorites/ids").json()["image_ids"]


def test_favorite_missing_image_returns_404(test_client, test_db):
    response = test_client.post("/api/collections/favorites", json={"image_id": 999999, "favorited": True})
    assert response.status_code == 404


# PLACEHOLDER_MORE_TESTS


def test_create_rename_delete_collection(test_client, test_db):
    created = test_client.post("/api/collections", json={"name": "My Best"})
    assert created.status_code == 200
    body = created.json()
    cid = body["id"]
    assert body["slug"] == "my-best"

    renamed = test_client.patch(f"/api/collections/{cid}", json={"name": "Renamed"})
    assert renamed.status_code == 200

    listing = test_client.get("/api/collections").json()["collections"]
    match = next(c for c in listing if c["id"] == cid)
    assert match["name"] == "Renamed"
    assert match["slug"] == "my-best"  # slug stays stable across rename

    deleted = test_client.delete(f"/api/collections/{cid}")
    assert deleted.status_code == 200
    listing2 = test_client.get("/api/collections").json()["collections"]
    assert all(c["id"] != cid for c in listing2)


def test_cannot_delete_favorites(test_client, test_db):
    import database as db

    fav_id = db.get_favorites_collection_id()
    response = test_client.delete(f"/api/collections/{fav_id}")
    assert response.status_code == 400


def test_membership_roundtrip_and_image_listing(test_client, test_db, tmp_path: Path):
    image_id = _add_image(tmp_path, "member.png")
    cid = test_client.post("/api/collections", json={"name": "Set A"}).json()["id"]

    add = test_client.post(f"/api/collections/{cid}/items", json={"image_id": image_id, "member": True})
    assert add.status_code == 200
    assert add.json()["member"] is True

    images = test_client.get(f"/api/collections/{cid}/images").json()["image_ids"]
    assert images == [image_id]

    remove = test_client.post(f"/api/collections/{cid}/items", json={"image_id": image_id, "member": False})
    assert remove.status_code == 200
    assert remove.json()["member"] is False
    assert test_client.get(f"/api/collections/{cid}/images").json()["image_ids"] == []


def test_membership_missing_collection_returns_404(test_client, test_db, tmp_path: Path):
    image_id = _add_image(tmp_path, "orphan.png")
    response = test_client.post("/api/collections/999999/items", json={"image_id": image_id, "member": True})
    assert response.status_code == 404


def test_create_collection_rejects_blank_name(test_client, test_db):
    response = test_client.post("/api/collections", json={"name": "   "})
    # Pydantic min_length on a blank-after-strip name → 400/422 family.
    assert response.status_code in (400, 422)


def test_images_filter_by_collection_id(test_client, test_db, tmp_path: Path):
    """GET /api/images?collection_id=X returns only that collection's members (v3.3.1)."""
    in_id = _add_image(tmp_path, "in_collection.png")
    out_id = _add_image(tmp_path, "out_collection.png")
    cid = test_client.post("/api/collections", json={"name": "Filter Set"}).json()["id"]
    test_client.post(f"/api/collections/{cid}/items", json={"image_id": in_id, "member": True})

    # Unfiltered listing sees both images.
    all_ids = {img["id"] for img in test_client.get("/api/images?limit=100").json()["images"]}
    assert {in_id, out_id} <= all_ids

    # Filtered listing sees only the collection member, and composes with pagination.
    filtered_body = test_client.get(f"/api/images?collection_id={cid}&limit=100").json()
    assert {img["id"] for img in filtered_body["images"]} == {in_id}
    # v3.3.1: the reported total must ALSO be collection-scoped, not the whole
    # library (regression guard for _get_filtered_count ignoring collection_id).
    assert filtered_body.get("total") == 1


def test_images_filter_by_favorites_collection(test_client, test_db, tmp_path: Path):
    """The Favorites view is just collection_id=<favorites id> (v3.3.1)."""
    import database as db

    fav_id = db.get_favorites_collection_id()
    liked = _add_image(tmp_path, "liked.png")
    plain = _add_image(tmp_path, "plain.png")
    test_client.post("/api/collections/favorites", json={"image_id": liked, "favorited": True})

    filtered = test_client.get(f"/api/images?collection_id={fav_id}&limit=100").json()["images"]
    filtered_ids = {img["id"] for img in filtered}
    assert liked in filtered_ids
    assert plain not in filtered_ids

