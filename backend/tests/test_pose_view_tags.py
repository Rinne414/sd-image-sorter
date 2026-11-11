"""Find by pose or camera angle: the library's own tags of those two kinds."""

from __future__ import annotations

from services import pose_view_tags


def _library(test_db, tmp_path, tags_per_picture):
    from PIL import Image

    ids = []
    for n, tags in enumerate(tags_per_picture):
        path = tmp_path / f"{n}.png"
        Image.new("RGB", (8, 8)).save(path)
        picture = test_db.add_image(
            path=str(path), filename=path.name, metadata_json="{}"
        )
        ids.append(picture)
        if tags:
            test_db.add_tags(picture, [{"tag": tag, "confidence": 1.0} for tag in tags])
    return ids


def test_the_two_kinds_are_told_apart_and_everything_else_is_left_out():
    assert pose_view_tags._group_of("from_above") == "view"
    assert pose_view_tags._group_of("cowboy_shot") == "view"
    assert pose_view_tags._group_of("looking back") == "view"
    assert pose_view_tags._group_of("sitting") == "pose"
    assert pose_view_tags._group_of("arms_up") == "pose"
    for other in ("1girl", "silver_hair", "smile", "school_uniform", "outdoors"):
        assert pose_view_tags._group_of(other) == ""


def test_the_library_lists_its_own_pose_and_view_tags_most_used_first(
    test_db, tmp_path, monkeypatch
):
    from services import tag_suggest_service

    monkeypatch.setattr(tag_suggest_service, "_ensure_loaded", lambda: None)
    # The first name of from_above is Japanese: the one without kana is shown.
    monkeypatch.setattr(
        tag_suggest_service,
        "_ZH_BLOBS",
        [("うえから,俯视", "from_above", 9, 0), ("坐", "sitting", 5, 0)],
    )
    _library(
        test_db,
        tmp_path,
        [
            ["1girl", "from_above", "sitting"],
            ["1girl", "from_above", "standing"],
            ["from_below", "sitting", "silver_hair"],
            ["sitting"],
            [],  # never tagged: the chooser cannot know this picture
        ],
    )

    found = pose_view_tags.library_pose_and_view()

    assert found["view"] == [
        {"tag": "from_above", "count": 2, "name": "俯视"},
        {"tag": "from_below", "count": 1, "name": None},
    ]
    assert found["pose"] == [
        {"tag": "sitting", "count": 3, "name": "坐"},
        {"tag": "standing", "count": 1, "name": None},
    ]
    assert found["untagged"] == 1


def test_the_endpoint_answers_for_an_empty_library(test_client):
    body = test_client.get("/api/tags/pose-view").json()

    assert body["view"] == [] and body["pose"] == [] and body["untagged"] == 0
