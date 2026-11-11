"""A move into a path that an old record of a missing file still claims."""

from __future__ import annotations


def test_the_moved_picture_takes_the_path_and_the_stale_record_goes(test_db, tmp_path):
    there = str(tmp_path / "album" / "a.png")
    stale = test_db.add_image(
        path=there, filename="a.png", generator="comfyui", width=8, height=8
    )
    live = test_db.add_image(
        path=str(tmp_path / "inbox" / "a.png"),
        filename="a.png",
        generator="comfyui",
        width=8,
        height=8,
    )
    test_db.set_user_rating(live, 5)

    test_db.update_image_path(live, there)

    assert test_db.get_image_by_id(stale) is None
    moved = test_db.get_image_by_id(live)
    assert moved["path"].replace("\\", "/") == there.replace("\\", "/")
    assert moved["user_rating"] == 5
