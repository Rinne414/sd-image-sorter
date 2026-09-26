"""A dataset batch can be copied ("Save as…", V4 slice 6n5 #108, D55).

The copy is a new dataset batch with its own project: the same items in the
same order, the same settings, and every caption with its history, copied as
new rows of the new project (never shared), each keeping who wrote it (an AI
caption stays an AI caption). Files uploaded into the batch are copied into
the new batch's own folder; a copy that fails leaves nothing behind.
"""

from __future__ import annotations

import importlib
import io
import json
from pathlib import Path

import pytest
from PIL import Image

from services.dataset_session.allowlist import _register_session_paths
from tests.batch_fixtures import (
    LIBRARY_HEADER,
    create_batch,
    isolate_batch_data_dir,
    seed_image,
)

OTHER_LIBRARY = {LIBRARY_HEADER: "studio"}
V35_DEFAULT_SETTINGS = json.loads(
    importlib.import_module(
        "migrations.033_dataset_project_settings"
    ).DEFAULT_SETTINGS_JSON_V1
)


@pytest.fixture(autouse=True)
def batch_data_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    return isolate_batch_data_dir(tmp_path, monkeypatch)


def _png_bytes(seed: int = 0) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (32, 24), (seed * 40 % 255, 80, 120)).save(buffer, format="PNG")
    return buffer.getvalue()


def _content(booru: str, nl: str = "") -> dict[str, object]:
    return {
        "content_version": 1,
        "booru_caption": booru,
        "nl_caption": nl,
        "caption_type": "both" if nl else "booru",
    }


def _project(client, project_id: int) -> dict:
    response = client.get(f"/api/dataset/projects/{project_id}")
    assert response.status_code == 200, response.text
    return response.json()


def _revise(client, project_id: int, subject: dict, content: dict, **extra) -> None:
    project = _project(client, project_id)
    heads = _heads(client, project_id)
    key = _subject_key(subject)
    generation = heads[key]["generation"] if key in heads else 0
    response = client.post(
        f"/api/annotations/projects/{project_id}/training-captions/revisions",
        json={
            "expected_project_revision": project["revision"],
            "expected_head_generation": generation,
            "subject": subject,
            "content": content,
            **extra,
        },
    )
    assert response.status_code == 201, response.text


def _subject_key(item: dict) -> str:
    if item["item_type"] == "library":
        return f"lib:{item['image_id']}"
    return f"local:{Path(item['path']).name}"


def _heads(client, project_id: int) -> dict[str, dict]:
    """Every caption head of a project with a caption, by image id or folder file name."""
    project = _project(client, project_id)
    response = client.get(
        f"/api/annotations/projects/{project_id}/training-captions/heads",
        params={"expected_project_revision": project["revision"], "limit": 200},
    )
    assert response.status_code == 200, response.text
    return {
        _subject_key(item["item"]): item
        for item in response.json()["items"]
        if item["generation"] > 0
    }


def _history(client, project_id: int, subject_id: int) -> list[dict]:
    response = client.get(
        f"/api/annotations/projects/{project_id}/subjects/{subject_id}/training-captions/revisions",
        params={
            "expected_project_revision": _project(client, project_id)["revision"],
            "limit": 50,
        },
    )
    assert response.status_code == 200, response.text
    return response.json()["revisions"]


def _without_ids(revision: dict) -> dict:
    return {
        key: value
        for key, value in revision.items()
        if key
        not in {"id", "subject_id", "parent_revision_id", "restored_from_revision_id"}
    }


@pytest.fixture
def source(test_client, test_db, tmp_path):
    """A dataset batch: two Library images (reordered), an uploaded file, a folder
    image, a trigger and a V4 option; captions by the tagger, a VLM and the user."""
    a = seed_image(test_db, tmp_path / "lib", "alpha")
    b = seed_image(test_db, tmp_path / "lib", "beta", seed=1)
    made = test_client.post(
        "/api/batches", json={"kind": "dataset", "name": "Faces", "image_ids": [a, b]}
    )
    assert made.status_code == 201, made.text
    batch = made.json()["batch"]
    uploaded = test_client.post(
        "/api/dataset/upload-files",
        files=[("files", ("drop.png", _png_bytes(3), "image/png"))],
        data={"batch_id": str(batch["id"])},
    )
    assert uploaded.status_code == 200, uploaded.text
    upload_path = uploaded.json()["items"][0]["abs_path"]
    folder_file = tmp_path / "folder" / "outside.png"
    folder_file.parent.mkdir()
    folder_file.write_bytes(_png_bytes(5))
    _register_session_paths([str(folder_file)])

    project_id = batch["dataset_project_id"]
    project = _project(test_client, project_id)
    settings = {
        **project["settings"],
        "caption_render": {
            **project["settings"]["caption_render"],
            "trigger": "facechar",
        },
    }
    put = test_client.put(
        f"/api/dataset/projects/{project_id}",
        json={
            "expected_revision": project["revision"],
            "name": project["name"],
            "items": [
                {"item_type": "library", "image_id": b},
                {"item_type": "library", "image_id": a},
                {"item_type": "local", "path": upload_path},
                {"item_type": "local", "path": str(folder_file)},
            ],
            "settings": settings,
        },
    )
    assert put.status_code == 200, put.text
    patched = test_client.patch(
        f"/api/batches/{batch['id']}",
        json={
            "revision": test_client.get(f"/api/batches/{batch['id']}").json()[
                "revision"
            ],
            "settings": {
                "dataset": {
                    "training_purpose": "character",
                    "export": {"json_sidecar": True},
                }
            },
        },
    )
    assert patched.status_code == 200, patched.text

    lib_a = {"item_type": "library", "image_id": a}
    lib_b = {"item_type": "library", "image_id": b}
    upload = {"item_type": "local", "path": upload_path}
    folder = {"item_type": "local", "path": str(folder_file)}
    wd14 = {"ai_provenance": {"source": "wd14", "model": "wd-swinv2-tagger-v3"}}
    _revise(test_client, project_id, lib_a, _content("1girl, smile"), **wd14)
    _revise(test_client, project_id, lib_a, _content("1girl, smile, hand edited"))
    _revise(
        test_client,
        project_id,
        lib_b,
        _content("1girl", "A girl by a window."),
        ai_provenance={"source": "vlm", "provider": "ollama", "model": "qwen3-vl:8b"},
    )
    _revise(test_client, project_id, upload, _content("dropped, 1boy"), **wd14)
    _revise(test_client, project_id, folder, _content("outside, typed by hand"))
    return {
        "batch_id": batch["id"],
        "project_id": project_id,
        "a": a,
        "b": b,
        "upload_path": Path(upload_path),
        "folder_file": folder_file,
    }


def _copy(client, batch_id: int, name: str, headers=None):
    return client.post(
        f"/api/batches/{batch_id}/copy", json={"name": name}, headers=headers or {}
    )


def test_the_copy_has_the_same_items_order_settings_and_captions(
    test_client, source, batch_data_dir
):
    response = _copy(test_client, source["batch_id"], "Faces (copy)")

    assert response.status_code == 201, response.text
    copy = response.json()["batch"]
    assert copy["kind"] == "dataset"
    assert copy["name"] == "Faces (copy)"
    assert copy["id"] != source["batch_id"]
    assert copy["dataset_project_id"] != source["project_id"]
    original = _project(test_client, source["project_id"])
    copied = _project(test_client, copy["dataset_project_id"])
    assert copied["name"] == "Faces (copy)"
    assert copied["settings"] == original["settings"]
    # the same items in the same order: Library images by id, the folder image in place,
    # the uploaded file copied into the new batch's own folder (same bytes)
    kinds = [(i["item_type"], i.get("source_image_id")) for i in copied["items"]]
    assert kinds == [
        ("library", source["b"]),
        ("library", source["a"]),
        ("local", None),
        ("local", None),
    ]
    uploaded_copy = Path(copied["items"][2]["path"])
    uploads = (batch_data_dir / "batches" / str(copy["id"]) / "uploads").resolve()
    assert uploaded_copy.parent == uploads
    assert uploaded_copy.name == source["upload_path"].name
    assert uploaded_copy.read_bytes() == source["upload_path"].read_bytes()
    assert copied["items"][3]["path"] == original["items"][3]["path"]
    assert [i.get("source_status") for i in copied["items"][2:]] == [
        "available",
        "available",
    ]
    # the V4 shell comes along: steps, current step and V4-only settings
    source_batch = test_client.get(f"/api/batches/{source['batch_id']}").json()
    assert copy["settings"] == source_batch["settings"]
    assert copy["steps"] == source_batch["steps"]
    assert copy["current_step"] == source_batch["current_step"]

    before = _heads(test_client, source["project_id"])
    after = _heads(test_client, copy["dataset_project_id"])
    assert (
        set(after)
        == set(before)
        == {
            f"lib:{source['a']}",
            f"lib:{source['b']}",
            "local:drop.png",
            "local:outside.png",
        }
    )
    for key, head in before.items():
        assert (
            after[key]["active_revision"]["content"]
            == head["active_revision"]["content"]
        ), key
        assert after[key]["generation"] == head["generation"], key
        # new rows of the new project, never the original's
        assert after[key]["active_revision"]["id"] != head["active_revision"]["id"], key
        assert after[key]["subject_id"] != head["subject_id"], key


def test_every_caption_keeps_who_wrote_it_and_its_history(test_client, source):
    copy = _copy(test_client, source["batch_id"], "Faces (copy)").json()["batch"]
    before = _heads(test_client, source["project_id"])
    after = _heads(test_client, copy["dataset_project_id"])

    # the tagger's and the VLM's captions stay AI-written, with their model; the user's stay the user's
    authors = {
        key: head["active_revision"]["author_class"] for key, head in after.items()
    }
    assert authors == {
        f"lib:{source['a']}": "user",
        f"lib:{source['b']}": "ai",
        "local:drop.png": "ai",
        "local:outside.png": "user",
    }
    for key, head in before.items():
        assert _without_ids(after[key]["active_revision"]) == _without_ids(
            head["active_revision"]
        ), key
    assert after[f"lib:{source['b']}"]["active_revision"]["model"] == "qwen3-vl:8b"
    assert (
        after[f"lib:{source['b']}"]["active_revision"]["content"]["caption_type"]
        == "both"
    )

    # the whole history comes along, in order, each revision pointing at its own copied parent
    lib_a = f"lib:{source['a']}"
    old = _history(test_client, source["project_id"], before[lib_a]["subject_id"])
    new = _history(test_client, copy["dataset_project_id"], after[lib_a]["subject_id"])
    assert [_without_ids(r) for r in new] == [_without_ids(r) for r in old]
    assert len(new) == 2
    assert new[0]["parent_revision_id"] == new[1]["id"]
    assert {r["id"] for r in new}.isdisjoint({r["id"] for r in old})


def test_editing_the_copy_leaves_the_original_as_it_was(test_client, source):
    copy = _copy(test_client, source["batch_id"], "Faces (copy)").json()["batch"]
    before = _heads(test_client, source["project_id"])

    _revise(
        test_client,
        copy["dataset_project_id"],
        {"item_type": "library", "image_id": source["a"]},
        _content("changed in the copy only"),
    )

    assert _heads(test_client, source["project_id"]) == before
    changed = _heads(test_client, copy["dataset_project_id"])[f"lib:{source['a']}"]
    assert (
        changed["active_revision"]["content"]["booru_caption"]
        == "changed in the copy only"
    )


def test_deleting_the_original_keeps_the_copy_whole(test_client, source):
    copy = _copy(test_client, source["batch_id"], "Faces (copy)").json()["batch"]
    original = _project(test_client, source["project_id"])

    deleted = test_client.delete(
        f"/api/batches/{source['batch_id']}",
        params={"expected_project_revision": original["revision"]},
    )

    assert deleted.status_code == 200, deleted.text
    assert not source["upload_path"].exists()
    copied = _project(test_client, copy["dataset_project_id"])
    assert Path(copied["items"][2]["path"]).is_file()
    assert [i.get("source_status") for i in copied["items"][2:]] == [
        "available",
        "available",
    ]
    assert len(_heads(test_client, copy["dataset_project_id"])) == 4


def test_a_copy_that_fails_leaves_nothing_behind(
    test_client, test_db, source, batch_data_dir, monkeypatch
):
    from services import batch_dataset_copy

    def fail(*_args, **_kwargs):
        raise RuntimeError("the database step failed")

    monkeypatch.setattr(batch_dataset_copy, "_copy_captions", fail)
    folders_before = sorted(p.name for p in (batch_data_dir / "batches").iterdir())
    batches_before = test_client.get("/api/batches").json()["batches"]

    with pytest.raises(RuntimeError, match="the database step failed"):
        _copy(test_client, source["batch_id"], "Faces (copy)")

    # no batch, no project, no copied file, no staging folder
    assert test_client.get("/api/batches").json()["batches"] == batches_before
    with test_db.get_db() as conn:
        names = [
            r[0] for r in conn.execute("SELECT name FROM dataset_projects").fetchall()
        ]
    assert "Faces (copy)" not in names
    assert (
        sorted(p.name for p in (batch_data_dir / "batches").iterdir()) == folders_before
    )
    # and the original is untouched
    assert source["upload_path"].is_file()
    assert len(_heads(test_client, source["project_id"])) == 4


def test_a_copy_refuses_other_kinds_taken_names_other_libraries_and_blank_names(
    test_client, test_db, tmp_path, source
):
    image = seed_image(test_db, tmp_path / "lib2", "gamma", seed=2)
    pixiv = create_batch(test_client, [image])

    not_dataset = _copy(test_client, pixiv["id"], "Posts copy")
    assert not_dataset.status_code == 409
    assert not_dataset.json()["code"] == "batch_not_dataset"
    taken = _copy(test_client, source["batch_id"], "faces")
    assert taken.status_code == 409
    assert taken.json()["code"] == "dataset_project_name_conflict"
    assert (
        _copy(
            test_client, source["batch_id"], "Elsewhere", headers=OTHER_LIBRARY
        ).status_code
        == 404
    )
    assert _copy(test_client, 999_999, "Nothing").status_code == 404
    # (the app answers a request that fails validation with 400)
    assert _copy(test_client, source["batch_id"], "   ").status_code == 400
