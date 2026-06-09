from __future__ import annotations


def test_bulk_tag_operations_reject_overlap(monkeypatch, test_client, tmp_path):
    """Overlapping bulk writes should fail fast instead of losing tag updates."""
    import database as db
    import routers.tags_bulk as tags_bulk

    image_id = db.add_image(path=str(tmp_path / "bulk-overlap.png"), filename="bulk-overlap.png")
    db.add_tags(image_id, [{"tag": "keep_tag", "confidence": 0.8}])
    assert tags_bulk._op_run_lock.acquire(blocking=False)
    try:
        response = test_client.post("/api/tags/bulk/add", json={
            "image_ids": [image_id],
            "tags": ["new_tag"],
            "dry_run": False,
        })
    finally:
        tags_bulk._op_run_lock.release()

    assert response.status_code == 409
    assert "already running" in response.text


def test_bulk_add_accepts_selection_token_in_chunks(monkeypatch, test_client, tmp_path):
    """Mass tag should consume selection tokens directly instead of requiring giant image_ids JSON."""
    import database as db
    import routers.tags_bulk as tags_bulk

    image_ids = []
    for index in range(5):
        image_path = tmp_path / f"bulk-token-scope-{index}.png"
        image_path.write_bytes(b"not a real image")
        image_ids.append(
            db.add_image(path=str(image_path), filename=image_path.name)
        )

    token_response = test_client.post("/api/images/selection-token", json={
        "search": "bulk-token-scope-",
        "sortBy": "oldest",
        "chunkSize": 2,
    })
    assert token_response.status_code == 200

    monkeypatch.setattr(tags_bulk, "BULK_TAG_ID_CHUNK_SIZE", 2)
    original_get_image_tags_map = db.get_image_tags_map
    observed_chunks = []

    def recording_get_image_tags_map(chunk):
        observed_chunks.append(list(chunk))
        assert len(chunk) <= 2
        return original_get_image_tags_map(chunk)

    monkeypatch.setattr(tags_bulk.db, "get_image_tags_map", recording_get_image_tags_map)

    response = test_client.post("/api/tags/bulk/add", json={
        "selection_token": token_response.json()["selection_token"],
        "tags": ["token_added"],
        "dry_run": True,
    })

    assert response.status_code == 200
    payload = response.json()
    assert payload["total_images_checked"] == 5
    assert payload["affected_images"] == 5
    assert payload["total_tags_added"] == 5
    assert observed_chunks == [image_ids[:2], image_ids[2:4], image_ids[4:]]


def test_bulk_remove_accepts_filter_contract_in_chunks(monkeypatch, test_client, tmp_path):
    """Bulk tag endpoints should accept a filter contract without pre-materialized image_ids."""
    import database as db
    import routers.tags_bulk as tags_bulk

    image_ids = []
    for index in range(5):
        image_path = tmp_path / f"bulk-filter-contract-{index}.png"
        image_path.write_bytes(b"not a real image")
        image_id = db.add_image(path=str(image_path), filename=image_path.name)
        db.add_tags(image_id, [
            {"tag": "remove_me", "confidence": 0.9},
            {"tag": "keep_me", "confidence": 0.8},
        ])
        image_ids.append(image_id)

    monkeypatch.setattr(tags_bulk, "BULK_TAG_ID_CHUNK_SIZE", 2)
    original_get_image_tags_map = db.get_image_tags_map
    observed_chunks = []

    def recording_get_image_tags_map(chunk):
        observed_chunks.append(list(chunk))
        assert len(chunk) <= 2
        return original_get_image_tags_map(chunk)

    monkeypatch.setattr(tags_bulk.db, "get_image_tags_map", recording_get_image_tags_map)

    response = test_client.post("/api/tags/bulk/remove", json={
        "filters": {
            "search": "bulk-filter-contract-",
            "sortBy": "oldest",
        },
        "tags": ["remove_me"],
        "dry_run": False,
    })

    assert response.status_code == 200
    payload = response.json()
    assert payload["total_images_checked"] == 5
    assert payload["affected_images"] == 5
    assert payload["total_tags_removed"] == 5
    assert observed_chunks == [image_ids[:2], image_ids[2:4], image_ids[4:]]
    for image_id in image_ids:
        assert [row["tag"] for row in db.get_image_tags(image_id)] == ["keep_me"]


def test_bulk_filter_contract_preserves_full_gallery_scope(test_client, tmp_path):
    """Legacy filters scope should not drop Gallery filters before mutating tags."""
    import database as db

    alpha = tmp_path / "bulk-contract-alpha"
    beta = tmp_path / "bulk-contract-beta"
    alpha.mkdir()
    beta.mkdir()
    collection = db.create_collection("Bulk Filter Contract")
    collection_id = int(collection["id"])

    def add_case(name, *, folder=alpha, generator="comfyui", prompt="clean prompt", rating=5, color="warm", member=True):
        image_path = folder / f"bulk-contract-{name}.png"
        image_id = db.add_image(
            path=str(image_path),
            filename=image_path.name,
            generator=generator,
            prompt=prompt,
            metadata_json="{}",
        )
        db.add_tags(image_id, [{"tag": "remove_me", "confidence": 0.9}])
        db.set_user_rating(image_id, rating)
        db.update_image_colors(image_id, {
            "avg_brightness": 128,
            "color_temperature": color,
            "brightness_distribution": "balanced",
        })
        if member:
            db.set_collection_membership(collection_id, image_id, True)
        return image_id

    keep_id = add_case("keep")
    add_case("low-rating", rating=2)
    add_case("excluded-prompt", prompt="clean prompt, blocked-term")
    add_case("excluded-color", color="cool")
    add_case("wrong-collection", member=False)
    add_case("wrong-folder", folder=beta)
    add_case("no-metadata", generator="unknown", prompt=None)

    response = test_client.post("/api/tags/bulk/remove", json={
        "filters": {
            "search": "bulk-contract-",
            "sortBy": "name_asc",
            "minUserRating": 4,
            "excludePrompts": ["blocked-term"],
            "excludeColors": ["cool"],
            "collectionId": collection_id,
            "folder": str(alpha),
            "hasMetadata": True,
        },
        "tags": ["remove_me"],
        "dry_run": True,
    })

    assert response.status_code == 200
    payload = response.json()
    assert payload["total_images_checked"] == 1
    assert payload["affected_images"] == 1
    assert payload["sample_changes"][0]["image_id"] == keep_id


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
