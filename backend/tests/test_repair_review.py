"""Tests for the Roadmap-C missing-file repair review flow.

Covers the persistence added by migration 021 (reconnect_reviews), the
service-level review listing/confirm logic, and the three HTTP endpoints
(GET /api/images/repair-candidates, POST /api/images/repair-confirm,
GET /api/image-preview-by-path).

Locked invariant (extends test_reconnect_missing_files.py): an ambiguous
name+size group NEVER mutates image rows during the run — rows keep their
old paths until the user explicitly confirms pick/merge.
"""
from pathlib import Path

import pytest
from fastapi import HTTPException
from PIL import Image


def _make_image(path: Path, color: str = "white") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (8, 8), color=color).save(path)
    return path


def _seed_ambiguous_pair(db, tmp_path: Path):
    """Two missing rows sharing filename+size, one found file matching both.

    Returns (first_id, second_id, old_a, old_b, found_path).
    """
    old_a = tmp_path / "old" / "same.png"
    old_b = tmp_path / "other-old" / "same.png"
    found = _make_image(tmp_path / "new" / "same.png")
    stat = found.stat()
    first_id = db.add_image(
        path=str(old_a),
        filename="same.png",
        metadata_json="{}",
        file_size=stat.st_size,
        source_size=stat.st_size,
        source_mtime_ns=stat.st_mtime_ns,
    )
    second_id = db.add_image(
        path=str(old_b),
        filename="same.png",
        metadata_json="{}",
        file_size=stat.st_size,
        source_size=stat.st_size,
        source_mtime_ns=stat.st_mtime_ns,
    )
    return first_id, second_id, old_a, old_b, found


def _run_ambiguous_reconnect(service, found: Path):
    result = service.reconnect_missing_files_once(str(found.parent), recursive=True)
    assert result["ambiguous"] == 1
    assert result["review_pending_total"] == 1
    return result


# ============================================================================
# Run-time persistence (reconnect_missing_files_once writes review rows)
# ============================================================================

def test_ambiguous_run_persists_review_with_ids_and_rows_keep_old_paths(test_db, tmp_path):
    from services.image_service import ImageService

    first_id, second_id, old_a, old_b, found = _seed_ambiguous_pair(test_db, tmp_path)

    result = _run_ambiguous_reconnect(ImageService(), found)

    assert result["matched"] == 0
    # Invariant: neither row was touched by the run itself.
    assert test_db.get_image_by_id(first_id)["path"] == str(old_a)
    assert test_db.get_image_by_id(second_id)["path"] == str(old_b)
    # But the ambiguous group was persisted WITH the real candidate ids
    # (the in-memory needs_review sample carries no ids and is capped).
    listing = test_db.list_reconnect_reviews(status=test_db.REVIEW_STATUS_PENDING)
    assert listing["total"] == 1
    review = listing["items"][0]
    assert review["filename"] == "same.png"
    assert review["found_path"] == str(found)
    assert sorted(review["candidate_ids"]) == sorted([first_id, second_id])
    assert review["candidate_count"] == 2
    assert review["status"] == test_db.REVIEW_STATUS_PENDING


def test_new_run_clears_previous_pending_reviews(test_db, tmp_path):
    from services.image_service import ImageService

    _, _, _, _, found = _seed_ambiguous_pair(test_db, tmp_path)
    service = ImageService()
    _run_ambiguous_reconnect(service, found)
    assert test_db.count_pending_reconnect_reviews() == 1

    # A later run searches a different (empty) folder: the stale pending
    # snapshot from the previous run must be dropped, not accumulated.
    empty_folder = tmp_path / "empty"
    empty_folder.mkdir()
    rerun = service.reconnect_missing_files_once(str(empty_folder), recursive=True)

    assert rerun["review_pending_total"] == 0
    assert test_db.count_pending_reconnect_reviews() == 0


def test_rerun_of_same_folder_replaces_pending_snapshot(test_db, tmp_path):
    from services.image_service import ImageService

    _, _, _, _, found = _seed_ambiguous_pair(test_db, tmp_path)
    service = ImageService()
    _run_ambiguous_reconnect(service, found)
    _run_ambiguous_reconnect(service, found)

    # Same ambiguity found again — still exactly one pending row, not two.
    assert test_db.count_pending_reconnect_reviews() == 1


# ============================================================================
# get_repair_candidates (listing + enrichment + pagination)
# ============================================================================

def test_get_repair_candidates_enriches_current_rows(test_db, tmp_path):
    from services.image_service import ImageService

    first_id, second_id, old_a, old_b, found = _seed_ambiguous_pair(test_db, tmp_path)
    service = ImageService()
    _run_ambiguous_reconnect(service, found)

    payload = service.get_repair_candidates()

    assert payload["total"] == 1
    item = payload["items"][0]
    assert item["filename"] == "same.png"
    assert item["found_path"] == str(found)
    assert item["found_exists"] is True
    assert item["status"] == "pending"
    assert item["resolution"] is None
    assert item["candidate_count"] == 2
    by_id = {c["image_id"]: c for c in item["candidates"]}
    assert set(by_id) == {first_id, second_id}
    assert by_id[first_id]["path"] == str(old_a)
    assert by_id[second_id]["path"] == str(old_b)
    # Old locations do not exist on disk → both flagged still missing.
    assert by_id[first_id]["still_missing"] is True
    assert by_id[second_id]["still_missing"] is True


def test_get_repair_candidates_omits_deleted_candidates(test_db, tmp_path):
    from services.image_service import ImageService

    first_id, second_id, _, _, found = _seed_ambiguous_pair(test_db, tmp_path)
    service = ImageService()
    _run_ambiguous_reconnect(service, found)

    test_db.delete_images_by_ids([second_id])
    payload = service.get_repair_candidates()

    item = payload["items"][0]
    assert [c["image_id"] for c in item["candidates"]] == [first_id]
    # candidate_count keeps the run-time group size for context.
    assert item["candidate_count"] == 2


def test_get_repair_candidates_paginates_newest_first(test_db, tmp_path):
    from services.image_service import ImageService

    ids = []
    for index in range(3):
        ids.append(test_db.add_reconnect_review(
            filename=f"file-{index}.png",
            found_path=str(tmp_path / f"file-{index}.png"),
            candidate_ids=[],
            candidate_count=2,
            run_started_at=1000.0 + index,
        ))

    service = ImageService()
    first_page = service.get_repair_candidates(limit=2, offset=0)
    second_page = service.get_repair_candidates(limit=2, offset=2)

    assert first_page["total"] == 3
    assert [item["review_id"] for item in first_page["items"]] == [ids[2], ids[1]]
    assert [item["review_id"] for item in second_page["items"]] == [ids[0]]


def test_get_repair_candidates_status_scoping(test_db, tmp_path):
    from services.image_service import ImageService

    _, _, _, _, found = _seed_ambiguous_pair(test_db, tmp_path)
    service = ImageService()
    _run_ambiguous_reconnect(service, found)
    review_id = service.get_repair_candidates()["items"][0]["review_id"]
    service.confirm_repair(review_id=review_id, action="skip")

    assert service.get_repair_candidates(status="pending")["total"] == 0
    assert service.get_repair_candidates(status="resolved")["total"] == 1
    assert service.get_repair_candidates(status="all")["total"] == 1


# ============================================================================
# confirm_repair — pick / merge / skip
# ============================================================================

def test_confirm_pick_relinks_chosen_preserves_tags_and_leaves_others(test_db, tmp_path):
    from services.image_service import ImageService

    first_id, second_id, _, old_b, found = _seed_ambiguous_pair(test_db, tmp_path)
    test_db.add_tags(first_id, [{"tag": "1girl", "confidence": 0.9}])
    service = ImageService()
    _run_ambiguous_reconnect(service, found)
    review_id = service.get_repair_candidates()["items"][0]["review_id"]

    outcome = service.confirm_repair(
        review_id=review_id, action="pick", chosen_image_id=first_id
    )

    assert outcome["status"] == "resolved"
    assert outcome["resolution"] == "pick"
    assert outcome["image_id"] == first_id
    assert outcome["new_path"] == str(found)
    assert outcome["deleted_ids"] == []
    chosen = test_db.get_image_by_id(first_id)
    assert chosen["path"] == str(found)
    assert chosen["is_readable"] == 1
    # Relinking must not touch the tags table.
    assert [t["tag"] for t in test_db.get_image_tags(first_id)] == ["1girl"]
    # The competing row is intact and untouched.
    other = test_db.get_image_by_id(second_id)
    assert other is not None
    assert other["path"] == str(old_b)
    # Review row flipped to resolved and left pending listing.
    review = test_db.get_reconnect_review(review_id)
    assert review["status"] == test_db.REVIEW_STATUS_RESOLVED
    assert review["resolution"] == "pick"
    assert review["chosen_image_id"] == first_id
    assert service.get_repair_candidates()["total"] == 0


def test_confirm_merge_relinks_chosen_and_deletes_others(test_db, tmp_path):
    from services.image_service import ImageService

    first_id, second_id, _, _, found = _seed_ambiguous_pair(test_db, tmp_path)
    service = ImageService()
    _run_ambiguous_reconnect(service, found)
    review_id = service.get_repair_candidates()["items"][0]["review_id"]

    outcome = service.confirm_repair(
        review_id=review_id, action="merge", chosen_image_id=first_id
    )

    assert outcome["resolution"] == "merge"
    assert outcome["deleted_ids"] == [second_id]
    assert test_db.get_image_by_id(first_id)["path"] == str(found)
    assert test_db.get_image_by_id(second_id) is None


def test_confirm_skip_records_decision_without_touching_rows(test_db, tmp_path):
    from services.image_service import ImageService

    first_id, second_id, old_a, old_b, found = _seed_ambiguous_pair(test_db, tmp_path)
    service = ImageService()
    _run_ambiguous_reconnect(service, found)
    review_id = service.get_repair_candidates()["items"][0]["review_id"]

    outcome = service.confirm_repair(review_id=review_id, action="skip")

    assert outcome == {"status": "resolved", "review_id": review_id, "resolution": "skip"}
    assert test_db.get_image_by_id(first_id)["path"] == str(old_a)
    assert test_db.get_image_by_id(second_id)["path"] == str(old_b)
    assert test_db.get_reconnect_review(review_id)["resolution"] == "skip"


def test_confirm_conflict_when_found_path_already_indexed(test_db, tmp_path):
    from services.image_service import ImageService

    first_id, second_id, old_a, old_b, found = _seed_ambiguous_pair(test_db, tmp_path)
    service = ImageService()
    _run_ambiguous_reconnect(service, found)
    review_id = service.get_repair_candidates()["items"][0]["review_id"]
    # A later scan indexed the found file as its own new row.
    stat = found.stat()
    interloper_id = test_db.add_image(
        path=str(found),
        filename="same.png",
        metadata_json="{}",
        file_size=stat.st_size,
        source_size=stat.st_size,
        source_mtime_ns=stat.st_mtime_ns,
    )

    with pytest.raises(HTTPException) as exc_info:
        service.confirm_repair(review_id=review_id, action="pick", chosen_image_id=first_id)

    assert exc_info.value.status_code == 409
    # Review marked conflict; no image row was relinked or deleted.
    assert test_db.get_reconnect_review(review_id)["status"] == test_db.REVIEW_STATUS_CONFLICT
    assert test_db.get_image_by_id(first_id)["path"] == str(old_a)
    assert test_db.get_image_by_id(second_id)["path"] == str(old_b)
    assert test_db.get_image_by_id(interloper_id)["path"] == str(found)


def test_confirm_pick_when_found_file_deleted_returns_409_and_stays_pending(test_db, tmp_path):
    from services.image_service import ImageService

    first_id, _, old_a, _, found = _seed_ambiguous_pair(test_db, tmp_path)
    service = ImageService()
    _run_ambiguous_reconnect(service, found)
    review_id = service.get_repair_candidates()["items"][0]["review_id"]
    found.unlink()

    assert service.get_repair_candidates()["items"][0]["found_exists"] is False
    with pytest.raises(HTTPException) as exc_info:
        service.confirm_repair(review_id=review_id, action="pick", chosen_image_id=first_id)

    assert exc_info.value.status_code == 409
    # The review is still actionable once the file reappears.
    assert test_db.get_reconnect_review(review_id)["status"] == test_db.REVIEW_STATUS_PENDING
    assert test_db.get_image_by_id(first_id)["path"] == str(old_a)


def test_confirm_rejects_bad_inputs(test_db, tmp_path):
    from services.image_service import ImageService

    first_id, second_id, _, _, found = _seed_ambiguous_pair(test_db, tmp_path)
    service = ImageService()
    _run_ambiguous_reconnect(service, found)
    review_id = service.get_repair_candidates()["items"][0]["review_id"]

    with pytest.raises(HTTPException) as unknown_review:
        service.confirm_repair(review_id=999999, action="pick", chosen_image_id=first_id)
    assert unknown_review.value.status_code == 404

    with pytest.raises(HTTPException) as bad_action:
        service.confirm_repair(review_id=review_id, action="detonate", chosen_image_id=first_id)
    assert bad_action.value.status_code == 400

    with pytest.raises(HTTPException) as missing_chosen:
        service.confirm_repair(review_id=review_id, action="pick")
    assert missing_chosen.value.status_code == 400

    with pytest.raises(HTTPException) as foreign_chosen:
        service.confirm_repair(review_id=review_id, action="pick", chosen_image_id=999999)
    assert foreign_chosen.value.status_code == 400

    # None of the rejections may have resolved the review or touched rows.
    assert test_db.get_reconnect_review(review_id)["status"] == test_db.REVIEW_STATUS_PENDING
    assert test_db.get_image_by_id(first_id) is not None
    assert test_db.get_image_by_id(second_id) is not None


def test_confirm_rejects_double_resolution(test_db, tmp_path):
    from services.image_service import ImageService

    first_id, _, _, _, found = _seed_ambiguous_pair(test_db, tmp_path)
    service = ImageService()
    _run_ambiguous_reconnect(service, found)
    review_id = service.get_repair_candidates()["items"][0]["review_id"]
    service.confirm_repair(review_id=review_id, action="skip")

    with pytest.raises(HTTPException) as exc_info:
        service.confirm_repair(review_id=review_id, action="pick", chosen_image_id=first_id)

    assert exc_info.value.status_code == 409


def test_confirm_refused_while_reconnect_run_active(test_db, tmp_path):
    from services.image_service import ImageService

    first_id, _, _, _, found = _seed_ambiguous_pair(test_db, tmp_path)
    service = ImageService()
    _run_ambiguous_reconnect(service, found)
    review_id = service.get_repair_candidates()["items"][0]["review_id"]
    service._reconnect_progress = {**service._reconnect_progress, "status": "running"}

    with pytest.raises(HTTPException) as exc_info:
        service.confirm_repair(review_id=review_id, action="pick", chosen_image_id=first_id)

    assert exc_info.value.status_code == 409
    assert test_db.get_reconnect_review(review_id)["status"] == test_db.REVIEW_STATUS_PENDING


# ============================================================================
# HTTP endpoints
# ============================================================================

def test_repair_candidates_route_not_shadowed_by_image_id(test_client):
    response = test_client.get("/api/images/repair-candidates")

    assert response.status_code == 200
    payload = response.json()
    assert payload == {"total": 0, "items": []}


def test_repair_confirm_endpoint_resolves_pending_review(test_client, tmp_path):
    db = test_client.test_db
    first_id, second_id, _, old_b, found = _seed_ambiguous_pair(db, tmp_path)
    review_id = db.add_reconnect_review(
        filename="same.png",
        found_path=str(found),
        candidate_ids=[first_id, second_id],
        candidate_count=2,
        run_started_at=1000.0,
    )

    listing = test_client.get("/api/images/repair-candidates")
    assert listing.status_code == 200
    assert listing.json()["total"] == 1
    assert listing.json()["items"][0]["review_id"] == review_id

    response = test_client.post(
        "/api/images/repair-confirm",
        json={"review_id": review_id, "action": "pick", "chosen_image_id": first_id},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "resolved"
    assert payload["resolution"] == "pick"
    assert payload["image_id"] == first_id
    assert db.get_image_by_id(first_id)["path"] == str(found)
    assert db.get_image_by_id(second_id)["path"] == str(old_b)
    assert test_client.get("/api/images/repair-candidates").json()["total"] == 0


def test_repair_confirm_endpoint_validates_body(test_client):
    # main.py's global handler downgrades pydantic 422s to 400 app-wide.
    bad_action = test_client.post(
        "/api/images/repair-confirm",
        json={"review_id": 1, "action": "explode"},
    )
    assert bad_action.status_code == 400

    missing_review = test_client.post(
        "/api/images/repair-confirm",
        json={"action": "skip"},
    )
    assert missing_review.status_code == 400

    unknown_review = test_client.post(
        "/api/images/repair-confirm",
        json={"review_id": 424242, "action": "skip"},
    )
    assert unknown_review.status_code == 404


def test_image_preview_by_path_serves_thumbnail(test_client, tmp_path):
    found = _make_image(tmp_path / "preview" / "candidate.png", color="red")

    response = test_client.get(
        "/api/image-preview-by-path",
        params={"path": str(found), "size": 64},
    )

    assert response.status_code == 200
    assert response.headers["content-type"] == "image/webp"
    assert len(response.content) > 0


def test_image_preview_by_path_rejects_bad_paths(test_client, tmp_path):
    missing = test_client.get(
        "/api/image-preview-by-path",
        params={"path": str(tmp_path / "nope" / "ghost.png")},
    )
    assert missing.status_code == 404

    non_image = tmp_path / "notes.txt"
    non_image.write_text("not an image")
    wrong_type = test_client.get(
        "/api/image-preview-by-path",
        params={"path": str(non_image)},
    )
    assert wrong_type.status_code == 404

    traversal = test_client.get(
        "/api/image-preview-by-path",
        params={"path": str(tmp_path / ".." / "escape.png")},
    )
    assert traversal.status_code == 404
