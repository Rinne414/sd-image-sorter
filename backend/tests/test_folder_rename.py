"""Renaming a library folder: the disk, the records, and the refusals."""

from __future__ import annotations

import os

import pytest
from PIL import Image

from services import folder_rename


def _picture(test_db, folder, name):
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / name
    Image.new("RGB", (8, 8), (10, 120, 200)).save(path)
    return test_db.add_image(
        path=str(path), filename=name, generator="comfyui", width=8, height=8
    )


def _path_of(test_db, image_id):
    return test_db.get_image_by_id(image_id)["path"].replace("\\", "/")


def test_the_folder_and_every_picture_under_it_take_the_new_name(test_db, tmp_path):
    old = tmp_path / "lib" / "sketches"
    top = _picture(test_db, old, "a.png")
    deep = _picture(test_db, old / "2026" / "may", "b.png")
    (old / "a.txt").write_text("caption", encoding="utf-8")
    outside = _picture(test_db, tmp_path / "lib" / "sketches-old", "c.png")
    test_db.set_user_rating(top, 4)
    test_db.set_favorite(deep, True)

    result = folder_rename.rename_folder(str(old), "studies")

    new = tmp_path / "lib" / "studies"
    assert result["pictures"] == 2
    assert not old.exists() and (new / "a.png").is_file()
    assert (new / "a.txt").read_text(encoding="utf-8") == "caption"
    assert _path_of(test_db, top) == str(new / "a.png").replace("\\", "/")
    assert _path_of(test_db, deep) == str(new / "2026" / "may" / "b.png").replace(
        "\\", "/"
    )
    assert "sketches-old" in _path_of(test_db, outside)
    assert test_db.get_image_by_id(top)["user_rating"] == 4
    folders = [f.replace("\\", "/") for f in test_db.get_library_folders()]
    assert not any(f.endswith("/sketches") or "/sketches/" in f for f in folders)


def test_a_library_root_under_the_folder_follows_it(test_db, tmp_path):
    old = tmp_path / "shelf"
    _picture(test_db, old / "root", "a.png")
    test_db.add_library_root(str(old / "root"))

    result = folder_rename.rename_folder(str(old), "bookcase")

    assert result["roots"] == 1
    roots = [r["path"].replace("\\", "/") for r in test_db.list_library_roots()]
    assert roots == [str(tmp_path / "bookcase" / "root").replace("\\", "/")]


@pytest.mark.parametrize(
    "name, code",
    [
        ("", "name_empty"),
        ("  ", "name_empty"),
        ("a/b", "name_invalid"),
        ("what?", "name_invalid"),
        ("ends.", "name_invalid"),
        ("NUL", "name_invalid"),
        ("taken", "name_taken"),
        ("mine", "name_same"),
    ],
)
def test_a_name_that_cannot_be_used_changes_nothing(test_db, tmp_path, name, code):
    old = tmp_path / "mine"
    image_id = _picture(test_db, old, "a.png")
    (tmp_path / "taken").mkdir()

    with pytest.raises(folder_rename.FolderRenameError) as refused:
        folder_rename.rename_folder(str(old), name)

    assert refused.value.code == code
    assert (old / "a.png").is_file()
    assert _path_of(test_db, image_id).endswith("/mine/a.png")


def test_a_folder_inside_an_eagle_library_is_left_to_eagle(test_db, tmp_path):
    inside = tmp_path / "Art.library" / "images" / "A1.info"
    _picture(test_db, inside, "one.png")

    with pytest.raises(folder_rename.FolderRenameError) as refused:
        folder_rename.rename_folder(str(inside), "renamed")

    assert refused.value.code == "eagle_library" and inside.is_dir()


def test_the_folder_goes_back_when_the_records_cannot_be_written(
    test_db, tmp_path, monkeypatch
):
    old = tmp_path / "keep"
    image_id = _picture(test_db, old, "a.png")

    def broken(*_args, **_kwargs):
        raise RuntimeError("disk full")

    monkeypatch.setattr(folder_rename, "_repoint_roots", broken)
    with pytest.raises(RuntimeError):
        folder_rename.rename_folder(str(old), "lost")

    assert (old / "a.png").is_file() and not (tmp_path / "lost").exists()
    assert _path_of(test_db, image_id).endswith("/keep/a.png")


def test_over_http_rename_then_back(test_client, test_db, tmp_path):
    old = tmp_path / "before"
    image_id = _picture(test_db, old, "a.png")

    done = test_client.post(
        "/api/folders/rename", json={"path": str(old), "new_name": "after"}
    )
    assert done.status_code == 200, done.text
    assert done.json()["pictures"] == 1
    assert _path_of(test_db, image_id).endswith("/after/a.png")

    taken = test_client.post(
        "/api/folders/rename", json={"path": str(old), "new_name": "x"}
    )
    assert taken.status_code in (400, 404)

    back = test_client.post(
        "/api/folders/rename",
        json={"path": done.json()["new_path"], "new_name": "before"},
    )
    assert back.status_code == 200, back.text
    assert os.path.isfile(old / "a.png")
    assert _path_of(test_db, image_id).endswith("/before/a.png")


def test_a_running_move_makes_the_rename_wait(
    test_client, test_db, tmp_path, monkeypatch
):
    from routers import folders

    old = tmp_path / "busy"
    _picture(test_db, old, "a.png")
    monkeypatch.setattr(folders, "_busy_reason", lambda: "A move is running.")

    refused = test_client.post(
        "/api/folders/rename", json={"path": str(old), "new_name": "later"}
    )

    assert refused.status_code == 409 and old.is_dir()


def test_a_record_of_a_file_that_is_gone_does_not_block_the_name(test_db, tmp_path):
    """The folder was called "old" once: its records stayed behind when it was renamed outside."""
    gone = tmp_path / "old"
    stale = test_db.add_image(
        path=str(gone / "a.png"),
        filename="a.png",
        generator="comfyui",
        width=8,
        height=8,
    )
    now = tmp_path / "current"
    live = _picture(test_db, now, "a.png")

    result = folder_rename.rename_folder(str(now), "old")

    assert result["pictures"] == 1 and result["replaced"] == 1
    assert test_db.get_image_by_id(stale) is None
    assert _path_of(test_db, live).endswith("/old/a.png")
