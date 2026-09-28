"""Chat-disguise APNG: build it, recognise it, and get the real picture back.

A disguise is a PNG whose still picture (the IDAT "default image") is a cover
and whose APNG animation is the real picture. Chat-list thumbnails decode only
the still picture; an APNG-aware viewer plays the animation. The two fixture
files were written by the third-party "PNG disguise tool" people already use,
so the restore tests prove we can open what friends actually send.
"""

from __future__ import annotations

import io
import shutil
from pathlib import Path

import pytest
from PIL import Image

import database as db
import disguise_apng as disguise
from image_manager import scan_folder
from metadata_parser.png_stealth import probe_pillow_stealth_signature

FIXTURES = Path(__file__).parent / "fixtures" / "disguise"
RED = (200, 40, 40, 255)
GREEN = (40, 200, 40, 255)
YELLOW = (200, 200, 40, 255)
BLUE = (40, 40, 200, 255)


def _solid(size: tuple[int, int], color: tuple[int, int, int, int]) -> Image.Image:
    return Image.new("RGBA", size, color)


def _still_picture(data: bytes) -> Image.Image:
    with Image.open(io.BytesIO(data)) as image:
        assert image.info.get("default_image") is True
        return image.convert("RGBA").copy()


def _center(image: Image.Image) -> tuple[int, ...]:
    return image.getpixel((image.width // 2, image.height // 2))


def test_a_built_disguise_shows_the_cover_as_its_still_picture() -> None:
    data = disguise.build_disguise(_solid((40, 30), BLUE), [_solid((40, 30), RED)])

    assert _still_picture(data).tobytes() == _solid((40, 30), BLUE).tobytes()


def test_a_built_disguise_plays_the_real_picture() -> None:
    real = _solid((40, 30), RED)
    data = disguise.build_disguise(_solid((40, 30), BLUE), [real])

    frames = disguise.extract_real_frames(data)

    assert [frame.image.tobytes() for frame in frames] == [real.tobytes()]


def test_one_real_picture_still_gives_a_two_frame_animation() -> None:
    """A one-frame animation is treated as a still image by some viewers,
    which would then show the cover. A 1x1 transparent frame drawn over the
    real picture keeps the animation at two frames without changing it."""
    data = disguise.build_disguise(_solid((40, 30), BLUE), [_solid((40, 30), RED)])

    info = disguise.probe_disguise(data)

    assert info is not None
    assert info.animation_frames == 2
    assert info.real_frames == 1
    with Image.open(io.BytesIO(data)) as image:
        image.seek(image.n_frames - 1)
        assert _center(image.convert("RGBA")) == RED


def test_a_pack_keeps_every_picture_in_order_with_its_timing() -> None:
    pictures = [
        _solid((40, 30), RED),
        _solid((40, 30), GREEN),
        _solid((40, 30), YELLOW),
    ]
    data = disguise.build_disguise(_solid((40, 30), BLUE), pictures, [100, 250, 400])

    frames = disguise.extract_real_frames(data)

    assert [_center(frame.image) for frame in frames] == [RED, GREEN, YELLOW]
    assert [frame.duration_ms for frame in frames] == [100, 250, 400]
    assert disguise.probe_disguise(data).real_frames == 3


def test_pictures_of_different_sizes_share_the_largest_canvas() -> None:
    pictures = [_solid((40, 30), RED), _solid((20, 60), GREEN)]
    data = disguise.build_disguise(
        _solid((10, 10), BLUE), pictures, background=(255, 255, 255, 255)
    )

    frames = disguise.extract_real_frames(data)
    still = _still_picture(data)

    assert still.size == (40, 60)
    assert [frame.image.size for frame in frames] == [(40, 60), (40, 60)]
    assert _center(frames[0].image) == RED
    assert frames[0].image.getpixel((20, 2)) == (255, 255, 255, 255)
    assert _center(still) == BLUE


@pytest.mark.parametrize(
    ("fixture", "expected_centers", "expected_ms"),
    [
        ("reference_tool_single.png", [RED], [100]),
        ("reference_tool_three_frames.png", [RED, GREEN, YELLOW], [250, 250, 250]),
    ],
)
def test_files_from_the_reference_tool_are_recognised_and_restored(
    fixture: str, expected_centers: list, expected_ms: list[int]
) -> None:
    path = FIXTURES / fixture

    info = disguise.probe_disguise(path)
    frames = disguise.extract_real_frames(path)

    assert info is not None
    assert info.real_frames == len(expected_centers)
    assert [_center(frame.image) for frame in frames] == expected_centers
    assert [frame.duration_ms for frame in frames] == expected_ms


def test_ordinary_png_and_ordinary_apng_are_not_disguises(tmp_path: Path) -> None:
    still = tmp_path / "still.png"
    _solid((8, 8), RED).save(still)
    animated = tmp_path / "animated.png"
    _solid((8, 8), RED).save(
        animated,
        save_all=True,
        append_images=[_solid((8, 8), GREEN)],
        duration=100,
        loop=0,
    )

    assert disguise.probe_disguise(still) is None
    assert disguise.probe_disguise(animated) is None


@pytest.mark.parametrize(
    "content",
    [b"", b"not a png at all", b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR\x00"],
)
def test_unreadable_files_are_simply_not_disguises(
    tmp_path: Path, content: bytes
) -> None:
    broken = tmp_path / "broken.png"
    broken.write_bytes(content)

    assert disguise.probe_disguise(broken) is None


def test_a_truncated_disguise_is_recognised_but_the_restore_does_not_write(
    tmp_path: Path,
) -> None:
    data = disguise.build_disguise(_solid((40, 30), BLUE), [_solid((40, 30), RED)])
    real_picture_data = data.index(b"fdAT") + 8
    cut = tmp_path / "cut.png"
    cut.write_bytes(data[:real_picture_data])

    with pytest.raises(disguise.DisguiseReadError):
        disguise.restore_next_to(cut)
    assert not (tmp_path / "cut_real.png").exists()


def _stealth_image(mode: str, signature: bytes) -> Image.Image:
    """Hide a signed carrier in pixel LSBs the way NovelAI / WebUI stealth does."""
    bits = [
        (byte >> shift) & 1
        for byte in signature + (64).to_bytes(4, "big")
        for shift in range(7, -1, -1)
    ]
    image = Image.new(
        mode, (32, 32), (100, 120, 140, 254) if mode == "RGBA" else (100, 120, 140)
    )
    pixels = image.load()
    channels = (3,) if mode == "RGBA" else (0, 1, 2)
    index = 0
    for x in range(32):
        for y in range(32):
            values = list(pixels[x, y])
            for channel in channels:
                if index < len(bits):
                    values[channel] = (values[channel] & ~1) | bits[index]
                    index += 1
            pixels[x, y] = tuple(values)
    return image


@pytest.mark.parametrize(
    ("mode", "signature"),
    [
        ("RGBA", b"stealth_pngcomp"),
        ("RGBA", b"stealth_pnginfo"),
        ("RGB", b"stealth_rgbinfo"),
    ],
)
def test_scrub_removes_prompts_hidden_in_pixels_without_visible_change(
    mode: str, signature: bytes
) -> None:
    carrier = _stealth_image(mode, signature)
    carrier.info["parameters"] = "secret prompt"
    assert probe_pillow_stealth_signature(carrier) == signature

    clean = disguise.scrub_hidden_data(carrier)

    assert probe_pillow_stealth_signature(clean) is None
    assert clean.info == {}
    before = carrier.convert("RGBA").tobytes()
    after = clean.tobytes()
    assert max(abs(a - b) for a, b in zip(before, after)) <= 1


def test_scrub_keeps_fully_transparent_pixels_transparent() -> None:
    image = Image.new("RGBA", (4, 4), (0, 0, 0, 0))

    clean = disguise.scrub_hidden_data(image)

    assert clean.getpixel((1, 1))[3] == 0


def test_restore_writes_the_real_picture_next_to_the_disguise(tmp_path: Path) -> None:
    source = tmp_path / "from_friend.png"
    source.write_bytes(
        disguise.build_disguise(_solid((40, 30), BLUE), [_solid((40, 30), RED)])
    )

    restored = disguise.restore_next_to(source)

    assert restored == tmp_path / "from_friend_real.png"
    with Image.open(restored) as image:
        assert image.size == (40, 30)
        assert getattr(image, "n_frames", 1) == 1
        assert _center(image.convert("RGBA")) == RED
    assert disguise.probe_disguise(restored) is None


def test_restore_of_a_pack_writes_an_ordinary_animation(tmp_path: Path) -> None:
    source = FIXTURES / "reference_tool_three_frames.png"
    local = tmp_path / "pack.png"
    shutil.copyfile(source, local)

    restored = disguise.restore_next_to(local)

    assert disguise.probe_disguise(restored) is None
    with Image.open(restored) as image:
        assert image.n_frames == 3
        assert not image.info.get("default_image")
        centers = []
        for index in range(3):
            image.seek(index)
            centers.append(_center(image.convert("RGBA")))
    assert centers == [RED, GREEN, YELLOW]


def test_restore_never_overwrites_an_existing_file(tmp_path: Path) -> None:
    source = tmp_path / "from_friend.png"
    source.write_bytes(
        disguise.build_disguise(_solid((40, 30), BLUE), [_solid((40, 30), RED)])
    )
    existing = tmp_path / "from_friend_real.png"
    existing.write_bytes(b"the user's own file")

    assert disguise.restore_next_to(source) is None
    assert existing.read_bytes() == b"the user's own file"


def test_restore_ignores_files_that_are_not_disguises(tmp_path: Path) -> None:
    plain = tmp_path / "plain.png"
    _solid((8, 8), RED).save(plain)

    assert disguise.restore_next_to(plain) is None
    assert not (tmp_path / "plain_real.png").exists()


def _library_with_a_received_disguise(tmp_path: Path) -> Path:
    library = tmp_path / "library"
    library.mkdir()
    shutil.copyfile(FIXTURES / "reference_tool_single.png", library / "qq_image.png")
    _solid((16, 16), GREEN).save(library / "normal.png")
    return library


def test_a_scan_restores_a_received_disguise_and_indexes_both_files(
    test_db, tmp_path: Path
) -> None:
    library = _library_with_a_received_disguise(tmp_path)

    result = scan_folder(str(library), recursive=False, metadata_workers=1)

    restored = library / "qq_image_real.png"
    assert restored.is_file()
    assert result["disguise_restored"] == 1
    assert db.get_image_by_path(str(library / "qq_image.png")) is not None
    assert db.get_image_by_path(str(restored)) is not None
    assert db.get_image_by_path(str(library / "normal.png")) is not None


def test_a_rescan_does_not_restore_the_same_file_again(test_db, tmp_path: Path) -> None:
    library = _library_with_a_received_disguise(tmp_path)
    scan_folder(str(library), recursive=False, metadata_workers=1)
    first_bytes = (library / "qq_image_real.png").read_bytes()

    result = scan_folder(str(library), recursive=False, metadata_workers=1)

    assert result["disguise_restored"] == 0
    assert (library / "qq_image_real.png").read_bytes() == first_bytes
    assert sorted(path.name for path in library.iterdir()) == [
        "normal.png",
        "qq_image.png",
        "qq_image_real.png",
    ]


def test_a_scan_can_leave_disguises_alone(test_db, tmp_path: Path) -> None:
    library = _library_with_a_received_disguise(tmp_path)

    result = scan_folder(
        str(library), recursive=False, metadata_workers=1, restore_disguised=False
    )

    assert result["disguise_restored"] == 0
    assert not (library / "qq_image_real.png").exists()


def test_a_failed_restore_is_reported_and_the_scan_goes_on(
    test_db, tmp_path: Path, monkeypatch
) -> None:
    library = _library_with_a_received_disguise(tmp_path)

    def refuse_to_write(path: Path, data: bytes) -> bool:
        raise PermissionError("read-only folder")

    monkeypatch.setattr(disguise, "_write_new_file", refuse_to_write)

    result = scan_folder(str(library), recursive=False, metadata_workers=1)

    assert result["disguise_restored"] == 0
    assert result["disguise_restore_failed"] == 1
    assert db.get_image_by_path(str(library / "qq_image.png")) is not None
    assert db.get_image_by_path(str(library / "normal.png")) is not None


def test_the_scan_total_counts_the_restored_picture(test_db, tmp_path: Path) -> None:
    library = _library_with_a_received_disguise(tmp_path)

    result = scan_folder(str(library), recursive=False, metadata_workers=1)

    assert result["total"] == 3
    assert result["new"] == 3


def test_the_scan_summary_says_how_many_real_pictures_were_restored(test_client, tmp_path: Path) -> None:
    library = _library_with_a_received_disguise(tmp_path)

    test_client.post("/api/scan", json={"folder_path": str(library), "recursive": False})
    progress = test_client.get("/api/scan/progress").json()

    assert progress["status"] == "done"
    assert "还原了 1 张伪装图" in progress["message"]
    assert "Restored 1 disguise image(s)" in progress["message"]


def test_the_scan_summary_names_restores_that_failed(test_client, tmp_path: Path, monkeypatch) -> None:
    library = _library_with_a_received_disguise(tmp_path)

    def refuse_to_write(path: Path, data: bytes) -> bool:
        raise PermissionError("read-only folder")

    monkeypatch.setattr(disguise, "_write_new_file", refuse_to_write)

    test_client.post("/api/scan", json={"folder_path": str(library), "recursive": False})
    progress = test_client.get("/api/scan/progress").json()

    assert "1 张伪装图没能还原" in progress["message"]
    assert "1 disguise image(s) could not be restored" in progress["message"]
