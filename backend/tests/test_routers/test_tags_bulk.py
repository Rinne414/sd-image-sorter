from __future__ import annotations

import pytest


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


def test_bulk_remove_filter_scope_covers_all_images_when_scope_matches_mutated_tag(monkeypatch, test_client, tmp_path):
    """Filters scope must not skip images when the filter matches the tag being removed.

    Offset pagination re-runs the filtered query between chunks. Removing tag X
    from a tag-X scope shrinks the matching set after every committed chunk, so
    without a pre-mutation ID snapshot roughly half the images are silently
    skipped (1000 matches / chunk 500 -> only 500 processed).
    """
    import database as db
    import routers.tags_bulk as tags_bulk

    image_ids = []
    for index in range(5):
        image_path = tmp_path / f"bulk-self-mutate-{index}.png"
        image_path.write_bytes(b"not a real image")
        image_id = db.add_image(path=str(image_path), filename=image_path.name)
        db.add_tags(image_id, [{"tag": "self_mutate_tag", "confidence": 0.9}])
        image_ids.append(image_id)

    monkeypatch.setattr(tags_bulk, "BULK_TAG_ID_CHUNK_SIZE", 2)

    response = test_client.post("/api/tags/bulk/remove", json={
        "filters": {
            "tags": ["self_mutate_tag"],
            "sortBy": "oldest",
        },
        "tags": ["self_mutate_tag"],
        "dry_run": False,
    })

    assert response.status_code == 200
    payload = response.json()
    assert payload["total_images_checked"] == 5
    assert payload["affected_images"] == 5
    assert payload["total_tags_removed"] == 5
    for image_id in image_ids:
        assert db.get_image_tags(image_id) == []


def test_bulk_remove_token_scope_covers_all_images_when_scope_matches_mutated_tag(monkeypatch, test_client, tmp_path):
    """Selection-token scope is the same offset iterator; it needs the same snapshot."""
    import database as db
    import routers.tags_bulk as tags_bulk

    image_ids = []
    for index in range(5):
        image_path = tmp_path / f"bulk-token-self-mutate-{index}.png"
        image_path.write_bytes(b"not a real image")
        image_id = db.add_image(path=str(image_path), filename=image_path.name)
        db.add_tags(image_id, [{"tag": "token_mutate_tag", "confidence": 0.9}])
        image_ids.append(image_id)

    token_response = test_client.post("/api/images/selection-token", json={
        "tags": ["token_mutate_tag"],
        "sortBy": "oldest",
    })
    assert token_response.status_code == 200

    monkeypatch.setattr(tags_bulk, "BULK_TAG_ID_CHUNK_SIZE", 2)

    response = test_client.post("/api/tags/bulk/remove", json={
        "selection_token": token_response.json()["selection_token"],
        "tags": ["token_mutate_tag"],
        "dry_run": False,
    })

    assert response.status_code == 200
    payload = response.json()
    assert payload["total_images_checked"] == 5
    assert payload["affected_images"] == 5
    assert payload["total_tags_removed"] == 5
    for image_id in image_ids:
        assert db.get_image_tags(image_id) == []


def test_bulk_scope_malformed_selection_token_returns_400(test_client):
    """A token with a non-numeric filter value must 400, not 500 inside SQL builders."""
    import base64
    import json

    payload = {"v": 2, "filters": {"minUserRating": "abc", "sortBy": "newest"}}
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    token = base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")

    response = test_client.post("/api/tags/bulk/remove", json={
        "selection_token": token,
        "tags": ["whatever"],
        "dry_run": True,
    })

    assert response.status_code == 400
    assert "selection token" in response.json()["error"].lower()


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


def test_bulk_ops_preserve_tag_provenance(test_client, tmp_path):
    """Bulk rewrites must carry source/category through (migration 024).

    Regression: the four bulk ops rebuilt rows as {tag, confidence} only,
    so add_tags(replace_scope="all") re-inserted every row with NULL
    provenance -- and the next pipeline re-tag (replace_scope="pipeline")
    would then delete formerly-manual rows.
    """
    import database as db

    image_path = tmp_path / "bulk-provenance.png"
    image_path.write_bytes(b"not a real image")
    image_id = db.add_image(path=str(image_path), filename=image_path.name)
    db.add_tags(image_id, [
        {"tag": "hand_made", "confidence": 1.0, "source": "manual", "category": "outfit"},
        {"tag": "machine_made", "confidence": 0.9, "source": "tagger", "category": "general"},
        {"tag": "old_name", "confidence": 0.8, "source": "tagger", "category": "general"},
    ])

    # --- find/replace: rename old_name -> new_name ---
    response = test_client.post("/api/tags/bulk/find-replace", json={
        "image_ids": [image_id],
        "find": "old_name",
        "replace": "new_name",
        "dry_run": False,
    })
    assert response.status_code == 200
    rows = {row["tag"]: row for row in db.get_image_tags(image_id)}
    assert rows["hand_made"]["source"] == "manual"
    assert rows["hand_made"]["category"] == "outfit"
    assert rows["machine_made"]["source"] == "tagger"
    assert rows["machine_made"]["category"] == "general"
    # A user-initiated rename produces a user-owned row.
    assert rows["new_name"]["source"] == "manual"

    # --- bulk add: untouched rows keep provenance, new rows are manual ---
    response = test_client.post("/api/tags/bulk/add", json={
        "image_ids": [image_id],
        "tags": ["user_added"],
        "dry_run": False,
    })
    assert response.status_code == 200
    rows = {row["tag"]: row for row in db.get_image_tags(image_id)}
    assert rows["hand_made"]["source"] == "manual"
    assert rows["hand_made"]["category"] == "outfit"
    assert rows["machine_made"]["source"] == "tagger"
    assert rows["user_added"]["source"] == "manual"

    # --- bulk remove: surviving rows keep provenance ---
    response = test_client.post("/api/tags/bulk/remove", json={
        "image_ids": [image_id],
        "tags": ["user_added"],
        "dry_run": False,
    })
    assert response.status_code == 200
    rows = {row["tag"]: row for row in db.get_image_tags(image_id)}
    assert "user_added" not in rows
    assert rows["hand_made"]["source"] == "manual"
    assert rows["machine_made"]["source"] == "tagger"

    # --- cleanup (dedupe path) : surviving rows keep provenance ---
    response = test_client.post("/api/tags/bulk/cleanup", json={
        "image_ids": [image_id],
        "min_confidence": 0.85,
        "dedupe": True,
        "dry_run": False,
    })
    assert response.status_code == 200
    rows = {row["tag"]: row for row in db.get_image_tags(image_id)}
    assert "new_name" not in rows  # 0.8 < 0.85 cleaned up
    assert rows["hand_made"]["source"] == "manual"
    assert rows["hand_made"]["category"] == "outfit"
    assert rows["machine_made"]["source"] == "tagger"
    assert rows["machine_made"]["category"] == "general"


def _seed_provenance_image(db, tmp_path, name):
    image_path = tmp_path / name
    image_path.write_bytes(b"not a real image")
    image_id = db.add_image(path=str(image_path), filename=image_path.name)
    db.add_tags(image_id, [
        {"tag": "keep_manual", "confidence": 1.0, "source": "manual", "category": "outfit"},
        {"tag": "keep_tagger", "confidence": 0.9, "source": "tagger", "category": "general"},
    ])
    return image_id


def test_bulk_undo_restores_previous_tags(test_client, tmp_path):
    """FE-2s: an applied bulk op is journaled and can be fully undone."""
    import database as db

    ids = [
        _seed_provenance_image(db, tmp_path, f"undo-{i}.png")
        for i in range(2)
    ]

    response = test_client.post("/api/tags/bulk/add", json={
        "image_ids": ids,
        "tags": ["bulk_added"],
        "dry_run": False,
    })
    assert response.status_code == 200
    payload = response.json()
    assert payload["undo_available"] is True
    op_id = payload["op_id"]
    assert op_id

    listing = test_client.get("/api/tags/bulk/ops")
    assert listing.status_code == 200
    ops = listing.json()["ops"]
    assert ops[0]["id"] == op_id
    assert ops[0]["undo_available"] is True

    undo = test_client.post(f"/api/tags/bulk/undo/{op_id}", json={})
    assert undo.status_code == 200
    result = undo.json()
    assert result["restored"] == 2
    assert result["skipped_conflicts"] == []
    assert result["redo_op_id"]

    for image_id in ids:
        rows = {row["tag"]: row for row in db.get_image_tags(image_id)}
        assert "bulk_added" not in rows
        assert rows["keep_manual"]["source"] == "manual"
        assert rows["keep_manual"]["category"] == "outfit"
        assert rows["keep_tagger"]["source"] == "tagger"

    # One-shot: a second undo of the same op is a conflict error.
    again = test_client.post(f"/api/tags/bulk/undo/{op_id}", json={})
    assert again.status_code == 409


def test_bulk_undo_conflict_skip_then_force(test_client, tmp_path):
    """FE-2s: images edited after the op are skipped unless force=true."""
    import database as db

    ids = [
        _seed_provenance_image(db, tmp_path, f"conflict-{i}.png")
        for i in range(2)
    ]

    response = test_client.post("/api/tags/bulk/remove", json={
        "image_ids": ids,
        "tags": ["keep_tagger"],
        "dry_run": False,
    })
    assert response.status_code == 200
    op_id = response.json()["op_id"]

    # Edit image 0 AFTER the op -> its tag set no longer matches the digest.
    conflicted = ids[0]
    rows = db.get_image_tags(conflicted)
    db.add_tags(conflicted, rows + [{"tag": "late_edit", "confidence": 1.0, "source": "manual"}])

    undo = test_client.post(f"/api/tags/bulk/undo/{op_id}", json={})
    assert undo.status_code == 200
    result = undo.json()
    assert result["restored"] == 1
    assert result["skipped_conflicts"] == [conflicted]

    # The clean image got keep_tagger back; the conflicted one kept its edit.
    clean_rows = {row["tag"] for row in db.get_image_tags(ids[1])}
    assert "keep_tagger" in clean_rows
    conflicted_rows = {row["tag"] for row in db.get_image_tags(conflicted)}
    assert "late_edit" in conflicted_rows
    assert "keep_tagger" not in conflicted_rows


def test_bulk_dry_run_is_not_journaled(test_client, tmp_path):
    """FE-2s: dry runs must not create journal entries."""
    import database as db

    image_id = _seed_provenance_image(db, tmp_path, "dry-journal.png")
    before_ops = test_client.get("/api/tags/bulk/ops").json()["ops"]

    response = test_client.post("/api/tags/bulk/add", json={
        "image_ids": [image_id],
        "tags": ["dry_tag"],
        "dry_run": True,
    })
    assert response.status_code == 200
    assert response.json()["op_id"] is None
    assert response.json()["undo_available"] is False

    after_ops = test_client.get("/api/tags/bulk/ops").json()["ops"]
    assert len(after_ops) == len(before_ops)


def test_find_replace_regex_mode(test_client, tmp_path):
    """QW-3: opt-in regex uses whole-tag fullmatch + backref replacement."""
    import database as db

    image_path = tmp_path / "regex-fr.png"
    image_path.write_bytes(b"not a real image")
    image_id = db.add_image(path=str(image_path), filename=image_path.name)
    db.add_tags(image_id, [
        {"tag": "hair_ribbon", "confidence": 0.9},
        {"tag": "hair_bow", "confidence": 0.9},
        {"tag": "crosshair_ribbon", "confidence": 0.9},  # fullmatch must NOT hit this
        {"tag": "1girl", "confidence": 0.9},
    ])

    response = test_client.post("/api/tags/bulk/find-replace", json={
        "image_ids": [image_id],
        "find": r"hair_(ribbon|bow)",
        "replace": r"hair_accessory_\1",
        "regex": True,
        "dry_run": False,
    })
    assert response.status_code == 200
    assert response.json()["affected_tags"] == 2

    tags = {row["tag"] for row in db.get_image_tags(image_id)}
    assert "hair_accessory_ribbon" in tags
    assert "hair_accessory_bow" in tags
    assert "crosshair_ribbon" in tags  # untouched: fullmatch semantics
    assert "hair_ribbon" not in tags

    # Invalid pattern is a 400, not a 500.
    bad = test_client.post("/api/tags/bulk/find-replace", json={
        "image_ids": [image_id],
        "find": "(unclosed",
        "replace": "",
        "regex": True,
        "dry_run": True,
    })
    assert bad.status_code == 400

    bad_replacement = test_client.post("/api/tags/bulk/find-replace", json={
        "image_ids": [image_id],
        "find": r"hair_(ribbon|bow)",
        "replace": r"hair_accessory_\2",
        "regex": True,
        "dry_run": True,
    })
    assert bad_replacement.status_code == 400
    assert "invalid regex replacement" in bad_replacement.json()["error"].lower()


def _seed_atomic_bulk_tag_images(db, tmp_path, count: int) -> list[int]:
    image_ids: list[int] = []
    for index in range(count):
        image_path = tmp_path / f"atomic-bulk-tag-{index}.png"
        image_path.write_bytes(b"not a real image")
        image_id = db.add_image(path=str(image_path), filename=image_path.name)
        db.add_tags(
            image_id,
            [{"tag": "original", "confidence": 1.0, "source": "manual"}],
        )
        image_ids.append(image_id)
    return image_ids


def test_bulk_add_dedupes_explicit_image_scope(test_client, tmp_path):
    import database as db

    image_id = _seed_atomic_bulk_tag_images(db, tmp_path, 1)[0]
    response = test_client.post(
        "/api/tags/bulk/add",
        json={"image_ids": [image_id, image_id], "tags": ["new_tag"]},
    )

    assert response.status_code == 200
    result = response.json()
    assert result["total_images_estimate"] == 1
    assert result["total_images_checked"] == 1
    assert result["affected_images"] == 1
    assert result["total_tags_added"] == 1
    journal_op = next(
        operation
        for operation in test_client.get("/api/tags/bulk/ops").json()["ops"]
        if operation["id"] == result["op_id"]
    )
    assert journal_op["images_affected"] == 1


def test_bulk_add_first_write_failure_rolls_back_without_journal(
    monkeypatch,
    test_client,
    tmp_path,
):
    """A failed logical operation must not report or journal planned writes."""
    import database as db
    import db_tags

    image_ids = _seed_atomic_bulk_tag_images(db, tmp_path, 2)
    previous_op_ids = {
        operation["id"]
        for operation in test_client.get("/api/tags/bulk/ops").json()["ops"]
    }

    def fail_replace(
        cursor: object,
        image_id: int,
        tags: list[dict[str, object]],
        *,
        default_source: str | None,
        replace_scope: str,
    ) -> None:
        raise RuntimeError(f"injected write failure for image_id={image_id}")

    monkeypatch.setattr(db_tags, "_replace_tag_rows", fail_replace)

    response = test_client.post(
        "/api/tags/bulk/add",
        json={"image_ids": image_ids, "tags": ["new_tag"], "dry_run": False},
    )

    assert response.status_code == 500
    assert "all changes were rolled back" in response.json()["error"].lower()
    assert "injected write failure" in response.json()["error"].lower()
    for image_id in image_ids:
        assert [row["tag"] for row in db.get_image_tags(image_id)] == ["original"]
    current_op_ids = {
        operation["id"]
        for operation in test_client.get("/api/tags/bulk/ops").json()["ops"]
    }
    assert current_op_ids == previous_op_ids


def test_bulk_add_later_chunk_failure_rolls_back_earlier_chunks(
    monkeypatch,
    test_client,
    tmp_path,
):
    """All scope chunks belong to one transaction, not one commit per chunk."""
    import database as db
    import db_tags
    import routers.tags_bulk as tags_bulk

    image_ids = _seed_atomic_bulk_tag_images(db, tmp_path, 3)
    failing_image_id = image_ids[1]
    original_replace = db_tags._replace_tag_rows
    previous_op_ids = {
        operation["id"]
        for operation in test_client.get("/api/tags/bulk/ops").json()["ops"]
    }

    def fail_second_chunk(
        cursor: object,
        image_id: int,
        tags: list[dict[str, object]],
        *,
        default_source: str | None,
        replace_scope: str,
    ) -> None:
        if image_id == failing_image_id:
            raise RuntimeError(
                f"injected later-chunk failure for image_id={image_id}"
            )
        original_replace(
            cursor,
            image_id,
            tags,
            default_source=default_source,
            replace_scope=replace_scope,
        )

    monkeypatch.setattr(tags_bulk, "BULK_TAG_ID_CHUNK_SIZE", 1)
    monkeypatch.setattr(db_tags, "_replace_tag_rows", fail_second_chunk)

    response = test_client.post(
        "/api/tags/bulk/add",
        json={"image_ids": image_ids, "tags": ["new_tag"], "dry_run": False},
    )

    assert response.status_code == 500
    assert "all changes were rolled back" in response.json()["error"].lower()
    assert "injected later-chunk failure" in response.json()["error"].lower()
    for image_id in image_ids:
        assert [row["tag"] for row in db.get_image_tags(image_id)] == ["original"]
    current_op_ids = {
        operation["id"]
        for operation in test_client.get("/api/tags/bulk/ops").json()["ops"]
    }
    assert current_op_ids == previous_op_ids


def test_bulk_add_preparation_failure_rolls_back_earlier_chunks(
    monkeypatch,
    test_client,
    tmp_path,
):
    """A preparation error must abort instead of silently skipping one image."""
    import database as db
    import routers.tags_bulk as tags_bulk

    image_ids = _seed_atomic_bulk_tag_images(db, tmp_path, 3)
    failing_image_id = image_ids[1]
    db.add_tags(
        failing_image_id,
        [{"tag": "fail_prepare", "confidence": 1.0, "source": "manual"}],
    )
    original_preserve_row = tags_bulk._preserve_row
    previous_op_ids = {
        operation["id"]
        for operation in test_client.get("/api/tags/bulk/ops").json()["ops"]
    }

    def fail_preparation(row: dict[str, object]) -> dict[str, object]:
        if row.get("tag") == "fail_prepare":
            raise RuntimeError(
                f"injected preparation failure for image_id={failing_image_id}"
            )
        return original_preserve_row(row)

    monkeypatch.setattr(tags_bulk, "BULK_TAG_ID_CHUNK_SIZE", 1)
    monkeypatch.setattr(tags_bulk, "_preserve_row", fail_preparation)

    response = test_client.post(
        "/api/tags/bulk/add",
        json={"image_ids": image_ids, "tags": ["new_tag"], "dry_run": False},
    )

    assert response.status_code == 500
    response_error = response.json()["error"].lower()
    assert "all changes were rolled back" in response_error
    assert "injected preparation failure" in response_error
    assert f"image_id={failing_image_id}" in response_error
    assert [row["tag"] for row in db.get_image_tags(image_ids[0])] == [
        "original"
    ]
    assert [row["tag"] for row in db.get_image_tags(failing_image_id)] == [
        "fail_prepare"
    ]
    assert [row["tag"] for row in db.get_image_tags(image_ids[2])] == [
        "original"
    ]
    current_op_ids = {
        operation["id"]
        for operation in test_client.get("/api/tags/bulk/ops").json()["ops"]
    }
    assert current_op_ids == previous_op_ids


@pytest.mark.parametrize(
    ("endpoint", "operation_fields"),
    [
        (
            "/api/tags/bulk/find-replace",
            {"find": "original", "replace": "renamed", "regex": False},
        ),
        (
            "/api/tags/bulk/add",
            {"tags": ["new_tag"], "confidence": 0.85},
        ),
        (
            "/api/tags/bulk/remove",
            {"tags": ["original"], "case_sensitive": False},
        ),
        (
            "/api/tags/bulk/cleanup",
            {"min_confidence": 0.5, "dedupe": True},
        ),
    ],
)
def test_each_bulk_operation_surfaces_atomic_write_failure(
    endpoint: str,
    operation_fields: dict[str, object],
    monkeypatch,
    test_client,
    tmp_path,
):
    """Every mutating endpoint must fail non-2xx without changing tags."""
    import database as db
    import db_tags

    image_id = _seed_atomic_bulk_tag_images(db, tmp_path, 1)[0]
    db.add_tags(
        image_id,
        [{"tag": "original", "confidence": 0.1, "source": "manual"}],
    )

    def fail_replace(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError(f"injected {endpoint} write failure")

    monkeypatch.setattr(db_tags, "_replace_tag_rows", fail_replace)
    response = test_client.post(
        endpoint,
        json={
            "image_ids": [image_id],
            "dry_run": False,
            **operation_fields,
        },
    )

    assert response.status_code == 500
    assert "all changes were rolled back" in response.json()["error"].lower()
    assert [row["tag"] for row in db.get_image_tags(image_id)] == ["original"]


def test_bulk_add_bounds_full_journal_rows_before_recording(
    monkeypatch,
    test_client,
    tmp_path,
):
    """Large operations must stop retaining full before/after rows at the cap."""
    import database as db
    from services import tag_bulk_journal

    image_ids = _seed_atomic_bulk_tag_images(db, tmp_path, 3)
    recorded: dict[str, object] = {}
    original_record_op = tag_bulk_journal.record_op

    def capture_record(
        *,
        operation: str,
        scope_source: str,
        params: dict[str, object],
        journal: tag_bulk_journal.JournalBuffer,
        images_affected: int,
    ) -> tag_bulk_journal.JournalRecordResult:
        recorded.update({
            "operation": operation,
            "scope_source": scope_source,
            "params": params,
            "entry_count": journal.entry_count,
            "serialized_bytes": len(journal.serialized_json),
            "truncated": journal.truncated,
            "truncation_reason": journal.truncation_reason,
            "images_affected": images_affected,
        })
        return original_record_op(
            operation=operation,
            scope_source=scope_source,
            params=params,
            journal=journal,
            images_affected=images_affected,
        )

    monkeypatch.setattr(tag_bulk_journal, "MAX_JOURNAL_IMAGES", 2)
    monkeypatch.setattr(tag_bulk_journal, "record_op", capture_record)

    response = test_client.post(
        "/api/tags/bulk/add",
        json={"image_ids": image_ids, "tags": ["new_tag"], "dry_run": False},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["affected_images"] == 3
    assert payload["op_id"]
    assert payload["undo_available"] is False
    assert payload["warnings"] == [
        {
            "code": "undo_journal_truncated",
            "message": (
                "Tags were applied, but undo is unavailable because the journal "
                "exceeded the 2-image limit."
            ),
        }
    ]
    assert recorded["images_affected"] == 3
    assert recorded["entry_count"] == 2
    assert recorded["serialized_bytes"] == 0
    assert recorded["truncated"] is True
    assert recorded["truncation_reason"] == "image_limit"


def test_bulk_add_journal_retains_only_bounded_serialized_undo_data(
    monkeypatch,
    test_client,
    tmp_path,
):
    """The router must not retain full after rows or rebuild a payload list."""
    import json

    import database as db
    from services import tag_bulk_journal

    image_id = _seed_atomic_bulk_tag_images(db, tmp_path, 1)[0]
    captured: dict[str, object] = {}
    original_record_op = tag_bulk_journal.record_op

    def capture_record(
        *,
        operation: str,
        scope_source: str,
        params: dict[str, object],
        journal: tag_bulk_journal.JournalBuffer,
        images_affected: int,
    ) -> tag_bulk_journal.JournalRecordResult:
        serialized = bytes(journal.serialized_json) + b"]"
        captured["serialized_bytes"] = len(serialized)
        captured["payload"] = json.loads(serialized.decode("utf-8"))
        return original_record_op(
            operation=operation,
            scope_source=scope_source,
            params=params,
            journal=journal,
            images_affected=images_affected,
        )

    monkeypatch.setattr(tag_bulk_journal, "record_op", capture_record)

    response = test_client.post(
        "/api/tags/bulk/add",
        json={"image_ids": [image_id], "tags": ["new_tag"], "dry_run": False},
    )

    assert response.status_code == 200
    assert int(captured["serialized_bytes"]) <= (
        tag_bulk_journal.MAX_JOURNAL_SERIALIZED_BYTES
    )
    payload = captured["payload"]
    assert isinstance(payload, list)
    assert len(payload) == 1
    assert set(payload[0]) == {"image_id", "before", "after_digest"}
    assert [row["tag"] for row in payload[0]["before"]] == ["original"]
    assert "new_tag" not in json.dumps(payload, ensure_ascii=False)


def test_bulk_add_processing_failure_rolls_back_earlier_chunks(
    monkeypatch,
    test_client,
    tmp_path,
):
    """Corrupt tag data must fail the operation instead of skipping one image."""
    import database as db
    import routers.tags_bulk as tags_bulk
    from db_core import get_db

    image_ids = _seed_atomic_bulk_tag_images(db, tmp_path, 2)
    with get_db() as conn:
        conn.execute(
            "UPDATE tags SET confidence = ? WHERE image_id = ? AND tag = ?",
            ("invalid-confidence", image_ids[1], "original"),
        )
    previous_op_ids = {
        operation["id"]
        for operation in test_client.get("/api/tags/bulk/ops").json()["ops"]
    }

    monkeypatch.setattr(tags_bulk, "BULK_TAG_ID_CHUNK_SIZE", 1)

    response = test_client.post(
        "/api/tags/bulk/add",
        json={"image_ids": image_ids, "tags": ["new_tag"], "dry_run": False},
    )

    assert response.status_code == 500
    assert "failed while preparing image_id" in response.json()["error"].lower()
    assert "invalid-confidence" in response.json()["error"].lower()
    for image_id in image_ids:
        assert [row["tag"] for row in db.get_image_tags(image_id)] == ["original"]
    current_op_ids = {
        operation["id"]
        for operation in test_client.get("/api/tags/bulk/ops").json()["ops"]
    }
    assert current_op_ids == previous_op_ids


@pytest.mark.parametrize(
    ("endpoint", "operation_fields", "zero_tag"),
    [
        (
            "/api/tags/bulk/add",
            {"tags": ["new_tag"]},
            "zero_score",
        ),
        (
            "/api/tags/bulk/remove",
            {"tags": ["keep_score"]},
            "zero_score",
        ),
        (
            "/api/tags/bulk/find-replace",
            {"find": "zero_score", "replace": "renamed_zero"},
            "renamed_zero",
        ),
    ],
)
def test_bulk_rewrites_preserve_zero_confidence(
    endpoint: str,
    operation_fields: dict[str, object],
    zero_tag: str,
    test_client,
    tmp_path,
):
    """Rewriting a tag list must not coerce a valid 0.0 score to 1.0."""
    import database as db

    image_id = _seed_atomic_bulk_tag_images(db, tmp_path, 1)[0]
    db.add_tags(
        image_id,
        [
            {"tag": "zero_score", "confidence": 0.0, "source": "tagger"},
            {"tag": "keep_score", "confidence": 0.8, "source": "tagger"},
        ],
    )

    response = test_client.post(
        endpoint,
        json={
            "image_ids": [image_id],
            "dry_run": False,
            **operation_fields,
        },
    )

    assert response.status_code == 200
    rows_by_tag = {row["tag"]: row for row in db.get_image_tags(image_id)}
    assert rows_by_tag[zero_tag]["confidence"] == 0.0


def test_bulk_cleanup_removes_zero_confidence_tag(test_client, tmp_path):
    """A 0.0 score is below a positive cleanup threshold, not a missing score."""
    import database as db

    image_id = _seed_atomic_bulk_tag_images(db, tmp_path, 1)[0]
    db.add_tags(
        image_id,
        [
            {"tag": "zero_score", "confidence": 0.0, "source": "tagger"},
            {"tag": "keep_score", "confidence": 0.8, "source": "tagger"},
        ],
    )

    response = test_client.post(
        "/api/tags/bulk/cleanup",
        json={
            "image_ids": [image_id],
            "min_confidence": 0.5,
            "dedupe": False,
            "dry_run": False,
        },
    )

    assert response.status_code == 200
    assert [row["tag"] for row in db.get_image_tags(image_id)] == ["keep_score"]


def test_bulk_add_transaction_exit_failure_is_actionable(
    monkeypatch,
    test_client,
    tmp_path,
):
    """A commit-phase failure must not collapse to a generic HTTP 500."""
    from contextlib import contextmanager

    import database as db

    image_id = _seed_atomic_bulk_tag_images(db, tmp_path, 1)[0]
    previous_op_ids = {
        operation["id"]
        for operation in test_client.get("/api/tags/bulk/ops").json()["ops"]
    }

    @contextmanager
    def fail_on_exit(
        *,
        default_source: str | None,
        replace_scope: str,
    ):
        assert default_source is None
        assert replace_scope == "all"

        def discard_updates(_updates: list[dict[str, object]]) -> None:
            return None

        yield discard_updates
        raise OSError("injected transaction commit failure")

    monkeypatch.setattr(db, "tag_update_transaction", fail_on_exit)

    response = test_client.post(
        "/api/tags/bulk/add",
        json={"image_ids": [image_id], "tags": ["new_tag"], "dry_run": False},
    )

    assert response.status_code == 500
    response_error = response.json()["error"]
    assert "bulk_add" in response_error
    assert "all changes were rolled back" in response_error
    assert "OSError" in response_error
    assert "injected transaction commit failure" in response_error
    assert [row["tag"] for row in db.get_image_tags(image_id)] == ["original"]
    current_op_ids = {
        operation["id"]
        for operation in test_client.get("/api/tags/bulk/ops").json()["ops"]
    }
    assert current_op_ids == previous_op_ids


def test_bulk_add_truncates_undo_journal_at_serialized_byte_limit(
    monkeypatch,
    test_client,
    tmp_path,
):
    """A byte-heavy entry must disable undo before the image-count limit."""
    import database as db
    from db_core import get_db
    from services import tag_bulk_journal

    image_id = _seed_atomic_bulk_tag_images(db, tmp_path, 1)[0]
    db.add_tags(
        image_id,
        [
            {
                "tag": "large_before_" + ("x" * 512),
                "confidence": 1.0,
                "source": "manual",
            }
        ],
    )
    serialized_byte_limit = 128
    monkeypatch.setattr(
        tag_bulk_journal,
        "MAX_JOURNAL_SERIALIZED_BYTES",
        serialized_byte_limit,
    )

    response = test_client.post(
        "/api/tags/bulk/add",
        json={"image_ids": [image_id], "tags": ["new_tag"], "dry_run": False},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["affected_images"] == 1
    assert payload["op_id"]
    assert payload["undo_available"] is False
    assert payload["warnings"] == [
        {
            "code": "undo_journal_truncated",
            "message": (
                "Tags were applied, but undo is unavailable because the journal "
                f"exceeded the {serialized_byte_limit}-byte serialized-data limit."
            ),
        }
    ]
    assert tag_bulk_journal.MAX_JOURNAL_IMAGES > 1
    with get_db() as conn:
        row = conn.execute(
            "SELECT images_affected, journal_gz, truncated FROM tag_bulk_ops WHERE id = ?",
            (payload["op_id"],),
        ).fetchone()
    assert row is not None
    assert int(row[0]) == 1
    assert row[1] is None
    assert int(row[2]) == 1
    undo_response = test_client.post(
        f"/api/tags/bulk/undo/{payload['op_id']}",
        json={},
    )
    assert undo_response.status_code == 409
    assert "serialized-data limit" in undo_response.json()["error"]
    assert {item["tag"] for item in db.get_image_tags(image_id)} == {
        "large_before_" + ("x" * 512),
        "new_tag",
    }


def test_bulk_add_journal_persistence_failure_returns_applied_warning(
    monkeypatch,
    test_client,
    tmp_path,
):
    """Committed tags stay successful while the lost undo capability is explicit."""
    import database as db
    from services import tag_bulk_journal

    image_id = _seed_atomic_bulk_tag_images(db, tmp_path, 1)[0]

    def fail_record_op(*_args: object, **_kwargs: object) -> object:
        raise OSError("injected undo journal disk failure")

    monkeypatch.setattr(tag_bulk_journal, "record_op", fail_record_op)

    response = test_client.post(
        "/api/tags/bulk/add",
        json={"image_ids": [image_id], "tags": ["new_tag"], "dry_run": False},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["affected_images"] == 1
    assert payload["op_id"] is None
    assert payload["undo_available"] is False
    assert payload["warnings"] == [
        {
            "code": "undo_journal_persistence_failed",
            "message": (
                "Tags were applied, but undo is unavailable because the journal "
                "could not be saved. Cause: OSError: injected undo journal disk failure"
            ),
        }
    ]
    assert "rolled back" not in payload["warnings"][0]["message"].lower()
    assert {item["tag"] for item in db.get_image_tags(image_id)} == {
        "original",
        "new_tag",
    }


@pytest.mark.parametrize(
    ("endpoint", "operation", "operation_fields"),
    [
        (
            "/api/tags/bulk/find-replace",
            "find_replace",
            {"find": "original", "replace": "renamed"},
        ),
        (
            "/api/tags/bulk/add",
            "bulk_add",
            {"tags": ["new_tag"]},
        ),
        (
            "/api/tags/bulk/remove",
            "bulk_remove",
            {"tags": ["original"]},
        ),
        (
            "/api/tags/bulk/cleanup",
            "cleanup",
            {"min_confidence": 0.5, "dedupe": True},
        ),
    ],
)
def test_each_bulk_operation_surfaces_scope_estimate_failure(
    endpoint: str,
    operation: str,
    operation_fields: dict[str, object],
    monkeypatch,
    test_client,
    tmp_path,
):
    """Scope reads fail before mutation with the operation and root cause."""
    import database as db
    import routers.tags_bulk as tags_bulk

    image_id = _seed_atomic_bulk_tag_images(db, tmp_path, 1)[0]
    previous_op_ids = {
        item["id"]
        for item in test_client.get("/api/tags/bulk/ops").json()["ops"]
    }

    def fail_scope_estimate(_request: object) -> int:
        raise OSError("injected scope count failure")

    monkeypatch.setattr(tags_bulk, "_estimate_scope_total", fail_scope_estimate)

    response = test_client.post(
        endpoint,
        json={
            "image_ids": [image_id],
            "dry_run": False,
            **operation_fields,
        },
    )

    assert response.status_code == 500
    response_error = response.json()["error"]
    assert operation in response_error
    assert "no changes were applied" in response_error
    assert "OSError" in response_error
    assert "injected scope count failure" in response_error
    state = test_client.get("/api/tags/bulk/state").json()
    assert state == {
        "running": False,
        "operation": operation,
        "total": 0,
        "completed": 0,
        "errors": [{"image_id": 0, "error": response_error}],
    }
    assert [item["tag"] for item in db.get_image_tags(image_id)] == ["original"]
    current_op_ids = {
        item["id"]
        for item in test_client.get("/api/tags/bulk/ops").json()["ops"]
    }
    assert current_op_ids == previous_op_ids


def test_bulk_add_dedupes_request_tags_case_insensitively(
    test_client,
    tmp_path,
):
    """Preview statistics and persisted rows use the same normalized tag list."""
    import database as db

    image_id = _seed_atomic_bulk_tag_images(db, tmp_path, 1)[0]
    response = test_client.post(
        "/api/tags/bulk/add",
        json={
            "image_ids": [image_id],
            "tags": [" Foo ", "foo", "FOO", "Bar", "bar"],
            "dry_run": False,
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["total_tags_added"] == 2
    assert payload["tags_to_add"] == ["Foo", "Bar"]
    assert {item["tag"] for item in db.get_image_tags(image_id)} == {
        "original",
        "Foo",
        "Bar",
    }


def test_bulk_undo_warns_when_redo_journal_exceeds_byte_limit(
    monkeypatch,
    test_client,
    tmp_path,
):
    """Undo remains successful when its larger redo journal is truncated."""
    import database as db
    from services import tag_bulk_journal

    image_id = _seed_atomic_bulk_tag_images(db, tmp_path, 1)[0]
    monkeypatch.setattr(tag_bulk_journal, "MAX_JOURNAL_SERIALIZED_BYTES", 256)
    long_tag = "redo_heavy_" + ("x" * 160)

    apply_response = test_client.post(
        "/api/tags/bulk/add",
        json={"image_ids": [image_id], "tags": [long_tag], "dry_run": False},
    )

    assert apply_response.status_code == 200
    applied = apply_response.json()
    assert applied["undo_available"] is True
    undo_response = test_client.post(
        f"/api/tags/bulk/undo/{applied['op_id']}",
        json={},
    )

    assert undo_response.status_code == 200
    undone = undo_response.json()
    assert undone["restored"] == 1
    assert undone["redo_op_id"] is None
    assert undone["redo_available"] is False
    assert undone["warnings"] == [
        {
            "code": "redo_journal_truncated",
            "message": (
                "Undo was applied, but redo is unavailable because the journal "
                "exceeded the 256-byte serialized-data limit."
            ),
        }
    ]
    assert [item["tag"] for item in db.get_image_tags(image_id)] == ["original"]
    repeat_response = test_client.post(
        f"/api/tags/bulk/undo/{applied['op_id']}",
        json={},
    )
    assert repeat_response.status_code == 409
    assert "already undone" in repeat_response.json()["error"].lower()


def test_bulk_undo_warns_when_redo_journal_persistence_fails(
    monkeypatch,
    test_client,
    tmp_path,
):
    """A saved Undo must not become a generic failure when redo cannot persist."""
    import database as db
    from services import tag_bulk_journal

    image_id = _seed_atomic_bulk_tag_images(db, tmp_path, 1)[0]
    apply_response = test_client.post(
        "/api/tags/bulk/add",
        json={"image_ids": [image_id], "tags": ["new_tag"], "dry_run": False},
    )
    assert apply_response.status_code == 200
    applied = apply_response.json()

    def fail_redo_record(*_args: object, **_kwargs: object) -> object:
        raise OSError("injected redo journal disk failure")

    monkeypatch.setattr(tag_bulk_journal, "record_op", fail_redo_record)
    undo_response = test_client.post(
        f"/api/tags/bulk/undo/{applied['op_id']}",
        json={},
    )

    assert undo_response.status_code == 200
    undone = undo_response.json()
    assert undone["restored"] == 1
    assert undone["redo_op_id"] is None
    assert undone["redo_available"] is False
    assert undone["warnings"] == [
        {
            "code": "redo_journal_persistence_failed",
            "message": (
                "Undo was applied, but redo is unavailable because the journal "
                "could not be saved. Cause: OSError: injected redo journal disk failure"
            ),
        }
    ]
    assert [item["tag"] for item in db.get_image_tags(image_id)] == ["original"]
    repeat_response = test_client.post(
        f"/api/tags/bulk/undo/{applied['op_id']}",
        json={},
    )
    assert repeat_response.status_code == 409
    assert "already undone" in repeat_response.json()["error"].lower()


def test_bulk_undo_rejects_journal_decompression_over_byte_limit(
    monkeypatch,
    test_client,
):
    """Persisted gzip data must not decompress beyond the configured bound."""
    import gzip

    from db_core import get_db
    from services import tag_bulk_journal

    serialized_byte_limit = 128
    monkeypatch.setattr(
        tag_bulk_journal,
        "MAX_JOURNAL_SERIALIZED_BYTES",
        serialized_byte_limit,
    )
    operation_id = "oversized-undo-journal"
    oversized_blob = gzip.compress(b"[" + (b" " * serialized_byte_limit) + b"]")
    with get_db() as conn:
        conn.execute(
            "INSERT INTO tag_bulk_ops "
            "(id, operation, scope_source, params_json, images_affected, "
            "journal_gz, truncated) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                operation_id,
                "bulk_add",
                "image_ids",
                "{}",
                1,
                oversized_blob,
                0,
            ),
        )

    response = test_client.post(
        f"/api/tags/bulk/undo/{operation_id}",
        json={},
    )

    assert response.status_code == 409
    error = response.json()["error"]
    assert "exceeds the supported serialized-data limit" in error
    assert f"limit={serialized_byte_limit} bytes" in error
