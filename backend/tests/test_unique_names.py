"""One auto-number style app-wide: name.ext, then name_2.ext, name_3.ext ...

Owner decision 2026-10-04. Before, censor save numbered ``name_2``, video
censor ``name_censored (2)``, the disguise tool ``name (2)``, and moving or
copying a picture into a folder (sorting) and dataset caption sidecars
``name_1``.
"""

from __future__ import annotations

from pathlib import Path


def test_numbered_filename_keeps_the_first_name_and_counts_from_two() -> None:
    from utils.unique_names import numbered_filename

    assert numbered_filename("00042", ".png", 1) == "00042.png"
    assert numbered_filename("00042", ".png", 2) == "00042_2.png"
    assert numbered_filename("00042", ".png", 11) == "00042_11.png"


def test_first_free_path_skips_every_taken_name(tmp_path: Path) -> None:
    from utils.unique_names import first_free_path

    (tmp_path / "a.png").write_bytes(b"1")
    (tmp_path / "a_2.png").write_bytes(b"2")

    assert first_free_path(tmp_path, "a", ".png") == tmp_path / "a_3.png"
    assert first_free_path(tmp_path, "b", ".png") == tmp_path / "b.png"


def test_video_censor_numbers_like_every_other_save(tmp_path: Path) -> None:
    from services.media_censor_service import free_output_path

    (tmp_path / "anim_censored.gif").write_bytes(b"x")

    assert (
        free_output_path(tmp_path, Path("anim.gif"), ".gif")
        == tmp_path / "anim_censored_2.gif"
    )


def test_disguise_numbers_like_every_other_save(tmp_path: Path) -> None:
    from routers.disguise import _free_name

    (tmp_path / "chat.png").write_bytes(b"x")

    assert _free_name(tmp_path, "chat") == tmp_path / "chat_2.png"


def test_moving_into_a_folder_with_the_same_name_numbers_from_two(
    tmp_path: Path,
) -> None:
    from image_manager import _prepare_destination_path

    source_dir = tmp_path / "src"
    target_dir = tmp_path / "dst"
    source_dir.mkdir()
    target_dir.mkdir()
    (source_dir / "00042.png").write_bytes(b"new")
    (target_dir / "00042.png").write_bytes(b"old")

    _, new_path = _prepare_destination_path(
        str(source_dir / "00042.png"), str(target_dir), "move"
    )

    assert Path(new_path).name == "00042_2.png"


def test_dataset_caption_sidecars_number_from_two(tmp_path: Path) -> None:
    from services.dataset_export.planning import _allocate_sidecar_path

    (tmp_path / "img.txt").write_text("taken", encoding="utf-8")

    path, problem = _allocate_sidecar_path(
        tmp_path, "img", ".txt", overwrite_policy="unique", used_paths=set()
    )

    assert problem is None
    assert path == tmp_path / "img_2.txt"


def test_running_out_of_numbers_raises_instead_of_looping(tmp_path: Path, monkeypatch) -> None:
    import utils.unique_names as unique_names

    monkeypatch.setattr(unique_names, "MAX_NUMBERED_COPIES", 3)
    for name in ("x.png", "x_2.png", "x_3.png"):
        (tmp_path / name).write_bytes(b"1")

    import pytest

    with pytest.raises(FileExistsError):
        unique_names.first_free_path(tmp_path, "x", ".png")


def test_a_full_folder_is_a_file_operation_error_for_moves(tmp_path: Path, monkeypatch) -> None:
    import pytest

    import utils.unique_names as unique_names
    from image_manager import FileOperationError, _prepare_destination_path

    monkeypatch.setattr(unique_names, "MAX_NUMBERED_COPIES", 2)
    (tmp_path / "src").mkdir()
    (tmp_path / "dst").mkdir()
    (tmp_path / "src" / "p.png").write_bytes(b"new")
    for name in ("p.png", "p_2.png"):
        (tmp_path / "dst" / name).write_bytes(b"old")

    with pytest.raises(FileOperationError):
        _prepare_destination_path(str(tmp_path / "src" / "p.png"), str(tmp_path / "dst"), "move")


def test_dataset_naming_counts_names_taken_earlier_in_the_same_run(tmp_path: Path, monkeypatch) -> None:
    import utils.unique_names as unique_names
    from services.dataset_naming import plan_renames

    images = [{"id": 1, "filename": "a.png"}, {"id": 2, "filename": "b.png"}, {"id": 3, "filename": "c.png"}]
    plan = plan_renames(images, output_folder=tmp_path, pattern="set", trigger="", overwrite_policy="unique")
    assert [entry[1].name for entry in plan] == ["set.png", "set_2.png", "set_3.png"]

    monkeypatch.setattr(unique_names, "MAX_NUMBERED_COPIES", 2)
    plan = plan_renames(images, output_folder=tmp_path, pattern="set", trigger="", overwrite_policy="unique")
    assert plan[2][1] is None
