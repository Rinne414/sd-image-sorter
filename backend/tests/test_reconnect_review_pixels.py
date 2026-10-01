"""Follow-up to test_reconnect_pixel_verification.py (T5 review LOWs).

1. An exact-mtime candidate is never hashed for its own sake, but when another
   candidate of the same found file already made its digest known, the exact
   candidate is compared too. A mismatch there is not a verdict -- the stored
   fingerprint may simply be stale -- so the group goes to review instead of
   being relinked or dropped.
2. Candidates dropped by the pixel check are counted (``pixel_mismatch``) in
   the run result and the progress state.
3. The repair-review listing says, per candidate, whether its stored pixel
   fingerprint matches the found file (``pixels_match``: True / False / None),
   hashing each found file at most once per listed review.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent.parent))

import image_fingerprint
from image_fingerprint import compute_image_content_fingerprint

ONE_SECOND_NS = 1_000_000_000


def _png(path: Path, color: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (8, 8), color=color).save(path)
    return path


def _missing_row(db, old_path: Path, found: Path, *, mtime_offset_ns: int, fingerprint):
    stat = found.stat()
    return db.add_image(
        path=str(old_path),
        filename=found.name,
        metadata_json="{}",
        file_size=stat.st_size,
        source_size=stat.st_size,
        source_mtime_ns=stat.st_mtime_ns + mtime_offset_ns,
        content_fingerprint=fingerprint,
        is_readable=False,
        read_error="File not found",
        metadata_status="error",
    )


@pytest.fixture
def pictures(tmp_path):
    found = _png(tmp_path / "new" / "pic.png", "red")
    other = _png(tmp_path / "elsewhere" / "other.png", "blue")
    return {
        "found": found,
        "found_digest": compute_image_content_fingerprint(str(found)),
        "other_digest": compute_image_content_fingerprint(str(other)),
    }


@pytest.fixture
def hash_calls(monkeypatch):
    calls: list[str] = []
    real = image_fingerprint.compute_image_content_fingerprint

    def counted(path, *args, **kwargs):
        calls.append(str(path))
        return real(path, *args, **kwargs)

    monkeypatch.setattr(image_fingerprint, "compute_image_content_fingerprint", counted)
    return calls


def _service():
    from services.image_service import ImageService

    return ImageService()


def _reconnect(service, found: Path):
    return service.reconnect_missing_files_once(
        str(found.parent), recursive=True, verify_uncertain=True
    )


def _path_of(db, image_id: int) -> str:
    return db.get_image_by_id(image_id)["path"]


# ------------------------------- 1. exact match, digest already known


def test_exact_candidate_with_known_different_digest_goes_to_review(
    test_db, tmp_path, pictures, hash_calls
):
    """Reviewer's probe: exact A (digest differs) + approximate B (hashes, differs)."""
    old_a = tmp_path / "oldA" / "pic.png"
    old_b = tmp_path / "oldB" / "pic.png"
    a_id = _missing_row(
        test_db,
        old_a,
        pictures["found"],
        mtime_offset_ns=0,
        fingerprint="digest-A-not-these-pixels",
    )
    b_id = _missing_row(
        test_db,
        old_b,
        pictures["found"],
        mtime_offset_ns=ONE_SECOND_NS,
        fingerprint="digest-B-not-these-pixels",
    )

    result = _reconnect(_service(), pictures["found"])

    assert hash_calls == [str(pictures["found"])]
    assert result["matched"] == 0
    assert result["ambiguous"] == 1
    assert result["review_pending_total"] == 1
    assert result["pixel_mismatch"] == 1
    assert _path_of(test_db, a_id) == str(old_a)
    assert _path_of(test_db, b_id) == str(old_b)
    review = test_db.list_reconnect_reviews(status=test_db.REVIEW_STATUS_PENDING)[
        "items"
    ][0]
    assert sorted(review["candidate_ids"]) == sorted([a_id, b_id])


def test_exact_candidate_with_known_same_digest_is_relinked_by_pixels(
    test_db, tmp_path, pictures, hash_calls
):
    """The approximate candidate hashes the file; the exact one then matches by pixels."""
    wrong_id = _missing_row(
        test_db,
        tmp_path / "oldW" / "pic.png",
        pictures["found"],
        mtime_offset_ns=ONE_SECOND_NS,
        fingerprint=pictures["other_digest"],
    )
    exact_id = _missing_row(
        test_db,
        tmp_path / "oldE" / "pic.png",
        pictures["found"],
        mtime_offset_ns=0,
        fingerprint=pictures["found_digest"],
    )

    result = _reconnect(_service(), pictures["found"])

    assert hash_calls == [str(pictures["found"])]
    assert result["matched"] == 1
    assert result["updated"][0]["match"] == "fingerprint"
    assert result["pixel_mismatch"] == 1
    assert _path_of(test_db, exact_id) == str(pictures["found"])
    assert _path_of(test_db, wrong_id) == str(tmp_path / "oldW" / "pic.png")


def test_exact_candidate_alone_is_not_hashed_even_with_a_different_digest(
    test_db, tmp_path, pictures, hash_calls
):
    """Nothing made the digest known: a plain move is relinked without reading the file."""
    image_id = _missing_row(
        test_db,
        tmp_path / "old" / "pic.png",
        pictures["found"],
        mtime_offset_ns=0,
        fingerprint=pictures["other_digest"],
    )

    result = _reconnect(_service(), pictures["found"])

    assert hash_calls == []
    assert result["matched"] == 1
    assert result["updated"][0]["match"] == "stat"
    assert result["ambiguous"] == 0
    assert _path_of(test_db, image_id) == str(pictures["found"])


# ------------------------------------------- 2. pixel_mismatch count


def test_pixel_mismatch_is_counted_in_result_and_progress(test_db, tmp_path, pictures):
    from routers.images import ReconnectMissingFilesRequest

    class ImmediateBackgroundTasks:
        def add_task(self, func, *args, **kwargs):
            func(*args, **kwargs)

    _missing_row(
        test_db,
        tmp_path / "old" / "pic.png",
        pictures["found"],
        mtime_offset_ns=ONE_SECOND_NS,
        fingerprint=pictures["other_digest"],
    )
    service = _service()

    service.start_reconnect_missing_files(
        ReconnectMissingFilesRequest(
            search_folder=str(pictures["found"].parent), recursive=True
        ),
        ImmediateBackgroundTasks(),
    )

    progress = service.get_reconnect_progress()
    assert progress["status"] == "done"
    assert progress["pixel_mismatch"] == 1
    assert progress["result"]["pixel_mismatch"] == 1
    assert progress["result"]["matched"] == 0
    assert progress["result"]["still_missing"] == 1
    assert service._build_default_reconnect_progress_state()["pixel_mismatch"] == 0


# ------------------------------- 3. pixels_match in the repair listing


def _pending_review(db, pictures, *fingerprints):
    """One review whose candidates carry the given stored fingerprints."""
    stat = pictures["found"].stat()
    ids = []
    for index, fingerprint in enumerate(fingerprints):
        ids.append(
            db.add_image(
                path=str(pictures["found"].parent.parent / f"old{index}" / "pic.png"),
                filename="pic.png",
                metadata_json="{}",
                file_size=stat.st_size,
                source_size=stat.st_size,
                source_mtime_ns=stat.st_mtime_ns,
                content_fingerprint=fingerprint,
            )
        )
    review_id = db.add_reconnect_review(
        filename="pic.png",
        found_path=str(pictures["found"]),
        candidate_ids=ids,
        candidate_count=len(ids),
        run_started_at=1000.0,
    )
    return review_id, ids


def test_repair_candidates_say_whether_the_pixels_match(test_db, pictures, hash_calls):
    _, ids = _pending_review(
        test_db, pictures, pictures["found_digest"], pictures["other_digest"], None
    )

    payload = _service().get_repair_candidates()

    assert hash_calls == [str(pictures["found"])]
    by_id = {
        c["image_id"]: c["pixels_match"] for c in payload["items"][0]["candidates"]
    }
    assert by_id == {ids[0]: True, ids[1]: False, ids[2]: None}


def test_repair_candidates_do_not_hash_when_no_candidate_has_a_fingerprint(
    test_db, pictures, hash_calls
):
    _, ids = _pending_review(test_db, pictures, None, None)

    payload = _service().get_repair_candidates()

    assert hash_calls == []
    assert [c["pixels_match"] for c in payload["items"][0]["candidates"]] == [
        None,
        None,
    ]


def test_repair_candidates_hash_once_per_review_and_not_a_missing_found_file(
    test_db, pictures, hash_calls
):
    _pending_review(
        test_db, pictures, pictures["found_digest"], pictures["found_digest"]
    )
    gone = _png(pictures["found"].parent.parent / "gone" / "pic.png", "green")
    stat = gone.stat()
    gone_id = test_db.add_image(
        path=str(pictures["found"].parent.parent / "oldG" / "pic.png"),
        filename="pic.png",
        metadata_json="{}",
        file_size=stat.st_size,
        source_size=stat.st_size,
        content_fingerprint=pictures["found_digest"],
    )
    test_db.add_reconnect_review(
        filename="pic.png",
        found_path=str(gone),
        candidate_ids=[gone_id],
        candidate_count=1,
        run_started_at=1001.0,
    )
    gone.unlink()

    payload = _service().get_repair_candidates()

    assert payload["total"] == 2
    assert hash_calls == [str(pictures["found"])]
    by_found = {item["found_path"]: item for item in payload["items"]}
    assert [
        c["pixels_match"] for c in by_found[str(pictures["found"])]["candidates"]
    ] == [True, True]
    assert by_found[str(gone)]["found_exists"] is False
    assert [c["pixels_match"] for c in by_found[str(gone)]["candidates"]] == [None]


def test_repair_candidates_endpoint_carries_pixels_match(test_client, tmp_path):
    db = test_client.test_db
    found = _png(tmp_path / "new" / "pic.png", "red")
    pictures = {
        "found": found,
        "found_digest": compute_image_content_fingerprint(str(found)),
    }
    _pending_review(db, pictures, pictures["found_digest"], "not-these-pixels")

    response = test_client.get("/api/images/repair-candidates")

    assert response.status_code == 200
    assert [c["pixels_match"] for c in response.json()["items"][0]["candidates"]] == [
        True,
        False,
    ]
