"""Bringing an Eagle library in: indexed in place, user data carried over, nothing overwritten."""

from __future__ import annotations

import json

from services import eagle_import


def _library(tmp_path, items, folders):
    from PIL import Image

    root = tmp_path / "Art.library"
    (root / "images").mkdir(parents=True)
    (root / "metadata.json").write_text(
        json.dumps({"folders": folders}), encoding="utf-8"
    )
    for n, item in enumerate(items):
        info = root / "images" / f"{item['id']}.info"
        info.mkdir()
        (info / "metadata.json").write_text(json.dumps(item), encoding="utf-8")
        # Different pixels per item, and a thumbnail that must not be indexed.
        Image.new("RGB", (16, 16), (n * 40, 10, 10)).save(info / f"{item['name']}.png")
        Image.new("RGB", (4, 4)).save(info / f"{item['name']}_thumbnail.png")
    return root


FOLDERS = [
    {
        "id": "F1",
        "name": "Characters",
        "children": [{"id": "F2", "name": "Miku", "children": []}],
    },
]
ITEMS = [
    {
        "id": "A1",
        "name": "miku night",
        "ext": "png",
        "tags": ["miku", "night"],
        "folders": ["F2"],
        "star": 4,
        "annotation": "cover candidate",
        "url": "https://example.test/post/1",
    },
    {"id": "B2", "name": "plain", "ext": "png"},
]


def _by_name(test_db):
    rows = test_db.get_images(limit=50)
    rows = (
        rows
        if isinstance(rows, list)
        else (rows[0] if isinstance(rows, tuple) else rows["images"])
    )
    return {row["filename"]: row for row in rows}


def test_pictures_are_indexed_where_they_lie_with_what_the_user_gave_them(
    test_db, tmp_path
):
    root = _library(tmp_path, ITEMS, FOLDERS)
    steps = []

    result = eagle_import.run_import(
        str(root), progress=lambda step, current, total: steps.append(step)
    )

    rows = _by_name(test_db)
    # Both pictures, in place, and no thumbnail.
    assert sorted(rows) == ["miku night.png", "plain.png"]
    miku = test_db.get_image_by_id(rows["miku night.png"]["id"])
    assert (
        str(root / "images" / "A1.info") in miku["path"].replace("/", "\\")
        or "A1.info" in miku["path"]
    )
    assert miku["user_rating"] == 4
    assert miku["note"] == "cover candidate"
    tags = {row["tag"]: row.get("source") for row in test_db.get_image_tags(miku["id"])}
    assert tags == {"miku": "manual", "night": "manual"}

    collections = {row["name"]: row for row in test_db.list_collections()}
    assert collections["Miku"]["parent_id"] == collections["Characters"]["id"]
    assert test_db.get_collection_image_ids(collections["Miku"]["id"]) == [miku["id"]]

    from db_collected_sources import get_collected_source

    assert get_collected_source(miku["id"])["page_url"] == "https://example.test/post/1"
    assert {
        key: result[key]
        for key in (
            "indexed",
            "not_indexed",
            "stars_set",
            "notes_set",
            "tags_added",
            "sources_set",
            "collections_created",
            "collection_memberships",
        )
    } == {
        "indexed": 2,
        "not_indexed": 0,
        "stars_set": 1,
        "notes_set": 1,
        "tags_added": 2,
        "sources_set": 1,
        "collections_created": 2,
        "collection_memberships": 1,
    }
    assert steps[0] == "index" and steps[-1] == "done"


def test_a_second_run_adds_nothing_and_never_overwrites_what_is_here(test_db, tmp_path):
    root = _library(tmp_path, ITEMS, FOLDERS)
    eagle_import.run_import(str(root))
    miku_id = _by_name(test_db)["miku night.png"]["id"]
    # The user changes things here afterwards.
    test_db.set_user_rating(miku_id, 2)
    test_db.set_image_note(miku_id, "my own note")

    again = eagle_import.run_import(str(root))

    assert {
        key: again[key]
        for key in (
            "stars_set",
            "notes_set",
            "tags_added",
            "sources_set",
            "collections_created",
        )
    } == {
        "stars_set": 0,
        "notes_set": 0,
        "tags_added": 0,
        "sources_set": 0,
        "collections_created": 0,
    }
    miku = test_db.get_image_by_id(miku_id)
    assert miku["user_rating"] == 2 and miku["note"] == "my own note"
    assert len(_by_name(test_db)) == 2
    assert (
        len(
            [
                row
                for row in test_db.list_collections()
                if row["name"] in ("Characters", "Miku")
            ]
        )
        == 2
    )
