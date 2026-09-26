"""Deleting a dataset batch deletes its project: only the version the user confirmed.

A dataset batch that still has its project is refused without
``expected_project_revision`` (nothing is deleted), so a project V3.5 changed
after the confirmation opened can never go with it unseen. Other kinds, and a
dataset batch whose project is already gone, need no revision.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from tests.batch_fixtures import create_batch, isolate_batch_data_dir, seed_image


@pytest.fixture(autouse=True)
def batch_data_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    return isolate_batch_data_dir(tmp_path, monkeypatch)


def _dataset_batch(client, image_id: int) -> dict:
    response = client.post(
        "/api/batches", json={"kind": "dataset", "name": "Set", "image_ids": [image_id]}
    )
    assert response.status_code == 201, response.text
    return response.json()["batch"]


def test_a_dataset_batch_is_not_deleted_without_the_confirmed_project_revision(
    test_client, test_db, tmp_path: Path
) -> None:
    image_id = seed_image(test_db, tmp_path / "lib", "a")
    batch = _dataset_batch(test_client, image_id)
    project_id = batch["dataset_project_id"]

    refused = test_client.delete(f"/api/batches/{batch['id']}")

    assert refused.status_code == 400
    body = refused.json()
    assert body["code"] == "dataset_project_revision_required"
    assert body["batch_id"] == batch["id"]
    assert body["project_id"] == project_id
    assert test_client.get(f"/api/batches/{batch['id']}").status_code == 200
    assert test_client.get(f"/api/dataset/projects/{project_id}").status_code == 200


def test_with_the_confirmed_revision_the_batch_and_its_project_go(
    test_client, test_db, tmp_path: Path
) -> None:
    image_id = seed_image(test_db, tmp_path / "lib", "a")
    batch = _dataset_batch(test_client, image_id)
    project_id = batch["dataset_project_id"]
    revision = test_client.get(f"/api/dataset/projects/{project_id}").json()["revision"]

    deleted = test_client.delete(
        f"/api/batches/{batch['id']}", params={"expected_project_revision": revision}
    )

    assert deleted.status_code == 200, deleted.text
    assert test_client.get(f"/api/dataset/projects/{project_id}").status_code == 404


def test_other_kinds_need_no_project_revision(
    test_client, test_db, tmp_path: Path
) -> None:
    image_id = seed_image(test_db, tmp_path / "lib", "a")
    batch = create_batch(test_client, [image_id], name="Post")

    assert test_client.delete(f"/api/batches/{batch['id']}").status_code == 200
