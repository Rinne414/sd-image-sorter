"""Dataset batches are views of Dataset Maker projects (V4 slice 3a, D26/D30).

The project stays the single source of truth that V3.5 also reads and writes:
a V4 dataset batch creates or links one, shows its name, items and archive
state, and forwards renames, archiving and deletion to it.
"""

from __future__ import annotations

import importlib
import json
import sqlite3
from pathlib import Path

import pytest

import migrations
from services.batch_dataset_service import default_dataset_project_settings
from services.dataset_project_models import DatasetProjectSettingsV1
from services.dataset_session.allowlist import _register_session_paths
from tests.batch_fixtures import (
    LIBRARY_HEADER,
    create_batch,
    isolate_batch_data_dir,
    seed_image,
)

V35_DEFAULT_SETTINGS = json.loads(
    importlib.import_module(
        "migrations.033_dataset_project_settings"
    ).DEFAULT_SETTINGS_JSON_V1
)
OTHER_LIBRARY = {LIBRARY_HEADER: "studio"}


@pytest.fixture(autouse=True)
def batch_data_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    return isolate_batch_data_dir(tmp_path, monkeypatch)


def _seed(test_db, tmp_path: Path, names=("a", "b", "c")) -> list[int]:
    return [
        seed_image(test_db, tmp_path / "lib", name, seed=index)
        for index, name in enumerate(names)
    ]


def _new_dataset_batch(client, name: str, image_ids: list[int], headers=None):
    response = client.post(
        "/api/batches",
        json={"kind": "dataset", "name": name, "image_ids": image_ids},
        headers=headers or {},
    )
    assert response.status_code == 201, response.text
    return response.json()


def _v35_project(client, name: str, image_ids: list[int], headers=None) -> dict:
    response = client.post(
        "/api/dataset/projects",
        json={
            "name": name,
            "items": [{"item_type": "library", "image_id": i} for i in image_ids],
            "settings": V35_DEFAULT_SETTINGS,
        },
        headers=headers or {},
    )
    assert response.status_code == 201, response.text
    return response.json()


def _link(client, project_id: int, headers=None):
    return client.post(
        "/api/batches",
        json={"kind": "dataset", "dataset_project_id": project_id},
        headers=headers or {},
    )


def _v35_get(client, project_id: int) -> dict:
    response = client.get(f"/api/dataset/projects/{project_id}")
    assert response.status_code == 200, response.text
    return response.json()


def _listed(client, **params) -> dict:
    response = client.get("/api/batches", params=params)
    assert response.status_code == 200, response.text
    return response.json()


def _row(listing: dict, batch_id: int) -> dict:
    return next(row for row in listing["batches"] if row["id"] == batch_id)


def _count(test_db, sql: str, params=()) -> int:
    with test_db.get_db() as conn:
        return int(conn.execute(sql, params).fetchone()[0])


def test_new_dataset_batch_creates_a_project_v35_opens_with_strict_settings(
    test_client, test_db, tmp_path
):
    a, b, c = _seed(test_db, tmp_path)

    created = _new_dataset_batch(test_client, " Faces ", [c, a, b, a])
    batch = created["batch"]

    assert created["skipped_image_ids"] == [a]
    assert batch["kind"] == "dataset"
    assert batch["name"] == "Faces"
    assert batch["items"] == []
    assert batch["item_count"] == 3
    assert batch["cover_image_ids"] == [c, a, b]
    assert batch["project_revision"] == 1
    assert batch["orphaned"] is False
    assert [step["id"] for step in batch["steps"]] == [
        "pick",
        "tag",
        "edit",
        "check",
        "export",
    ]
    project = _v35_get(test_client, batch["dataset_project_id"])
    assert project["name"] == "Faces"
    assert [item["image_id"] for item in project["items"]] == [c, a, b]
    DatasetProjectSettingsV1.model_validate(project["settings"], strict=True)
    kohya = next(
        trainer
        for trainer in test_client.get("/api/dataset/trainers").json()["trainers"]
        if trainer["wire_value"] == "kohya_toml"
    )
    assert project["settings"]["trainer"]["config"] == "kohya_toml"
    assert (
        project["settings"]["trainer"]["contract_version"]
        == (kohya["contract_version"])
    )
    assert (
        project["settings"]["trainer"]["repeats"]
        == (kohya["option_bounds"]["repeats"]["default"])
    )

    # V3.5 can save the project back exactly as it reads it.
    saved = test_client.put(
        f"/api/dataset/projects/{project['id']}",
        json={
            "expected_revision": 1,
            "name": project["name"],
            "items": [
                {"item_type": "library", "image_id": item["image_id"]}
                for item in project["items"]
            ],
            "settings": project["settings"],
        },
    )
    assert saved.status_code == 200, saved.text


def test_default_project_settings_pass_the_v35_model():
    settings = default_dataset_project_settings()

    reread = DatasetProjectSettingsV1.model_validate_json(
        settings.model_dump_json(), strict=True
    )
    assert reread.trainer.config == "kohya_toml"
    assert reread.output.mode == "folder"
    assert reread.output.image_op == "copy"


def test_creating_with_a_taken_project_name_changes_nothing(
    test_client, test_db, tmp_path
):
    (a,) = _seed(test_db, tmp_path, ("a",))
    _v35_project(test_client, "Taken", [])

    refused = test_client.post(
        "/api/batches", json={"kind": "dataset", "name": "TAKEN", "image_ids": [a]}
    )

    assert refused.status_code == 409
    assert refused.json()["code"] == "dataset_project_name_conflict"
    assert _count(test_db, "SELECT COUNT(*) FROM batches") == 0
    assert _count(test_db, "SELECT COUNT(*) FROM dataset_projects") == 1

    missing = test_client.post(
        "/api/batches",
        json={"kind": "dataset", "name": "Ghosts", "image_ids": [a, 999_999]},
    )
    assert missing.status_code == 404
    assert missing.json()["code"] == "batch_images_not_found"
    assert _count(test_db, "SELECT COUNT(*) FROM dataset_projects") == 1


def test_linking_a_v35_project_twice_returns_the_same_batch(
    test_client, test_db, tmp_path
):
    a, b = _seed(test_db, tmp_path, ("a", "b"))
    project = _v35_project(test_client, "From V3.5", [b, a])

    unlinked = _listed(test_client)["unlinked_dataset_projects"]
    assert [p["id"] for p in unlinked] == [project["id"]]
    assert unlinked[0]["name"] == "From V3.5"
    assert unlinked[0]["item_count"] == 2
    assert unlinked[0]["cover_image_ids"] == [b, a]

    first = _link(test_client, project["id"])
    again = _link(test_client, project["id"])

    assert first.status_code == 201, first.text
    assert again.status_code == 200, again.text
    batch = first.json()["batch"]
    assert again.json()["batch"]["id"] == batch["id"]
    assert batch["name"] == "From V3.5"
    assert batch["dataset_project_id"] == project["id"]
    assert batch["item_count"] == 2
    listing = _listed(test_client)
    assert listing["unlinked_dataset_projects"] == []
    assert [row["id"] for row in listing["batches"]] == [batch["id"]]
    assert _count(test_db, "SELECT COUNT(*) FROM batches") == 1


def test_link_request_is_validated_and_library_scoped(test_client, test_db, tmp_path):
    project = _v35_project(test_client, "Mine", [])
    studio = _v35_project(test_client, "Studio's", [], headers=OTHER_LIBRARY)

    for body in (
        {"kind": "custom", "dataset_project_id": project["id"]},
        {"kind": "dataset", "dataset_project_id": project["id"], "name": "Other"},
        {"kind": "dataset", "dataset_project_id": project["id"], "image_ids": [1]},
        {"kind": "dataset"},
    ):
        assert test_client.post("/api/batches", json=body).status_code == 400, body

    unknown = _link(test_client, 999_999)
    assert unknown.status_code == 404
    assert unknown.json()["code"] == "dataset_project_not_found"
    foreign = _link(test_client, studio["id"])
    assert foreign.status_code == 404
    assert [p["id"] for p in _listed(test_client)["unlinked_dataset_projects"]] == [
        project["id"]
    ]
    assert _listed(test_client, kind="pixiv")["unlinked_dataset_projects"] == []
    assert _link(test_client, studio["id"], OTHER_LIBRARY).status_code == 201


def test_v35_rename_archive_and_delete_show_in_the_v4_list(
    test_client, test_db, tmp_path
):
    (a,) = _seed(test_db, tmp_path, ("a",))
    project = _v35_project(test_client, "Old name", [a])
    batch = _link(test_client, project["id"]).json()["batch"]
    pixiv = create_batch(test_client, [a], name="Newer pixiv")

    renamed = test_client.put(
        f"/api/dataset/projects/{project['id']}",
        json={
            "expected_revision": 1,
            "name": "New name",
            "items": [{"item_type": "library", "image_id": a}],
            "settings": V35_DEFAULT_SETTINGS,
        },
    )
    assert renamed.status_code == 200, renamed.text
    listing = _listed(test_client)
    row = _row(listing, batch["id"])
    assert row["name"] == "New name"
    assert row["project_revision"] == 2
    assert row["updated_at"] == renamed.json()["updated_at"]
    # The V3.5 edit is the newest change, so the batch moves above the Pixiv one.
    assert [r["id"] for r in listing["batches"]] == [batch["id"], pixiv["id"]]
    assert test_client.get(f"/api/batches/{batch['id']}").json()["name"] == "New name"

    archived = test_client.post(
        f"/api/dataset/projects/{project['id']}/archive",
        json={"expected_revision": 2},
    )
    assert archived.status_code == 200, archived.text
    assert batch["id"] not in [r["id"] for r in _listed(test_client)["batches"]]
    everything = _listed(test_client, include_archived=True)
    assert (
        _row(everything, batch["id"])["archived_at"] == archived.json()["archived_at"]
    )
    assert everything["unlinked_dataset_projects"] == []

    deleted = test_client.request(
        "DELETE",
        f"/api/dataset/projects/{project['id']}",
        json={"expected_revision": 3},
    )
    assert deleted.status_code == 200, deleted.text
    orphan = _row(_listed(test_client, include_archived=True), batch["id"])
    assert orphan["orphaned"] is True
    assert orphan["dataset_project_id"] is None
    assert orphan["project_revision"] is None
    assert orphan["item_count"] == 0
    assert orphan["name"]
    fetched = test_client.get(f"/api/batches/{batch['id']}").json()
    assert fetched["orphaned"] is True


def test_v4_rename_and_archive_go_to_the_project_in_one_transaction(
    test_client, test_db, tmp_path
):
    (a,) = _seed(test_db, tmp_path, ("a",))
    batch = _new_dataset_batch(test_client, "Set", [a])["batch"]
    project_id = batch["dataset_project_id"]
    _v35_project(test_client, "Taken", [])

    renamed = test_client.patch(
        f"/api/batches/{batch['id']}", json={"revision": 1, "name": "Renamed"}
    )
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["name"] == "Renamed"
    assert renamed.json()["revision"] == 2
    assert renamed.json()["project_revision"] == 2
    assert _v35_get(test_client, project_id)["name"] == "Renamed"

    taken = test_client.patch(
        f"/api/batches/{batch['id']}", json={"revision": 2, "name": "taken"}
    )
    assert taken.status_code == 409
    assert taken.json()["code"] == "dataset_project_name_conflict"
    stale = test_client.patch(
        f"/api/batches/{batch['id']}", json={"revision": 1, "name": "Stale"}
    )
    assert stale.status_code == 409
    assert stale.json()["code"] == "batch_revision_conflict"
    unchanged = test_client.get(f"/api/batches/{batch['id']}").json()
    assert (unchanged["name"], unchanged["revision"]) == ("Renamed", 2)
    assert _v35_get(test_client, project_id)["revision"] == 2

    archived = test_client.patch(
        f"/api/batches/{batch['id']}", json={"revision": 2, "archived": True}
    )
    assert archived.status_code == 200, archived.text
    assert archived.json()["archived_at"]
    v35_archived = test_client.get("/api/dataset/projects/archived").json()
    assert [p["id"] for p in v35_archived["projects"]] == [project_id]

    restored = test_client.patch(
        f"/api/batches/{batch['id']}", json={"revision": 3, "archived": False}
    )
    assert restored.status_code == 200, restored.text
    assert restored.json()["archived_at"] is None
    assert _v35_get(test_client, project_id)["archived_at"] is None

    steps_only = test_client.patch(
        f"/api/batches/{batch['id']}", json={"revision": 4, "current_step": "tag"}
    )
    assert steps_only.status_code == 200, steps_only.text
    assert _v35_get(test_client, project_id)["revision"] == 4


def test_item_endpoints_refuse_dataset_batches(test_client, test_db, tmp_path):
    a, b = _seed(test_db, tmp_path, ("a", "b"))
    batch = _new_dataset_batch(test_client, "Set", [a])["batch"]
    url = f"/api/batches/{batch['id']}/items"

    responses = [
        test_client.post(url, json={"image_ids": [b]}),
        test_client.request("DELETE", url, json={"image_ids": [a]}),
        test_client.put(f"{url}/order", json={"image_ids": [a]}),
    ]

    for response in responses:
        assert response.status_code == 409, response.text
        assert response.json()["code"] == "dataset_batch_items_in_project"
    assert _count(test_db, "SELECT COUNT(*) FROM batch_items") == 0
    project = _v35_get(test_client, batch["dataset_project_id"])
    assert [item["image_id"] for item in project["items"]] == [a]


def _add_caption_revision(client, project_id: int, image_id: int) -> None:
    response = client.post(
        f"/api/annotations/projects/{project_id}/training-captions/revisions",
        json={
            "expected_project_revision": 1,
            "expected_head_generation": 0,
            "subject": {"item_type": "library", "image_id": image_id},
            "content": {
                "content_version": 1,
                "booru_caption": "1girl, hand edited",
                "nl_caption": "",
                "caption_type": "booru",
            },
        },
    )
    assert response.status_code == 201, response.text


def _add_folder_image(client, project_id: int, library_id: int, path: Path) -> None:
    _register_session_paths([str(path)])
    response = client.put(
        f"/api/dataset/projects/{project_id}",
        json={
            "expected_revision": 1,
            "name": "Set",
            "items": [
                {"item_type": "library", "image_id": library_id},
                {"item_type": "local", "path": str(path)},
            ],
            "settings": _v35_get(client, project_id)["settings"],
        },
    )
    assert response.status_code == 200, response.text


def test_delete_removes_project_captions_and_owned_uploads_never_originals(
    test_client, test_db, tmp_path, batch_data_dir
):
    (a,) = _seed(test_db, tmp_path, ("a",))
    original = tmp_path / "lib" / "a.png"
    original_bytes = original.read_bytes()
    folder_image = tmp_path / "folder" / "local.png"
    folder_image.parent.mkdir()
    folder_image.write_bytes(original_bytes)
    batch = _new_dataset_batch(test_client, "Set", [a])["batch"]
    project_id = batch["dataset_project_id"]
    _add_caption_revision(test_client, project_id, a)
    _add_folder_image(test_client, project_id, a, folder_image)
    upload = batch_data_dir / "batches" / str(batch["id"]) / "uploads" / "drop.png"
    upload.parent.mkdir(parents=True)
    upload.write_bytes(b"uploaded into the batch")
    assert (
        _count(
            test_db,
            "SELECT COUNT(*) FROM annotation_revisions r JOIN annotation_subjects s "
            "ON s.id = r.subject_id WHERE s.project_id = ?",
            (project_id,),
        )
        == 1
    )

    deleted = test_client.delete(f"/api/batches/{batch['id']}")

    assert deleted.status_code == 200, deleted.text
    assert deleted.json() == {"deleted": True, "batch_id": batch["id"]}
    assert test_client.get(f"/api/dataset/projects/{project_id}").status_code == 404
    for table in (
        "dataset_project_items",
        "dataset_project_local_sources",
        "annotation_subjects",
    ):
        assert (
            _count(
                test_db,
                f"SELECT COUNT(*) FROM {table} WHERE project_id = ?",
                (project_id,),
            )
            == 0
        ), table
    assert _count(test_db, "SELECT COUNT(*) FROM annotation_revisions") == 0
    assert _count(test_db, "SELECT COUNT(*) FROM annotation_heads") == 0
    assert not upload.parent.parent.exists()
    assert original.read_bytes() == original_bytes
    assert folder_image.read_bytes() == original_bytes
    assert _count(test_db, "SELECT COUNT(*) FROM images WHERE id = ?", (a,)) == 1


def test_orphaned_batch_can_only_be_deleted(test_client, test_db, tmp_path):
    project = _v35_project(test_client, "Doomed", [])
    batch = _link(test_client, project["id"]).json()["batch"]
    test_client.request(
        "DELETE",
        f"/api/dataset/projects/{project['id']}",
        json={"expected_revision": 1},
    )

    rename = test_client.patch(
        f"/api/batches/{batch['id']}", json={"revision": 1, "name": "Back"}
    )
    assert rename.status_code == 409
    assert rename.json()["code"] == "dataset_batch_orphaned"
    assert test_client.get(f"/api/batches/{batch['id']}").json()["name"] == "Doomed"

    assert test_client.delete(f"/api/batches/{batch['id']}").status_code == 200
    assert test_client.get(f"/api/batches/{batch['id']}").status_code == 404


def test_list_reports_the_collection_a_custom_batch_came_from(
    test_client, test_db, tmp_path
):
    (a,) = _seed(test_db, tmp_path, ("a",))
    from_collection = test_client.post(
        "/api/batches", json={"kind": "custom", "name": "Coll", "image_ids": [a]}
    ).json()["batch"]
    plain = create_batch(test_client, [a], name="Plain")
    odd = create_batch(test_client, [a], name="Odd")
    for batch, settings in (
        (from_collection, {"source_collection_id": 4, "export": {}}),
        (odd, {"source_collection_id": True}),
    ):
        patched = test_client.patch(
            f"/api/batches/{batch['id']}", json={"revision": 1, "settings": settings}
        )
        assert patched.status_code == 200, patched.text

    listing = _listed(test_client)

    assert _row(listing, from_collection["id"])["source_collection_id"] == 4
    assert _row(listing, plain["id"])["source_collection_id"] is None
    assert _row(listing, odd["id"])["source_collection_id"] is None
    assert "settings_json" not in _row(listing, plain["id"])


def _migration(version: int):
    return next(m for m in migrations.get_migrations() if m.version == version)


def test_migration_061_keeps_one_batch_per_project(tmp_path):
    conn = sqlite3.connect(tmp_path / "link.db")
    try:
        conn.execute("CREATE TABLE images (id INTEGER PRIMARY KEY)")
        conn.execute("CREATE TABLE dataset_projects (id INTEGER PRIMARY KEY)")
        _migration(60).apply(conn)
        conn.execute("INSERT INTO dataset_projects (id) VALUES (1), (2)")
        conn.executemany(
            "INSERT INTO batches (id, kind, name, dataset_project_id) "
            "VALUES (?, 'dataset', 'D', ?)",
            [(10, 1), (11, 1), (12, 2), (13, None)],
        )

        assert _migration(61).apply(conn) is False
        assert _migration(61).apply(conn) is False

        links = dict(conn.execute("SELECT id, dataset_project_id FROM batches"))
        assert links == {10: 1, 11: None, 12: 2, 13: None}
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO batches (kind, name, dataset_project_id) "
                "VALUES ('dataset', 'Again', 2)"
            )
        conn.execute("INSERT INTO batches (kind, name) VALUES ('dataset', 'Free')")
    finally:
        conn.close()


def test_fresh_database_has_the_unique_link_index(test_db):
    with test_db.get_db() as conn:
        sql = conn.execute(
            "SELECT sql FROM sqlite_master WHERE name = 'uq_batches_dataset_project_id'"
        ).fetchone()
    assert sql is not None
    assert "UNIQUE" in sql[0].upper()
