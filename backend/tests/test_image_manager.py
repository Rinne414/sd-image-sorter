"""
Unit tests for scan progress callbacks.
"""

import os
import sys
from datetime import datetime
from pathlib import Path

import database as db
from PIL import Image
from PIL.PngImagePlugin import PngInfo

sys.path.insert(0, str(Path(__file__).parent.parent))

from exceptions import ScanCancelledError  # noqa: E402
import image_manager  # noqa: E402
from image_fingerprint import compute_image_content_fingerprint  # noqa: E402
from image_manager import scan_folder  # noqa: E402


def test_scan_folder_starts_processing_without_count_preamble(test_db, tmp_path: Path):
    for index in range(2):
        Image.new("RGB", (64, 64), color="white").save(tmp_path / f"sample-{index}.png")

    progress_events = []

    def progress_callback(current, total, filename, details=None):
        progress_events.append(
            {
                "current": current,
                "total": total,
                "filename": filename,
                "details": details or {},
            }
        )

    result = scan_folder(str(tmp_path), recursive=False, progress_callback=progress_callback)

    assert result["total"] == 2
    assert progress_events
    assert progress_events[0]["current"] == 1
    assert progress_events[0]["total"] == 1
    assert progress_events[0]["filename"]
    assert progress_events[0]["details"].get("phase") == "importing"
    assert progress_events[0]["details"].get("total_final") is False
    assert "counted" not in [event["details"].get("phase") for event in progress_events]


def test_scan_folder_raises_cancelled_when_stop_requested_after_first_progress(test_db, tmp_path: Path):
    for index in range(2):
        Image.new("RGB", (64, 64), color="white").save(tmp_path / f"cancel-{index}.png")

    state = {"cancel": False}

    def progress_callback(current, total, filename, details=None):
        details = details or {}
        if details.get("phase") == "importing" and current == 1:
            state["cancel"] = True

    try:
        scan_folder(
            str(tmp_path),
            recursive=False,
            progress_callback=progress_callback,
            stop_requested=lambda: state["cancel"],
        )
    except ScanCancelledError as exc:
        assert "cancelled" in exc.message.lower()
    else:
        raise AssertionError("Expected scan_folder() to raise ScanCancelledError")

    with db.get_db() as conn:
        rows = conn.execute(
            """
            SELECT metadata_status
            FROM images
            WHERE filename LIKE 'cancel-%'
            """,
        ).fetchall()

    assert rows == []


def test_scan_folder_reports_updated_count_for_rescanned_images(test_db, tmp_path: Path):
    image_path = tmp_path / "rescanned.png"
    Image.new("RGB", (64, 64), color="white").save(image_path)

    first = scan_folder(str(tmp_path), recursive=False)
    second = scan_folder(str(tmp_path), recursive=False)

    assert first["total"] == 1
    assert first["new"] == 1
    assert first["updated"] == 0

    assert second["total"] == 1
    assert second["new"] == 0
    assert second["updated"] == 1
    assert second["unchanged"] == 1
    assert second["metadata_updated"] == 0


def test_scan_folder_preserves_created_at_when_file_mtime_changes(test_db, tmp_path: Path):
    image_path = tmp_path / "stable-order.png"
    Image.new("RGB", (64, 64), color="white").save(image_path)
    original_timestamp = 1_700_000_000
    os.utime(image_path, (original_timestamp, original_timestamp))

    first = scan_folder(str(tmp_path), recursive=False)
    assert first["new"] == 1
    original_row = test_db.get_images(limit=10, include_unreadable=True)[0]

    updated_timestamp = original_timestamp + 7200
    os.utime(image_path, (updated_timestamp, updated_timestamp))

    second = scan_folder(str(tmp_path), recursive=False)
    assert second["updated"] == 1
    rescanned_row = test_db.get_images(limit=10, include_unreadable=True)[0]
    assert rescanned_row["library_order_time"] == original_row["library_order_time"]
    assert rescanned_row["source_file_mtime"] != original_row["source_file_mtime"]
    assert rescanned_row["created_at"] == original_row["created_at"]


def test_scan_folder_preserves_derived_state_when_only_metadata_changes(test_db, tmp_path: Path):
    import database as db

    image_path = tmp_path / "metadata-only.png"
    Image.new("RGB", (64, 64), color="white").save(image_path)

    scan_folder(str(tmp_path), recursive=False)
    image = test_db.get_images(limit=10, include_unreadable=True)[0]
    image_id = image["id"]
    original_fingerprint = compute_image_content_fingerprint(str(image_path))

    db.add_tags(image_id, [{"tag": "kept_tag", "confidence": 0.9}], content_fingerprint=original_fingerprint)
    with db.get_db() as conn:
        conn.execute(
            """
            UPDATE images
            SET ai_caption = ?, aesthetic_score = ?, embedding = ?, content_fingerprint = ?
            WHERE id = ?
            """,
            ("keep caption", 6.25, b"\x10\x20\x30", original_fingerprint, image_id),
        )
        conn.execute(
            """
            INSERT INTO artist_predictions (image_id, artist, confidence, top_predictions)
            VALUES (?, ?, ?, ?)
            """,
            (image_id, "artist_meta", 0.92, '[{"artist":"artist_meta","confidence":0.92}]'),
        )

    pnginfo = PngInfo()
    pnginfo.add_text("parameters", "prompt: metadata only rewrite")
    with Image.open(image_path) as source:
        source.save(image_path, pnginfo=pnginfo)
    updated_mtime_ns = image_path.stat().st_mtime_ns + 2_000_000_000
    os.utime(image_path, ns=(updated_mtime_ns, updated_mtime_ns))

    result = scan_folder(str(tmp_path), recursive=False)
    assert result["updated"] == 1

    assert {tag["tag"] for tag in db.get_image_tags(image_id)} == {"kept_tag"}
    with db.get_db() as conn:
        row = conn.execute(
            """
            SELECT ai_caption, aesthetic_score, embedding, content_fingerprint
            FROM images
            WHERE id = ?
            """,
            (image_id,),
        ).fetchone()
        artist_row = conn.execute(
            "SELECT artist FROM artist_predictions WHERE image_id = ?",
            (image_id,),
        ).fetchone()

    assert row["ai_caption"] == "keep caption"
    assert row["aesthetic_score"] == 6.25
    assert row["embedding"] == b"\x10\x20\x30"
    assert row["content_fingerprint"] == original_fingerprint
    assert artist_row["artist"] == "artist_meta"


def test_scan_folder_clears_derived_state_when_pixels_change_same_path(test_db, tmp_path: Path):
    import database as db

    image_path = tmp_path / "pixel-change.png"
    Image.new("RGB", (64, 64), color="white").save(image_path)

    scan_folder(str(tmp_path), recursive=False)
    image = test_db.get_images(limit=10, include_unreadable=True)[0]
    image_id = image["id"]
    original_fingerprint = compute_image_content_fingerprint(str(image_path))

    db.add_tags(image_id, [{"tag": "stale_tag", "confidence": 0.9}], content_fingerprint=original_fingerprint)
    with db.get_db() as conn:
        conn.execute(
            """
            UPDATE images
            SET ai_caption = ?, aesthetic_score = ?, embedding = ?, content_fingerprint = ?
            WHERE id = ?
            """,
            ("stale caption", 5.5, b"\xaa\xbb\xcc", original_fingerprint, image_id),
        )
        conn.execute(
            """
            INSERT INTO artist_predictions (image_id, artist, confidence, top_predictions)
            VALUES (?, ?, ?, ?)
            """,
            (image_id, "artist_old", 0.77, '[{"artist":"artist_old","confidence":0.77}]'),
        )

    Image.new("RGB", (64, 64), color="black").save(image_path)
    updated_mtime_ns = image_path.stat().st_mtime_ns + 2_000_000_000
    os.utime(image_path, ns=(updated_mtime_ns, updated_mtime_ns))

    result = scan_folder(str(tmp_path), recursive=False)
    assert result["updated"] == 1

    assert db.get_image_tags(image_id) == []
    with db.get_db() as conn:
        row = conn.execute(
            """
            SELECT ai_caption, aesthetic_score, embedding, content_fingerprint
            FROM images
            WHERE id = ?
            """,
            (image_id,),
        ).fetchone()
        artist_row = conn.execute(
            "SELECT COUNT(*) FROM artist_predictions WHERE image_id = ?",
            (image_id,),
        ).fetchone()

    assert row["ai_caption"] is None
    assert row["aesthetic_score"] is None
    assert row["embedding"] is None
    assert row["content_fingerprint"] is not None
    assert row["content_fingerprint"] != original_fingerprint
    assert artist_row[0] == 0


def test_scan_folder_skips_reparsing_unchanged_images(test_db, tmp_path: Path, monkeypatch):
    image_path = tmp_path / "unchanged.png"
    Image.new("RGB", (64, 64), color="white").save(image_path)

    first = scan_folder(str(tmp_path), recursive=False)
    assert first["new"] == 1

    parse_calls = {"count": 0}
    original_parse = image_manager.parse_image

    def tracking_parse(*args, **kwargs):
        parse_calls["count"] += 1
        return original_parse(*args, **kwargs)

    monkeypatch.setattr(image_manager, "parse_image", tracking_parse)

    second = scan_folder(str(tmp_path), recursive=False)

    assert second["updated"] == 1
    assert second["unchanged"] == 1
    assert second["metadata_updated"] == 0
    assert parse_calls["count"] == 0


def test_scan_folder_force_reparses_unchanged_images(test_db, tmp_path: Path, monkeypatch):
    image_path = tmp_path / "force-reread.png"
    Image.new("RGB", (64, 64), color="white").save(image_path)

    first = scan_folder(str(tmp_path), recursive=False)
    assert first["new"] == 1

    parse_calls = {"count": 0}
    original_parse = image_manager.parse_image

    def tracking_parse(*args, **kwargs):
        parse_calls["count"] += 1
        return original_parse(*args, **kwargs)

    monkeypatch.setattr(image_manager, "parse_image", tracking_parse)

    second = scan_folder(str(tmp_path), recursive=False, force_reparse=True)

    assert second["updated"] == 1
    assert second["unchanged"] == 0
    assert second["metadata_updated"] == 1
    assert parse_calls["count"] == 1


def test_scan_folder_persists_source_fingerprint_and_metadata_status(test_db, tmp_path: Path):
    image_path = tmp_path / "fingerprint.png"
    Image.new("RGB", (64, 64), color="white").save(image_path)

    scan_folder(str(tmp_path), recursive=False)

    image = test_db.get_images(limit=10, include_unreadable=True)[0]
    stat_result = image_path.stat()

    assert image["source_mtime_ns"] == stat_result.st_mtime_ns
    assert image["source_size"] == stat_result.st_size
    assert image["metadata_status"] == "complete"


def test_scan_folder_emits_library_ready_before_metadata_progress(test_db, tmp_path: Path):
    image_path = tmp_path / "library-ready.png"
    Image.new("RGB", (64, 64), color="white").save(image_path)

    phases = []

    def progress_callback(current, total, filename, details=None):
        details = details or {}
        phase = details.get("phase")
        if phase:
            phases.append(phase)

    scan_folder(str(tmp_path), recursive=False, progress_callback=progress_callback, quick_import=True)

    assert "library_ready" in phases
    assert "metadata" in phases
    assert phases.index("library_ready") < phases.index("metadata")


def test_scan_folder_marks_total_as_growing_until_discovery_finishes(test_db, tmp_path: Path):
    for index in range(2):
        Image.new("RGB", (64, 64), color="white").save(tmp_path / f"growing-{index}.png")

    importing_total_final = []
    metadata_total_final = []

    def progress_callback(current, total, filename, details=None):
        details = details or {}
        if details.get("phase") == "importing":
            importing_total_final.append(details.get("total_final"))
        elif details.get("phase") == "metadata":
            metadata_total_final.append(details.get("total_final"))

    result = scan_folder(str(tmp_path), recursive=False, progress_callback=progress_callback, quick_import=True)

    assert importing_total_final
    assert any(flag is False for flag in importing_total_final)
    assert metadata_total_final
    assert all(flag is True for flag in metadata_total_final)
    assert result["total_final"] is True


def test_scan_folder_cleanup_missing_entries(test_db, tmp_path: Path):
    good_path = tmp_path / "good.png"
    Image.new("RGB", (64, 64), color="white").save(good_path)
    missing_path = tmp_path / "missing.png"

    test_db.add_image(
        path=str(good_path),
        filename=good_path.name,
        metadata_json="{}",
        width=64,
        height=64,
        file_size=good_path.stat().st_size,
        created_at=datetime.fromtimestamp(good_path.stat().st_mtime),
    )
    test_db.add_image(
        path=str(missing_path),
        filename=missing_path.name,
        metadata_json="{}",
        width=64,
        height=64,
        file_size=123,
        created_at=datetime.now(),
    )

    result = scan_folder(str(tmp_path), recursive=False, cleanup_missing=True)

    images = test_db.get_images(limit=10, include_unreadable=True)

    assert result["removed"] == 1
    assert [image["filename"] for image in images] == ["good.png"]
