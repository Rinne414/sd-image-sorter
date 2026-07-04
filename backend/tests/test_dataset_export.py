"""End-to-end tests for /api/dataset/export.

Exercises the full path: a few images on disk -> add to DB -> tag them
-> POST /api/dataset/export -> verify image+caption pairs land in the
output folder with matching stems."""
from __future__ import annotations

import os
import threading
import time
from pathlib import Path
import pytest
from PIL import Image


@pytest.fixture
def staged_images(test_db, tmp_path: Path):
    """Build 3 images on disk, add to the DB, tag them, return image_ids
    + their on-disk filenames."""
    import database as db

    src = tmp_path / "src"
    src.mkdir()
    info = []
    filenames = ["my (lora char).png", "subject_002.png", "subject_003.png"]
    for name in filenames:
        path = src / name
        Image.new("RGB", (32, 32), color=(50, 100, 150)).save(path)
        image_id = db.add_image(path=str(path), filename=name)
        db.add_tags(image_id, [
            {"tag": "1girl", "confidence": 0.9},
            {"tag": "long_hair", "confidence": 0.85},
            {"tag": "looking_at_viewer", "confidence": 0.82},
        ])
        info.append((image_id, name, path))
    return info


def _wait_dataset_export_job(test_client, job_id: str, timeout: float = 5.0):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        response = test_client.get(f"/api/dataset/export/progress?job_id={job_id}")
        assert response.status_code == 200, response.text
        last = response.json()
        if last["status"] in {"done", "failed", "cancelled"}:
            return last
        time.sleep(0.05)
    pytest.fail(f"dataset export job did not finish in time; last progress={last}")


def test_export_default_pattern_keeps_filenames(test_client, staged_images, tmp_path: Path):
    """``{filename}`` (the default) should keep image filenames intact —
    even ones with parens / apostrophes."""
    out = tmp_path / "out"
    out.mkdir()
    image_ids = [i[0] for i in staged_images]

    response = test_client.post("/api/dataset/export", json={
        "image_ids": image_ids,
        "output_folder": str(out),
        "naming_pattern": "{filename}",
        "trigger": "",
        "image_op": "copy",
        "overwrite_policy": "unique",
    })
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "ok", body
    assert body["exported"] == 3

    # Every image+caption pair must exist with matching stems
    for image_id, original_name, _ in staged_images:
        stem = os.path.splitext(original_name)[0]
        ext = os.path.splitext(original_name)[1]
        img_path = out / f"{stem}{ext}"
        cap_path = out / f"{stem}.txt"
        assert img_path.exists(), f"image missing: {img_path}"
        assert cap_path.exists(), f"caption missing: {cap_path}"

    # The (lora char) image should preserve parens
    assert (out / "my (lora char).png").exists()
    assert (out / "my (lora char).txt").exists()


def test_gallery_beside_image_mode_writes_txt_next_to_original_without_copying(
    test_client, staged_images
):
    """Gallery-sourced DB rows should support the same-name .txt beside
    original mode. The image stays in place and only the sidecar is written.
    """
    image_id, original_name, image_path = staged_images[0]
    sidecar_path = image_path.with_suffix(".txt")

    response = test_client.post("/api/dataset/export", json={
        "image_ids": [image_id],
        "output_mode": "beside_image",
        "output_folder": "",
        "naming_pattern": "ignored_{index:03d}",
        "trigger": "gallery_trigger",
        "image_op": "copy",
        "overwrite_policy": "overwrite",
        "image_overrides": {str(image_id): "gallery sidecar caption"},
        "normalize_tag_underscores": False,
    })

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "ok", body
    assert body["exported"] == 1
    assert body["output_mode"] == "beside_image"
    assert image_path.exists()
    assert sidecar_path.read_text(encoding="utf-8") == "gallery sidecar caption"
    assert not (image_path.parent / f"ignored_001{image_path.suffix}").exists()
    assert body["items"][0]["dst_image_path"] is None
    assert body["items"][0]["dst_caption_path"] == str(sidecar_path)


def test_background_export_reports_progress_and_result(test_client, staged_images, tmp_path: Path):
    out = tmp_path / "background-out"
    out.mkdir()
    image_ids = [i[0] for i in staged_images]

    response = test_client.post("/api/dataset/export/start", json={
        "image_ids": image_ids,
        "output_folder": str(out),
        "naming_pattern": "bg_{index:03d}",
        "image_op": "copy",
        "overwrite_policy": "unique",
    })
    assert response.status_code == 200, response.text
    started = response.json()
    assert started["status"] == "started"
    assert started["total"] == 3
    assert started["job_id"]

    progress = _wait_dataset_export_job(test_client, started["job_id"])
    assert progress["status"] == "done"
    assert progress["current"] == 3
    assert progress["total"] == 3
    assert progress["exported"] == 3
    assert progress["result"]["status"] == "ok"
    assert progress["result"]["items_truncated"] is False
    assert (out / "bg_001.png").exists()
    assert (out / "bg_001.txt").exists()


def test_background_export_can_be_cancelled(test_client, staged_images, tmp_path: Path, monkeypatch):
    import services.dataset_export_service as export_service

    out = tmp_path / "cancel-out"
    out.mkdir()
    image_ids = [i[0] for i in staged_images]

    original_copy2 = export_service.shutil.copy2
    first_copy_started = threading.Event()
    release_copy = threading.Event()

    def slow_copy2(src, dst, *args, **kwargs):
        first_copy_started.set()
        release_copy.wait(timeout=2.0)
        return original_copy2(src, dst, *args, **kwargs)

    monkeypatch.setattr(export_service.shutil, "copy2", slow_copy2)

    response = test_client.post("/api/dataset/export/start", json={
        "image_ids": image_ids,
        "output_folder": str(out),
        "naming_pattern": "cancel_{index:03d}",
        "image_op": "copy",
        "overwrite_policy": "unique",
    })
    assert response.status_code == 200, response.text
    job_id = response.json()["job_id"]
    assert first_copy_started.wait(timeout=2.0), "worker never reached first copy"

    second_start = test_client.post("/api/dataset/export/start", json={
        "image_ids": image_ids,
        "output_folder": str(out),
        "naming_pattern": "second_{index:03d}",
        "image_op": "copy",
        "overwrite_policy": "unique",
    })
    assert second_start.status_code == 409, second_start.text

    cancel_response = test_client.post("/api/dataset/export/cancel", json={"job_id": job_id})
    assert cancel_response.status_code == 200, cancel_response.text
    assert cancel_response.json()["status"] == "cancelling"
    release_copy.set()

    progress = _wait_dataset_export_job(test_client, job_id)
    assert progress["status"] == "cancelled"
    result = progress["result"]
    assert result["status"] == "cancelled"
    assert 0 < result["exported"] < len(image_ids)


def test_export_renumber_with_padded_index(test_client, staged_images, tmp_path: Path):
    """``train_{index:03d}`` should produce ``train_001.png``,
    ``train_001.txt``, ``train_002.png``, ..."""
    out = tmp_path / "out"
    out.mkdir()
    image_ids = [i[0] for i in staged_images]

    response = test_client.post("/api/dataset/export", json={
        "image_ids": image_ids,
        "output_folder": str(out),
        "naming_pattern": "train_{index:03d}",
        "trigger": "",
        "image_op": "copy",
        "overwrite_policy": "unique",
    })
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "ok"
    assert body["exported"] == 3

    # Folder-mode export also drops an export_manifest.json run record; this
    # test asserts the renamed image/caption pairs, so exclude the manifest.
    actual = sorted(p.name for p in out.iterdir() if p.name != "export_manifest.json")
    expected = sorted([
        "train_001.png", "train_001.txt",
        "train_002.png", "train_002.txt",
        "train_003.png", "train_003.txt",
    ])
    assert actual == expected


def test_export_caption_content_uses_template_engine(test_client, staged_images, tmp_path: Path):
    """The .txt content must come through the same template engine the
    UI's preview uses, honoring trigger / common_tags / underscore."""
    out = tmp_path / "out"
    out.mkdir()
    image_ids = [staged_images[0][0]]

    response = test_client.post("/api/dataset/export", json={
        "image_ids": image_ids,
        "output_folder": str(out),
        "naming_pattern": "test",  # static stem
        "trigger": "MY_TRIGGER",
        "image_op": "copy",
        "overwrite_policy": "unique",
        "common_tags": ["masterpiece", "best_quality"],
        "normalize_tag_underscores": True,
    })
    assert response.status_code == 200, response.text

    cap_path = out / "test.txt"
    assert cap_path.exists()
    content = cap_path.read_text(encoding="utf-8")
    # Trigger must appear
    assert "MY_TRIGGER" in content
    # Tags must be space-separated (long hair, not long_hair) when normalize is True
    assert "long hair" in content
    # Common tags appended (also normalized)
    assert "masterpiece" in content
    assert "best quality" in content


def test_export_trigger_index_pattern(test_client, staged_images, tmp_path: Path):
    """``{trigger}_{index:03d}`` is the most common LoRA renaming pattern."""
    out = tmp_path / "out"
    out.mkdir()
    image_ids = [i[0] for i in staged_images]

    response = test_client.post("/api/dataset/export", json={
        "image_ids": image_ids,
        "output_folder": str(out),
        "naming_pattern": "{trigger}_{index:03d}",
        "trigger": "my_subject",
        "image_op": "copy",
        "overwrite_policy": "unique",
    })
    assert response.status_code == 200, response.text
    assert response.json()["exported"] == 3
    assert (out / "my_subject_001.png").exists()
    assert (out / "my_subject_001.txt").exists()
    assert (out / "my_subject_002.png").exists()
    assert (out / "my_subject_003.png").exists()


def test_export_move_removes_source(test_client, staged_images, tmp_path: Path):
    """``image_op=move`` should remove the source image from disk and
    update the DB path so the gallery doesn't see it as missing."""
    import database as db
    out = tmp_path / "out"
    out.mkdir()
    image_id, original_name, src_path = staged_images[0]
    assert src_path.exists()

    response = test_client.post("/api/dataset/export", json={
        "image_ids": [image_id],
        "output_folder": str(out),
        "naming_pattern": "moved",
        "image_op": "move",
        "overwrite_policy": "unique",
    })
    assert response.status_code == 200, response.text
    assert response.json()["exported"] == 1

    assert not src_path.exists(), "source image should be gone after move"
    assert (out / "moved.png").exists()
    assert (out / "moved.txt").exists()

    # DB is updated to point at the new location
    image_now = db.get_image_by_id(image_id)
    assert str(image_now["path"]).endswith("moved.png"), image_now


def test_export_overwrite_policy_skip(test_client, staged_images, tmp_path: Path):
    """When the output already exists and policy is 'skip', the row is
    counted as skipped and the existing file is not touched."""
    out = tmp_path / "out"
    out.mkdir()
    # Pre-create one of the targets
    existing = out / "train_001.png"
    existing.write_bytes(b"DO NOT OVERWRITE")
    image_ids = [staged_images[0][0]]

    response = test_client.post("/api/dataset/export", json={
        "image_ids": image_ids,
        "output_folder": str(out),
        "naming_pattern": "train_{index:03d}",
        "image_op": "copy",
        "overwrite_policy": "skip",
    })
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["exported"] == 0
    assert body["skipped"] == 1
    assert existing.read_bytes() == b"DO NOT OVERWRITE", "existing file was overwritten"


def test_export_image_overrides(test_client, staged_images, tmp_path: Path):
    """User-edited captions in the Dataset Maker should win over the
    template-rendered caption."""
    out = tmp_path / "out"
    out.mkdir()
    image_id = staged_images[0][0]

    response = test_client.post("/api/dataset/export", json={
        "image_ids": [image_id],
        "output_folder": str(out),
        "naming_pattern": "test",
        "image_op": "copy",
        "overwrite_policy": "unique",
        "image_overrides": {str(image_id): "USER_EDITED_CAPTION_FOR_THIS_IMAGE"},
    })
    assert response.status_code == 200, response.text
    cap = (out / "test.txt").read_text(encoding="utf-8")
    assert cap == "USER_EDITED_CAPTION_FOR_THIS_IMAGE"


def test_export_content_mode_tags_writes_common_tags(test_client, staged_images, tmp_path: Path):
    out = tmp_path / "out"
    out.mkdir()
    image_id = staged_images[0][0]

    response = test_client.post("/api/dataset/export", json={
        "image_ids": [image_id],
        "output_folder": str(out),
        "naming_pattern": "tags_only",
        "image_op": "copy",
        "overwrite_policy": "unique",
        "content_mode": "tags",
        "common_tags": ["masterpiece"],
        "normalize_tag_underscores": True,
    })

    assert response.status_code == 200, response.text
    content = (out / "tags_only.txt").read_text(encoding="utf-8")
    assert "1girl" in content
    assert "long hair" in content
    assert "masterpiece" in content


def test_export_content_mode_json_uses_json_sidecar(test_client, staged_images, tmp_path: Path):
    out = tmp_path / "out"
    out.mkdir()
    image_id = staged_images[0][0]

    response = test_client.post("/api/dataset/export", json={
        "image_ids": [image_id],
        "output_folder": str(out),
        "naming_pattern": "json_pair",
        "image_op": "copy",
        "overwrite_policy": "unique",
        "content_mode": "json",
    })

    assert response.status_code == 200, response.text
    assert (out / "json_pair.png").exists()
    json_path = out / "json_pair.json"
    assert json_path.exists()
    assert '"tags"' in json_path.read_text(encoding="utf-8")
    assert not (out / "json_pair.txt").exists()


def test_export_template_options_override_legacy_template(test_client, staged_images, tmp_path: Path):
    out = tmp_path / "out"
    out.mkdir()
    image_id = staged_images[0][0]

    response = test_client.post("/api/dataset/export", json={
        "image_ids": [image_id],
        "output_folder": str(out),
        "naming_pattern": "templated",
        "image_op": "copy",
        "overwrite_policy": "unique",
        "content_mode": "template",
        "template_options": {
            "preset_id": "custom",
            "template_override": "{trigger}::{tags:filtered}",
            "trigger": "MYTRIGGER",
            "append": ["extra_tag"],
            "max_tags": 0,
            "replace_rules": {},
        },
    })

    assert response.status_code == 200, response.text
    content = (out / "templated.txt").read_text(encoding="utf-8")
    assert "MYTRIGGER" in content
    assert "extra tag" in content


def test_export_local_path_with_path_override(test_client, tmp_path: Path):
    src = tmp_path / "local.png"
    Image.new("RGB", (32, 32), color=(10, 20, 30)).save(src)
    out = tmp_path / "out"
    out.mkdir()

    response = test_client.post("/api/dataset/export", json={
        "image_paths": [str(src)],
        "output_folder": str(out),
        "naming_pattern": "local_item",
        "image_op": "copy",
        "overwrite_policy": "unique",
        "image_overrides": {str(src): "local caption text"},
    })

    assert response.status_code == 200, response.text
    assert (out / "local_item.png").exists()
    assert (out / "local_item.txt").read_text(encoding="utf-8") == "local caption text"


def test_export_preview_uses_dataset_renderer(test_client, staged_images, tmp_path: Path):
    out = tmp_path / "preview-out"
    out.mkdir()
    image_id = staged_images[0][0]

    response = test_client.post("/api/dataset/export-preview", json={
        "image_ids": [image_id],
        "output_folder": str(out),
        "naming_pattern": "preview_{index:03d}",
        "content_mode": "tags",
        "common_tags": ["best_quality"],
        "limit": 10,
    })

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["total"] == 1
    assert body["returned"] == 1
    item = body["items"][0]
    assert item["output_image_name"] == "preview_001.png"
    assert item["output_caption_name"] == "preview_001.txt"
    assert "best quality" in item["caption"]


def test_export_invalid_output_folder_returns_400(test_client, staged_images):
    response = test_client.post("/api/dataset/export", json={
        "image_ids": [staged_images[0][0]],
        "output_folder": "",  # empty -> Pydantic validation rejects
        "naming_pattern": "{filename}",
    })
    assert response.status_code in (400, 422), response.text


def test_export_invalid_image_op_returns_400(test_client, staged_images, tmp_path: Path):
    out = tmp_path / "out"
    out.mkdir()
    response = test_client.post("/api/dataset/export", json={
        "image_ids": [staged_images[0][0]],
        "output_folder": str(out),
        "image_op": "delete",  # not in {copy, move}
    })
    assert response.status_code == 400, response.text


def test_export_empty_image_ids_returns_400(test_client, tmp_path: Path):
    out = tmp_path / "out"
    out.mkdir()
    response = test_client.post("/api/dataset/export", json={
        "image_ids": [],
        "output_folder": str(out),
    })
    assert response.status_code in (400, 422), response.text


def test_export_missing_image_recorded_as_error(test_client, tmp_path: Path):
    """An image_id that doesn't exist in the DB should produce one error
    entry but not abort the whole export."""
    out = tmp_path / "out"
    out.mkdir()
    response = test_client.post("/api/dataset/export", json={
        "image_ids": [9_999_999],
        "output_folder": str(out),
        "naming_pattern": "{filename}",
    })
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "failed"
    assert body["exported"] == 0
    assert body["error_count"] >= 1
    assert any("not found in library" in m for m in body["error_messages"])


# ---------------------------------------------------------------------------
# Point 3: per-image natural-language caption type (two-box editor).
# image_types = booru | nl | both ; image_nl_overrides = edited NL-box text.
# Absent type entry => booru-only (the default, also the full back-compat path).
# ---------------------------------------------------------------------------

_NL_SENTENCE = "a lone figure stands in a quiet field at dawn"


@pytest.fixture
def captioned_image(test_db, tmp_path: Path):
    """One on-disk image with booru tags AND a stored nl_caption."""
    import database as db

    src = tmp_path / "capsrc"
    src.mkdir()
    path = src / "subject.png"
    Image.new("RGB", (32, 32), color=(10, 20, 30)).save(path)
    image_id = db.add_image(path=str(path), filename="subject.png")
    db.add_tags(image_id, [
        {"tag": "1girl", "confidence": 0.9},
        {"tag": "long_hair", "confidence": 0.85},
    ])
    db.update_image_caption(image_id, "", nl_caption=_NL_SENTENCE)
    return image_id, path


def _export_caption_beside(test_client, image_id, path, **extra):
    """Export one image in beside_image mode and return the written caption."""
    body = {
        "image_ids": [image_id],
        "output_mode": "beside_image",
        "output_folder": "",
        "naming_pattern": "ignored",
        "image_op": "copy",
        "overwrite_policy": "overwrite",
        **extra,
    }
    response = test_client.post("/api/dataset/export", json=body)
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "ok", response.json()
    return path.with_suffix(".txt").read_text(encoding="utf-8")


def test_per_image_type_both_appends_nl(test_client, captioned_image):
    image_id, path = captioned_image
    caption = _export_caption_beside(
        test_client, image_id, path, image_types={str(image_id): "both"}
    )
    assert "1girl" in caption  # booru part still present
    assert caption.strip().endswith(_NL_SENTENCE)  # sentence appended last
    assert caption.index("1girl") < caption.index(_NL_SENTENCE)  # tags first


def test_per_image_type_nl_only_replaces_tags(test_client, captioned_image):
    image_id, path = captioned_image
    caption = _export_caption_beside(
        test_client, image_id, path, image_types={str(image_id): "nl"}
    )
    assert caption.strip() == _NL_SENTENCE
    assert "1girl" not in caption


def test_per_image_type_booru_is_unchanged(test_client, captioned_image):
    image_id, path = captioned_image
    caption = _export_caption_beside(
        test_client, image_id, path, image_types={str(image_id): "booru"}
    )
    assert "1girl" in caption
    assert _NL_SENTENCE not in caption


def test_absent_type_is_back_compat_booru_only(test_client, captioned_image):
    """No image_types at all => exact pre-feature behavior (booru only)."""
    image_id, path = captioned_image
    caption = _export_caption_beside(test_client, image_id, path)
    assert "1girl" in caption
    assert _NL_SENTENCE not in caption


def test_per_image_nl_override_wins_over_stored(test_client, captioned_image):
    image_id, path = captioned_image
    edited = "an entirely different hand-edited sentence"
    caption = _export_caption_beside(
        test_client, image_id, path,
        image_types={str(image_id): "both"},
        image_nl_overrides={str(image_id): edited},
    )
    assert "1girl" in caption
    assert caption.strip().endswith(edited)
    assert _NL_SENTENCE not in caption  # stored nl_caption was overridden


def test_nl_compose_not_doubled_for_tags_nl_mode(test_client, captioned_image):
    """tags_nl already emits the sentence globally; per-image 'both' must not
    append it a second time."""
    image_id, path = captioned_image
    caption = _export_caption_beside(
        test_client, image_id, path,
        content_mode="tags_nl",
        image_types={str(image_id): "both"},
    )
    assert caption.count(_NL_SENTENCE) == 1


def test_preview_composes_per_image_nl(test_client, captioned_image):
    image_id, path = captioned_image
    response = test_client.post("/api/dataset/export-preview", json={
        "image_ids": [image_id],
        "output_mode": "beside_image",
        "image_types": {str(image_id): "both"},
    })
    assert response.status_code == 200, response.text
    items = response.json()["items"]
    assert len(items) == 1
    caption = items[0]["caption"]
    assert "1girl" in caption and _NL_SENTENCE in caption
    # The preview also surfaces the raw nl_caption separately for the NL box.
    assert items[0]["nl_caption"] == _NL_SENTENCE


def test_lora_caption_golden_matrix_across_tag_and_dataset_exports(test_client, test_db, tmp_path: Path):
    """Golden gate for the v3.3.3 tagging-pipeline merge.

    The Gallery tag export path and Dataset Maker export path must keep the
    same LoRA caption semantics while the two tagging entry points are unified:
    tag underscores normalize for trainer captions, score_* stays intact,
    tags_nl excludes original prompt text, and per-image NL composition never
    appends the sentence twice.
    """
    import database as db
    from services.smart_tag_service import assemble_caption

    src = tmp_path / "golden-src"
    src.mkdir()
    image_path = src / "golden_lora.png"
    Image.new("RGB", (32, 32), color=(40, 80, 120)).save(image_path)
    image_id = db.add_image(
        path=str(image_path),
        filename=image_path.name,
        prompt="newest, original prompt should not appear",
        metadata_json="{}",
    )
    db.add_tags(image_id, [
        {"tag": "blue_hair", "confidence": 0.95},
        {"tag": "looking_at_viewer", "confidence": 0.90},
        {"tag": "score_9_up", "confidence": 0.85},
        {"tag": "safe", "confidence": 0.80},
    ])
    db.update_image_caption(
        image_id,
        "golden_trigger, blue hair, a blue-haired girl smiling",
        nl_caption="a blue-haired girl smiling",
    )

    actual = {
        "smart_tag_caption": assemble_caption(
            rating="general",
            general_tags=["blue_hair", "looking_at_viewer", "score_9_up", "safe"],
            character_tags=["tomori_(bang_dream!)"],
            nl_text="a blue-haired girl smiling",
            trigger_word="tomori_lora",
            auto_strip_noise=True,
        ),
    }

    tag_tags_nl_out = tmp_path / "tag-tags-nl"
    tag_tags_nl_out.mkdir()
    response = test_client.post("/api/tags/export-batch", json={
        "image_ids": [image_id],
        "output_folder": str(tag_tags_nl_out),
        "content_mode": "tags_nl",
        "prefix": "tomori_lora",
        "blacklist": ["safe", "newest"],
    })
    assert response.status_code == 200, response.text
    actual["tags_api_tags_nl"] = (tag_tags_nl_out / "golden_lora.txt").read_text(encoding="utf-8")

    tag_caption_merged_out = tmp_path / "tag-caption-merged"
    tag_caption_merged_out.mkdir()
    response = test_client.post("/api/tags/export-batch", json={
        "image_ids": [image_id],
        "output_folder": str(tag_caption_merged_out),
        "content_mode": "caption_merged",
        "prefix": "tomori_lora",
        "blacklist": ["safe", "newest"],
    })
    assert response.status_code == 200, response.text
    actual["tags_api_caption_merged"] = (tag_caption_merged_out / "golden_lora.txt").read_text(encoding="utf-8")

    response = test_client.post("/api/dataset/export", json={
        "image_ids": [image_id],
        "output_mode": "beside_image",
        "output_folder": "",
        "naming_pattern": "ignored",
        "image_op": "copy",
        "overwrite_policy": "overwrite",
        "content_mode": "tags",
        "blacklist": ["safe"],
        "image_types": {str(image_id): "both"},
        "image_nl_overrides": {str(image_id): "manual edited NL"},
    })
    assert response.status_code == 200, response.text
    actual["dataset_tags_both"] = image_path.with_suffix(".txt").read_text(encoding="utf-8")

    response = test_client.post("/api/dataset/export", json={
        "image_ids": [image_id],
        "output_mode": "beside_image",
        "output_folder": "",
        "naming_pattern": "ignored",
        "image_op": "copy",
        "overwrite_policy": "overwrite",
        "content_mode": "tags_nl",
        "blacklist": ["safe"],
        "image_types": {str(image_id): "both"},
    })
    assert response.status_code == 200, response.text
    actual["dataset_tags_nl_no_double"] = image_path.with_suffix(".txt").read_text(encoding="utf-8")

    response = test_client.post("/api/dataset/export-preview", json={
        "image_ids": [image_id],
        "output_mode": "beside_image",
        "content_mode": "tags",
        "blacklist": ["safe"],
        "image_types": {str(image_id): "both"},
    })
    assert response.status_code == 200, response.text
    preview_item = response.json()["items"][0]
    actual["dataset_preview_both"] = preview_item["caption"]
    actual["dataset_preview_nl_caption"] = preview_item["nl_caption"]

    assert actual == {
        "smart_tag_caption": "tomori_lora, tomori (bang dream!), blue hair, looking at viewer, a blue-haired girl smiling",
        "tags_api_tags_nl": "tomori_lora, blue hair, looking at viewer, score_9_up, a blue-haired girl smiling",
        "tags_api_caption_merged": "tomori_lora, golden_trigger, blue hair, a blue-haired girl smiling, original prompt should not appear, looking at viewer, score_9_up",
        "dataset_tags_both": "blue hair, looking at viewer, score_9_up, manual edited NL",
        "dataset_tags_nl_no_double": "blue hair, looking at viewer, score_9_up, a blue-haired girl smiling",
        "dataset_preview_both": "blue hair, looking at viewer, score_9_up, a blue-haired girl smiling",
        "dataset_preview_nl_caption": "a blue-haired girl smiling",
    }
