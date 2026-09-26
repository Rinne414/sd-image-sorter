"""Many training-caption revisions in one request (V4 bulk caption edits).

Every entry is written or none is; each names the head generation it was made
on; images outside the project are refused with the rest; a restore names an
earlier revision of the same image and is recorded as a restore; the Library
tags are never touched.
"""

from __future__ import annotations

import importlib
import json
import sqlite3
from pathlib import Path

from services.dataset_session.allowlist import _register_session_paths

DEFAULT_SETTINGS = json.loads(
    importlib.import_module(
        "migrations.033_dataset_project_settings"
    ).DEFAULT_SETTINGS_JSON_V1
)


def _project(
    test_client, test_db, tmp_path: Path, count: int = 3
) -> tuple[int, list[int], Path]:
    ids = []
    for i in range(count):
        image_path = tmp_path / f"library-{i}.png"
        image_path.write_bytes(f"library-fixture-{i}".encode())
        ids.append(
            int(test_db.add_image(path=str(image_path), filename=image_path.name))
        )
    local = tmp_path / "folder" / "local.png"
    local.parent.mkdir()
    local.write_bytes(b"folder-fixture")
    _register_session_paths([str(local)])
    response = test_client.post(
        "/api/dataset/projects",
        json={
            "name": "Bulk captions",
            "items": [
                *({"item_type": "library", "image_id": image_id} for image_id in ids),
                {"item_type": "local", "path": str(local)},
            ],
            "settings": DEFAULT_SETTINGS,
        },
    )
    assert response.status_code == 201, response.text
    return int(response.json()["id"]), ids, local


def _content(booru: str) -> dict[str, object]:
    return {
        "content_version": 1,
        "booru_caption": booru,
        "nl_caption": "",
        "caption_type": "booru",
    }


def _lib(image_id: int) -> dict[str, object]:
    return {"item_type": "library", "image_id": image_id}


def _batch(test_client, project_id: int, entries: list[dict], revision: int = 1):
    return test_client.post(
        f"/api/annotations/projects/{project_id}/training-captions/revisions:batch",
        json={"expected_project_revision": revision, "entries": entries},
    )


def _heads(test_client, project_id: int) -> dict[str, dict]:
    response = test_client.get(
        f"/api/annotations/projects/{project_id}/training-captions/heads",
        params={"expected_project_revision": 1, "limit": 200},
    )
    assert response.status_code == 200, response.text
    out = {}
    for item in response.json()["items"]:
        subject = item["item"]
        key = (
            f"lib:{subject['image_id']}"
            if subject["item_type"] == "library"
            else "local"
        )
        out[key] = item
    return out


def _revision_count(test_db) -> int:
    with sqlite3.connect(test_db.DATABASE_PATH) as conn:
        return int(
            conn.execute("SELECT COUNT(*) FROM annotation_revisions").fetchone()[0]
        )


def test_every_entry_is_written_in_one_request_as_the_user(
    test_client, test_db, tmp_path
):
    project_id, ids, local = _project(test_client, test_db, tmp_path)
    entries = [
        *(
            {
                "subject": _lib(i),
                "expected_head_generation": 0,
                "content": _content(f"tag {i}"),
            }
            for i in ids
        ),
        {
            "subject": {"item_type": "local", "path": str(local)},
            "expected_head_generation": 0,
            "content": _content("forest"),
        },
    ]

    response = _batch(test_client, project_id, entries)

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["written"] == 4
    assert [item["generation"] for item in body["items"]] == [1, 1, 1, 1]
    assert [item["item"] for item in body["items"]][:3] == [_lib(i) for i in ids]
    assert {item["source"] for item in body["items"]} == {"manual"}
    heads = _heads(test_client, project_id)
    for image_id in ids:
        revision = heads[f"lib:{image_id}"]["active_revision"]
        assert revision["content"]["booru_caption"] == f"tag {image_id}"
        assert (revision["source"], revision["author_class"]) == ("manual", "user")
    assert heads["local"]["active_revision"]["content"]["booru_caption"] == "forest"


def test_one_stale_generation_writes_nothing_and_lists_the_conflict(
    test_client, test_db, tmp_path
):
    project_id, ids, _local = _project(test_client, test_db, tmp_path)
    first = _batch(
        test_client,
        project_id,
        [
            {
                "subject": _lib(ids[0]),
                "expected_head_generation": 0,
                "content": _content("a"),
            }
        ],
    )
    assert first.status_code == 201, first.text
    before = _revision_count(test_db)

    response = _batch(
        test_client,
        project_id,
        [
            {
                "subject": _lib(ids[1]),
                "expected_head_generation": 0,
                "content": _content("b"),
            },
            {
                "subject": _lib(ids[0]),
                "expected_head_generation": 0,
                "content": _content("stale"),
            },
            {
                "subject": _lib(ids[2]),
                "expected_head_generation": 0,
                "content": _content("c"),
            },
        ],
    )

    assert response.status_code == 409, response.text
    detail = response.json()
    assert detail["code"] == "annotation_batch_conflict"
    assert detail["written"] == 0
    assert [
        (p["index"], p["reason"], p["expected_generation"], p["current_generation"])
        for p in detail["problems"]
    ] == [(1, "generation", 0, 1)]
    assert _revision_count(test_db) == before
    heads = _heads(test_client, project_id)
    assert set(heads) == {f"lib:{ids[0]}"}
    assert heads[f"lib:{ids[0]}"]["active_revision"]["content"]["booru_caption"] == "a"


def test_images_outside_the_project_are_refused_with_the_rest(
    test_client, test_db, tmp_path
):
    project_id, ids, _local = _project(test_client, test_db, tmp_path)
    outsider = tmp_path / "outsider.png"
    outsider.write_bytes(b"not in the project")
    outsider_id = int(test_db.add_image(path=str(outsider), filename=outsider.name))
    stray = tmp_path / "stray.png"
    stray.write_bytes(b"stray")
    _register_session_paths([str(stray)])

    response = _batch(
        test_client,
        project_id,
        [
            {
                "subject": _lib(ids[0]),
                "expected_head_generation": 0,
                "content": _content("ok"),
            },
            {
                "subject": _lib(outsider_id),
                "expected_head_generation": 0,
                "content": _content("no"),
            },
            {
                "subject": {"item_type": "local", "path": str(stray)},
                "expected_head_generation": 0,
                "content": _content("no"),
            },
        ],
    )

    assert response.status_code == 409, response.text
    problems = response.json()["problems"]
    assert [(p["index"], p["reason"]) for p in problems] == [
        (1, "not_in_project"),
        (2, "not_in_project"),
    ]
    assert _heads(test_client, project_id) == {}


def test_a_changed_folder_file_is_refused(test_client, test_db, tmp_path):
    project_id, ids, local = _project(test_client, test_db, tmp_path)
    local.write_bytes(b"changed after it was added")

    response = _batch(
        test_client,
        project_id,
        [
            {
                "subject": _lib(ids[0]),
                "expected_head_generation": 0,
                "content": _content("ok"),
            },
            {
                "subject": {"item_type": "local", "path": str(local)},
                "expected_head_generation": 0,
                "content": _content("no"),
            },
        ],
    )

    assert response.status_code == 409, response.text
    assert [(p["index"], p["reason"]) for p in response.json()["problems"]] == [
        (1, "identity")
    ]
    assert _heads(test_client, project_id) == {}


def test_undo_restores_earlier_revisions_with_their_lineage(
    test_client, test_db, tmp_path
):
    project_id, ids, _local = _project(test_client, test_db, tmp_path)
    original = _batch(
        test_client,
        project_id,
        [
            {
                "subject": _lib(i),
                "expected_head_generation": 0,
                "content": _content(f"orig {i}"),
            }
            for i in ids
        ],
    )
    assert original.status_code == 201, original.text
    first_revisions = [item["revision_id"] for item in original.json()["items"]]
    changed = _batch(
        test_client,
        project_id,
        [
            {
                "subject": _lib(i),
                "expected_head_generation": 1,
                "content": _content("bulk"),
            }
            for i in ids
        ],
    )
    assert changed.status_code == 201, changed.text

    undo = _batch(
        test_client,
        project_id,
        [
            {
                "subject": _lib(i),
                "expected_head_generation": 2,
                "restore_revision_id": rev,
            }
            for i, rev in zip(ids, first_revisions)
        ],
    )

    assert undo.status_code == 201, undo.text
    items = undo.json()["items"]
    assert [(item["source"], item["restored_from_revision_id"]) for item in items] == [
        ("restore", rev) for rev in first_revisions
    ]
    heads = _heads(test_client, project_id)
    for image_id in ids:
        revision = heads[f"lib:{image_id}"]["active_revision"]
        assert revision["content"]["booru_caption"] == f"orig {image_id}"
        assert (revision["source"], revision["author_class"]) == ("restore", "user")
        assert heads[f"lib:{image_id}"]["generation"] == 3


def test_a_restore_must_name_the_same_images_revision(test_client, test_db, tmp_path):
    project_id, ids, _local = _project(test_client, test_db, tmp_path)
    written = _batch(
        test_client,
        project_id,
        [
            {
                "subject": _lib(i),
                "expected_head_generation": 0,
                "content": _content(f"t{i}"),
            }
            for i in ids[:2]
        ],
    )
    other_revision = written.json()["items"][1]["revision_id"]

    response = _batch(
        test_client,
        project_id,
        [
            {
                "subject": _lib(ids[0]),
                "expected_head_generation": 1,
                "restore_revision_id": other_revision,
            }
        ],
    )

    assert response.status_code == 409, response.text
    assert [(p["index"], p["reason"]) for p in response.json()["problems"]] == [
        (0, "revision")
    ]


def test_bad_requests_are_refused_before_anything_is_read(
    test_client, test_db, tmp_path
):
    project_id, ids, _local = _project(test_client, test_db, tmp_path)
    both = {
        "subject": _lib(ids[0]),
        "expected_head_generation": 0,
        "content": _content("x"),
        "restore_revision_id": 1,
    }
    neither = {"subject": _lib(ids[0]), "expected_head_generation": 0}
    twice = [
        {
            "subject": _lib(ids[0]),
            "expected_head_generation": 0,
            "content": _content("x"),
        },
        {
            "subject": _lib(ids[0]),
            "expected_head_generation": 0,
            "content": _content("y"),
        },
    ]

    assert _batch(test_client, project_id, [both]).status_code == 400
    assert _batch(test_client, project_id, [neither]).status_code == 400
    assert _batch(test_client, project_id, []).status_code == 400
    duplicate = _batch(test_client, project_id, twice)
    assert duplicate.status_code == 400, duplicate.text
    assert _batch(test_client, project_id, twice[:1], revision=99).status_code == 409
    assert _heads(test_client, project_id) == {}


def test_library_tags_are_never_touched(test_client, test_db, tmp_path):
    project_id, ids, _local = _project(test_client, test_db, tmp_path)
    test_db.add_tags(
        ids[0],
        [{"tag": "1girl", "confidence": 0.9}, {"tag": "smile", "confidence": 0.8}],
    )

    response = _batch(
        test_client,
        project_id,
        [
            {
                "subject": _lib(ids[0]),
                "expected_head_generation": 0,
                "content": _content("only mine"),
            }
        ],
    )

    assert response.status_code == 201, response.text
    tags = sorted(tag["tag"] for tag in test_db.get_image_tags(ids[0]))
    assert tags == ["1girl", "smile"]


def test_undo_keeps_who_wrote_each_version(test_client, test_db, tmp_path):
    """An AI caption put back by an undo is still the AI's; a caption the
    template made (the image was never edited) comes back as a system
    snapshot, so neither counts as the user's writing."""
    project_id, ids, _local = _project(test_client, test_db, tmp_path)
    ai = test_client.post(
        f"/api/annotations/projects/{project_id}/training-captions/revisions",
        json={
            "expected_project_revision": 1,
            "expected_head_generation": 0,
            "subject": _lib(ids[0]),
            "content": _content("from the tagger"),
            "ai_provenance": {"source": "wd14", "model": "wd-swinv2-tagger-v3"},
        },
    )
    assert ai.status_code == 201, ai.text
    ai_revision = ai.json()["active_revision"]["id"]
    bulk = _batch(
        test_client,
        project_id,
        [
            {"subject": _lib(ids[0]), "expected_head_generation": 1, "content": _content("bulk")},
            {"subject": _lib(ids[1]), "expected_head_generation": 0, "content": _content("bulk")},
        ],
    )
    assert bulk.status_code == 201, bulk.text

    undo = _batch(
        test_client,
        project_id,
        [
            {"subject": _lib(ids[0]), "expected_head_generation": 2, "restore_revision_id": ai_revision},
            {"subject": _lib(ids[1]), "expected_head_generation": 1, "content": _content("as the template made it"), "template_snapshot": True},
        ],
    )

    assert undo.status_code == 201, undo.text
    assert [(i["source"], i["author_class"]) for i in undo.json()["items"]] == [("restore", "ai"), ("legacy_snapshot", "system")]
    heads = _heads(test_client, project_id)
    first = heads[f"lib:{ids[0]}"]["active_revision"]
    assert (first["source"], first["author_class"], first["model"]) == ("restore", "ai", "wd-swinv2-tagger-v3")
    assert first["content"]["booru_caption"] == "from the tagger"
    second = heads[f"lib:{ids[1]}"]["active_revision"]
    assert (second["source"], second["author_class"]) == ("legacy_snapshot", "system")
    assert second["content"]["booru_caption"] == "as the template made it"


def test_a_template_snapshot_carries_content_only(test_client, test_db, tmp_path):
    project_id, ids, _local = _project(test_client, test_db, tmp_path)
    response = _batch(test_client, project_id, [{"subject": _lib(ids[0]), "expected_head_generation": 0, "restore_revision_id": 1, "template_snapshot": True}])
    assert response.status_code == 400, response.text
