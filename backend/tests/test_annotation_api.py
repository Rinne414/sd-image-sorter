"""Integration coverage for Dataset Project training-caption revision APIs."""
from __future__ import annotations

import importlib
import json
from pathlib import Path


DEFAULT_SETTINGS_JSON_V1 = importlib.import_module(
    "migrations.033_dataset_project_settings"
).DEFAULT_SETTINGS_JSON_V1


def _create_library_project(test_client, test_db, tmp_path: Path) -> tuple[int, int]:
    image_path = tmp_path / "annotation-api.png"
    image_path.write_bytes(b"annotation-api-fixture")
    image_id = int(test_db.add_image(path=str(image_path), filename=image_path.name))
    response = test_client.post(
        "/api/dataset/projects",
        json={
            "name": "Annotation API",
            "items": [{"item_type": "library", "image_id": image_id}],
            "settings": json.loads(DEFAULT_SETTINGS_JSON_V1),
        },
    )
    assert response.status_code == 201
    return int(response.json()["id"]), image_id


def _content(booru_caption: str, nl_caption: str, caption_type: str) -> dict[str, object]:
    return {
        "content_version": 1,
        "booru_caption": booru_caption,
        "nl_caption": nl_caption,
        "caption_type": caption_type,
    }


def _create_revision(
    test_client,
    project_id: int,
    image_id: int,
    expected_generation: int,
    content: dict[str, object],
):
    return test_client.post(
        f"/api/annotations/projects/{project_id}/training-captions/revisions",
        json={
            "expected_project_revision": 1,
            "expected_head_generation": expected_generation,
            "subject": {"item_type": "library", "image_id": image_id},
            "content": content,
        },
    )


def test_training_caption_api_create_history_restore_and_conflict(
    test_client,
    test_db,
    tmp_path: Path,
) -> None:
    project_id, image_id = _create_library_project(
        test_client,
        test_db,
        tmp_path,
    )

    resolved = test_client.post(
        f"/api/annotations/projects/{project_id}/training-captions/head",
        json={
            "expected_project_revision": 1,
            "subject": {"item_type": "library", "image_id": image_id},
        },
    )
    assert resolved.status_code == 200
    resolved_payload = resolved.json()
    subject_key = resolved_payload.pop("subject_key")
    assert subject_key.startswith(f"project_library:{image_id}:")
    assert resolved_payload == {
        "subject_id": None,
        "item": {"item_type": "library", "image_id": image_id},
        "generation": 0,
        "active_revision": None,
        "reviewed_revision_id": None,
        "export_revision_id": None,
    }

    first_content = _content(
        "1girl, blue_hair",
        "A blue-haired girl looks at the camera.",
        "both",
    )
    first = _create_revision(
        test_client,
        project_id,
        image_id,
        0,
        first_content,
    )
    assert first.status_code == 201
    first_payload = first.json()
    assert first_payload["generation"] == 1
    assert first_payload["active_revision"]["content"] == first_content
    assert first_payload["active_revision"]["source"] == "manual"
    assert first_payload["active_revision"]["author_class"] == "user"
    assert len(first_payload["active_revision"]["content_sha256"]) == 64

    resolved_again = test_client.post(
        f"/api/annotations/projects/{project_id}/training-captions/head",
        json={
            "expected_project_revision": 1,
            "subject": {"item_type": "library", "image_id": image_id},
        },
    )
    assert resolved_again.status_code == 200
    assert resolved_again.json()["active_revision"]["content"] == first_content

    stale = _create_revision(
        test_client,
        project_id,
        image_id,
        0,
        _content("stale", "stale", "nl"),
    )
    assert stale.status_code == 409
    stale_payload = stale.json()
    assert {
        key: stale_payload[key]
        for key in (
            "code",
            "message",
            "subject_id",
            "expected_generation",
            "current_generation",
        )
    } == {
        "code": "annotation_head_conflict",
        "message": "The annotation changed since it was loaded. Reload it before saving.",
        "subject_id": first_payload["subject_id"],
        "expected_generation": 0,
        "current_generation": 1,
    }

    second_content = _content("1girl, red_dress", "A girl wears red.", "both")
    second = _create_revision(
        test_client,
        project_id,
        image_id,
        1,
        second_content,
    )
    assert second.status_code == 201
    second_payload = second.json()
    assert second_payload["generation"] == 2
    assert second_payload["active_revision"]["parent_revision_id"] == first_payload["active_revision"]["id"]

    heads = test_client.get(
        f"/api/annotations/projects/{project_id}/training-captions/heads",
        params={"expected_project_revision": 1, "limit": 1},
    )
    assert heads.status_code == 200
    assert heads.json()["project_id"] == project_id
    assert len(heads.json()["items"]) == 1
    assert heads.json()["items"][0]["active_revision"]["content"] == second_content
    assert heads.json()["has_more"] is False

    first_page = test_client.get(
        f"/api/annotations/projects/{project_id}/subjects/"
        f"{first_payload['subject_id']}/training-captions/revisions",
        params={"expected_project_revision": 1, "limit": 1},
    )
    assert first_page.status_code == 200
    first_page_payload = first_page.json()
    assert [item["id"] for item in first_page_payload["revisions"]] == [
        second_payload["active_revision"]["id"],
    ]
    assert first_page_payload["has_more"] is True
    assert first_page_payload["next_before_revision_id"] == second_payload["active_revision"]["id"]

    second_page = test_client.get(
        f"/api/annotations/projects/{project_id}/subjects/"
        f"{first_payload['subject_id']}/training-captions/revisions",
        params={
            "limit": 1,
            "expected_project_revision": 1,
            "before_revision_id": first_page_payload["next_before_revision_id"],
        },
    )
    assert second_page.status_code == 200
    assert [item["id"] for item in second_page.json()["revisions"]] == [
        first_payload["active_revision"]["id"],
    ]

    restored = test_client.post(
        f"/api/annotations/projects/{project_id}/subjects/"
        f"{first_payload['subject_id']}/training-captions/restore",
        json={
            "expected_project_revision": 1,
            "revision_id": first_payload["active_revision"]["id"],
            "expected_head_generation": 2,
        },
    )
    assert restored.status_code == 201
    restored_payload = restored.json()
    assert restored_payload["generation"] == 3
    assert restored_payload["active_revision"]["content"] == first_content
    assert restored_payload["active_revision"]["source"] == "restore"
    assert restored_payload["active_revision"]["restored_from_revision_id"] == first_payload["active_revision"]["id"]
    assert restored_payload["active_revision"]["id"] not in {
        first_payload["active_revision"]["id"],
        second_payload["active_revision"]["id"],
    }


def test_training_caption_api_rejects_extra_and_invalid_content_fields(
    test_client,
    test_db,
    tmp_path: Path,
) -> None:
    project_id, image_id = _create_library_project(
        test_client,
        test_db,
        tmp_path,
    )

    response = _create_revision(
        test_client,
        project_id,
        image_id,
        0,
        {
            **_content("1girl", "A girl.", "booru"),
            "unexpected": "must fail",
        },
    )
    assert response.status_code == 400

    invalid_type = _create_revision(
        test_client,
        project_id,
        image_id,
        0,
        _content("1girl", "A girl.", "automatic"),
    )
    assert invalid_type.status_code == 400
