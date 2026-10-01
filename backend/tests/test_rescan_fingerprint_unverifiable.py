"""Follow-up to test_rescan_forgets_stale_fingerprint.py (review LOWs).

1. Rows upgraded from before ``source_mtime_ns`` / ``source_size`` were stored
   have a fingerprint but no mtime/size pair. ``_is_source_fingerprint_changed``
   calls such a row "unchanged" (nothing to compare) while the scanner's
   ``_source_fingerprint_matches`` calls it "changed" and re-parses the file. The
   rewrite that follows is the first to record mtime and size; if hashing failed
   in that same pass, the old fingerprint used to be kept next to them, and from
   then on the row was a permanent unchanged hit. Rule: a stored pair missing +
   both incoming present + no new digest => the fingerprint is unverifiable and
   goes. Rows with derived state are deliberately left alone (product choice:
   never delete machine output on a guess), so their fingerprint stays with it.

2. ``update_image_metadata`` with ``metadata_status="pending"`` now withholds
   the incoming mtime/size exactly like ``_upsert_image_record`` does, so the
   "pending keeps the fingerprint" exemption in both predicates is sound on
   both rewrite paths. No production caller passes "pending" here today.

3. The reviewer's end-to-end probe: the real ``scan_folder`` (placeholder +
   backfill, thread executor) forgets the fingerprint when hashing raises, and
   the next scan of the untouched file is an unchanged hit that hashes nothing.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent.parent))

import database as db
import image_manager

OLD_FINGERPRINT = "fp-old"
NEW_MTIME_NS = 101
NEW_SIZE = 300


def _row(image_id: int) -> dict:
    with db.get_db() as conn:
        return dict(
            conn.execute(
                "SELECT content_fingerprint, source_mtime_ns, source_size, "
                "metadata_status, tagged_at FROM images WHERE id = ?",
                (image_id,),
            ).fetchone()
        )


def _tag_count(image_id: int) -> int:
    with db.get_db() as conn:
        return conn.execute(
            "SELECT COUNT(*) FROM tags WHERE image_id = ?", (image_id,)
        ).fetchone()[0]


def _legacy_row(path: str, *, mtime_ns, size) -> int:
    """A fingerprinted row whose mtime/size pair is (partly) missing."""
    image_id = db.add_image(
        path=path,
        filename=os.path.basename(path),
        source_mtime_ns=mtime_ns,
        source_size=size,
        content_fingerprint=OLD_FINGERPRINT,
    )
    row = _row(image_id)
    assert row["content_fingerprint"] == OLD_FINGERPRINT
    assert (row["source_mtime_ns"], row["source_size"]) == (mtime_ns, size)
    return image_id


def _upsert(path: str, *, mtime_ns, size, fingerprint, status="complete") -> int:
    return db.add_image(
        path=path,
        filename=os.path.basename(path),
        source_mtime_ns=mtime_ns,
        source_size=size,
        metadata_status=status,
        content_fingerprint=fingerprint,
    )


def _update_metadata(
    image_id: int, *, mtime_ns, size, fingerprint, status="complete"
) -> None:
    db.update_image_metadata(
        image_id=image_id,
        generator="comfyui",
        prompt="rescanned",
        negative_prompt=None,
        metadata_json="{}",
        width=64,
        height=64,
        file_size=size,
        checkpoint=None,
        loras=[],
        is_readable=True,
        source_mtime_ns=mtime_ns,
        source_size=size,
        metadata_status=status,
        content_fingerprint=fingerprint,
    )


LEGACY_PAIRS = pytest.mark.parametrize(
    ("legacy_mtime_ns", "legacy_size"),
    [(None, None), (100, None), (None, 200)],
    ids=["no-pair", "mtime-only", "size-only"],
)


# ------------------------------------------------ 1. unverifiable legacy rows


@LEGACY_PAIRS
def test_scan_upsert_forgets_unverifiable_fingerprint(
    test_db, legacy_mtime_ns, legacy_size
):
    path = "/lib/legacy-upsert.png"
    image_id = _legacy_row(path, mtime_ns=legacy_mtime_ns, size=legacy_size)

    same_id = _upsert(path, mtime_ns=NEW_MTIME_NS, size=NEW_SIZE, fingerprint=None)

    assert same_id == image_id
    row = _row(image_id)
    assert row["content_fingerprint"] is None
    assert (row["source_mtime_ns"], row["source_size"]) == (NEW_MTIME_NS, NEW_SIZE)


@LEGACY_PAIRS
def test_update_image_metadata_forgets_unverifiable_fingerprint(
    test_db, legacy_mtime_ns, legacy_size
):
    image_id = _legacy_row(
        "/lib/legacy-update.png", mtime_ns=legacy_mtime_ns, size=legacy_size
    )

    _update_metadata(image_id, mtime_ns=NEW_MTIME_NS, size=NEW_SIZE, fingerprint=None)

    row = _row(image_id)
    assert row["content_fingerprint"] is None
    assert (row["source_mtime_ns"], row["source_size"]) == (NEW_MTIME_NS, NEW_SIZE)


def test_legacy_row_takes_the_new_fingerprint_when_hashing_worked(test_db):
    path = "/lib/legacy-hashed.png"
    image_id = _legacy_row(path, mtime_ns=None, size=None)

    _upsert(path, mtime_ns=NEW_MTIME_NS, size=NEW_SIZE, fingerprint="fp-new")

    assert _row(image_id)["content_fingerprint"] == "fp-new"


def test_legacy_row_keeps_fingerprint_when_the_write_brings_no_pair_either(test_db):
    """Nothing to verify against, nothing learned: not a reason to forget."""
    path = "/lib/legacy-nopair.png"
    image_id = _legacy_row(path, mtime_ns=None, size=None)

    _upsert(path, mtime_ns=None, size=None, fingerprint=None)

    assert _row(image_id)["content_fingerprint"] == OLD_FINGERPRINT


def test_legacy_row_with_derived_state_is_left_alone(test_db):
    """Product choice pinned, not a bug: machine output is never deleted on a
    guess, and the fingerprint that describes it stays with it.

    The write that brought no digest records no mtime/size either, so the row
    stays incomparable: the next scan re-parses it and hashes again, and the
    digest comparison in ``_should_clear_derived_state`` decides (section 4)."""
    path = "/lib/legacy-tagged.png"
    image_id = _legacy_row(path, mtime_ns=None, size=None)
    db.add_tags(
        image_id, [{"tag": "x", "confidence": 0.9}], content_fingerprint=OLD_FINGERPRINT
    )
    assert _row(image_id)["tagged_at"] is not None

    _upsert(path, mtime_ns=NEW_MTIME_NS, size=NEW_SIZE, fingerprint=None)

    row = _row(image_id)
    assert row["content_fingerprint"] == OLD_FINGERPRINT
    assert row["tagged_at"] is not None
    assert _tag_count(image_id) == 1
    assert (row["source_mtime_ns"], row["source_size"]) == (None, None)


def test_update_image_metadata_legacy_row_with_derived_state_withholds_pair(test_db):
    image_id = _legacy_row("/lib/legacy-tagged-update.png", mtime_ns=None, size=None)
    db.add_tags(
        image_id, [{"tag": "x", "confidence": 0.9}], content_fingerprint=OLD_FINGERPRINT
    )

    _update_metadata(image_id, mtime_ns=NEW_MTIME_NS, size=NEW_SIZE, fingerprint=None)

    row = _row(image_id)
    assert row["content_fingerprint"] == OLD_FINGERPRINT
    assert _tag_count(image_id) == 1
    assert (row["source_mtime_ns"], row["source_size"]) == (None, None)
    assert row["metadata_status"] == "complete"


def test_legacy_derived_row_without_fingerprint_records_the_pair(test_db):
    """Nothing to re-verify later: no digest means the pair is simply recorded."""
    path = "/lib/legacy-tagged-nofp.png"
    image_id = db.add_image(path=path, filename="legacy-tagged-nofp.png")
    db.add_tags(image_id, [{"tag": "x", "confidence": 0.9}])
    with db.get_db() as conn:
        conn.execute(
            "UPDATE images SET tagged_at = CURRENT_TIMESTAMP, content_fingerprint = NULL "
            "WHERE id = ?",
            (image_id,),
        )

    _upsert(path, mtime_ns=NEW_MTIME_NS, size=NEW_SIZE, fingerprint=None)

    row = _row(image_id)
    assert row["content_fingerprint"] is None
    assert _tag_count(image_id) == 1
    assert (row["source_mtime_ns"], row["source_size"]) == (NEW_MTIME_NS, NEW_SIZE)


# --------------------------------- 2. update_image_metadata with "pending"


def test_update_image_metadata_pending_withholds_mtime_size_and_fingerprint(test_db):
    path = "/lib/pending-update.png"
    image_id = _legacy_row(path, mtime_ns=100, size=200)

    _update_metadata(
        image_id,
        mtime_ns=NEW_MTIME_NS,
        size=NEW_SIZE,
        fingerprint=None,
        status="pending",
    )

    row = _row(image_id)
    assert row["metadata_status"] == "pending"
    assert (row["source_mtime_ns"], row["source_size"]) == (100, 200)
    assert row["content_fingerprint"] == OLD_FINGERPRINT

    # The backfill that follows is the one that records the pair and decides.
    _update_metadata(image_id, mtime_ns=NEW_MTIME_NS, size=NEW_SIZE, fingerprint=None)

    row = _row(image_id)
    assert row["metadata_status"] == "complete"
    assert (row["source_mtime_ns"], row["source_size"]) == (NEW_MTIME_NS, NEW_SIZE)
    assert row["content_fingerprint"] is None


# ------------------------------------- 3. the real scanner, end to end


def _raise_locked(*_args, **_kwargs):
    raise PermissionError("file is locked")


@pytest.mark.parametrize("quick_import", [True, False], ids=["quick", "validated"])
def test_scan_folder_forgets_then_does_not_rehash(
    test_db, tmp_path, monkeypatch, quick_import
):
    folder = tmp_path / "lib"
    folder.mkdir()
    png = folder / "a.png"
    Image.new("RGB", (16, 16), color="teal").save(png)
    stat = png.stat()
    image_id = db.add_image(
        path=str(png),
        filename=png.name,
        source_mtime_ns=stat.st_mtime_ns + 7,
        source_size=stat.st_size + 7,
        content_fingerprint=OLD_FINGERPRINT,
    )
    monkeypatch.setattr(image_manager, "SCAN_METADATA_EXECUTOR_MODE", "thread")
    monkeypatch.setattr(
        image_manager, "compute_image_content_fingerprint", _raise_locked
    )

    first = image_manager.scan_folder(
        str(folder), quick_import=quick_import, metadata_workers=1
    )

    row = _row(image_id)
    assert first["errors"] == 0
    assert row["content_fingerprint"] is None
    assert (row["source_mtime_ns"], row["source_size"]) == (
        stat.st_mtime_ns,
        stat.st_size,
    )
    assert row["metadata_status"] == "complete"

    hashed: list[str] = []

    def _count_hashes(path, *_args, **_kwargs):
        hashed.append(str(path))
        return "fp-new"

    monkeypatch.setattr(
        image_manager, "compute_image_content_fingerprint", _count_hashes
    )

    second = image_manager.scan_folder(
        str(folder), quick_import=quick_import, metadata_workers=1
    )

    # The untouched file is an unchanged hit: nothing is re-read or hashed. The
    # fingerprint stays NULL until a pipeline that needs it hashes on demand.
    assert hashed == []
    assert second["unchanged"] == 1
    assert _row(image_id)["content_fingerprint"] is None


# ------------- 4. legacy row WITH derived state: the second scan decides


def _tags_by_source(image_id: int) -> dict:
    with db.get_db() as conn:
        rows = conn.execute(
            "SELECT tag, source FROM tags WHERE image_id = ? ORDER BY tag", (image_id,)
        ).fetchall()
    return {row["tag"]: row["source"] for row in rows}


@pytest.mark.parametrize(
    ("second_hash", "pipeline_tag_survives"),
    [("fp-new", False), (OLD_FINGERPRINT, True)],
    ids=["pixels-changed", "pixels-same"],
)
def test_scan_folder_legacy_derived_row_is_decided_by_the_next_hash(
    test_db, tmp_path, monkeypatch, second_hash, pipeline_tag_survives
):
    folder = tmp_path / "lib"
    folder.mkdir()
    png = folder / "a.png"
    Image.new("RGB", (16, 16), color="teal").save(png)
    stat = png.stat()
    image_id = db.add_image(
        path=str(png), filename=png.name, content_fingerprint=OLD_FINGERPRINT
    )
    db.add_tags(
        image_id,
        [
            {"tag": "guessed", "confidence": 0.9, "source": "tagger"},
            {"tag": "typed", "confidence": 1.0, "source": "manual"},
        ],
        content_fingerprint=OLD_FINGERPRINT,
    )
    assert _tags_by_source(image_id) == {"guessed": "tagger", "typed": "manual"}
    monkeypatch.setattr(image_manager, "SCAN_METADATA_EXECUTOR_MODE", "thread")
    monkeypatch.setattr(
        image_manager, "compute_image_content_fingerprint", _raise_locked
    )

    first = image_manager.scan_folder(str(folder), quick_import=True, metadata_workers=1)

    # Hashing failed: nothing is decided, and the pair is NOT recorded, so the
    # row cannot become a permanent unchanged hit with the old digest.
    row = _row(image_id)
    assert first["errors"] == 0
    assert row["metadata_status"] == "complete"
    assert row["content_fingerprint"] == OLD_FINGERPRINT
    assert (row["source_mtime_ns"], row["source_size"]) == (None, None)
    assert _tags_by_source(image_id) == {"guessed": "tagger", "typed": "manual"}

    hashed: list[str] = []

    def _hash(path, *_args, **_kwargs):
        hashed.append(str(path))
        return second_hash

    monkeypatch.setattr(image_manager, "compute_image_content_fingerprint", _hash)

    second = image_manager.scan_folder(str(folder), quick_import=True, metadata_workers=1)

    # Still incomparable, so the file is re-parsed and hashed once more; the
    # digest comparison decides, and the pair is recorded with the verdict.
    assert second["unchanged"] == 0
    assert hashed == [str(png)]
    row = _row(image_id)
    assert row["content_fingerprint"] == second_hash
    assert (row["source_mtime_ns"], row["source_size"]) == (
        stat.st_mtime_ns,
        stat.st_size,
    )
    expected_tags = {"typed": "manual"}
    if pipeline_tag_survives:
        expected_tags["guessed"] = "tagger"
    assert _tags_by_source(image_id) == expected_tags
