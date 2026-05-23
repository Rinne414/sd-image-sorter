"""Tests for the v3.2.2 Dataset Maker session backend (T7a).

These cover ``services.dataset_session_service`` and the
``POST /api/dataset/folder-scan`` route. The hard invariant is that
folder scanning for the Dataset Maker MUST NOT touch the main library
DB — that's the whole reason this path exists.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services.dataset_session_service import (  # noqa: E402
    _ds_id_for_path,
    resolve_paths_for_dataset,
    scan_folder_for_dataset,
    virtual_image_record_for_path,
)


# ============== _ds_id_for_path ==============

def test_ds_id_is_stable_for_the_same_path():
    a = _ds_id_for_path(r"C:\foo\bar.png")
    b = _ds_id_for_path(r"C:\foo\bar.png")
    assert a == b


def test_ds_id_changes_with_the_path():
    assert _ds_id_for_path(r"C:\foo\bar.png") != _ds_id_for_path(r"C:\foo\baz.png")


def test_ds_id_format():
    out = _ds_id_for_path(r"C:\foo.png")
    assert out.startswith("ds:")
    assert len(out) == 19  # "ds:" + 16 hex chars


# ============== scan_folder_for_dataset ==============

@pytest.fixture
def folder_with_mixed_files(tmp_path: Path):
    """Folder containing 3 valid PNGs, 1 unreadable bytes file with .png
    extension, and 1 non-image file (.txt)."""
    # Three readable images
    for name, color in (
        ("alpha.png", (200, 100, 50)),
        ("beta.png", (50, 100, 200)),
        ("gamma.jpg", (100, 200, 100)),
    ):
        Image.new("RGB", (320, 240), color=color).save(tmp_path / name)
    # An unreadable .png
    (tmp_path / "broken.png").write_bytes(b"not a png")
    # A non-image file
    (tmp_path / "readme.txt").write_text("hello", encoding="utf-8")
    return tmp_path


def test_scan_returns_metadata_for_valid_images(folder_with_mixed_files):
    result = scan_folder_for_dataset(str(folder_with_mixed_files))
    assert result["folder_path"]  # absolute resolved path
    items = result["items"]
    # 3 valid images, 1 unreadable PNG should be skipped
    assert len(items) == 3
    assert {item["filename"] for item in items} == {"alpha.png", "beta.png", "gamma.jpg"}
    for item in items:
        assert item["width"] == 320
        assert item["height"] == 240
        assert item["thumb_b64"]  # non-empty base64 string
        assert item["ds_id"].startswith("ds:")
        assert item["abs_path"]
        assert item["mtime"] > 0
        assert item["size"] > 0


def test_scan_counts_skipped_unreadable(folder_with_mixed_files):
    result = scan_folder_for_dataset(str(folder_with_mixed_files))
    # broken.png passes the extension filter but fails Pillow open
    assert result["skipped_unreadable"] == 1
    # total_files_seen is 4 (3 valid + 1 broken), excluding the .txt
    assert result["total_files_seen"] == 4


def test_scan_thumbnails_are_jpeg_base64(folder_with_mixed_files):
    """Thumbnails must be base64-encoded JPEG so the frontend can plug
    them straight into ``<img src="data:image/jpeg;base64,...">``."""
    import base64

    result = scan_folder_for_dataset(str(folder_with_mixed_files))
    item = result["items"][0]
    raw = base64.b64decode(item["thumb_b64"])
    # JPEG SOI marker
    assert raw[:2] == b"\xff\xd8"


def test_scan_invalid_folder_raises_valueerror(tmp_path):
    nonexistent = tmp_path / "does-not-exist"
    with pytest.raises(ValueError):
        scan_folder_for_dataset(str(nonexistent))


def test_scan_does_not_touch_main_db(test_db, folder_with_mixed_files):
    """The hard invariant: folder-scan MUST NOT add rows to images.db.
    This is why the small-gallery flow exists at all."""
    import database as db

    before = db.get_image_count() if hasattr(db, "get_image_count") else 0
    # Some test fixtures use a different counting helper
    if before == 0:
        try:
            before_rows = list(db.get_filtered_image_id_chunks(chunk_size=10_000))
            before = sum(len(c) for c in before_rows)
        except Exception:
            before = 0

    scan_folder_for_dataset(str(folder_with_mixed_files))

    after = db.get_image_count() if hasattr(db, "get_image_count") else 0
    if after == 0:
        try:
            after_rows = list(db.get_filtered_image_id_chunks(chunk_size=10_000))
            after = sum(len(c) for c in after_rows)
        except Exception:
            after = 0

    assert after == before, (
        f"Dataset folder-scan touched the main DB: rows went from "
        f"{before} to {after}. This breaks the small-gallery invariant."
    )


def test_scan_recursive_sees_subfolders(tmp_path):
    """``recursive=True`` walks subdirectories; default does not."""
    nested = tmp_path / "sub" / "nested"
    nested.mkdir(parents=True)
    Image.new("RGB", (32, 32), color=(100, 100, 100)).save(tmp_path / "top.png")
    Image.new("RGB", (32, 32), color=(150, 150, 150)).save(nested / "deep.png")

    flat = scan_folder_for_dataset(str(tmp_path), recursive=False)
    assert {it["filename"] for it in flat["items"]} == {"top.png"}

    deep = scan_folder_for_dataset(str(tmp_path), recursive=True)
    assert {it["filename"] for it in deep["items"]} == {"top.png", "deep.png"}


def test_scan_truncated_when_above_limit(tmp_path):
    """Hits the per-call cap and reports ``truncated=True``."""
    for i in range(7):
        Image.new("RGB", (32, 32), color=(i * 30, 100, 100)).save(tmp_path / f"img{i}.png")
    result = scan_folder_for_dataset(str(tmp_path), limit=3)
    assert len(result["items"]) == 3
    assert result["truncated"] is True
    # total_files_seen counts the file that tripped the cap before we
    # broke out of the loop, so it's items+1 here.
    assert result["total_files_seen"] >= 3


# ============== resolve_paths_for_dataset ==============

def test_resolve_paths_filters_missing_and_non_image(tmp_path):
    img = tmp_path / "ok.png"
    Image.new("RGB", (32, 32)).save(img)
    txt = tmp_path / "ignore.txt"
    txt.write_text("hi", encoding="utf-8")
    nonexistent = tmp_path / "ghost.png"

    out = resolve_paths_for_dataset([str(img), str(txt), str(nonexistent)])
    assert len(out) == 1
    assert Path(out[0]).name == "ok.png"


def test_resolve_paths_dedupes(tmp_path):
    img = tmp_path / "ok.png"
    Image.new("RGB", (32, 32)).save(img)
    out = resolve_paths_for_dataset([str(img), str(img), str(img.absolute())])
    assert len(out) == 1


# ============== virtual_image_record_for_path ==============

def test_virtual_record_shape_matches_db_row(tmp_path):
    img = tmp_path / "vr.png"
    Image.new("RGB", (640, 480), color=(0, 0, 0)).save(img)
    rec = virtual_image_record_for_path(str(img))

    assert rec["id"] == 0  # sentinel
    assert rec["filename"] == "vr.png"
    # Path comparison via samefile to be case-insensitive on Windows
    # (the system's pytest tmp_path can produce ``pytest-of-User`` while
    # Pillow / Path.resolve() lowercase the user component).
    assert Path(rec["path"]).samefile(img)
    assert rec["width"] == 640
    assert rec["height"] == 480
    assert rec["ai_caption"] is None
    assert rec["ds_id"].startswith("ds:")


# ============== /api/dataset/folder-scan route ==============

def test_route_folder_scan_happy_path(test_client, folder_with_mixed_files):
    resp = test_client.post("/api/dataset/folder-scan", json={
        "folder_path": str(folder_with_mixed_files),
        "recursive": False,
    })
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert len(body["items"]) == 3
    assert body["skipped_unreadable"] == 1
    assert body["truncated"] is False


def test_route_folder_scan_invalid_path_returns_400(test_client, tmp_path):
    resp = test_client.post("/api/dataset/folder-scan", json={
        "folder_path": str(tmp_path / "nope"),
        "recursive": False,
    })
    assert resp.status_code == 400


def test_route_folder_scan_does_not_touch_db(test_client, folder_with_mixed_files):
    """End-to-end version of the hard invariant: hitting the route
    over HTTP must not register any image rows."""
    list_before = test_client.get("/api/images?limit=1").json()
    count_before = list_before.get("total_count", 0) or len(list_before.get("images", []))

    test_client.post("/api/dataset/folder-scan", json={
        "folder_path": str(folder_with_mixed_files),
        "recursive": False,
    })

    list_after = test_client.get("/api/images?limit=1").json()
    count_after = list_after.get("total_count", 0) or len(list_after.get("images", []))

    assert count_after == count_before
