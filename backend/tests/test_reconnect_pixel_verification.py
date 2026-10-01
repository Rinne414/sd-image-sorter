"""Reconnect verifies an approximate stat match against the pixels (T2 review LOW-3).

``_find_reconnect_match`` calls a found file "the" missing row when the name
and byte size match and the mtime is within RECONNECT_MTIME_TOLERANCE_NS (2 s,
for file systems and copies that round timestamps). The relink then records
the found file's exact mtime, so an approximate match was written down as an
exact one, and the row's derived state (tags, captions, embeddings) went with
it unverified.

Rule pinned here: when the row has a pixel fingerprint and the mtime match is
only approximate, the found file is hashed once and must match. A different
digest means a different picture: not relinked, left for a normal scan. An
mtime that matches to the nanosecond is trusted as before, without hashing --
checking every moved file would turn a plain library move into a full re-read.
Rows without a fingerprint cannot be checked and keep today's behaviour. The
check follows the existing "confirm uncertain matches by reading image pixels"
switch (``verify_uncertain``).
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
    """A missing row that claims the found file's size, an mtime near it, and
    the given pixel digest."""
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
    """``found`` is the file on disk; ``other_digest`` belongs to a different picture."""
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


def _reconnect(found: Path, *, verify_uncertain: bool = True):
    from services.image_service import ImageService

    return ImageService().reconnect_missing_files_once(
        str(found.parent), recursive=True, verify_uncertain=verify_uncertain
    )


# ------------------------------------------------------------- the hole


def test_near_mtime_same_size_different_pixels_is_not_relinked(
    test_db, tmp_path, pictures, hash_calls
):
    old_path = tmp_path / "old" / "pic.png"
    image_id = _missing_row(
        test_db,
        old_path,
        pictures["found"],
        mtime_offset_ns=ONE_SECOND_NS,
        fingerprint=pictures["other_digest"],
    )
    test_db.add_tags(
        image_id,
        [{"tag": "1girl", "confidence": 0.9}],
        content_fingerprint=pictures["other_digest"],
    )

    result = _reconnect(pictures["found"])

    assert result["matched"] == 0
    assert result["ambiguous"] == 0
    assert result["skipped"] == 1
    assert result["still_missing"] == 1
    assert hash_calls == [str(pictures["found"])]
    row = test_db.get_image_by_id(image_id)
    assert row["path"] == str(old_path)
    assert row["is_readable"] == 0
    with test_db.get_db() as conn:
        stored_digest = conn.execute(
            "SELECT content_fingerprint FROM images WHERE id = ?", (image_id,)
        ).fetchone()[0]
    assert stored_digest == pictures["other_digest"]
    assert [t["tag"] for t in test_db.get_image_tags(image_id)] == ["1girl"]


def test_near_mtime_same_pixels_is_relinked_as_a_pixel_match(
    test_db, tmp_path, pictures, hash_calls
):
    old_path = tmp_path / "old" / "pic.png"
    image_id = _missing_row(
        test_db,
        old_path,
        pictures["found"],
        mtime_offset_ns=-ONE_SECOND_NS,
        fingerprint=pictures["found_digest"],
    )

    result = _reconnect(pictures["found"])

    assert result["matched"] == 1
    assert result["updated"][0]["match"] == "fingerprint"
    assert hash_calls == [str(pictures["found"])]
    row = test_db.get_image_by_id(image_id)
    assert row["path"] == str(pictures["found"])
    assert row["is_readable"] == 1
    assert row["source_mtime_ns"] == pictures["found"].stat().st_mtime_ns


def test_two_near_matches_resolve_to_the_one_with_the_same_pixels(
    test_db, tmp_path, pictures, hash_calls
):
    wrong_id = _missing_row(
        test_db,
        tmp_path / "old-a" / "pic.png",
        pictures["found"],
        mtime_offset_ns=ONE_SECOND_NS,
        fingerprint=pictures["other_digest"],
    )
    right_id = _missing_row(
        test_db,
        tmp_path / "old-b" / "pic.png",
        pictures["found"],
        mtime_offset_ns=ONE_SECOND_NS,
        fingerprint=pictures["found_digest"],
    )

    result = _reconnect(pictures["found"])

    assert result["matched"] == 1
    assert result["ambiguous"] == 0
    assert hash_calls == [str(pictures["found"])]
    assert test_db.get_image_by_id(right_id)["path"] == str(pictures["found"])
    assert test_db.get_image_by_id(wrong_id)["path"] == str(
        tmp_path / "old-a" / "pic.png"
    )


# --------------------------------------------------- what must not change


def test_exact_mtime_is_trusted_without_hashing(
    test_db, tmp_path, pictures, hash_calls
):
    """A plain move keeps mtime to the nanosecond; it is relinked as today and
    the file is not read. (Pinned trade-off: an exact match is not re-verified.)"""
    image_id = _missing_row(
        test_db,
        tmp_path / "old" / "pic.png",
        pictures["found"],
        mtime_offset_ns=0,
        fingerprint=pictures["found_digest"],
    )

    result = _reconnect(pictures["found"])

    assert result["matched"] == 1
    assert result["updated"][0]["match"] == "stat"
    assert hash_calls == []
    assert test_db.get_image_by_id(image_id)["path"] == str(pictures["found"])


def test_near_mtime_without_a_stored_fingerprint_keeps_todays_behaviour(
    test_db, tmp_path, pictures, hash_calls
):
    image_id = _missing_row(
        test_db,
        tmp_path / "old" / "pic.png",
        pictures["found"],
        mtime_offset_ns=ONE_SECOND_NS,
        fingerprint=None,
    )

    result = _reconnect(pictures["found"])

    assert result["matched"] == 1
    assert result["updated"][0]["match"] == "stat"
    assert hash_calls == []
    assert test_db.get_image_by_id(image_id)["path"] == str(pictures["found"])


def test_verify_uncertain_off_skips_the_pixel_check(
    test_db, tmp_path, pictures, hash_calls
):
    image_id = _missing_row(
        test_db,
        tmp_path / "old" / "pic.png",
        pictures["found"],
        mtime_offset_ns=ONE_SECOND_NS,
        fingerprint=pictures["other_digest"],
    )

    result = _reconnect(pictures["found"], verify_uncertain=False)

    assert result["matched"] == 1
    assert result["updated"][0]["match"] == "stat"
    assert hash_calls == []
    assert test_db.get_image_by_id(image_id)["path"] == str(pictures["found"])


def test_mtime_outside_tolerance_is_still_relinked_by_pixels(
    test_db, tmp_path, pictures, hash_calls
):
    """The pre-existing verify_uncertain branch (name + size match, mtime
    off by more than the tolerance, pixels prove it). It never fired before:
    the candidate SELECT did not load content_fingerprint."""
    image_id = _missing_row(
        test_db,
        tmp_path / "old" / "pic.png",
        pictures["found"],
        mtime_offset_ns=60 * ONE_SECOND_NS,
        fingerprint=pictures["found_digest"],
    )

    result = _reconnect(pictures["found"])

    assert result["matched"] == 1
    assert result["updated"][0]["match"] == "fingerprint"
    assert hash_calls == [str(pictures["found"])]
    assert test_db.get_image_by_id(image_id)["path"] == str(pictures["found"])


def test_unhashable_found_file_falls_back_to_the_stat_match(
    test_db, tmp_path, pictures, monkeypatch
):
    image_id = _missing_row(
        test_db,
        tmp_path / "old" / "pic.png",
        pictures["found"],
        mtime_offset_ns=ONE_SECOND_NS,
        fingerprint=pictures["other_digest"],
    )

    def _locked(*_args, **_kwargs):
        raise PermissionError("file is locked")

    monkeypatch.setattr(image_fingerprint, "compute_image_content_fingerprint", _locked)

    result = _reconnect(pictures["found"])

    assert result["matched"] == 1
    assert result["updated"][0]["match"] == "stat"
    assert test_db.get_image_by_id(image_id)["path"] == str(pictures["found"])
