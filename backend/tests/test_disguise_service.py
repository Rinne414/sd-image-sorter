"""Making disguise images: covers, sizing, scrubbing, and the made-here registry."""

from __future__ import annotations

import io
from pathlib import Path

import pytest
from PIL import Image, ImageStat

import disguise_apng
import disguise_registry
from metadata_parser.png_stealth import probe_pillow_stealth_signature
from services import disguise_service as service
from services.disguise_service import CoverSpec, CoverUnavailable, MakeOptions

RED = (200, 40, 40, 255)
BLUE = (40, 40, 200, 255)


@pytest.fixture(autouse=True)
def _isolated_data_dir(tmp_path: Path, monkeypatch) -> Path:
    data = tmp_path / "data"
    data.mkdir()
    monkeypatch.setattr(disguise_registry, "get_data_dir", lambda: str(data))
    return data


def _checkerboard(size: tuple[int, int], cell: int = 2) -> Image.Image:
    image = Image.new("RGBA", size, (0, 0, 0, 255))
    pixels = image.load()
    for x in range(size[0]):
        for y in range(size[1]):
            if (x // cell + y // cell) % 2:
                pixels[x, y] = (255, 255, 255, 255)
    return image


def _still_picture(data: bytes) -> Image.Image:
    with Image.open(io.BytesIO(data)) as image:
        return image.convert("RGBA").copy()


@pytest.mark.parametrize(
    ("size", "block"), [((4000, 3000), 40), ((1600, 900), 16), ((200, 100), 4)]
)
def test_mosaic_cells_follow_the_long_side_with_a_4px_floor(size, block) -> None:
    assert service.mosaic_block_size(size) == block


def test_regions_use_the_polygon_when_there_is_one_and_the_box_otherwise() -> None:
    mask = service.regions_mask(
        (100, 100),
        [
            {
                "box": [0, 0, 100, 100],
                "polygon": [[10, 10], [30, 10], [30, 30], [10, 30]],
            },
            {"box": [60, 60, 80, 80]},
        ],
    )

    assert mask.getpixel((20, 20)) == 255
    assert mask.getpixel((50, 50)) == 0
    assert mask.getpixel((70, 70)) == 255


def test_the_mosaic_cover_changes_only_the_detected_region() -> None:
    picture = _checkerboard((400, 400))
    mask = service.regions_mask((400, 400), [{"box": [100, 100, 300, 300]}])

    cover = service.mosaic_cover(picture, mask)

    assert (
        cover.crop((0, 0, 100, 100)).tobytes()
        == picture.crop((0, 0, 100, 100)).tobytes()
    )
    inside_before = ImageStat.Stat(
        picture.crop((100, 100, 300, 300)).convert("L")
    ).stddev[0]
    inside_after = ImageStat.Stat(cover.crop((100, 100, 300, 300)).convert("L")).stddev[
        0
    ]
    assert inside_after < inside_before / 4


def test_a_mosaic_cover_needs_something_detected() -> None:
    with pytest.raises(CoverUnavailable) as caught:
        service.mosaic_cover(_checkerboard((50, 50)), Image.new("L", (50, 50), 0))

    assert caught.value.reason == "nothing_detected"


def test_the_blur_cover_leaves_no_fine_detail() -> None:
    picture = _checkerboard((300, 200))

    cover = service.blurred_cover(picture)

    assert cover.size == (300, 200)
    assert ImageStat.Stat(cover.convert("L")).stddev[0] < 5


def test_the_text_card_draws_the_text_centered_on_its_background() -> None:
    card = service.text_card(
        (400, 300), "点开看原图\nOpen to view", "#102030", "#ffffff"
    )

    assert card.size == (400, 300)
    assert card.getpixel((2, 2)) == (16, 32, 48, 255)
    colors = card.getcolors(maxcolors=100_000)
    assert len(colors) > 1


def test_an_empty_text_card_is_just_the_background() -> None:
    card = service.text_card((40, 30), "  ", "#102030", "#ffffff")

    assert card.getcolors() == [(40 * 30, (16, 32, 48, 255))]


@pytest.mark.parametrize(
    ("spec", "reason"),
    [
        (CoverSpec(kind="default"), "no_default_cover"),
        (CoverSpec(kind="upload"), "no_upload"),
        (CoverSpec(kind="mosaic"), "not_in_library"),
    ],
)
def test_covers_that_cannot_be_made_say_why(spec: CoverSpec, reason: str) -> None:
    with pytest.raises(CoverUnavailable) as caught:
        service.resolve_cover(spec, Image.new("RGBA", (10, 10), RED))

    assert caught.value.reason == reason


def test_an_unknown_cover_kind_is_a_caller_error() -> None:
    with pytest.raises(ValueError):
        service.resolve_cover(
            CoverSpec(kind="rainbow"), Image.new("RGBA", (10, 10), RED)
        )


def test_the_default_cover_is_saved_loaded_and_cleared(
    _isolated_data_dir: Path,
) -> None:
    assert service.load_default_cover() is None

    service.save_default_cover(Image.new("RGBA", (30, 20), BLUE))
    loaded = service.load_default_cover()

    assert loaded.size == (30, 20)
    assert loaded.getpixel((5, 5))[:3] == (40, 40, 200)
    assert service.clear_default_cover() is True
    assert service.load_default_cover() is None
    assert service.clear_default_cover() is False


def test_a_made_disguise_shows_the_cover_and_plays_the_pictures() -> None:
    made = service.make_disguise(
        [Image.new("RGBA", (60, 40), RED)],
        CoverSpec(kind="upload", upload=Image.new("RGBA", (60, 40), BLUE)),
        MakeOptions(scrub=False),
    )

    assert disguise_apng.probe_disguise(made.data).real_frames == 1
    assert _still_picture(made.data).getpixel((30, 20)) == BLUE
    frames = disguise_apng.extract_real_frames(made.data)
    assert frames[0].image.getpixel((30, 20)) == RED
    assert made.cover.getpixel((30, 20)) == BLUE


def test_pictures_larger_than_the_limit_are_scaled_down_and_zero_keeps_them() -> None:
    big = Image.new("RGBA", (3200, 1600), RED)
    cover = CoverSpec(kind="blur")

    limited = service.make_disguise(
        [big], cover, MakeOptions(max_side=1600, scrub=False)
    )
    kept = service.make_disguise([big], cover, MakeOptions(max_side=0, scrub=False))

    assert (limited.width, limited.height) == (1600, 800)
    assert (kept.width, kept.height) == (3200, 1600)


def test_scrubbing_removes_prompts_hidden_in_the_pictures() -> None:
    carrier = Image.new("RGBA", (32, 32), (100, 120, 140, 254))
    bits = [
        (byte >> shift) & 1
        for byte in b"stealth_pngcomp" + (64).to_bytes(4, "big")
        for shift in range(7, -1, -1)
    ]
    pixels = carrier.load()
    for index, bit in enumerate(bits):
        x, y = divmod(index, 32)
        r, g, b, a = pixels[x, y]
        pixels[x, y] = (r, g, b, (a & ~1) | bit)
    assert probe_pillow_stealth_signature(carrier) == b"stealth_pngcomp"

    made = service.make_disguise(
        [carrier], CoverSpec(kind="blur"), MakeOptions(max_side=0)
    )

    real = disguise_apng.extract_real_frames(made.data)[0].image
    assert probe_pillow_stealth_signature(real) is None


def test_a_mosaic_cover_hides_the_detected_part_of_the_first_picture() -> None:
    picture = _checkerboard((400, 400))

    made = service.make_disguise(
        [picture],
        CoverSpec(kind="mosaic"),
        MakeOptions(scrub=False),
        detect_regions=lambda: [{"box": [100, 100, 300, 300]}],
    )

    still = _still_picture(made.data)
    real = disguise_apng.extract_real_frames(made.data)[0].image
    assert ImageStat.Stat(still.crop((100, 100, 300, 300)).convert("L")).stddev[0] < 30
    assert real.tobytes() == picture.tobytes()


def test_our_own_disguises_are_remembered_so_a_scan_leaves_them_alone(
    tmp_path: Path,
) -> None:
    made = service.make_disguise(
        [Image.new("RGBA", (20, 20), RED)], CoverSpec(kind="blur")
    )
    ours = tmp_path / "ours.png"
    ours.write_bytes(made.data)
    received = tmp_path / "received.png"
    received.write_bytes(
        disguise_apng.build_disguise(
            Image.new("RGBA", (20, 20), BLUE), [Image.new("RGBA", (20, 20), RED)]
        )
    )

    assert disguise_registry.was_made_here(ours) is True
    assert disguise_registry.was_made_here(received) is False


def test_a_cover_that_cannot_be_made_writes_nothing(tmp_path: Path) -> None:
    with pytest.raises(CoverUnavailable):
        service.make_disguise(
            [Image.new("RGBA", (20, 20), RED)],
            CoverSpec(kind="mosaic"),
            detect_regions=lambda: [],
        )

    assert not (
        disguise_registry.disguise_dir() / disguise_registry.REGISTRY_NAME
    ).exists()
