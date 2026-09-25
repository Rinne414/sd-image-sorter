"""A dataset batch's pick step (V4 slice 3b): its project read, uploads that
live in the batch's own folder, and a delete that refuses a changed project."""

from __future__ import annotations

import io
from pathlib import Path

import pytest
from PIL import Image

from tests.batch_fixtures import (
    LIBRARY_HEADER,
    create_batch,
    isolate_batch_data_dir,
    seed_image,
)

OTHER_LIBRARY = {LIBRARY_HEADER: "studio"}


@pytest.fixture(autouse=True)
def batch_data_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    return isolate_batch_data_dir(tmp_path, monkeypatch)


def _png_bytes(seed: int = 0) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (32, 24), (seed * 40 % 255, 80, 120)).save(buffer, format="PNG")
    return buffer.getvalue()


def _dataset_batch(client, name: str, image_ids: list[int]) -> dict:
    response = client.post(
        "/api/batches", json={"kind": "dataset", "name": name, "image_ids": image_ids}
    )
    assert response.status_code == 201, response.text
    return response.json()["batch"]


def _upload(client, batch_id, names: list[str], headers=None):
    data = {} if batch_id is None else {"batch_id": str(batch_id)}
    return client.post(
        "/api/dataset/upload-files",
        files=[
            ("files", (name, _png_bytes(i), "image/png"))
            for i, name in enumerate(names)
        ],
        data=data,
        headers=headers or {},
    )


def _put_items(client, project: dict, items: list[dict]):
    return client.put(
        f"/api/dataset/projects/{project['id']}",
        json={
            "expected_revision": project["revision"],
            "name": project["name"],
            "items": items,
            "settings": project["settings"],
        },
    )


def _view(client, batch_id: int) -> dict:
    response = client.get(f"/api/batches/{batch_id}/project")
    assert response.status_code == 200, response.text
    return response.json()


def test_project_view_names_library_images_and_matches_v35(
    test_client, test_db, tmp_path
):
    a = seed_image(test_db, tmp_path / "lib", "alpha")
    b = seed_image(test_db, tmp_path / "lib", "beta", seed=1)
    batch = _dataset_batch(test_client, "Faces", [b, a])

    view = _view(test_client, batch["id"])

    v35 = test_client.get(f"/api/dataset/projects/{batch['dataset_project_id']}").json()
    assert view["project"] == v35
    names = {row["id"]: row["filename"] for row in view["library_images"]}
    assert names == {a: "alpha.png", b: "beta.png"}
    assert all(
        set(row) == {"id", "filename", "width", "height", "tagged"}
        for row in view["library_images"]
    )
    assert view["uploaded_count"] == 0


def test_project_view_says_which_library_images_are_tagged(
    test_client, test_db, tmp_path
):
    a = seed_image(test_db, tmp_path / "lib", "alpha")
    b = seed_image(test_db, tmp_path / "lib", "beta", seed=1)
    with test_db.get_db() as conn:
        conn.execute(
            "UPDATE images SET tagged_at = CURRENT_TIMESTAMP WHERE id = ?", (a,)
        )
    batch = _dataset_batch(test_client, "Tagged", [a, b])

    view = _view(test_client, batch["id"])

    tagged = {row["id"]: row["tagged"] for row in view["library_images"]}
    assert tagged == {a: True, b: False}


def test_project_view_refuses_other_kinds_orphans_and_other_libraries(
    test_client, test_db, tmp_path
):
    a = seed_image(test_db, tmp_path / "lib", "alpha")
    pixiv = create_batch(test_client, [a])
    dataset = _dataset_batch(test_client, "Soon gone", [])

    not_dataset = test_client.get(f"/api/batches/{pixiv['id']}/project")
    assert not_dataset.status_code == 409
    assert not_dataset.json()["code"] == "batch_not_dataset"
    foreign = test_client.get(
        f"/api/batches/{dataset['id']}/project", headers=OTHER_LIBRARY
    )
    assert foreign.status_code == 404
    test_client.request(
        "DELETE",
        f"/api/dataset/projects/{dataset['dataset_project_id']}",
        json={"expected_revision": 1},
    )
    orphan = test_client.get(f"/api/batches/{dataset['id']}/project")
    assert orphan.status_code == 409
    assert orphan.json()["code"] == "dataset_batch_orphaned"


def test_uploads_go_to_the_batch_folder_and_can_join_the_project(
    test_client, test_db, tmp_path, batch_data_dir
):
    batch = _dataset_batch(test_client, "Drops", [])
    with test_db.get_db() as conn:
        library_rows = conn.execute("SELECT COUNT(*) FROM images").fetchone()[0]

    uploaded = _upload(test_client, batch["id"], ["one.png", "two.png"])

    assert uploaded.status_code == 200, uploaded.text
    uploads = batch_data_dir / "batches" / str(batch["id"]) / "uploads"
    paths = [item["abs_path"] for item in uploaded.json()["items"]]
    assert sorted(Path(p).name for p in paths) == ["one.png", "two.png"]
    assert all(Path(p).parent == uploads.resolve() for p in paths)
    project = _view(test_client, batch["id"])["project"]
    saved = _put_items(
        test_client, project, [{"item_type": "local", "path": p} for p in paths]
    )
    assert saved.status_code == 200, saved.text
    view = _view(test_client, batch["id"])
    assert view["uploaded_count"] == 2
    assert [item["path"] for item in view["project"]["items"]] == paths
    with test_db.get_db() as conn:
        assert conn.execute("SELECT COUNT(*) FROM images").fetchone()[0] == library_rows

    assert test_client.delete(f"/api/batches/{batch['id']}").status_code == 200
    assert not uploads.exists()


def test_upload_into_a_batch_needs_a_linked_dataset_batch_of_this_library(
    test_client, test_db, tmp_path
):
    a = seed_image(test_db, tmp_path / "lib", "alpha")
    pixiv = create_batch(test_client, [a])
    dataset = _dataset_batch(test_client, "Mine", [])

    not_dataset = _upload(test_client, pixiv["id"], ["x.png"])
    assert not_dataset.status_code == 409
    assert not_dataset.json()["code"] == "batch_not_dataset"
    assert _upload(test_client, 999_999, ["x.png"]).status_code == 404
    foreign = _upload(test_client, dataset["id"], ["x.png"], headers=OTHER_LIBRARY)
    assert foreign.status_code == 404
    assert _upload(test_client, None, ["shared.png"]).status_code == 200


def test_delete_with_a_stale_project_revision_keeps_everything(
    test_client, test_db, tmp_path
):
    a = seed_image(test_db, tmp_path / "lib", "alpha")
    batch = _dataset_batch(test_client, "Kept", [a])
    project = _view(test_client, batch["id"])["project"]
    assert _put_items(test_client, project, []).status_code == 200

    stale = test_client.delete(
        f"/api/batches/{batch['id']}", params={"expected_project_revision": 1}
    )

    assert stale.status_code == 409
    assert stale.json()["code"] == "dataset_project_revision_conflict"
    assert stale.json()["current_revision"] == 2
    assert test_client.get(f"/api/batches/{batch['id']}").status_code == 200
    assert _view(test_client, batch["id"])["project"]["revision"] == 2

    fresh = test_client.delete(
        f"/api/batches/{batch['id']}", params={"expected_project_revision": 2}
    )
    assert fresh.status_code == 200, fresh.text
    assert test_client.get(f"/api/batches/{batch['id']}").status_code == 404
