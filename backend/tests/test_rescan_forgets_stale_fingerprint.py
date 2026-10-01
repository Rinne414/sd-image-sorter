"""A rescan that finds a changed file but cannot hash it forgets the old fingerprint.

``content_fingerprint`` is a SHA of the pixels. The scanner and the style
index both say "unchanged, keep the stored fingerprint" when the stored
``source_mtime_ns`` / ``source_size`` still match the file
(``image_manager_gates._source_fingerprint_matches``,
``style_vector_prepare.fingerprint_for``). That is only sound while the
fingerprint and the mtime/size pair describe the same bytes.

The hole: a row with a fingerprint but no derived state (no tags, caption,
score, embedding, prediction or style vector). The file changes; the rescan
sees the new mtime and size, but hashing fails (file locked, decoder error).
``_should_clear_derived_state`` answered False because there was nothing
derived to clear, and ``COALESCE(?, content_fingerprint)`` kept the OLD
fingerprint next to the NEW mtime and size. From then on both the scanner
and the style index treated the new pixels as the old ones.

Rule pinned here: source changed + no new fingerprint => fingerprint NULL,
whether or not the row has derived state. A NULL is always recomputed by
whichever pipeline next needs it.
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
from db_helpers import _ensure_content_fingerprint_value
from image_fingerprint import compute_image_content_fingerprint
from services.style_vector_prepare import fingerprint_for

OLD_FINGERPRINT = "fp-old"
OLD_MTIME_NS = 100
OLD_SIZE = 200
NEW_MTIME_NS = 101
NEW_SIZE = 300


def _row(image_id: int) -> dict:
    with db.get_db() as conn:
        return dict(
            conn.execute(
                "SELECT content_fingerprint, source_mtime_ns, source_size, tagged_at, "
                "ai_caption, aesthetic_score, embedding FROM images WHERE id = ?",
                (image_id,),
            ).fetchone()
        )


def _fingerprinted_bare_image(path: str) -> int:
    """A row that has a fingerprint and nothing derived from its pixels."""
    image_id = db.add_image(
        path=path,
        filename=os.path.basename(path),
        source_mtime_ns=OLD_MTIME_NS,
        source_size=OLD_SIZE,
        content_fingerprint=OLD_FINGERPRINT,
    )
    row = _row(image_id)
    assert row["content_fingerprint"] == OLD_FINGERPRINT
    assert (
        row["tagged_at"],
        row["ai_caption"],
        row["aesthetic_score"],
        row["embedding"],
    ) == (
        None,
        None,
        None,
        None,
    )
    return image_id


def _rescan_upsert(
    path: str, *, mtime_ns: int, size: int, fingerprint, status="complete"
) -> int:
    return db.add_image(
        path=path,
        filename=os.path.basename(path),
        source_mtime_ns=mtime_ns,
        source_size=size,
        metadata_status=status,
        content_fingerprint=fingerprint,
    )


def _rescan_update_metadata(
    image_id: int, *, mtime_ns: int, size: int, fingerprint
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
        metadata_status="complete",
        content_fingerprint=fingerprint,
    )


CHANGED_SOURCES = pytest.mark.parametrize(
    ("mtime_ns", "size"),
    [
        (NEW_MTIME_NS, NEW_SIZE),
        (NEW_MTIME_NS, OLD_SIZE),
        (OLD_MTIME_NS, NEW_SIZE),
    ],
    ids=["mtime+size", "mtime-only", "size-only"],
)


# ---------------------------------------------------------------- the hole


@CHANGED_SOURCES
def test_scan_upsert_forgets_fingerprint_when_source_changed_and_hash_unknown(
    test_db, mtime_ns, size
):
    path = "/lib/bare-upsert.png"
    image_id = _fingerprinted_bare_image(path)

    same_id = _rescan_upsert(path, mtime_ns=mtime_ns, size=size, fingerprint=None)

    assert same_id == image_id
    row = _row(image_id)
    assert row["content_fingerprint"] is None
    assert (row["source_mtime_ns"], row["source_size"]) == (mtime_ns, size)


@CHANGED_SOURCES
def test_update_image_metadata_forgets_fingerprint_when_source_changed_and_hash_unknown(
    test_db, mtime_ns, size
):
    image_id = _fingerprinted_bare_image("/lib/bare-update.png")

    _rescan_update_metadata(image_id, mtime_ns=mtime_ns, size=size, fingerprint=None)

    row = _row(image_id)
    assert row["content_fingerprint"] is None
    assert (row["source_mtime_ns"], row["source_size"]) == (mtime_ns, size)


def test_scan_upsert_forgets_fingerprint_also_when_row_has_derived_state(test_db):
    """The derived-state clear already covered this row; the rule must not regress it."""
    path = "/lib/tagged-upsert.png"
    image_id = _fingerprinted_bare_image(path)
    db.add_tags(
        image_id, [{"tag": "x", "confidence": 0.9}], content_fingerprint=OLD_FINGERPRINT
    )
    assert _row(image_id)["tagged_at"] is not None

    _rescan_upsert(path, mtime_ns=NEW_MTIME_NS, size=NEW_SIZE, fingerprint=None)

    row = _row(image_id)
    assert row["content_fingerprint"] is None
    assert row["tagged_at"] is None


# ------------------------------------------------------- what must not change


def test_scan_upsert_keeps_fingerprint_when_source_unchanged(test_db):
    path = "/lib/same-upsert.png"
    image_id = _fingerprinted_bare_image(path)

    _rescan_upsert(path, mtime_ns=OLD_MTIME_NS, size=OLD_SIZE, fingerprint=None)

    assert _row(image_id)["content_fingerprint"] == OLD_FINGERPRINT


def test_update_image_metadata_keeps_fingerprint_when_source_unchanged(test_db):
    image_id = _fingerprinted_bare_image("/lib/same-update.png")

    _rescan_update_metadata(
        image_id, mtime_ns=OLD_MTIME_NS, size=OLD_SIZE, fingerprint=None
    )

    assert _row(image_id)["content_fingerprint"] == OLD_FINGERPRINT


def test_scan_upsert_writes_new_fingerprint_when_known(test_db):
    path = "/lib/new-upsert.png"
    image_id = _fingerprinted_bare_image(path)

    _rescan_upsert(path, mtime_ns=NEW_MTIME_NS, size=NEW_SIZE, fingerprint="fp-new")

    assert _row(image_id)["content_fingerprint"] == "fp-new"


def test_update_image_metadata_writes_new_fingerprint_when_known(test_db):
    image_id = _fingerprinted_bare_image("/lib/new-update.png")

    _rescan_update_metadata(
        image_id, mtime_ns=NEW_MTIME_NS, size=NEW_SIZE, fingerprint="fp-new"
    )

    assert _row(image_id)["content_fingerprint"] == "fp-new"


def test_pending_placeholder_keeps_fingerprint_until_the_backfill_decides(test_db):
    """A placeholder consumes neither the new mtime/size nor the fingerprint;
    the final backfill for the same scan is where the decision is taken."""
    path = "/lib/pending.png"
    image_id = _fingerprinted_bare_image(path)

    _rescan_upsert(
        path, mtime_ns=NEW_MTIME_NS, size=NEW_SIZE, fingerprint=None, status="pending"
    )

    row = _row(image_id)
    assert row["content_fingerprint"] == OLD_FINGERPRINT
    assert (row["source_mtime_ns"], row["source_size"]) == (OLD_MTIME_NS, OLD_SIZE)

    _rescan_upsert(path, mtime_ns=NEW_MTIME_NS, size=NEW_SIZE, fingerprint=None)

    row = _row(image_id)
    assert row["content_fingerprint"] is None
    assert (row["source_mtime_ns"], row["source_size"]) == (NEW_MTIME_NS, NEW_SIZE)


# ------------------------------------------ the real scanner, hashing raises


def _stale_row_for(png: Path) -> int:
    """The indexed row disagrees with the file on disk in mtime and size."""
    stat = png.stat()
    image_id = db.add_image(
        path=str(png),
        filename=png.name,
        source_mtime_ns=stat.st_mtime_ns + 7,
        source_size=stat.st_size + 7,
        content_fingerprint=OLD_FINGERPRINT,
    )
    return image_id


def _png(path: Path) -> Path:
    Image.new("RGB", (16, 16), color="teal").save(path)
    return path


def _raise_locked(*_args, **_kwargs):
    raise PermissionError("file is locked")


def test_reparse_image_metadata_forgets_fingerprint_when_hashing_raises(
    test_db, tmp_path, monkeypatch
):
    png = _png(tmp_path / "reparse.png")
    image_id = _stale_row_for(png)
    monkeypatch.setattr(
        image_manager, "compute_image_content_fingerprint", _raise_locked
    )

    image_manager.reparse_image_metadata(image_id, str(png))

    row = _row(image_id)
    assert row["content_fingerprint"] is None
    assert (row["source_mtime_ns"], row["source_size"]) == (
        png.stat().st_mtime_ns,
        png.stat().st_size,
    )


def test_scan_backfill_record_forgets_fingerprint_when_hashing_raises(
    test_db, tmp_path, monkeypatch
):
    png = _png(tmp_path / "scan.png")
    image_id = _stale_row_for(png)
    monkeypatch.setattr(
        image_manager, "compute_image_content_fingerprint", _raise_locked
    )

    job = image_manager._parse_metadata_job(
        {"path": str(png), "filename": png.name, "compute_content_fingerprint": True}
    )
    assert job["error"] is None
    assert job["record"]["content_fingerprint"] is None
    db.add_images_batch([job["record"]])

    row = _row(image_id)
    assert row["content_fingerprint"] is None
    assert (row["source_mtime_ns"], row["source_size"]) == (
        png.stat().st_mtime_ns,
        png.stat().st_size,
    )


# --------------------------------------- a NULL is recomputed, never matched


def test_forgotten_fingerprint_is_rehashed_by_the_style_index(test_db, tmp_path):
    png = _png(tmp_path / "style.png")
    image_id = _stale_row_for(png)
    stat = png.stat()
    _rescan_update_metadata(
        image_id, mtime_ns=stat.st_mtime_ns, size=stat.st_size, fingerprint=None
    )
    row = _row(image_id)
    assert row["content_fingerprint"] is None

    rehashed = fingerprint_for(
        str(png), row["content_fingerprint"], row["source_mtime_ns"], row["source_size"]
    )

    assert rehashed == compute_image_content_fingerprint(str(png))
    assert rehashed != OLD_FINGERPRINT


def test_forgotten_fingerprint_is_rehashed_by_the_tag_writers(test_db, tmp_path):
    png = _png(tmp_path / "tags.png")
    image_id = _stale_row_for(png)
    stat = png.stat()
    _rescan_update_metadata(
        image_id, mtime_ns=stat.st_mtime_ns, size=stat.st_size, fingerprint=None
    )
    assert _row(image_id)["content_fingerprint"] is None

    with db.get_db() as conn:
        rehashed = _ensure_content_fingerprint_value(conn.cursor(), image_id, None)

    assert rehashed == compute_image_content_fingerprint(str(png))
