"""Tests for the ``export_manifest.json`` written on folder-mode dataset export.

A folder-mode export now drops a run manifest into the output folder so the
user (and downstream tooling) has a machine-readable record of which sources
mapped to which outputs, the settings used, and the counts. Beside-image mode
has no single destination folder, so it must NOT write a manifest anywhere.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from PIL import Image


@pytest.fixture
def two_tagged_images(test_db, tmp_path: Path):
    """Two on-disk images added to the DB and tagged. Returns (ids, src_dir)."""
    import database as db

    src = tmp_path / "src"
    src.mkdir()
    ids = []
    for name in ("alpha.png", "beta.png"):
        path = src / name
        Image.new("RGB", (32, 32), color=(20, 40, 60)).save(path)
        image_id = db.add_image(path=str(path), filename=name)
        db.add_tags(image_id, [
            {"tag": "1girl", "confidence": 0.9},
            {"tag": "long_hair", "confidence": 0.85},
        ])
        ids.append(image_id)
    return ids, src


def test_folder_export_writes_manifest(test_client, two_tagged_images, tmp_path: Path):
    """A ``folder``-mode export writes export_manifest.json with the run's
    version, settings, counts, and a per-item src->dst list."""
    ids, _src = two_tagged_images
    out = tmp_path / "out"
    out.mkdir()

    response = test_client.post("/api/dataset/export", json={
        "image_ids": ids,
        "output_folder": str(out),
        "naming_pattern": "train_{index:03d}",
        "trigger": "my_subject",
        "image_op": "copy",
        "overwrite_policy": "unique",
        "content_mode": "tags",
        "common_tags": ["masterpiece"],
    })
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "ok", body
    assert body["exported"] == 2

    manifest_path = out / "export_manifest.json"
    assert manifest_path.exists(), "export_manifest.json missing from folder export"

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    # Schema + provenance
    assert manifest["manifest_version"] == 1
    assert manifest["status"] == "ok"
    assert isinstance(manifest["generated_at"], (int, float))
    assert manifest["generated_at_iso"]  # non-empty ISO string
    assert str(out) in manifest["output_folder"]

    # Settings actually used
    settings = manifest["settings"]
    assert settings["output_mode"] == "folder"
    assert settings["content_mode"] == "tags"
    assert settings["image_op"] == "copy"
    assert settings["overwrite_policy"] == "unique"
    assert settings["naming_pattern"] == "train_{index:03d}"
    assert settings["trigger"] == "my_subject"
    assert settings["common_tags"] == ["masterpiece"]

    # Counts must match the export result
    counts = manifest["counts"]
    assert counts["total"] == 2
    assert counts["exported"] == 2
    assert counts["skipped"] == 0
    assert counts["failed"] == 0

    # Per-item src->dst entries present and pointing at the renamed outputs
    assert manifest["items_truncated"] is False
    items = manifest["items"]
    assert len(items) == 2
    for entry in items:
        assert entry["source_path"], entry
        assert entry["output_path"], entry
        assert entry["output_path"].endswith(".png")
        assert entry["caption_path"].endswith(".txt")
        assert entry["error"] is None
    output_names = sorted(Path(e["output_path"]).name for e in items)
    assert output_names == ["train_001.png", "train_002.png"]


def test_beside_image_export_skips_manifest(test_client, two_tagged_images, tmp_path: Path):
    """``beside_image`` mode has no single destination folder, so no manifest
    is written next to the source images or anywhere else."""
    ids, src = two_tagged_images

    response = test_client.post("/api/dataset/export", json={
        "image_ids": ids,
        "output_mode": "beside_image",
        "output_folder": "",
        "naming_pattern": "ignored_{index:03d}",
        "image_op": "copy",
        "overwrite_policy": "overwrite",
    })
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "ok", body
    assert body["output_mode"] == "beside_image"

    # The sidecars landed next to the originals, but NOT a manifest.
    assert (src / "alpha.txt").exists()
    assert not (src / "export_manifest.json").exists()
    assert not (tmp_path / "export_manifest.json").exists()


def test_failed_folder_export_still_writes_manifest_recording_error(
    test_client, tmp_path: Path, test_db
):
    """Even a fully-failed folder export writes a manifest that records the
    failure counts and the per-item error, since files may still be present."""
    out = tmp_path / "out"
    out.mkdir()

    response = test_client.post("/api/dataset/export", json={
        "image_ids": [9_999_999],  # not in the DB -> one error, zero exports
        "output_folder": str(out),
        "naming_pattern": "{filename}",
    })
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "failed", body

    manifest_path = out / "export_manifest.json"
    assert manifest_path.exists(), "manifest missing for a failed folder export"

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert manifest["status"] == "failed"
    assert manifest["counts"] == {"total": 1, "exported": 0, "skipped": 0, "failed": 1}
    assert len(manifest["items"]) == 1
    assert "not found in library" in (manifest["items"][0]["error"] or "")
