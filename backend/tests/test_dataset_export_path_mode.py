"""Tests for the v3.2.2 path-mode dataset export (T7a).

Path-mode lets the Dataset Maker export images that the user imported
directly from a folder (the "small gallery" workflow) WITHOUT first
adding them to the main library DB.

The export must:
  1. Copy / rename the on-disk images using the same naming engine
  2. Write a same-stem .txt sidecar using the user-supplied caption
     override (because path-source items have no DB tags / ai_caption)
  3. Leave the main DB untouched
"""
from __future__ import annotations

import os
from pathlib import Path

import pytest
from PIL import Image


@pytest.fixture
def folder_with_locals(tmp_path: Path) -> tuple[Path, list[Path]]:
    """3 images in a folder NOT scanned into the gallery DB."""
    folder = tmp_path / "local-only"
    folder.mkdir()
    paths = []
    for name, color in (
        ("local_a.png", (255, 0, 0)),
        ("local_b.png", (0, 255, 0)),
        ("local_c.png", (0, 0, 255)),
    ):
        p = folder / name
        Image.new("RGB", (96, 96), color=color).save(p)
        paths.append(p)
    return folder, paths


def test_path_mode_export_works_without_db_rows(test_client, test_db, folder_with_locals, tmp_path):
    """Hard test: paths-only request -> /api/dataset/export must
    rename the images and write same-stem captions without ever
    inserting into images.db."""
    folder, paths = folder_with_locals
    out = tmp_path / "out"
    out.mkdir()

    # Caption overrides keyed by absolute path (small-gallery convention)
    captions = {
        str(p.resolve()): f"my_oc, painting style, content {p.stem}"
        for p in paths
    }

    response = test_client.post("/api/dataset/export", json={
        "image_ids": [],
        "image_paths": [str(p) for p in paths],
        "output_folder": str(out),
        "naming_pattern": "{trigger}_{index:03d}",
        "trigger": "my_oc",
        "image_op": "copy",
        "overwrite_policy": "unique",
        "image_overrides": captions,
        "normalize_tag_underscores": False,
    })
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "ok", body
    assert body["exported"] == 3

    # Verify the renamed image+caption pairs
    for idx in range(1, 4):
        stem = f"my_oc_{idx:03d}"
        assert (out / f"{stem}.png").exists(), f"missing renamed image {stem}.png"
        cap = out / f"{stem}.txt"
        assert cap.exists(), f"missing caption {stem}.txt"
        # Caption content must come from the override (paths have no DB tags)
        text = cap.read_text(encoding="utf-8")
        assert text.startswith("my_oc, painting style, content local_"), text

    # Source files still in the source folder (image_op=copy)
    for p in paths:
        assert p.exists(), f"source removed despite copy mode: {p}"

    # MAIN DB INVARIANT: no rows for any of these paths
    import database as db
    list_resp = test_client.get("/api/images?limit=100").json()
    db_rows = list_resp.get("images") or []
    bad_db_rows = [r for r in db_rows if str(folder) in str(r.get("path", ""))]
    assert not bad_db_rows, (
        f"Path-mode export added DB rows for the local folder: "
        f"{[r['path'] for r in bad_db_rows]}"
    )


def test_path_mode_invalid_path_reports_error(test_client, test_db, tmp_path):
    """Garbage paths should surface as per-item errors, not crash the export."""
    out = tmp_path / "out"
    out.mkdir()
    response = test_client.post("/api/dataset/export", json={
        "image_ids": [],
        "image_paths": [str(tmp_path / "ghost.png")],
        "output_folder": str(out),
        "naming_pattern": "{trigger}_{index:03d}",
        "trigger": "x",
        "image_op": "copy",
        "overwrite_policy": "unique",
    })
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "failed", body  # exported=0, error_count>=1
    assert body["error_count"] >= 1
    msg = " ".join(body["error_messages"]).lower()
    assert "ghost.png" in msg or "not a readable image" in msg


def test_path_mode_caption_falls_back_to_template_when_no_override(
    test_client, test_db, folder_with_locals, tmp_path
):
    """If no override is supplied for a path-source item, the export
    still writes a caption — built by the template engine on the
    synthetic record (which has no tags, so the caption is just the
    trigger + common_tags)."""
    folder, paths = folder_with_locals
    out = tmp_path / "out"
    out.mkdir()

    response = test_client.post("/api/dataset/export", json={
        "image_ids": [],
        "image_paths": [str(paths[0])],
        "output_folder": str(out),
        "naming_pattern": "{filename}",
        "trigger": "myloratrigger",
        "common_tags": ["masterpiece", "best_quality"],
        "image_op": "copy",
        "overwrite_policy": "unique",
        "normalize_tag_underscores": False,
    })
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["exported"] == 1

    cap = (out / "local_a.txt").read_text(encoding="utf-8").strip()
    assert "myloratrigger" in cap
    assert "masterpiece" in cap


def test_path_mode_export_accepts_dataset_scan_token_without_path_payload(
    test_client, test_db, folder_with_locals, tmp_path
):
    folder, paths = folder_with_locals
    out = tmp_path / "token-out"
    out.mkdir()

    scan = test_client.post("/api/dataset/folder-scan", json={
        "folder_path": str(folder),
        "recursive": False,
        "limit": 1,
    })
    assert scan.status_code == 200, scan.text
    token = scan.json()["scan_token"]

    response = test_client.post("/api/dataset/export", json={
        "image_ids": [],
        "image_paths": [],
        "dataset_scan_tokens": [{
            "scan_token": token,
            "exclude_paths": [str(paths[1].resolve())],
        }],
        "output_folder": str(out),
        "naming_pattern": "{filename}",
        "trigger": "token_trigger",
        "image_op": "copy",
        "overwrite_policy": "unique",
        "common_tags": ["clean_caption"],
        "normalize_tag_underscores": False,
    })
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "ok", body
    assert body["exported"] == 2
    assert (out / "local_a.png").exists()
    assert not (out / "local_b.png").exists()
    assert (out / "local_c.png").exists()


def test_path_mode_beside_image_writes_sidecars_next_to_originals_without_output_folder(
    test_client, test_db, folder_with_locals
):
    """The Dataset Maker's "same-name .txt beside original" mode must work
    for real folder-path imports without asking for an output folder or
    copying images into a second location."""
    _folder, paths = folder_with_locals
    captions = {
        str(p.resolve()): f"beside caption for {p.stem}"
        for p in paths[:2]
    }

    response = test_client.post("/api/dataset/export", json={
        "image_ids": [],
        "image_paths": [str(paths[0]), str(paths[1])],
        "output_mode": "beside_image",
        "output_folder": "",
        "naming_pattern": "ignored_{index:03d}",
        "trigger": "ignored",
        "image_op": "copy",
        "overwrite_policy": "overwrite",
        "image_overrides": captions,
        "normalize_tag_underscores": False,
    })
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "ok", body
    assert body["exported"] == 2
    assert body["output_mode"] == "beside_image"

    assert paths[0].exists()
    assert paths[1].exists()
    assert (paths[0].with_suffix(".txt")).read_text(encoding="utf-8") == "beside caption for local_a"
    assert (paths[1].with_suffix(".txt")).read_text(encoding="utf-8") == "beside caption for local_b"
    assert not (paths[0].parent / "ignored_001.png").exists()


def test_export_400_when_neither_ids_nor_paths_supplied(test_client, test_db, tmp_path):
    """Empty request payload should be a 400, not a server error."""
    out = tmp_path / "out"
    out.mkdir()
    response = test_client.post("/api/dataset/export", json={
        "image_ids": [],
        "image_paths": [],
        "output_folder": str(out),
        "image_op": "copy",
        "overwrite_policy": "unique",
    })
    assert response.status_code == 400, response.text
