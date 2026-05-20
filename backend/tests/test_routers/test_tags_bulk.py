from __future__ import annotations


def test_find_replace_empty_replace_deletes_matching_tag(test_client, tmp_path):
    """Find & Replace with an empty replacement is the UI's delete operation."""
    import database as db

    image_id = db.add_image(path=str(tmp_path / "bulk-delete.png"), filename="bulk-delete.png")
    db.add_tags(image_id, [
        {"tag": "bad_tag", "confidence": 0.9},
        {"tag": "keep_tag", "confidence": 0.8},
    ])

    response = test_client.post("/api/tags/bulk/find-replace", json={
        "image_ids": [image_id],
        "find": "bad_tag",
        "replace": "",
        "dry_run": False,
    })

    assert response.status_code == 200
    payload = response.json()
    assert payload["affected_images"] == 1
    assert payload["affected_tags"] == 1
    assert payload["sample_changes"][0]["after"] == ["keep_tag"]
    assert [row["tag"] for row in db.get_image_tags(image_id)] == ["keep_tag"]
