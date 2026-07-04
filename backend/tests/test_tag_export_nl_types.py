"""Aurora #25c caption consolidation — per-image Booru/NL/Both caption types
on the /api/tags export engine.

The Dataset Maker export (``/api/dataset/export``) has spoken the
``image_types`` + ``image_nl_overrides`` contract since the two-box editor
shipped; these tests lock the SAME contract onto the v321 batch-export path
(``/api/tags/export-batch`` + ``/api/tags/export-combined``) and the shared
join rule both engines now delegate to.

Key invariants:
  - absent maps == pre-feature output byte-for-byte (back-compat),
  - compose runs AFTER overrides/render and BEFORE caption_transforms,
  - the {template, tags} mode gate matches dataset_export_service,
  - an explicit empty-string NL override suppresses the stored sentence.
"""
from __future__ import annotations

import os
import time
from pathlib import Path

import pytest
from PIL import Image

import database as db
from services.tag_export_service import compose_caption_with_nl


NL_SENTENCE = "a serene portrait of a girl standing in soft light"
EDITED_SENTENCE = "an edited sentence from the caption editor"


# ---------------------------------------------------------------------------
# Unit: the shared join rule
# ---------------------------------------------------------------------------

def test_compose_returns_rendered_verbatim_for_non_nl_types():
    # Untrimmed input must pass through untouched for booru/absent/garbage
    # types — this is the byte-for-byte back-compat contract.
    raw = "  1girl, long_hair  "
    assert compose_caption_with_nl(raw, "", NL_SENTENCE) == raw
    assert compose_caption_with_nl(raw, "booru", NL_SENTENCE) == raw
    assert compose_caption_with_nl(raw, "garbage", NL_SENTENCE) == raw


def test_compose_nl_type_prefers_sentence_and_falls_back_to_booru():
    assert compose_caption_with_nl("1girl", "nl", NL_SENTENCE) == NL_SENTENCE
    assert compose_caption_with_nl("1girl", "nl", "   ") == "1girl"
    assert compose_caption_with_nl("", "nl", "") == ""


def test_compose_both_joins_with_comma_and_handles_empty_sides():
    assert compose_caption_with_nl("1girl", "both", NL_SENTENCE) == f"1girl, {NL_SENTENCE}"
    assert compose_caption_with_nl("", "both", NL_SENTENCE) == NL_SENTENCE
    assert compose_caption_with_nl("1girl", "both", "") == "1girl"
    assert compose_caption_with_nl("", "both", "") == ""


# ---------------------------------------------------------------------------
# Integration: scan a tiny folder, tag it, set NL captions, export
# ---------------------------------------------------------------------------

def _wait_for_scan(test_client) -> None:
    for _ in range(60):
        time.sleep(0.25)
        progress = test_client.get("/api/scan/progress").json()
        if progress.get("status") in ("done", "idle", "completed", "success"):
            return
    pytest.fail("scan did not finish in time")


@pytest.fixture
def tagged_images(test_client, test_db, tmp_path: Path):
    """Five scanned images with tags; the first three carry a stored NL caption."""
    folder = tmp_path / "imgs"
    folder.mkdir()
    for i in range(5):
        Image.new("RGB", (32, 32), color=(10 * i, 20, 30)).save(folder / f"img_{i}.png")

    test_client.post("/api/scan/reset")
    response = test_client.post("/api/scan", json={"folder_path": str(folder), "recursive": False})
    assert response.status_code == 200, response.text
    _wait_for_scan(test_client)

    list_resp = test_client.get("/api/images?limit=50")
    assert list_resp.status_code == 200, list_resp.text
    images = [
        img for img in list_resp.json().get("images", [])
        if str(folder) in str(img.get("path", "")).replace("/", os.sep)
    ]
    assert len(images) == 5, f"expected 5 scanned images, got {len(images)}"
    images.sort(key=lambda img: img["filename"])
    ids = [img["id"] for img in images]

    add = test_client.post("/api/tags/bulk/add", json={
        "image_ids": ids,
        "tags": ["1girl", "long_hair"],
        "confidence": 0.85,
        "dry_run": False,
    })
    assert add.status_code == 200, add.text

    for image_id in ids[:3]:
        db.update_image_caption(image_id, f"fused: {NL_SENTENCE}", nl_caption=NL_SENTENCE)

    return ids


def _export_batch(test_client, ids, out_dir: Path, **extra):
    payload = {
        "image_ids": ids,
        "output_folder": str(out_dir),
        "output_mode": "folder",
        "content_mode": "tags",
        "overwrite_policy": "overwrite",
        "normalize_tag_underscores": False,
        **extra,
    }
    resp = test_client.post("/api/tags/export-batch", json=payload)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _sidecar_text(out_dir: Path, index: int) -> str:
    path = out_dir / f"img_{index}.txt"
    assert path.exists(), f"missing sidecar {path.name} in {[p.name for p in out_dir.iterdir()]}"
    return path.read_text(encoding="utf-8")


def test_batch_export_per_image_types(test_client, tagged_images, tmp_path: Path):
    ids = tagged_images

    # Baseline export without any type maps — the pre-feature output.
    base_dir = tmp_path / "base"
    base_dir.mkdir()
    _export_batch(test_client, ids, base_dir)
    base = _sidecar_text(base_dir, 0)
    assert NL_SENTENCE not in base, "baseline must not contain the NL sentence"
    assert "1girl" in base

    out_dir = tmp_path / "typed"
    out_dir.mkdir()
    _export_batch(
        test_client, ids, out_dir,
        image_types={
            str(ids[0]): "both",
            str(ids[1]): "nl",
            str(ids[3]): "both",   # has NO stored NL caption
        },
        image_nl_overrides={
            str(ids[2]): EDITED_SENTENCE,  # no type entry -> override ignored
            str(ids[3]): EDITED_SENTENCE,  # override supplies the missing NL
        },
    )

    # both = baseline tags, then the sentence (comma-joined).
    assert _sidecar_text(out_dir, 0) == f"{base}, {NL_SENTENCE}"
    # nl = sentence only.
    assert _sidecar_text(out_dir, 1) == NL_SENTENCE
    # no type entry = byte-identical to baseline even with an NL override.
    assert _sidecar_text(out_dir, 2) == base
    # both + NL override on an image without a stored sentence.
    assert _sidecar_text(out_dir, 3) == f"{base}, {EDITED_SENTENCE}"
    # untouched image = baseline.
    assert _sidecar_text(out_dir, 4) == base


def test_batch_export_empty_nl_override_suppresses_stored_sentence(test_client, tagged_images, tmp_path: Path):
    ids = tagged_images
    out_dir = tmp_path / "suppressed"
    out_dir.mkdir()
    _export_batch(
        test_client, [ids[0]], out_dir,
        image_types={str(ids[0]): "both"},
        image_nl_overrides={str(ids[0]): ""},
    )
    content = _sidecar_text(out_dir, 0)
    assert NL_SENTENCE not in content
    assert "1girl" in content


def test_batch_export_booru_override_composes_with_nl(test_client, tagged_images, tmp_path: Path):
    ids = tagged_images
    out_dir = tmp_path / "override"
    out_dir.mkdir()
    _export_batch(
        test_client, [ids[0]], out_dir,
        image_overrides={str(ids[0]): "manual booru text"},
        image_types={str(ids[0]): "both"},
    )
    assert _sidecar_text(out_dir, 0) == f"manual booru text, {NL_SENTENCE}"


def test_batch_export_nl_mode_gate_skips_compose(test_client, tagged_images, tmp_path: Path):
    """NL-aware global modes already emit the sentence — types must not double it."""
    ids = tagged_images
    plain_dir = tmp_path / "nlmode-plain"
    typed_dir = tmp_path / "nlmode-typed"
    plain_dir.mkdir()
    typed_dir.mkdir()
    _export_batch(test_client, [ids[0]], plain_dir, content_mode="nl_caption")
    _export_batch(
        test_client, [ids[0]], typed_dir,
        content_mode="nl_caption",
        image_types={str(ids[0]): "both"},
    )
    assert _sidecar_text(typed_dir, 0) == _sidecar_text(plain_dir, 0)
    assert _sidecar_text(typed_dir, 0).count(NL_SENTENCE) == 1


def test_batch_export_transforms_apply_after_compose(test_client, tagged_images, tmp_path: Path):
    """Order contract: override/render -> compose -> caption_transforms."""
    ids = tagged_images
    out_dir = tmp_path / "transforms"
    out_dir.mkdir()
    _export_batch(
        test_client, [ids[0]], out_dir,
        image_types={str(ids[0]): "both"},
        caption_transforms={"remove": ["long_hair"]},
    )
    content = _sidecar_text(out_dir, 0)
    assert "long_hair" not in content
    assert "1girl" in content
    assert content.endswith(NL_SENTENCE)


def test_combined_export_honors_image_types(test_client, tagged_images):
    ids = tagged_images
    resp = test_client.post("/api/tags/export-combined", json={
        "image_ids": [ids[0]],
        "output_folder": "",
        "output_mode": "folder",
        "content_mode": "tags",
        "normalize_tag_underscores": False,
        "image_types": {str(ids[0]): "nl"},
    })
    assert resp.status_code == 200, resp.text
    body = resp.json()
    download = test_client.get(body["download_url"])
    assert download.status_code == 200
    assert download.text.strip() == NL_SENTENCE


def test_export_preview_returns_nl_fields_for_editor(test_client, tagged_images):
    """The caption editor's NL box is fed by these two response fields."""
    ids = tagged_images
    resp = test_client.post("/api/tags/export-preview", json={"image_ids": [ids[0], ids[4]]})
    assert resp.status_code == 200, resp.text
    results = {item["image_id"]: item for item in resp.json()["results"]}
    assert results[ids[0]]["nl_caption"] == NL_SENTENCE
    assert results[ids[0]]["ai_caption"] == f"fused: {NL_SENTENCE}"
    assert results[ids[4]]["nl_caption"] == ""
