"""Exporting a second time into a folder that already holds a dataset.

Walkthrough defect: export 25 pictures to ``out1`` (51 files with the
manifest), export again with "renumber" into the same folder, and the folder
silently holds both sets (101 files). The confirm said nothing about the folder
already containing a dataset, and the name previews disagreed with each other.

Not blocked (owner principle: warn and let the user choose). These tests pin
the two facts the confirm needs: what the folder already holds, and that the
preview names are exactly the names the export then writes.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from PIL import Image

pytestmark = pytest.mark.usefixtures("authorize_legacy_dataset_exports")


@pytest.fixture
def three_images(test_db, tmp_path: Path):
    import database as db

    src = tmp_path / "src"
    src.mkdir()
    ids = []
    for name in ("a.png", "b.png", "c.png"):
        path = src / name
        Image.new("RGB", (16, 16), color=(1, 2, 3)).save(path)
        image_id = db.add_image(path=str(path), filename=name)
        db.add_tags(image_id, [{"tag": "1girl", "confidence": 0.9}])
        ids.append(image_id)
    return ids


def _payload(ids, out: Path, policy: str = "unique") -> dict:
    return {
        "image_ids": ids,
        "output_folder": str(out),
        "naming_pattern": "{index:03d}",
        "trigger": "",
        "image_op": "copy",
        "overwrite_policy": policy,
        "content_mode": "tags",
    }


def test_output_folder_status_counts_what_the_folder_already_holds(
    test_client, three_images, tmp_path: Path
):
    out = tmp_path / "out1"

    empty = test_client.post(
        "/api/dataset/output-folder-status", json={"output_folder": str(out)}
    )
    assert empty.status_code == 200, empty.text
    assert empty.json() == {
        "exists": False,
        "file_count": 0,
        "image_count": 0,
        "caption_count": 0,
        "has_export_manifest": False,
    }

    first = test_client.post("/api/dataset/export", json=_payload(three_images, out))
    assert first.status_code == 200, first.text

    status = test_client.post(
        "/api/dataset/output-folder-status", json={"output_folder": str(out)}
    )
    assert status.status_code == 200, status.text
    assert status.json() == {
        "exists": True,
        "file_count": 7,
        "image_count": 3,
        "caption_count": 3,
        "has_export_manifest": True,
    }


@pytest.mark.parametrize("policy", ["unique", "overwrite"])
def test_preview_names_are_the_names_the_second_export_writes(
    test_client, three_images, tmp_path: Path, policy
):
    out = tmp_path / f"out-{policy}"
    first = test_client.post("/api/dataset/export", json=_payload(three_images, out))
    assert first.status_code == 200, first.text

    preview = test_client.post(
        "/api/dataset/export-preview",
        json={**_payload(three_images, out, policy), "limit": 10},
    )
    assert preview.status_code == 200, preview.text
    previewed = sorted(
        name
        for item in preview.json()["items"]
        for name in (item["output_image_name"], item["output_caption_name"])
        if name and not item.get("skipped_reason")
    )

    second = test_client.post(
        "/api/dataset/export", json=_payload(three_images, out, policy)
    )
    assert second.status_code == 200, second.text
    written = sorted(
        Path(path).name
        for item in second.json()["items"]
        for path in (item["dst_image_path"], item["dst_caption_path"])
        if path and not item.get("skipped_reason")
    )
    assert previewed == written
