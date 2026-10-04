"""kohya folder layout: ``<output>/<repeats>_<concept>/`` for Dataset Maker exports.

The Dataset Maker promises "a training set kohya can read directly", but the
export wrote every pair flat into the output folder. kohya-ss sd-scripts (the
DreamBooth-style ``--train_data_dir`` method) reads one subfolder per concept
and takes the repeat count from its ``<repeats>_<name>`` prefix. With
``folder_layout="kohya"`` the export, its readiness check, its preview, the
re-export folder status, the result's ``output_folder`` and the manifest all
use that subfolder; ``"flat"`` keeps the old layout.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from PIL import Image
from pydantic import ValidationError

pytestmark = pytest.mark.usefixtures("authorize_legacy_dataset_exports")


@pytest.fixture
def two_images(test_db, tmp_path: Path):
    import database as db

    src = tmp_path / "src"
    src.mkdir()
    ids = []
    for name in ("a.png", "b.png"):
        path = src / name
        Image.new("RGB", (16, 16), color=(9, 8, 7)).save(path)
        image_id = db.add_image(path=str(path), filename=name)
        db.add_tags(image_id, [{"tag": "1girl", "confidence": 0.9}])
        ids.append(image_id)
    return ids


def _payload(ids, out: Path, **extra) -> dict:
    return {
        "image_ids": ids,
        "output_folder": str(out),
        "naming_pattern": "{index:03d}",
        "trigger": "mylora_walk",
        "image_op": "copy",
        "overwrite_policy": "unique",
        "content_mode": "tags",
        "trainer_repeats": 10,
        **extra,
    }


def test_kohya_layout_writes_pairs_into_the_repeats_concept_subfolder(
    test_client, two_images, tmp_path: Path
):
    out = tmp_path / "out"
    response = test_client.post(
        "/api/dataset/export",
        json=_payload(
            two_images, out, folder_layout="kohya", kohya_concept="mylora_walk"
        ),
    )
    assert response.status_code == 200, response.text
    body = response.json()
    concept = out / "10_mylora_walk"

    assert Path(body["output_folder"]) == concept
    assert sorted(p.name for p in concept.iterdir() if p.suffix != ".json") == [
        "001.png",
        "001.txt",
        "002.png",
        "002.txt",
    ]
    assert [p.name for p in out.iterdir()] == ["10_mylora_walk"]
    for item in body["items"]:
        assert Path(item["dst_image_path"]).parent == concept
        assert Path(item["dst_caption_path"]).parent == concept

    manifest = json.loads((concept / "export_manifest.json").read_text("utf-8"))
    assert manifest["output_folder"] == str(concept)
    assert manifest["settings"]["folder_layout"] == {
        "layout": "kohya",
        "output_root": str(out),
        "subfolder": "10_mylora_walk",
        "repeats": 10,
    }


def test_flat_layout_is_unchanged_and_recorded(test_client, two_images, tmp_path: Path):
    out = tmp_path / "flat"
    response = test_client.post(
        "/api/dataset/export", json=_payload(two_images, out, folder_layout="flat")
    )
    assert response.status_code == 200, response.text
    assert Path(response.json()["output_folder"]) == out
    assert (out / "001.png").is_file()
    manifest = json.loads((out / "export_manifest.json").read_text("utf-8"))
    assert manifest["settings"]["folder_layout"] == {
        "layout": "flat",
        "output_root": str(out),
        "subfolder": "",
        "repeats": 10,
    }


def test_empty_concept_falls_back_to_dataset(test_client, two_images, tmp_path: Path):
    out = tmp_path / "fallback"
    response = test_client.post(
        "/api/dataset/export",
        json=_payload(
            two_images, out, folder_layout="kohya", kohya_concept="", trainer_repeats=3
        ),
    )
    assert response.status_code == 200, response.text
    assert Path(response.json()["output_folder"]) == out / "3_dataset"
    assert (out / "3_dataset" / "001.png").is_file()


@pytest.mark.parametrize(
    "concept",
    [
        "../escape",
        "a/b",
        "a\\b",
        "my lora",
        "name.",
        ".hidden",
        "bad:name",
        "q?",
        "x\x01",
    ],
)
def test_unsafe_concept_names_are_rejected(concept):
    from services.dataset_export.models import DatasetExportRequest

    with pytest.raises(ValidationError):
        DatasetExportRequest(
            image_ids=[1],
            output_folder="C:/out",
            folder_layout="kohya",
            kohya_concept=concept,
        )


def test_preview_and_reexport_status_use_the_subfolder(
    test_client, two_images, tmp_path: Path
):
    out = tmp_path / "again"
    payload = _payload(two_images, out, folder_layout="kohya", kohya_concept="walk")
    first = test_client.post("/api/dataset/export", json=payload)
    assert first.status_code == 200, first.text

    preview = test_client.post(
        "/api/dataset/export-preview", json={**payload, "limit": 10}
    )
    assert preview.status_code == 200, preview.text
    first_item = preview.json()["items"][0]
    # The second export into the same concept folder collides with the first.
    assert first_item["output_image_name"] == "001_2.png"
    assert Path(first_item["output_image_path"]).parent == out / "10_walk"

    status = test_client.post(
        "/api/dataset/output-folder-status",
        json={"output_folder": str(out / "10_walk")},
    )
    assert status.status_code == 200, status.text
    assert status.json()["image_count"] == 2
    assert status.json()["has_export_manifest"] is True


def test_kohya_trainer_config_points_at_the_concept_subfolder(
    test_client, two_images, tmp_path: Path
):
    out = tmp_path / "pkg"
    response = test_client.post(
        "/api/dataset/export",
        json=_payload(
            two_images,
            out,
            folder_layout="kohya",
            kohya_concept="mylora_walk",
            trainer_config="kohya_toml",
            trainer_repeats=7,
            naming_pattern="{filename}",
        ),
    )
    assert response.status_code == 200, response.text
    body = response.json()
    concept = out / "7_mylora_walk"
    assert Path(body["output_folder"]) == concept
    toml = Path(body["trainer_config_path"])
    assert toml.parent == concept
    content = toml.read_text("utf-8")
    assert f'image_dir = "{concept.as_posix()}"' in content
    assert "num_repeats = 7" in content
    manifest = json.loads((concept / "export_manifest.json").read_text("utf-8"))
    assert manifest["options"]["folder_layout"] == "kohya"
