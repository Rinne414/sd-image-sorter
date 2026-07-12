"""kohya trainer handoff: dataset_config.toml generation at export.

Shape evidence: kohya-ss/sd-scripts docs/masked_loss_README.md (subset with
image_dir / caption_extension / num_repeats / conditioning_data_dir) and
docs/config_README-en.md (folder-name repeats are ignored by the config
method — num_repeats must be explicit).
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent.parent))

import database as db
from services import mask_service


@pytest.fixture
def masks_dir(tmp_path, monkeypatch):
    target = tmp_path / "masks"
    monkeypatch.setattr(mask_service, "MASKS_DIR", target)
    return target


def _stage(tmp_path, count=2):
    src = tmp_path / "kh-src"
    src.mkdir()
    ids = []
    for index in range(1, count + 1):
        path = src / f"kh_{index:03d}.png"
        Image.new("RGB", (32, 32), color=(30 * index, 60, 90)).save(path)
        image_id = db.add_image(path=str(path), filename=path.name)
        db.add_tags(image_id, [{"tag": "1girl", "confidence": 0.9}])
        ids.append(image_id)
    return ids


def test_kohya_toml_written_with_explicit_repeats_and_trigger(test_client, test_db, tmp_path):
    ids = _stage(tmp_path)
    out = tmp_path / "out-toml"
    out.mkdir()
    response = test_client.post("/api/dataset/export", json={
        "image_ids": ids,
        "output_folder": str(out),
        "naming_pattern": "{filename}",
        "trigger": "mychar",
        "trainer_config": "kohya_toml",
        "trainer_repeats": 7,
        "trainer_batch": 4,
    })
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["trainer_config_path"], body
    toml_path = Path(body["trainer_config_path"])
    assert toml_path.name == "dataset_config.toml" and toml_path.exists()
    content = toml_path.read_text(encoding="utf-8")
    assert "num_repeats = 7" in content
    assert "batch_size = 4" in content
    assert 'caption_extension = ".txt"' in content
    assert 'class_tokens = "mychar"' in content
    assert "\\" not in content, "paths must be forward-slashed for TOML basic strings"
    assert "conditioning_data_dir" not in content, "no masks were exported"


def test_kohya_toml_points_conditioning_dir_at_exported_masks(
    test_client, test_db, tmp_path, masks_dir
):
    import base64
    import io as _io

    ids = _stage(tmp_path)
    buffer = _io.BytesIO()
    Image.new("L", (32, 32), color=255).save(buffer, format="PNG")
    data_url = "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")
    for image_id in ids:
        assert test_client.put(f"/api/masks/{image_id}", json={"data_url": data_url}).status_code == 200

    out = tmp_path / "out-toml-mask"
    out.mkdir()
    response = test_client.post("/api/dataset/export", json={
        "image_ids": ids,
        "output_folder": str(out),
        "naming_pattern": "{filename}",
        "mask_export": "kohya",
        "trainer_config": "kohya_toml",
    })
    body = response.json()
    assert body["masks_written"] == 2
    content = Path(body["trainer_config_path"]).read_text(encoding="utf-8")
    assert "conditioning_data_dir" in content
    assert content.count("/mask\"") == 1


def test_default_export_writes_no_toml(test_client, test_db, tmp_path):
    ids = _stage(tmp_path)
    out = tmp_path / "out-plain"
    out.mkdir()
    response = test_client.post("/api/dataset/export", json={
        "image_ids": ids,
        "output_folder": str(out),
        "naming_pattern": "{filename}",
    })
    body = response.json()
    assert body["trainer_config_path"] is None
    assert not (out / "dataset_config.toml").exists()


def test_invalid_trainer_config_400(test_client, test_db, tmp_path):
    ids = _stage(tmp_path)
    response = test_client.post("/api/dataset/export", json={
        "image_ids": ids,
        "output_folder": str(tmp_path / "x"),
        "trainer_config": "onetrainer_toml",
    })
    assert response.status_code == 400
