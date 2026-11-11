"""Reading an Eagle library: items, what the user gave them, and what is passed over.

The libraries here are built to the publicly described layout; none comes from
Eagle itself.
"""

from __future__ import annotations

import json

import pytest

from services import eagle_library


def _library(tmp_path, items, folders=None):
    root = tmp_path / "Art.library"
    (root / "images").mkdir(parents=True)
    (root / "metadata.json").write_text(
        json.dumps({"folders": folders or [], "smartFolders": [], "tagsGroups": []}),
        encoding="utf-8",
    )
    for item in items:
        info = root / "images" / f"{item['id']}.info"
        info.mkdir()
        meta = {key: value for key, value in item.items() if not key.startswith("_")}
        if item.get("_meta", True):
            (info / "metadata.json").write_text(json.dumps(meta), encoding="utf-8")
        if item.get("_file", True):
            (info / f"{item.get('name', 'x')}.{item.get('ext', 'png')}").write_bytes(
                b"picture"
            )
        if item.get("_thumb"):
            (info / f"{item.get('name', 'x')}_thumbnail.png").write_bytes(b"thumb")
    return root


FOLDERS = [
    {
        "id": "F1",
        "name": "Characters",
        "children": [{"id": "F2", "name": "Miku", "children": []}],
    },
    {"id": "F3", "name": "Backgrounds", "children": []},
]


def test_an_item_carries_its_file_tags_folders_stars_note_and_source(tmp_path):
    root = _library(
        tmp_path,
        [
            {
                "id": "A1",
                "name": "miku night",
                "ext": "png",
                "tags": ["miku", "night", "miku", "  "],
                "folders": ["F2", "F3", "GONE"],
                "star": 4,
                "annotation": " cover candidate ",
                "url": "https://example.test/post/1",
                "_thumb": True,
            }
        ],
        FOLDERS,
    )

    (item,) = list(eagle_library.iter_items(root))

    assert item.item_id == "A1"
    assert item.file_path == root / "images" / "A1.info" / "miku night.png"
    assert item.name == "miku night"
    assert item.tags == ("miku", "night")  # repeats and blanks dropped, order kept
    # Folder ids become the names from the top down; an id the library no longer has is left out.
    assert item.folders == (("Characters", "Miku"), ("Backgrounds",))
    assert item.star == 4
    assert item.annotation == "cover candidate"
    assert item.url == "https://example.test/post/1"


def test_deleted_items_bookmarks_and_broken_folders_are_counted_not_read(tmp_path):
    root = _library(
        tmp_path,
        [
            {"id": "OK", "name": "kept", "ext": "jpg", "tags": ["a"]},
            {"id": "DEL", "name": "gone", "ext": "png", "isDeleted": True},
            {
                "id": "BOOK",
                "name": "a page",
                "ext": "url",
                "url": "https://example.test",
                "_file": False,
            },
            {"id": "BROKEN", "name": "x", "ext": "png", "_meta": False},
        ],
    )

    summary = eagle_library.summarize(str(root))

    assert summary["items"] == 1
    assert summary["skipped_deleted"] == 1
    assert summary["skipped_no_file"] == 1
    assert summary["skipped_unreadable"] == 1
    assert summary["unreadable_examples"] == ["BROKEN.info"]
    assert summary["name"] == "Art.library"


def test_the_summary_counts_what_would_be_brought_over(tmp_path):
    root = _library(
        tmp_path,
        [
            {"id": "A", "name": "a", "ext": "png", "tags": ["x", "y"], "star": 5},
            {
                "id": "B",
                "name": "b",
                "ext": "png",
                "tags": ["y"],
                "folders": ["F3"],
                "annotation": "note",
            },
            {"id": "C", "name": "c", "ext": "webp", "url": "https://example.test/c"},
        ],
        FOLDERS,
    )

    summary = eagle_library.summarize(str(root))

    assert {
        key: summary[key]
        for key in (
            "items",
            "with_tags",
            "with_stars",
            "with_notes",
            "in_folders",
            "with_source",
            "distinct_tags",
            "folders",
        )
    } == {
        "items": 3,
        "with_tags": 2,
        "with_stars": 1,
        "with_notes": 1,
        "in_folders": 1,
        "with_source": 1,
        "distinct_tags": 2,
        "folders": 3,
    }


def test_odd_values_are_treated_as_absent(tmp_path):
    root = _library(
        tmp_path,
        [
            {
                "id": "ODD",
                "name": "odd",
                "ext": "png",
                "tags": "not a list",
                "folders": None,
                "star": "five",
                "annotation": 12,
                "url": None,
            },
            # No name or ext in the metadata: the only file that is not a thumbnail is the picture.
            {"id": "BARE", "_thumb": True},
            {"id": "HIGH", "name": "high", "ext": "png", "star": 9},
        ],
    )
    (root / "images" / "BARE.info" / "x.png").rename(
        root / "images" / "BARE.info" / "found.png"
    )

    items = {item.item_id: item for item in eagle_library.iter_items(root)}

    assert items["ODD"].tags == () and items["ODD"].folders == ()
    assert (
        items["ODD"].star == 0
        and items["ODD"].annotation == ""
        and items["ODD"].url == ""
    )
    assert items["BARE"].file_path.name == "found.png" and items["BARE"].name == "found"
    assert items["HIGH"].star == 5


def test_the_images_folder_is_accepted_and_another_folder_is_refused(tmp_path):
    root = _library(tmp_path, [{"id": "A", "name": "a", "ext": "png"}])

    assert eagle_library.resolve_library_root(str(root / "images")) == root
    with pytest.raises(eagle_library.NotAnEagleLibraryError, match="Eagle"):
        eagle_library.resolve_library_root(str(tmp_path))
