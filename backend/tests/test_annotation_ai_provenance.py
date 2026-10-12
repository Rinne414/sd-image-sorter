"""A training-caption revision written from AI results says so (V4 tag step).

Without ``ai_provenance`` a revision stays what V3.5 always wrote: a user's
manual edit. With it, the revision records the AI source (wd14 or vlm) and
author "ai", so a later AI run can tell its own output from a user's edit.
"""

from __future__ import annotations

import importlib
import json
from pathlib import Path

from services.dataset_session.allowlist import _register_session_paths

DEFAULT_SETTINGS = json.loads(
    importlib.import_module(
        "migrations.033_dataset_project_settings"
    ).DEFAULT_SETTINGS_JSON_V1
)


def _project(test_client, test_db, tmp_path: Path) -> tuple[int, int, Path]:
    image_path = tmp_path / "library.png"
    image_path.write_bytes(b"library-fixture")
    image_id = int(test_db.add_image(path=str(image_path), filename=image_path.name))
    local = tmp_path / "folder" / "local.png"
    local.parent.mkdir()
    local.write_bytes(b"folder-fixture")
    _register_session_paths([str(local)])
    response = test_client.post(
        "/api/dataset/projects",
        json={
            "name": "AI provenance",
            "items": [
                {"item_type": "library", "image_id": image_id},
                {"item_type": "local", "path": str(local)},
            ],
            "settings": DEFAULT_SETTINGS,
        },
    )
    assert response.status_code == 201, response.text
    return int(response.json()["id"]), image_id, local


def _content(booru: str, nl: str = "") -> dict[str, object]:
    return {
        "content_version": 1,
        "booru_caption": booru,
        "nl_caption": nl,
        "caption_type": "both" if nl else "booru",
    }


def _revise(test_client, project_id: int, subject: dict, generation: int, **extra):
    return test_client.post(
        f"/api/annotations/projects/{project_id}/training-captions/revisions",
        json={
            "expected_project_revision": 1,
            "expected_head_generation": generation,
            "subject": subject,
            "content": _content("1girl, smile"),
            **extra,
        },
    )


def test_ai_results_are_recorded_as_ai_revisions(test_client, test_db, tmp_path):
    project_id, _image_id, local = _project(test_client, test_db, tmp_path)
    subject = {"item_type": "local", "path": str(local)}

    tagged = _revise(
        test_client,
        project_id,
        subject,
        0,
        ai_provenance={"source": "wd14", "model": "wd-swinv2-tagger-v3"},
    )

    assert tagged.status_code == 201, tagged.text
    revision = tagged.json()["active_revision"]
    assert revision["source"] == "wd14"
    assert revision["author_class"] == "ai"
    assert revision["model"] == "wd-swinv2-tagger-v3"
    assert revision["provider"] is None


def test_without_ai_provenance_a_revision_is_still_a_user_edit(
    test_client, test_db, tmp_path
):
    project_id, image_id, _local = _project(test_client, test_db, tmp_path)

    edited = _revise(
        test_client, project_id, {"item_type": "library", "image_id": image_id}, 0
    )

    assert edited.status_code == 201, edited.text
    revision = edited.json()["active_revision"]
    assert (revision["source"], revision["author_class"]) == ("manual", "user")


def test_ai_provenance_takes_only_ai_sources(test_client, test_db, tmp_path):
    project_id, image_id, _local = _project(test_client, test_db, tmp_path)
    subject = {"item_type": "library", "image_id": image_id}

    for bad in ({"source": "manual"}, {"source": "vlm", "author_class": "user"}):
        response = _revise(test_client, project_id, subject, 0, ai_provenance=bad)
        assert response.status_code in (400, 422), bad
