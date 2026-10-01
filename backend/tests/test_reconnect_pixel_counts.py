"""pixel_mismatch counts records, and one pixel-proven candidate beats a suspect (T5b review).

``pixel_mismatch`` is the number of DISTINCT records that a found file was
refused for because the pixels differ and that are still missing when the run
ends. It used to count (record x file) pairs, so three identical files against
twenty records reported sixty, and a record relinked to its real file later in
the same run was still reported (MEDIUM-2).

When an exact-mtime candidate's stored digest disagrees with the found file
(a suspect) and exactly one other candidate is proven by pixels, the proven one
is relinked and the suspect simply stays missing; only when nobody is proven
does the group go to review (LOW-1).
"""

from __future__ import annotations

import os
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
    # compress_level=0: solid pictures of different colours get the same byte size.
    Image.new("RGB", (8, 8), color=color).save(path, compress_level=0)
    return path


def _row(db, old_path: Path, found: Path, *, mtime_offset_ns: int, fingerprint):
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
def hash_calls(monkeypatch):
    calls: list[str] = []
    real = image_fingerprint.compute_image_content_fingerprint

    def counted(path, *args, **kwargs):
        calls.append(str(path))
        return real(path, *args, **kwargs)

    monkeypatch.setattr(image_fingerprint, "compute_image_content_fingerprint", counted)
    return calls


def _reconnect(folder: Path):
    from services.image_service import ImageService

    return ImageService().reconnect_missing_files_once(
        str(folder), recursive=True, verify_uncertain=True
    )


def _path_of(db, image_id: int) -> str:
    return db.get_image_by_id(image_id)["path"]


# ------------------------------------------------- MEDIUM-2: distinct records


def test_a_record_relinked_elsewhere_in_the_same_run_is_not_counted(test_db, tmp_path):
    """One record, two same-name files: refused by the first (pixels differ),
    relinked by the second (its real file). Whatever the walk order, it ends
    the run reconnected, so it is not a pixel mismatch."""
    real = _png(tmp_path / "new" / "b" / "pic.png", "red")
    impostor = _png(tmp_path / "new" / "a" / "pic.png", "blue")
    assert real.stat().st_size == impostor.stat().st_size
    os.utime(
        impostor, ns=(real.stat().st_atime_ns, real.stat().st_mtime_ns + ONE_SECOND_NS)
    )
    record = _row(
        test_db,
        tmp_path / "old" / "pic.png",
        real,
        mtime_offset_ns=0,
        fingerprint=compute_image_content_fingerprint(str(real)),
    )

    result = _reconnect(tmp_path / "new")

    assert result["matched"] == 1
    assert result["pixel_mismatch"] == 0
    assert result["still_missing"] == 0
    assert _path_of(test_db, record) == str(real)


def test_one_file_relinked_to_the_right_record_counts_the_refused_one_once(
    test_db, tmp_path
):
    found = _png(tmp_path / "new" / "pic.png", "red")
    other_digest = compute_image_content_fingerprint(
        str(_png(tmp_path / "x" / "o.png", "blue"))
    )
    wrong = _row(
        test_db,
        tmp_path / "w" / "pic.png",
        found,
        mtime_offset_ns=ONE_SECOND_NS,
        fingerprint=other_digest,
    )
    right = _row(
        test_db,
        tmp_path / "r" / "pic.png",
        found,
        mtime_offset_ns=ONE_SECOND_NS,
        fingerprint=compute_image_content_fingerprint(str(found)),
    )

    result = _reconnect(tmp_path / "new")

    assert result["matched"] == 1
    assert result["pixel_mismatch"] == 1
    assert result["still_missing"] == 1
    assert _path_of(test_db, right) == str(found)
    assert _path_of(test_db, wrong) == str(tmp_path / "w" / "pic.png")


def test_many_records_against_few_identical_files_count_each_record_once(
    test_db, tmp_path
):
    files = [
        _png(tmp_path / "new" / f"d{index}" / "pic.png", "red") for index in range(3)
    ]
    for file in files[1:]:
        os.utime(file, ns=(files[0].stat().st_atime_ns, files[0].stat().st_mtime_ns))
    for index in range(20):
        _row(
            test_db,
            tmp_path / f"o{index}" / "pic.png",
            files[0],
            mtime_offset_ns=ONE_SECOND_NS,
            fingerprint=f"digest-{index}",
        )

    result = _reconnect(tmp_path / "new")

    assert result["matched"] == 0
    assert result["pixel_mismatch"] == 20
    assert result["still_missing"] == 20


def test_pixel_mismatch_is_reported_in_the_progress_snapshot_during_the_run(
    test_db, tmp_path
):
    found = _png(tmp_path / "new" / "pic.png", "red")
    other_digest = compute_image_content_fingerprint(
        str(_png(tmp_path / "x" / "o.png", "blue"))
    )
    _row(
        test_db,
        tmp_path / "w" / "pic.png",
        found,
        mtime_offset_ns=ONE_SECOND_NS,
        fingerprint=other_digest,
    )
    from services.image_service import ImageService

    snapshots: list[int] = []
    ImageService().reconnect_missing_files_once(
        str(found.parent),
        recursive=True,
        verify_uncertain=True,
        progress_callback=lambda snapshot: snapshots.append(
            int(snapshot["pixel_mismatch"])
        ),
    )

    assert snapshots[-1] == 1


# ------------------------------------------ LOW-1: proven candidate wins


def test_one_pixel_proven_candidate_beats_an_exact_suspect(
    test_db, tmp_path, hash_calls
):
    found = _png(tmp_path / "new" / "pic.png", "red")
    suspect = _row(
        test_db,
        tmp_path / "a" / "pic.png",
        found,
        mtime_offset_ns=0,
        fingerprint="digest-A-stale-or-other",
    )
    proven = _row(
        test_db,
        tmp_path / "b" / "pic.png",
        found,
        mtime_offset_ns=ONE_SECOND_NS,
        fingerprint=compute_image_content_fingerprint(str(found)),
    )

    result = _reconnect(tmp_path / "new")

    assert hash_calls == [str(found)]
    assert result["matched"] == 1
    assert result["ambiguous"] == 0
    assert result["updated"][0]["match"] == "fingerprint"
    assert _path_of(test_db, proven) == str(found)
    assert _path_of(test_db, suspect) == str(tmp_path / "a" / "pic.png")
    # The suspect ends the run missing and was refused by pixels: reported.
    assert result["pixel_mismatch"] == 1
    assert result["still_missing"] == 1


def test_two_pixel_proven_candidates_with_a_suspect_still_go_to_review(
    test_db, tmp_path
):
    found = _png(tmp_path / "new" / "pic.png", "red")
    digest = compute_image_content_fingerprint(str(found))
    ids = [
        _row(
            test_db,
            tmp_path / "a" / "pic.png",
            found,
            mtime_offset_ns=0,
            fingerprint="digest-A-stale",
        ),
        _row(
            test_db,
            tmp_path / "b" / "pic.png",
            found,
            mtime_offset_ns=ONE_SECOND_NS,
            fingerprint=digest,
        ),
        _row(
            test_db,
            tmp_path / "c" / "pic.png",
            found,
            mtime_offset_ns=-ONE_SECOND_NS,
            fingerprint=digest,
        ),
    ]

    result = _reconnect(tmp_path / "new")

    assert result["matched"] == 0
    assert result["ambiguous"] == 1
    assert result["pixel_mismatch"] == 0
    for image_id, folder in zip(ids, ("a", "b", "c")):
        assert _path_of(test_db, image_id) == str(tmp_path / folder / "pic.png")
