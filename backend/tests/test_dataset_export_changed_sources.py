"""What a dataset export of a named project does with sources that changed
or cannot be read.

A Library image whose file changed after its caption was edited: the caption
subject binds the old file identity, so the backend no longer lists the
edited caption, an export that still names the old revision is refused as a
whole, and a template export of the new file is accepted. Pinned so the V4
export step's handling stays honest.

An image the check leaves out (unreadable and skipped on request, or an
output that already exists under the "skip" rule) still matches its caption
selection: it must not turn into a "selection matches no exported item"
blocker, or skipping could never work for a project export.
"""

from __future__ import annotations

import importlib
import json
import os
from pathlib import Path

import pytest
from PIL import Image

from services.dataset_export.annotations import AnnotationSelectionResolutionError
from services.dataset_export.models import DatasetReadinessRequest
from services.dataset_export.readiness import run_dataset_readiness


DEFAULT_SETTINGS_JSON_V1 = importlib.import_module(
    "migrations.033_dataset_project_settings"
).DEFAULT_SETTINGS_JSON_V1


def _readiness(payload: dict[str, object]):
    return run_dataset_readiness(
        DatasetReadinessRequest.model_validate(payload),
        readiness_report_id="changed-source",
        progress_callback=lambda _processed, _total, _message: None,
        cancellation_requested=lambda: False,
    )


def test_changed_library_file_drops_its_edited_caption_from_the_project(
    test_client, test_db, tmp_path: Path
) -> None:
    source = tmp_path / "library.png"
    Image.new("RGB", (16, 16), color=(10, 20, 30)).save(source)
    image_id = int(test_db.add_image(path=str(source), filename=source.name))
    test_db.add_tags(image_id, [{"tag": "1girl", "confidence": 0.9}])
    project = test_client.post(
        "/api/dataset/projects",
        json={
            "name": "Changed library file",
            "items": [{"item_type": "library", "image_id": image_id}],
            "settings": json.loads(DEFAULT_SETTINGS_JSON_V1),
        },
    )
    assert project.status_code == 201, project.text
    project_id = int(project.json()["id"])
    content = {
        "content_version": 1,
        "booru_caption": "edited by hand",
        "nl_caption": "",
        "caption_type": "booru",
    }
    revision_id = int(
        test_db.create_project_library_training_caption_revision(
            project_id, 1, image_id, 0, content, "manual", "user", None, None
        )["revision"]["id"]
    )
    heads_url = f"/api/annotations/projects/{project_id}/training-captions/heads?expected_project_revision=1&limit=200"
    assert len(test_client.get(heads_url).json()["items"]) == 1

    # The file is replaced on disk (a re-save in an editor); a rescan would keep the same row.
    stat = source.stat()
    Image.new("RGB", (24, 16), color=(200, 20, 30)).save(source)
    os.utime(source, ns=(stat.st_atime_ns, stat.st_mtime_ns + 5_000_000_000))

    # 1. The project no longer lists the edited caption for this image.
    assert test_client.get(heads_url).json()["items"] == []

    base = {
        "image_ids": [image_id],
        "output_folder": str(tmp_path / "out"),
        "trigger": "hero",
        "content_mode": "template",
        "dataset_project_id": project_id,
        "dataset_project_revision": 1,
    }
    # 2. An export that still names the old revision is refused as a whole.
    with pytest.raises(AnnotationSelectionResolutionError, match=f"key='{image_id}'"):
        _readiness(
            base
            | {
                "annotation_selections": {
                    str(image_id): {"kind": "revision_ref", "revision_id": revision_id}
                }
            }
        )

    # 3. The template path accepts the new file: the hand edit is not in the export.
    report = _readiness(
        base | {"annotation_selections": {str(image_id): {"kind": "dynamic_source"}}}
    )
    assert report.summary.blocker_count == 0
    assert report.summary.trainable_pairs == 1


def _project(test_client, image_ids: list[int]) -> int:
    response = test_client.post(
        "/api/dataset/projects",
        json={
            "name": f"Skip in project {image_ids[0]}",
            "items": [{"item_type": "library", "image_id": image_id} for image_id in image_ids],
            "settings": json.loads(DEFAULT_SETTINGS_JSON_V1),
        },
    )
    assert response.status_code == 201, response.text
    return int(response.json()["id"])


def _two_images(test_db, tmp_path: Path) -> list[int]:
    ids = []
    for name in ("keep.png", "broken.png"):
        source = tmp_path / name
        Image.new("RGB", (16, 16), color=(30, 60, 90)).save(source)
        image_id = int(test_db.add_image(path=str(source), filename=name))
        test_db.add_tags(image_id, [{"tag": "1girl", "confidence": 0.9}])
        ids.append(image_id)
    return ids


def _project_request(project_id: int, ids: list[int], output: Path, **extra: object) -> dict[str, object]:
    return {
        "image_ids": ids,
        "output_folder": str(output),
        "trigger": "hero",
        "content_mode": "template",
        "dataset_project_id": project_id,
        "dataset_project_revision": 1,
        "annotation_selections": {str(i): {"kind": "dynamic_source"} for i in ids},
        **extra,
    }


def test_an_unreadable_original_can_be_skipped_in_a_project_export(test_client, test_db, tmp_path: Path) -> None:
    ids = _two_images(test_db, tmp_path)
    project_id = _project(test_client, ids)
    (tmp_path / "broken.png").write_bytes(b"not a picture" * 20)

    blocked = _readiness(_project_request(project_id, ids, tmp_path / "out"))
    assert {issue.code for issue in blocked.issues if issue.severity == "blocker"} == {"source_unreadable"}

    skipped = _readiness(_project_request(project_id, ids, tmp_path / "out", skip_blocked_items=True))
    assert skipped.summary.blocker_count == 0
    assert skipped.summary.skippable_items == 1
    assert skipped.summary.trainable_pairs == 1


def test_the_skip_rule_leaves_existing_outputs_in_a_project_export(test_client, test_db, tmp_path: Path) -> None:
    ids = _two_images(test_db, tmp_path)
    project_id = _project(test_client, ids)
    out = tmp_path / "out"
    out.mkdir()
    (out / "keep.png").write_bytes(b"already exported")

    report = _readiness(_project_request(project_id, ids, out, overwrite_policy="skip"))

    assert report.summary.blocker_count == 0
    assert "existing_output_skipped" in {issue.code for issue in report.issues}
