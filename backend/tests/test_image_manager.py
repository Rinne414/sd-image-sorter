"""
Unit tests for scan progress callbacks.
"""

import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).parent.parent))

from exceptions import ScanCancelledError  # noqa: E402
from image_manager import scan_folder  # noqa: E402


def test_scan_folder_reports_total_before_processing_first_image(test_db, tmp_path: Path):
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
    assert progress_events[0]["current"] == 0
    assert progress_events[0]["total"] == 2
    assert progress_events[0]["filename"] == ""


def test_scan_folder_raises_cancelled_when_stop_requested_after_count(test_db, tmp_path: Path):
    for index in range(2):
        Image.new("RGB", (64, 64), color="white").save(tmp_path / f"cancel-{index}.png")

    state = {"cancel": False}

    def progress_callback(current, total, filename, details=None):
        details = details or {}
        if details.get("phase") == "counted":
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
