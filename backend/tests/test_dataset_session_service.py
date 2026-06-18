"""Tests for the v3.2.2 Dataset Maker session backend (T7a).

These cover ``services.dataset_session_service`` and the
``POST /api/dataset/folder-scan`` route. The hard invariant is that
folder scanning for the Dataset Maker MUST NOT touch the main library
DB — that's the whole reason this path exists.
"""
from __future__ import annotations

import sys
import zipfile
import asyncio
from io import BytesIO
from pathlib import Path

import pytest
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services.dataset_session_service import (  # noqa: E402
    _ds_id_for_path,
    _load_scan_manifest,
    get_scan_manifest_paths,
    resolve_paths_for_dataset,
    scan_folder_for_dataset,
    upload_files_for_dataset,
    virtual_image_record_for_path,
)
from services import dataset_session_service as dataset_session_module  # noqa: E402


class FakeUploadFile:
    def __init__(self, filename: str, content: bytes):
        self.filename = filename
        self._content = content
        self.file = BytesIO(content)

    async def read(self) -> bytes:
        return self._content


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
    assert result["total_files_seen"] == 7
    assert result["scan_token"]
    assert result["has_more"] is True
    assert result["next_offset"] == 3
    assert "manifest_items" not in result
    manifest = _load_scan_manifest(result["scan_token"])
    assert "paths" not in manifest
    assert manifest["manifest_format"] == "jsonl-items-v2"
    assert len(get_scan_manifest_paths(result["scan_token"])) == 7


def test_scan_token_paginates_large_folder_without_rescanning_payload(tmp_path):
    for i in range(7):
        Image.new("RGB", (32, 32), color=(i * 25, 100, 100)).save(tmp_path / f"img{i}.png")

    first = scan_folder_for_dataset(str(tmp_path), limit=3)
    second = scan_folder_for_dataset(
        str(tmp_path),
        limit=3,
        offset=first["next_offset"],
        scan_token=first["scan_token"],
    )

    assert len(first["items"]) == 3
    assert len(second["items"]) == 3
    assert first["scan_token"] == second["scan_token"]
    assert "manifest_items" not in first
    assert "manifest_items" not in second
    assert second["offset"] == 3
    assert second["next_offset"] == 6
    assert second["has_more"] is True
    assert {item["abs_path"] for item in first["items"]}.isdisjoint(
        {item["abs_path"] for item in second["items"]}
    )


def test_scan_can_return_manifest_items_without_inline_thumbnails(folder_with_mixed_files):
    result = scan_folder_for_dataset(
        str(folder_with_mixed_files),
        limit=10,
        include_thumbnails=False,
    )

    assert len(result["items"]) == 4
    assert result["skipped_unreadable"] == 0
    assert result["total_files_seen"] == 4
    assert result["scan_token"]
    for item in result["items"]:
        assert item["ds_id"].startswith("ds:")
        assert item["abs_path"]
        assert item["filename"]
        assert item["thumb_b64"] == ""
        assert item["width"] == 0
        assert item["height"] == 0


# ============== upload_files_for_dataset ==============

def _image_bytes(fmt: str = "PNG") -> bytes:
    buf = BytesIO()
    Image.new("RGB", (40, 32), color=(120, 80, 40)).save(buf, format=fmt)
    return buf.getvalue()


def _zip_bytes(entries: dict[str, bytes]) -> bytes:
    buf = BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, content in entries.items():
            zf.writestr(name, content)
    return buf.getvalue()


def test_upload_files_accepts_zip_and_respects_recursive_flag(tmp_path, monkeypatch):
    monkeypatch.setattr(dataset_session_module, "_UPLOAD_DIR", tmp_path / "uploads")
    payload = _zip_bytes({
        "top.png": _image_bytes(),
        "nested/deep.png": _image_bytes(),
        "../escape.png": _image_bytes(),
        "readme.txt": b"not an image",
    })

    flat = asyncio.run(upload_files_for_dataset([FakeUploadFile("dataset.zip", payload)], recursive=False))
    assert {item["filename"] for item in flat["items"]} == {"top.png"}
    assert {item["source_kind"] for item in flat["items"]} == {"zip_extract"}
    # v3.2.2: extracted ZIP entries live on disk in the upload dir, so
    # ``beside_image`` export can write a same-name .txt next to each copy.
    assert {item["sidecar_capability"] for item in flat["items"]} == {"beside_image"}

    deep = asyncio.run(upload_files_for_dataset([FakeUploadFile("dataset.zip", payload)], recursive=True))
    assert {item["filename"] for item in deep["items"]} == {"top.png", "deep.png"}
    assert {item["source_kind"] for item in deep["items"]} == {"zip_extract"}
    assert {item["sidecar_capability"] for item in deep["items"]} == {"beside_image"}


def test_upload_files_marks_direct_images_as_beside_image(tmp_path, monkeypatch):
    monkeypatch.setattr(dataset_session_module, "_UPLOAD_DIR", tmp_path / "uploads")

    result = asyncio.run(upload_files_for_dataset([FakeUploadFile("loose.png", _image_bytes())]))

    assert len(result["items"]) == 1
    item = result["items"][0]
    assert item["filename"] == "loose.png"
    assert item["source_kind"] == "uploaded_file"
    # v3.2.2: drag/drop images land in the upload dir as real files, so the
    # beside-image export mode can place the .txt right next to them.
    assert item["sidecar_capability"] == "beside_image"


def test_upload_files_rejects_rar_when_rarfile_dependency_missing(tmp_path, monkeypatch):
    """Without the optional rarfile dep, .rar uploads must fail with a clear
    error pointing at the workaround. The behaviour with rarfile installed
    is exercised via integration on dev machines.
    """
    monkeypatch.setattr(dataset_session_module, "_UPLOAD_DIR", tmp_path / "uploads")
    monkeypatch.setattr(dataset_session_module, "_try_import_rarfile", lambda: None)

    with pytest.raises(ValueError, match="rarfile"):
        asyncio.run(upload_files_for_dataset([FakeUploadFile("dataset.rar", b"not really rar")]))


def test_upload_files_does_not_truncate_zip_imports_at_preview_page_size(tmp_path, monkeypatch):
    monkeypatch.setattr(dataset_session_module, "_UPLOAD_DIR", tmp_path / "uploads")
    monkeypatch.setattr(dataset_session_module, "MAX_SCAN_RESULTS", 2)
    payload = _zip_bytes({f"img{i}.png": _image_bytes() for i in range(5)})

    result = asyncio.run(upload_files_for_dataset([FakeUploadFile("dataset.zip", payload)], recursive=True))

    assert len(result["items"]) == 5
    assert result["truncated"] is False


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


def test_route_folder_scan_can_skip_inline_thumbnails(test_client, folder_with_mixed_files):
    resp = test_client.post("/api/dataset/folder-scan", json={
        "folder_path": str(folder_with_mixed_files),
        "recursive": False,
        "include_thumbnails": False,
        "limit": 10,
    })
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert len(body["items"]) == 4
    assert body["skipped_unreadable"] == 0
    assert all(item["thumb_b64"] == "" for item in body["items"])


def test_route_local_thumbnail_serves_dataset_path(test_client, folder_with_mixed_files):
    # The thumbnail endpoint is gated by the Dataset Maker session
    # allowlist, so the folder must be scanned first to register the
    # path. See test_route_local_thumbnail_requires_session_membership
    # for the negative case.
    scan_resp = test_client.post("/api/dataset/folder-scan", json={
        "folder_path": str(folder_with_mixed_files),
        "recursive": False,
        "limit": 10,
    })
    assert scan_resp.status_code == 200, scan_resp.text

    source = folder_with_mixed_files / "alpha.png"

    resp = test_client.get("/api/dataset/local-thumbnail", params={
        "path": str(source),
        "size": 160,
    })

    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"].startswith("image/webp")
    assert resp.content.startswith(b"RIFF")


def test_route_local_thumbnail_requires_session_membership(test_client, folder_with_mixed_files):
    """A path the user never scanned/uploaded must not be thumbnail-readable.

    Regression for the arbitrary-host-file read hole: before the session
    allowlist, ``?path=<anywhere>`` could read thumbnails of any image
    on the host that had a recognised extension. The endpoint now 403s
    unless the path was surfaced by folder-scan, upload-files, or a
    scan-token manifest.
    """
    # alpha.png is under the scanned folder but we never scanned it in
    # this test, so it must NOT be in the session allowlist.
    source = folder_with_mixed_files / "alpha.png"

    # Clear any carryover from other tests in the same process.
    from services.dataset_session_service import _session_path_cache
    _session_path_cache.clear()

    resp = test_client.get("/api/dataset/local-thumbnail", params={
        "path": str(source),
        "size": 160,
    })
    assert resp.status_code == 403, resp.text

    # After a real folder-scan, the same path becomes readable.
    scan_resp = test_client.post("/api/dataset/folder-scan", json={
        "folder_path": str(folder_with_mixed_files),
        "recursive": False,
        "limit": 10,
    })
    assert scan_resp.status_code == 200, scan_resp.text

    resp2 = test_client.get("/api/dataset/local-thumbnail", params={
        "path": str(source),
        "size": 160,
    })
    assert resp2.status_code == 200, resp2.text
    assert resp2.headers["content-type"].startswith("image/webp")
