"""
Unit tests for scan progress callbacks.
"""

import os
import sys
from datetime import datetime
from pathlib import Path

import database as db
import pytest
from PIL import Image
from PIL.PngImagePlugin import PngInfo

sys.path.insert(0, str(Path(__file__).parent.parent))

from exceptions import FileOperationError, ScanCancelledError  # noqa: E402
import image_manager  # noqa: E402
from image_fingerprint import compute_image_content_fingerprint  # noqa: E402
from image_manager import scan_folder  # noqa: E402


def test_move_image_restores_file_when_database_update_fails(test_db, tmp_path: Path, monkeypatch):
    source_dir = tmp_path / "move-source"
    destination_dir = tmp_path / "move-dest"
    source_dir.mkdir()
    destination_dir.mkdir()
    source_path = source_dir / "rollback-move.png"
    Image.new("RGB", (32, 32), color="green").save(source_path)
    image_id = db.add_image(path=str(source_path), filename=source_path.name)

    def fail_update_path(_image_id: int, _new_path: str):
        raise RuntimeError("simulated database failure")

    monkeypatch.setattr(image_manager, "update_image_path", fail_update_path)

    with pytest.raises(FileOperationError, match="file was restored"):
        image_manager.move_image(image_id, str(destination_dir), str(source_path))

    assert source_path.exists()
    assert not (destination_dir / source_path.name).exists()
    assert db.get_image_by_id(image_id)["path"] == str(source_path)


def test_copy_image_removes_copied_file_when_database_update_fails(test_db, tmp_path: Path, monkeypatch):
    source_dir = tmp_path / "copy-source"
    destination_dir = tmp_path / "copy-dest"
    source_dir.mkdir()
    destination_dir.mkdir()
    source_path = source_dir / "rollback-copy.png"
    Image.new("RGB", (32, 32), color="purple").save(source_path)
    image_id = db.add_image(path=str(source_path), filename=source_path.name)

    def fail_copy_state(*_args, **_kwargs):
        raise RuntimeError("simulated database failure")

    monkeypatch.setattr(image_manager, "add_copied_image_with_state", fail_copy_state)

    with pytest.raises(FileOperationError, match="copied file was removed"):
        image_manager.copy_image(image_id, str(destination_dir), str(source_path), db.get_image_by_id(image_id))

    assert source_path.exists()
    assert not (destination_dir / source_path.name).exists()
    assert db.get_image_by_path(str(destination_dir / source_path.name)) is None


def test_copy_image_replaces_stale_target_row_state(test_db, tmp_path: Path):
    source_dir = tmp_path / "copy-source"
    destination_dir = tmp_path / "copy-dest"
    source_dir.mkdir()
    destination_dir.mkdir()
    source_path = source_dir / "stale-copy.png"
    target_path = destination_dir / source_path.name
    Image.new("RGB", (32, 32), color="orange").save(source_path)
    source_id = db.add_image(path=str(source_path), filename=source_path.name)
    stale_id = db.add_image(path=str(target_path), filename=target_path.name)
    db.add_tags(source_id, [{"tag": "fresh_tag", "confidence": 0.9}])
    db.add_tags(stale_id, [{"tag": "stale_tag", "confidence": 0.8}])
    with db.get_db() as conn:
        conn.execute(
            "INSERT INTO artist_predictions (image_id, artist, confidence, top_predictions) VALUES (?, ?, ?, ?)",
            (stale_id, "stale_artist", 0.5, "[]"),
        )

    result = image_manager.copy_image(source_id, str(destination_dir), str(source_path), db.get_image_by_id(source_id))

    copied_id = result["new_image_id"]
    assert copied_id == stale_id
    assert target_path.exists()
    assert {tag["tag"] for tag in db.get_image_tags(copied_id)} == {"fresh_tag"}
    with db.get_db() as conn:
        artist_count = conn.execute(
            "SELECT COUNT(*) FROM artist_predictions WHERE image_id = ?",
            (copied_id,),
        ).fetchone()[0]
    assert artist_count == 0


def test_add_copied_image_with_state_rolls_back_partial_database_rows(test_db, tmp_path: Path):
    source_path = tmp_path / "source.png"
    copied_path = tmp_path / "copied.png"
    Image.new("RGB", (32, 32), color="blue").save(source_path)
    source_id = db.add_image(path=str(source_path), filename=source_path.name)
    source_row = db.get_image_by_id(source_id)
    record = image_manager._build_copied_image_record(source_row, str(copied_path), source_path.stat())

    with pytest.raises(Exception):
        db.add_copied_image_with_state(
            source_id,
            record,
            [
                {"tag": "duplicate_tag", "confidence": 0.9},
                {"tag": "duplicate_tag", "confidence": 0.8},
            ],
        )

    assert db.get_image_by_path(str(copied_path)) is None


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
    assert any(flag is True for flag in metadata_total_final)
    assert metadata_total_final[-1] is True
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


def test_get_folder_stats_skips_symlinked_images(tmp_path: Path):
    real_image = tmp_path / "real.png"
    Image.new("RGB", (32, 32), color="white").save(real_image)

    symlink_image = tmp_path / "linked.png"
    try:
        symlink_image.symlink_to(real_image)
    except (OSError, NotImplementedError):
        return

    stats = image_manager.get_folder_stats(str(tmp_path))

    assert stats["total_files"] == 1
    assert stats["by_extension"] == {".png": 1}
