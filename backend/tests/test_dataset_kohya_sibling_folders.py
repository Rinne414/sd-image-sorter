"""Re-exporting with new repeats or a new trigger warns about the old folder.

kohya reads every `<repeats>_<name>` folder under its train dir. Exporting
`10_foo` and later `15_foo` into one output folder trains the same pictures
twice; the confirm only looked at the new, empty folder and said nothing
(review of the kohya layout, 2026-10-05).
"""

from __future__ import annotations

from pathlib import Path

from services.dataset_export._constants import EXPORT_MANIFEST_FILENAME
from services.dataset_export.output_folder import output_folder_status


def _export(folder: Path) -> None:
    folder.mkdir(parents=True)
    (folder / "001.png").write_bytes(b"x")
    (folder / EXPORT_MANIFEST_FILENAME).write_text("{}", encoding="utf-8")


def test_a_new_kohya_folder_lists_earlier_exports_beside_it(tmp_path: Path) -> None:
    _export(tmp_path / "10_foo")
    _export(tmp_path / "8_bar")
    (tmp_path / "12_notes").mkdir()  # no export manifest: not a dataset
    (tmp_path / "reg").mkdir()

    status = output_folder_status(str(tmp_path / "15_foo"))

    assert status["exists"] is False
    assert status["other_kohya_folders"] == ["10_foo", "8_bar"]


def test_a_flat_or_lone_folder_reports_no_siblings(tmp_path: Path) -> None:
    _export(tmp_path / "10_foo")

    assert output_folder_status(str(tmp_path / "10_foo"))["other_kohya_folders"] == []
    assert output_folder_status(str(tmp_path))["other_kohya_folders"] == []
