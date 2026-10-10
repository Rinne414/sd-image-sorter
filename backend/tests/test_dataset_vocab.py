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


def test_vocab_counts_shown_gallery_captions_instead_of_db_tags(test_db, test_client):
    """A gallery image whose caption the editor shows is counted from that caption.

    The DB tag table only seeds the caption; trigger/common tags, blacklist and
    the user's edits live in the shown caption, so the vocabulary must use it.
    Images without a loaded caption still fall back to their DB tags.
    """
    import database as db

    shown = db.add_image(path="/tmp/shown.png", filename="shown.png")
    db.add_tags(shown, [{"tag": "blue_hair", "confidence": 0.9}])
    unloaded = db.add_image(path="/tmp/unloaded.png", filename="unloaded.png")
    db.add_tags(unloaded, [{"tag": "1girl", "confidence": 0.9}])

    resp = test_client.post(
        "/api/dataset/vocab",
        json={
            "image_ids": [shown, unloaded],
            "image_caption_overrides": {str(shown): "my_oc, red_hair"},
        },
    )

    assert resp.status_code == 200, resp.text
    vocab = {entry["tag"]: entry for entry in resp.json()["vocab"]}
    assert {tag: entry["count"] for tag, entry in vocab.items()} == {
        "1girl": 1,
        "my_oc": 1,
        "red_hair": 1,
    }
    assert vocab["my_oc"]["sample_image_id"] == shown
    assert vocab["1girl"]["sample_image_id"] == unloaded
