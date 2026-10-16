"""A Censor save asked to keep the metadata says when it could not.

When the original picture's file was gone (moved, deleted) or its row was
missing, the save went on without its prompt and EXIF and answered "ok" with
no warning: the user believed the metadata was kept and might delete the
original. The save now reports it in its warnings, which the Censor page
shows.
"""

from __future__ import annotations

import base64
from io import BytesIO
from pathlib import Path
from types import ModuleType

from fastapi.testclient import TestClient
from PIL import Image, PngImagePlugin

from services.censor.output_io import METADATA_NOT_COPIED_WARNING


def _png_with_prompt(path: Path) -> None:
    info = PngImagePlugin.PngInfo()
    info.add_text("parameters", "1girl, solo, masterpiece")
    Image.new("RGB", (32, 24), (200, 120, 40)).save(path, format="PNG", pnginfo=info)


def _canvas_data_url() -> str:
    buffer = BytesIO()
    Image.new("RGB", (32, 24), (0, 0, 0)).save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode(
        "ascii"
    )


def _save_canvas(client: TestClient, image_id: int, out_dir: Path) -> dict:
    response = client.post(
        "/api/censor/save-data",
        json={
            "image_data": _canvas_data_url(),
            "original_image_id": image_id,
            "filename": "edited.png",
            "output_folder": str(out_dir),
            "metadata_option": "keep",
            "output_format": "png",
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_a_kept_metadata_save_from_a_readable_original_copies_it_without_warning(
    test_client: TestClient, test_db: ModuleType, tmp_path: Path
) -> None:
    source = tmp_path / "source.png"
    _png_with_prompt(source)
    image_id = int(
        test_db.add_image(path=str(source), filename=source.name, metadata_json="{}")
    )

    body = _save_canvas(test_client, image_id, tmp_path / "out")

    assert body["warnings"] == []
    with Image.open(tmp_path / "out" / "edited.png") as saved:
        assert saved.info.get("parameters") == "1girl, solo, masterpiece"


def test_an_original_that_was_moved_away_is_reported_not_copied(
    test_client: TestClient, test_db: ModuleType, tmp_path: Path
) -> None:
    source = tmp_path / "moved.png"
    _png_with_prompt(source)
    image_id = int(
        test_db.add_image(path=str(source), filename=source.name, metadata_json="{}")
    )
    source.unlink()

    body = _save_canvas(test_client, image_id, tmp_path / "out")

    assert body["warnings"] == [METADATA_NOT_COPIED_WARNING]
    with Image.open(tmp_path / "out" / "edited.png") as saved:
        assert "parameters" not in saved.info


def test_an_original_whose_row_is_gone_is_reported_not_copied(
    test_client: TestClient, test_db: ModuleType, tmp_path: Path
) -> None:
    source = tmp_path / "removed.png"
    _png_with_prompt(source)
    image_id = int(
        test_db.add_image(path=str(source), filename=source.name, metadata_json="{}")
    )
    test_db.delete_image(image_id)

    body = _save_canvas(test_client, image_id, tmp_path / "out")

    assert body["warnings"] == [METADATA_NOT_COPIED_WARNING]


def test_a_byte_copy_cut_short_leaves_the_existing_file_and_no_partial_one(
    test_client: TestClient, test_db: ModuleType, tmp_path: Path, monkeypatch
) -> None:
    """Same format with metadata kept is a byte copy; one cut short (disk
    full) used to truncate the file it replaced."""
    import services.censor.output_io as output_io

    source = tmp_path / "source.png"
    _png_with_prompt(source)
    image_id = int(test_db.add_image(path=str(source), filename=source.name, metadata_json="{}"))
    out_dir = tmp_path / "out"
    out_dir.mkdir()
    (out_dir / "export.png").write_bytes(b"the earlier export")

    def disk_full(src, dst, *args, **kwargs):
        Path(dst).write_bytes(Path(src).read_bytes()[:10])
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(output_io.shutil, "copyfile", disk_full)
    response = test_client.post(
        "/api/censor/save-original",
        json={
            "original_image_id": image_id,
            "filename": "export.png",
            "output_folder": str(out_dir),
            "metadata_option": "keep",
            "output_format": "original",
            "allow_overwrite": True,
        },
    )

    assert response.status_code == 500, response.text
    assert (out_dir / "export.png").read_bytes() == b"the earlier export"
    assert sorted(p.name for p in out_dir.iterdir()) == ["export.png"]


def test_staging_files_end_in_tmp_so_a_left_one_is_never_scanned_as_a_picture(
    test_client: TestClient, test_db: ModuleType, tmp_path: Path, monkeypatch
) -> None:
    import services.censor.output_io as output_io

    staged: list[str] = []
    real_create = output_io.create_staging_sibling

    def recording(target):
        staging, descriptor = real_create(target)
        staged.append(staging.name)
        return staging, descriptor

    monkeypatch.setattr(output_io, "create_staging_sibling", recording)
    source = tmp_path / "source.png"
    _png_with_prompt(source)
    image_id = int(test_db.add_image(path=str(source), filename=source.name, metadata_json="{}"))
    _save_canvas(test_client, image_id, tmp_path / "out")
    response = test_client.post(
        "/api/censor/save-original",
        json={
            "original_image_id": image_id,
            "filename": "copy.png",
            "output_folder": str(tmp_path / "out"),
            "metadata_option": "keep",
            "output_format": "original",
        },
    )
    assert response.status_code == 200, response.text

    assert len(staged) >= 2
    assert all(name.endswith(".tmp") for name in staged), staged
