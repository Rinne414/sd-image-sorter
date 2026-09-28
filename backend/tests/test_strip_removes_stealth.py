""" "Strip metadata" must also remove a prompt hidden in pixel bits (NovelAI / WebUI stealth).

Dropping PNG text chunks left NovelAI's alpha-LSB prompt in every censored
or published "stripped" picture, so anyone could still read it. The strip
now clears those bits when a signed carrier is present, and leaves every
other picture's pixels exactly as they were.
"""

from __future__ import annotations

import pytest
from PIL import Image

from metadata_parser.png_stealth import probe_pillow_stealth_signature
from services.censor_service import CensorService


def _carrier(mode: str, signature: bytes) -> Image.Image:
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
        ("RGB", b"stealth_rgbcomp"),
    ],
)
def test_strip_removes_a_prompt_hidden_in_pixels(mode: str, signature: bytes) -> None:
    carrier = _carrier(mode, signature)
    assert probe_pillow_stealth_signature(carrier) == signature

    clean = CensorService._strip_all_metadata(carrier)

    assert clean.mode == mode
    assert probe_pillow_stealth_signature(clean) is None
    assert max(abs(a - b) for a, b in zip(carrier.tobytes(), clean.tobytes())) <= 1


def test_strip_leaves_an_ordinary_picture_bit_for_bit() -> None:
    picture = Image.new("RGBA", (16, 16), (101, 121, 141, 200))
    picture.info["parameters"] = "prompt"

    clean = CensorService._strip_all_metadata(picture)

    assert clean.tobytes() == picture.tobytes()
    assert "parameters" not in clean.info
