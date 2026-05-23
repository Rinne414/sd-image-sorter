"""Tests for the v3.2.2 dataset vocab endpoint (T10)."""
from __future__ import annotations


def test_vocab_from_path_overrides_only(test_client):
    """No DB rows; just split caption text by comma."""
    resp = test_client.post("/api/dataset/vocab", json={
        "image_ids": [],
        "path_caption_overrides": {
            "/a.png": "my_oc, masterpiece, blue_hair",
            "/b.png": "my_oc, blue_hair",
            "/c.png": "my_oc",
        },
    })
    assert resp.status_code == 200, resp.text
    body = resp.json()
    by_tag = {entry["tag"]: entry["count"] for entry in body["vocab"]}
    assert by_tag.get("my_oc") == 3
    assert by_tag.get("blue_hair") == 2
    assert by_tag.get("masterpiece") == 1
    assert body["total_unique_tags"] == 3


def test_vocab_orders_by_descending_count(test_client):
    resp = test_client.post("/api/dataset/vocab", json={
        "image_ids": [],
        "path_caption_overrides": {"/a.png": "rare, common, common, common"},
    })
    body = resp.json()
    assert body["vocab"][0]["tag"] == "common"
    assert body["vocab"][0]["count"] == 3


def test_vocab_top_n_truncates(test_client):
    overrides = {f"/img_{i}.png": ", ".join(f"tag_{j}" for j in range(20))
                 for i in range(5)}
    resp = test_client.post("/api/dataset/vocab", json={
        "image_ids": [],
        "path_caption_overrides": overrides,
        "top_n": 5,
    })
    body = resp.json()
    assert len(body["vocab"]) == 5
    assert body["total_unique_tags"] == 20


def test_vocab_includes_db_tags(test_db, test_client):
    """Tags from image_ids (DB-source) should appear alongside local tags."""
    import database as db
    image_id = db.add_image(path="/tmp/v.png", filename="v.png")
    db.add_tags(image_id, [
        {"tag": "1girl", "confidence": 0.9},
        {"tag": "blue_hair", "confidence": 0.85},
    ])
    resp = test_client.post("/api/dataset/vocab", json={
        "image_ids": [image_id],
        "path_caption_overrides": {},
    })
    body = resp.json()
    by_tag = {entry["tag"]: entry["count"] for entry in body["vocab"]}
    assert by_tag.get("1girl") == 1
    assert by_tag.get("blue_hair") == 1
