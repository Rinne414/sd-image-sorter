"""Tests for signed Stealth PNG Info prompt carriers."""

import gzip
import json
import sys
from pathlib import Path

import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent.parent))

import metadata_parser as metadata_parser_module
from metadata_parser import parse_image


_WEBUI_PARAMETERS = (
    "signed carrier prompt\n"
    "Negative prompt: lowres\n"
    "Steps: 24, Sampler: Euler a, CFG scale: 7, Seed: 42, "
    "Size: 32x160, Model: carrier-model.safetensors"
)


def _bytes_to_bits(value: bytes) -> list[int]:
    return [
        (byte >> shift) & 1
        for byte in value
        for shift in range(7, -1, -1)
    ]


def _write_stealth_png(
    path: Path,
    signature: bytes,
    payload: bytes,
    declared_bit_length: int,
    mode: str,
) -> None:
    width = 32
    height = 160
    header = signature + declared_bit_length.to_bytes(4, "big")
    bits = _bytes_to_bits(header + payload)
    channels_per_pixel = 1 if signature.startswith(b"stealth_png") else 3
    if len(bits) > width * height * channels_per_pixel:
        raise ValueError("Test carrier does not fit in the fixture image")

    base_pixel = (100, 120, 140, 254) if mode == "RGBA" else (100, 120, 140)
    image = Image.new(mode, (width, height), color=base_pixel)
    pixels = image.load()
    bit_index = 0
    for x in range(width):
        for y in range(height):
            values = list(pixels[x, y])
            channel_indexes = (3,) if channels_per_pixel == 1 else (0, 1, 2)
            for channel_index in channel_indexes:
                if bit_index >= len(bits):
                    break
                values[channel_index] = (values[channel_index] & ~1) | bits[bit_index]
                bit_index += 1
            pixels[x, y] = tuple(values)
            if bit_index >= len(bits):
                break
        if bit_index >= len(bits):
            break
    image.save(path)


@pytest.mark.parametrize(
    ("signature", "mode", "compressed"),
    [
        (b"stealth_pnginfo", "RGBA", False),
        (b"stealth_pngcomp", "RGBA", True),
        (b"stealth_rgbinfo", "RGB", False),
        (b"stealth_rgbcomp", "RGB", True),
    ],
)
def test_signed_stealth_webui_carriers_use_existing_detector(
    tmp_path: Path,
    signature: bytes,
    mode: str,
    compressed: bool,
) -> None:
    image_path = tmp_path / f"{signature.decode('ascii')}.png"
    plain_payload = _WEBUI_PARAMETERS.encode("utf-8")
    payload = gzip.compress(plain_payload) if compressed else plain_payload
    _write_stealth_png(
        image_path,
        signature,
        payload,
        len(payload) * 8,
        mode,
    )

    result = parse_image(str(image_path))

    assert result["parse_error"] is None
    assert result["metadata_error"] is None
    assert result["generator"] == "webui"
    assert result["prompt"] == "signed carrier prompt"
    assert result["negative_prompt"] == "lowres"
    assert result["checkpoint"] == "carrier-model.safetensors"
    assert result["metadata"]["parameters"] == _WEBUI_PARAMETERS


def test_signed_stealth_novelai_json_uses_existing_detector(tmp_path: Path) -> None:
    image_path = tmp_path / "novelai-stealth.png"
    metadata = {
        "Description": "signed NovelAI prompt",
        "Software": "NovelAI",
        "Source": "NovelAI Diffusion Anime V3",
        "Comment": json.dumps({
            "prompt": "signed NovelAI prompt",
            "uc": "bad anatomy",
            "steps": 28,
            "sampler": "k_euler",
        }),
    }
    plain_payload = json.dumps(metadata).encode("utf-8")
    payload = gzip.compress(plain_payload)
    _write_stealth_png(
        image_path,
        b"stealth_pngcomp",
        payload,
        len(payload) * 8,
        "RGBA",
    )

    result = parse_image(str(image_path))

    assert result["parse_error"] is None
    assert result["metadata_error"] is None
    assert result["generator"] == "nai"
    assert result["prompt"] == "signed NovelAI prompt"
    assert result["negative_prompt"] == "bad anatomy"
    assert result["checkpoint"] == "NovelAI Diffusion Anime V3"


def test_corrupt_recognized_stealth_gzip_is_nonfatal_metadata_error(tmp_path: Path) -> None:
    image_path = tmp_path / "corrupt-stealth.png"
    payload = b"not a gzip stream"
    _write_stealth_png(
        image_path,
        b"stealth_pngcomp",
        payload,
        len(payload) * 8,
        "RGBA",
    )

    result = parse_image(str(image_path))

    assert result["parse_error"] is None
    assert result["generator"] == "unknown"
    assert result["metadata_error"].startswith(
        "PNG Stealth metadata could not be parsed: invalid gzip payload"
    )
    assert result["width"] == 32
    assert result["height"] == 160


def test_recognized_stealth_declared_length_over_capacity_is_nonfatal(tmp_path: Path) -> None:
    image_path = tmp_path / "truncated-stealth.png"
    _write_stealth_png(
        image_path,
        b"stealth_pnginfo",
        b"",
        100_000,
        "RGBA",
    )

    result = parse_image(str(image_path))

    assert result["parse_error"] is None
    assert result["generator"] == "unknown"
    assert "declares 100000 payload bits" in result["metadata_error"]
    assert "image capacity" in result["metadata_error"]


def test_recognized_stealth_payload_respects_png_chunk_cap(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    image_path = tmp_path / "oversize-stealth.png"
    payload = b"123456789abcde"
    _write_stealth_png(
        image_path,
        b"stealth_pnginfo",
        payload,
        len(payload) * 8,
        "RGBA",
    )
    monkeypatch.setattr(metadata_parser_module, "_MAX_PNG_CHUNK_BYTES", 13)

    result = parse_image(str(image_path))

    assert result["parse_error"] is None
    assert result["generator"] == "unknown"
    assert "exceeds the 13-byte encoded payload limit" in result["metadata_error"]


def test_recognized_stealth_gzip_respects_decompressed_cap(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    image_path = tmp_path / "gzip-bomb-stealth.png"
    payload = gzip.compress(b"A" * 65)
    _write_stealth_png(
        image_path,
        b"stealth_pngcomp",
        payload,
        len(payload) * 8,
        "RGBA",
    )
    monkeypatch.setattr(metadata_parser_module, "_MAX_DECOMPRESSED_BYTES", 64)

    result = parse_image(str(image_path))

    assert result["parse_error"] is None
    assert result["generator"] == "unknown"
    assert "exceeds the 64-byte decompressed payload limit" in result["metadata_error"]


def test_recognized_stealth_rejects_non_byte_aligned_length(tmp_path: Path) -> None:
    image_path = tmp_path / "unaligned-stealth.png"
    _write_stealth_png(
        image_path,
        b"stealth_pnginfo",
        b"x",
        7,
        "RGBA",
    )

    result = parse_image(str(image_path))

    assert result["parse_error"] is None
    assert result["generator"] == "unknown"
    assert "declared payload length 7 bits is not byte-aligned" in result["metadata_error"]


def test_recognized_stealth_rejects_invalid_utf8(tmp_path: Path) -> None:
    image_path = tmp_path / "invalid-utf8-stealth.png"
    payload = b"\xff"
    _write_stealth_png(
        image_path,
        b"stealth_pnginfo",
        payload,
        len(payload) * 8,
        "RGBA",
    )

    result = parse_image(str(image_path))

    assert result["parse_error"] is None
    assert result["generator"] == "unknown"
    assert "payload is not valid UTF-8 at byte 0" in result["metadata_error"]


def test_recognized_stealth_rejects_malformed_json_claim(tmp_path: Path) -> None:
    image_path = tmp_path / "invalid-json-stealth.png"
    payload = b"{broken json"
    _write_stealth_png(
        image_path,
        b"stealth_pnginfo",
        payload,
        len(payload) * 8,
        "RGBA",
    )

    result = parse_image(str(image_path))

    assert result["parse_error"] is None
    assert result["generator"] == "unknown"
    assert result["metadata_error"].startswith(
        "PNG Stealth metadata could not be parsed: invalid JSON payload"
    )


def test_recognized_stealth_rejects_malformed_json_with_webui_markers(
    tmp_path: Path,
) -> None:
    image_path = tmp_path / "invalid-json-with-webui-markers-stealth.png"
    payload = b'{"prompt":"portrait","footer":"Steps: 20, Sampler: Euler"'
    _write_stealth_png(
        image_path,
        b"stealth_pnginfo",
        payload,
        len(payload) * 8,
        "RGBA",
    )

    result = parse_image(str(image_path))

    assert result["parse_error"] is None
    assert result["generator"] == "unknown"
    assert result["metadata_error"].startswith(
        "PNG Stealth metadata could not be parsed: invalid JSON payload"
    )


def test_braced_webui_parameters_are_not_misclassified_as_json(tmp_path: Path) -> None:
    image_path = tmp_path / "braced-webui-stealth.png"
    parameter_text = (
        "{emphasized subject}, portrait\n"
        "Negative prompt: lowres\n"
        "Steps: 20, Sampler: Euler a, CFG scale: 7, Seed: 4"
    )
    payload = parameter_text.encode("utf-8")
    _write_stealth_png(
        image_path,
        b"stealth_pnginfo",
        payload,
        len(payload) * 8,
        "RGBA",
    )

    result = parse_image(str(image_path))

    assert result["parse_error"] is None
    assert result["metadata_error"] is None
    assert result["generator"] == "webui"
    assert result["prompt"] == "{emphasized subject}, portrait"


def test_unsigned_png_probe_does_not_open_or_decode_pixels(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    image_path = tmp_path / "ordinary.png"
    Image.new("RGBA", (512, 512), color=(100, 120, 140, 254)).save(image_path)

    def fail_open(*args: object, **kwargs: object) -> None:
        raise AssertionError("Unsigned PNG must not use Pillow pixel decoding")

    monkeypatch.setattr(metadata_parser_module.Image, "open", fail_open)

    result = parse_image(str(image_path))

    assert result["parse_error"] is None
    assert result["metadata_error"] is None
    assert result["generator"] == "unknown"
