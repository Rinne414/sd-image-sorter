"""The HSV main-colour algorithm and its agreement across the three copies."""

from __future__ import annotations

import colorsys
import json
import shutil
import subprocess
from pathlib import Path

import pytest
from PIL import Image

from color_analyzer import _analyze_pil_image, dominant_color_tags_from_json
from hsv_palette import COLOR_ALGORITHM_VERSION, hsv_palette

ROOT = Path(__file__).resolve().parents[2]
VECTORS_PATH = Path(__file__).parent / "fixtures" / "hsv_palette_vectors.json"
CLASSIC_JS = ROOT / "frontend" / "js" / "modules" / "utils" / "hsv-palette.js"


def _pixels(runs) -> bytes:
    return b"".join(bytes(rgb) * count for rgb, count in runs)


def _vectors() -> list[dict]:
    return json.loads(VECTORS_PATH.read_text(encoding="utf-8"))


def _hue_of(hex_color: str) -> float:
    value = hex_color.lstrip("#")
    channels = [int(value[i : i + 2], 16) / 255 for i in (0, 2, 4)]
    return colorsys.rgb_to_hsv(*channels)[0] * 360


def test_light_and_dark_versions_of_one_colour_are_one_main_colour():
    shades = [
        ((200, 20, 20), 200),
        ((230, 40, 40), 200),
        ((170, 15, 15), 200),
        ((20, 60, 220), 400),
    ]
    result = hsv_palette(_pixels(shades))
    assert len(result) == 2
    assert _hue_of(result[0]["hex"]) < 15 or _hue_of(result[0]["hex"]) > 345
    assert result[0]["pct"] == 60.0
    assert 210 < _hue_of(result[1]["hex"]) < 240
    assert result[1]["pct"] == 40.0


def test_red_on_both_sides_of_the_hue_circle_is_one_colour():
    result = hsv_palette(_pixels([((230, 20, 40), 500), ((230, 40, 20), 500)]))
    assert len(result) == 1
    assert result[0]["pct"] == 100.0


def test_a_small_real_colour_survives_a_big_background():
    runs = [((252, 252, 252), 700), ((238, 238, 238), 200), ((30, 200, 90), 100)]
    result = hsv_palette(_pixels(runs))
    assert [entry["pct"] for entry in result] == [90.0, 10.0]
    assert 120 < _hue_of(result[1]["hex"]) < 160


def test_noise_below_one_percent_is_not_a_main_colour():
    result = hsv_palette(_pixels([((20, 60, 220), 995), ((230, 20, 20), 5)]))
    assert len(result) == 1


def test_top_limits_the_answer_and_empty_input_gives_nothing():
    runs = [
        ((230, 20, 20), 100),
        ((20, 200, 40), 100),
        ((20, 40, 220), 100),
        ((240, 220, 20), 100),
    ]
    assert len(hsv_palette(_pixels(runs), top=2)) == 2
    assert hsv_palette(b"") == []


def test_the_colour_filter_finds_a_colour_split_across_shades():
    """Two reds under the 15% floor each used to miss the red tag; together they pass."""
    image = Image.new("RGB", (10, 10), (250, 250, 250))
    pixels = image.load()
    for x in range(10):
        pixels[x, 0] = (220, 30, 30)
        pixels[x, 1] = (190, 25, 25)
    analysed = _analyze_pil_image(image)
    assert "red" in dominant_color_tags_from_json(analysed["dominant_colors"])
    assert analysed["color_version"] == COLOR_ALGORITHM_VERSION


@pytest.mark.parametrize("vector", _vectors(), ids=lambda vector: vector["name"])
def test_the_python_copy_gives_the_recorded_answers(vector):
    assert (
        hsv_palette(_pixels(vector["pixels"]), top=vector["top"]) == vector["expected"]
    )


def test_the_classic_copy_gives_the_recorded_answers():
    node = shutil.which("node")
    if node is None:
        pytest.skip("Node.js is needed to run the classic copy")
    script = """
const fs = require('fs');
const vm = require('vm');
const [jsPath, vectorsPath] = process.argv.slice(1);
const context = { window: {} };
vm.createContext(context);
vm.runInContext(fs.readFileSync(jsPath, 'utf8'), context);
const answers = JSON.parse(fs.readFileSync(vectorsPath, 'utf8')).map((vector) => {
    const rgba = [];
    vector.pixels.forEach(([rgb, count]) => {
        for (let i = 0; i < count; i += 1) rgba.push(rgb[0], rgb[1], rgb[2], 255);
    });
    rgba.push(9, 200, 9, 0);
    return context.window.hsvPalette(rgba, vector.top).map(({ hex, pct }) => ({ hex, pct }));
});
process.stdout.write(JSON.stringify(answers));
"""
    completed = subprocess.run(
        [node, "-e", script, str(CLASSIC_JS), str(VECTORS_PATH)],
        capture_output=True,
        text=True,
        check=True,
        timeout=60,
    )
    answers = json.loads(completed.stdout)
    for vector, answer in zip(_vectors(), answers):
        expected = [
            {"hex": entry["hex"].lower(), "pct": entry["pct"]}
            for entry in vector["expected"]
        ]
        assert answer == expected, vector["name"]
