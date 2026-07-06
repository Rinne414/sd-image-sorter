"""Reference-site parity for the obfuscation engine (Audit Target A, closed 2026-07-07).

The golden vectors in ``tests/assets/obfuscation_reference_golden.json`` were
produced by running the SAVED Big Tomato site JavaScript
(``reference/大番茄图片混淆_files``) in node: deterministic RGBA inputs were
scrambled by the site's own ``encryptImageData`` and text values by its own
``encryptTEXT``/``encryptTEXT_old``. These tests pin that our backend stays
byte-exact with the reference — if a refactor changes the gilbert curve, the
golden-ratio offset, padding, or the text crypto, uploads stop round-tripping
with the real site and this file goes red.

The frontend engine is pinned against the same vectors by
``tests/e2e/specs/obfuscation-parity.spec.ts``.

Verified divergences that are deliberately NOT covered (site-side quirks):
- Non-numeric passwords: the site's ``parseInt`` yields NaN and it scrambles
  ZERO times; we treat them as step 1. Cross-site use needs numeric passwords.
- 1-3 char passwords: the site gets NaN extra width/height and breaks its own
  canvas; we default the missing digits to 0.
- Legacy PNG-info mode with astral characters (emoji): the site shifts UTF-16
  units and corrupts them at TextEncoder time on its own side; modern mode
  (the default) is base64-first and safe.
"""

import base64
import json
import math
from pathlib import Path

import pytest

import obfuscation as obf

GOLDEN_PATH = Path(__file__).parent / "assets" / "obfuscation_reference_golden.json"


@pytest.fixture(scope="module")
def golden():
    return json.loads(GOLDEN_PATH.read_text(encoding="utf-8"))


class TestPixelParityWithReferenceSite:
    def test_encrypt_matches_reference_bytes(self, golden):
        for case in golden["pixel_cases"]:
            password = obf.parse_password(case["password"])
            original = base64.b64decode(case["original_b64"])
            expected = base64.b64decode(case["encrypted_b64"])

            encrypted, width, height = obf.encrypt_rgba(
                original, case["width"], case["height"], password
            )

            assert (width, height) == (case["encrypted_width"], case["encrypted_height"]), (
                f"{case['width']}x{case['height']} pw={case['password']!r}: padded dimensions drifted"
            )
            assert encrypted == expected, (
                f"{case['width']}x{case['height']} pw={case['password']!r}: "
                "scrambled bytes differ from the reference site output"
            )

    def test_decrypt_restores_reference_encrypted_bytes(self, golden):
        for case in golden["pixel_cases"]:
            password = obf.parse_password(case["password"])
            original = base64.b64decode(case["original_b64"])
            encrypted = base64.b64decode(case["encrypted_b64"])

            decoded, width, height = obf.decrypt_rgba(
                encrypted, case["encrypted_width"], case["encrypted_height"], password
            )

            assert (width, height) == (case["width"], case["height"])
            assert decoded == original, (
                f"{case['width']}x{case['height']} pw={case['password']!r}: "
                "decoding a site-encrypted image did not restore the original"
            )


class TestTextParityWithReferenceSite:
    def test_modern_text_crypto_matches_reference(self, golden):
        for case in golden["text_cases"]:
            key = tuple(case["key"])
            assert obf.encrypt_text(case["value"], key, legacy_mode=False) == case["modern"]
            assert obf.decrypt_text(case["modern"], key, legacy_mode=False) == case["value"]

    def test_legacy_text_crypto_matches_reference(self, golden):
        for case in golden["text_cases"]:
            key = tuple(case["key"])
            assert obf.encrypt_text(case["value"], key, legacy_mode=True) == case["legacy"]
            assert obf.decrypt_text(case["legacy"], key, legacy_mode=True) == case["value"]


class TestOffsetRoundingContract:
    def test_golden_ratio_offset_matches_js_math_round_semantics(self):
        # JS Math.round is half-up; Python round is half-even. A full scan of
        # every pixel count up to the 40MP cap found ZERO divergent values
        # (2026-07-07), so round() is safe — this spot-checks the contract on
        # the shipped sizes plus awkward candidates so a future change to the
        # offset formula re-runs the comparison.
        ratio = (math.sqrt(5) - 1) / 2
        for total in [1, 2, 35, 527, 9471, 40_000_000, 12_582_912, 33_177_600]:
            product = ratio * total
            assert round(product) == math.floor(product + 0.5), (
                f"offset rounding diverged from JS semantics at totalPixels={total}"
            )
