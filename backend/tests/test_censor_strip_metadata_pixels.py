"""Stripping generation metadata never changes what the picture looks like.

``CensorService._strip_all_metadata`` rebuilt the image with
``Image.new(mode)`` + ``putdata``. For a palette (P mode) image that copies the
palette indices onto Pillow's default palette, so every colour came out wrong,
and the transparent index was lost with the rest of ``info``.
"""

from __future__ import annotations

import tracemalloc
from pathlib import Path
from types import ModuleType

import pytest
from fastapi.testclient import TestClient
from PIL import Image, PngImagePlugin

from services.censor_service import CensorService

_PALETTE_COLOURS = [(220, 30, 40), (20, 180, 60), (30, 60, 220), (250, 250, 250)]


def _palette_image(*, transparent_index: int | None = None) -> Image.Image:
    image = Image.new("P", (8, 8))
    flat: list[int] = []
    for colour in _PALETTE_COLOURS:
        flat.extend(colour)
    image.putpalette(flat + [0] * (768 - len(flat)))
    for x in range(8):
        for y in range(8):
            image.putpixel((x, y), (x + y) % len(_PALETTE_COLOURS))
    image.info["parameters"] = "1girl, secret prompt"
    if transparent_index is not None:
        image.info["transparency"] = transparent_index
    return image


def test_a_palette_image_keeps_its_colours():
    image = _palette_image()

    stripped = CensorService._strip_all_metadata(image)

    assert "parameters" not in stripped.info
    assert stripped.convert("RGB").tobytes() == image.convert("RGB").tobytes()


def test_a_palette_image_keeps_its_transparent_colour():
    image = _palette_image(transparent_index=3)

    stripped = CensorService._strip_all_metadata(image)

    assert "parameters" not in stripped.info
    assert stripped.convert("RGBA").tobytes() == image.convert("RGBA").tobytes()


def test_saving_an_unedited_palette_png_without_metadata_keeps_its_colours(
    test_client: TestClient, test_db: ModuleType, tmp_path: Path
) -> None:
    source = tmp_path / "palette.png"
    original = _palette_image(transparent_index=3)
    info = PngImagePlugin.PngInfo()
    info.add_text("parameters", "1girl, secret prompt")
    original.save(source, format="PNG", pnginfo=info, transparency=3)
    image_id = int(
        test_db.add_image(path=str(source), filename=source.name, metadata_json="{}")
    )
    out_dir = tmp_path / "out"

    response = test_client.post(
        "/api/censor/save-original",
        json={
            "original_image_id": image_id,
            "filename": "palette_out",
            "output_folder": str(out_dir),
            "metadata_option": "strip",
            "output_format": "original",
        },
    )

    assert response.status_code == 200, response.text
    with Image.open(source) as before, Image.open(out_dir / "palette_out.png") as after:
        assert "parameters" not in after.info
        assert after.convert("RGBA").tobytes() == before.convert("RGBA").tobytes()


@pytest.mark.parametrize("mode", ["RGB", "RGBA", "L", "LA", "1", "I;16", "CMYK", "P"])
def test_every_mode_keeps_its_exact_pixels(mode):
    image = Image.effect_noise((33, 17), 60).convert(mode)
    image.info["parameters"] = "1girl, secret prompt"

    stripped = CensorService._strip_all_metadata(image)

    assert stripped.mode == mode
    assert "parameters" not in stripped.info
    assert stripped.tobytes() == image.tobytes()


def test_stripping_does_not_copy_every_pixel_into_python_objects():
    """#10: a 2 MP strip took ~1.5 s and ~160 MB of Python objects (a tuple per pixel)."""
    image = Image.effect_noise((1600, 1250), 60).convert("RGB")
    image.info["parameters"] = "1girl, secret prompt"
    raw_bytes = len(image.tobytes())

    tracemalloc.start()
    try:
        CensorService._strip_all_metadata(image)
        _current, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()

    assert peak < 4 * raw_bytes, f"peak {peak / 1e6:.1f} MB for {raw_bytes / 1e6:.1f} MB of pixels"
