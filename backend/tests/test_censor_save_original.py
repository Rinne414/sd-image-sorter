"""Reorder-and-rename exports save unedited images straight from their source.

The censor queue used to push every unedited image through a browser canvas:
a JPG came back as a large PNG, alpha and colour went through the canvas, and
big images hit the 40 MP canvas limit. /api/censor/save-original copies the
file byte for byte when the format and metadata are kept, and re-encodes on
the server otherwise.
"""

from __future__ import annotations

from pathlib import Path
from types import ModuleType

from fastapi.testclient import TestClient
from PIL import Image, PngImagePlugin


def _png_with_prompt(path: Path) -> None:
    info = PngImagePlugin.PngInfo()
    info.add_text("parameters", "1girl, solo, masterpiece")
    Image.new("RGB", (32, 24), (200, 120, 40)).save(path, format="PNG", pnginfo=info)


def _add_image(db: ModuleType, path: Path) -> int:
    return int(db.add_image(path=str(path), filename=path.name, metadata_json="{}"))


def test_same_format_with_metadata_kept_is_a_byte_copy(
    test_client: TestClient, test_db: ModuleType, tmp_path: Path
) -> None:
    source = tmp_path / "source.jpg"
    Image.new("RGB", (40, 30), (10, 90, 200)).save(source, format="JPEG", quality=83)
    image_id = _add_image(test_db, source)
    out_dir = tmp_path / "out"

    response = test_client.post(
        "/api/censor/save-original",
        json={
            "original_image_id": image_id,
            "filename": "pixiv_set_001.png",
            "output_folder": str(out_dir),
            "metadata_option": "keep",
            "output_format": "original",
        },
    )

    assert response.status_code == 200, response.text
    written = out_dir / "pixiv_set_001.jpg"
    assert written.read_bytes() == source.read_bytes()


def test_strip_removes_the_prompt_and_keeps_the_source_format(
    test_client: TestClient, test_db: ModuleType, tmp_path: Path
) -> None:
    source = tmp_path / "prompted.png"
    _png_with_prompt(source)
    image_id = _add_image(test_db, source)
    out_dir = tmp_path / "out"

    response = test_client.post(
        "/api/censor/save-original",
        json={
            "original_image_id": image_id,
            "filename": "set_000",
            "output_folder": str(out_dir),
            "metadata_option": "strip",
            "output_format": "original",
        },
    )

    assert response.status_code == 200, response.text
    with Image.open(out_dir / "set_000.png") as saved:
        saved.load()
        assert saved.format == "PNG"
        assert "parameters" not in saved.info
        assert saved.size == (32, 24)


def test_an_explicit_format_re_encodes(
    test_client: TestClient, test_db: ModuleType, tmp_path: Path
) -> None:
    source = tmp_path / "source.png"
    _png_with_prompt(source)
    image_id = _add_image(test_db, source)
    out_dir = tmp_path / "out"

    response = test_client.post(
        "/api/censor/save-original",
        json={
            "original_image_id": image_id,
            "filename": "converted.png",
            "output_folder": str(out_dir),
            "metadata_option": "strip",
            "output_format": "webp",
        },
    )

    assert response.status_code == 200, response.text
    with Image.open(out_dir / "converted.webp") as saved:
        assert saved.format == "WEBP"


def test_an_existing_file_is_not_overwritten_without_permission(
    test_client: TestClient, test_db: ModuleType, tmp_path: Path
) -> None:
    source = tmp_path / "source.png"
    _png_with_prompt(source)
    image_id = _add_image(test_db, source)
    out_dir = tmp_path / "out"
    out_dir.mkdir()
    (out_dir / "taken.png").write_bytes(b"keep me")

    response = test_client.post(
        "/api/censor/save-original",
        json={
            "original_image_id": image_id,
            "filename": "taken.png",
            "output_folder": str(out_dir),
            "metadata_option": "keep",
            "output_format": "original",
        },
    )

    assert response.status_code == 409, response.text
    assert (out_dir / "taken.png").read_bytes() == b"keep me"
