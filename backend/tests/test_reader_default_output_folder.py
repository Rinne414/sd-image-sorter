"""The Reader's default save folder is made by the save, any other is not."""

from pathlib import Path

import config
from services.image import serving


def test_default_reader_folder_is_created(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "output_root", lambda: tmp_path / "output")
    target = tmp_path / "output" / "reader" / "picture.edited.png"

    serving.ensure_reader_output_folder(str(target))

    assert target.parent.is_dir()


def test_other_missing_folders_are_not_created(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "output_root", lambda: tmp_path / "output")
    typed = tmp_path / "somewhere" / "else" / "picture.png"
    nested = tmp_path / "output" / "reader" / "deeper" / "picture.png"

    serving.ensure_reader_output_folder(str(typed))
    serving.ensure_reader_output_folder(str(nested))

    assert not typed.parent.exists()
    assert not (tmp_path / "output").exists()


def test_bad_paths_are_left_to_validation(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "output_root", lambda: tmp_path / "output")

    serving.ensure_reader_output_folder("")

    assert not (tmp_path / "output").exists()
    assert Path(tmp_path).is_dir()
