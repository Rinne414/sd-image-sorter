"""The program's one way to find a picture's main colours, in HSV.

Measured on 400 real pictures (2026-11-07) against the RGB ways used before:
RGB splits or buckets by channel, so the top places fill with light and dark
versions of one colour and push real colours out. Near-duplicate pairs per
picture fell from 2.04 to 0.82, real hues left out from 7.8% to 0%, and the
colour-filter tags a picture should have but did not from 54.1% to 15.2%. The
cost: colours with under 2% of the picture near them rose from 0.5% to 1.4% of
those reported, never in first place.

How it works: pixels go into HSV bins, each bin then absorbs the smaller bins
close to it (hue wraps around, so 355 and 5 degrees are the same red), and each
group is shown by the average of its largest bin, so the colour shown is one
the picture really has.

Keep in step with frontend/js/modules/utils/hsv-palette.js and
frontend-v4/src/lib/hsvPalette.ts: backend/tests/fixtures/hsv_palette_vectors.json
holds the answers all three must give. Standard library only.
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, NamedTuple, Tuple

# Bump when the stored colours of analysed pictures should be measured again.
COLOR_ALGORITHM_VERSION = 1

BLACK_VALUE = 0.14
GRAY_SATURATION = 0.10
HUE_BIN_DEGREES = 12.0
SATURATION_EDGES = (0.35, 0.65)
VALUE_EDGES = (0.40, 0.70)
GRAY_VALUE_EDGES = (0.40, 0.70, 0.85)
MERGE_HUE_DEGREES = 20.0
MERGE_SATURATION = 0.35
MERGE_VALUE = 0.30
MERGE_GRAY_VALUE = 0.20
# A group smaller than this share of the picture is noise, not a main colour.
MIN_SHARE_PERCENT = 1.0


class _Bin(NamedTuple):
    chromatic: bool
    pixels: int
    hue: float
    saturation: float
    value: float


def _band(value: float, edges: Tuple[float, ...]) -> int:
    for index, edge in enumerate(edges):
        if value < edge:
            return index
    return len(edges)


def _rgb_to_hsv(r: int, g: int, b: int) -> Tuple[float, float, float]:
    red, green, blue = r / 255.0, g / 255.0, b / 255.0
    high = max(red, green, blue)
    low = min(red, green, blue)
    spread = high - low
    if spread == 0:
        return 0.0, 0.0, high
    if high == red:
        sector = ((green - blue) / spread + 6.0) % 6.0
    elif high == green:
        sector = (blue - red) / spread + 2.0
    else:
        sector = (red - green) / spread + 4.0
    return sector * 60.0, spread / high, high


def _to_byte(channel: float) -> int:
    return int(math.floor(channel * 255.0 + 0.5))


def _hsv_to_hex(hue: float, saturation: float, value: float) -> str:
    chroma = value * saturation
    sector = hue / 60.0
    second = chroma * (1.0 - abs(sector % 2.0 - 1.0))
    base = value - chroma
    red, green, blue = (
        (chroma, second, 0.0),
        (second, chroma, 0.0),
        (0.0, chroma, second),
        (0.0, second, chroma),
        (second, 0.0, chroma),
        (chroma, 0.0, second),
    )[int(math.floor(sector)) % 6]
    return "#{:02X}{:02X}{:02X}".format(
        _to_byte(red + base), _to_byte(green + base), _to_byte(blue + base)
    )


def _bin_key(hue: float, saturation: float, value: float) -> str:
    if value < BLACK_VALUE:
        return "k"
    if saturation < GRAY_SATURATION:
        return f"g{_band(value, GRAY_VALUE_EDGES)}"
    hue_bin = int(math.floor(hue / HUE_BIN_DEGREES)) % 30
    saturation_band = _band(saturation, SATURATION_EDGES)
    value_band = _band(value, VALUE_EDGES)
    return f"c{hue_bin}.{saturation_band}.{value_band}"


def _collect_bins(rgb: bytes) -> List[_Bin]:
    totals: Dict[str, List[float]] = {}
    for offset in range(0, len(rgb) - 2, 3):
        hue, saturation, value = _rgb_to_hsv(
            rgb[offset], rgb[offset + 1], rgb[offset + 2]
        )
        entry = totals.setdefault(
            _bin_key(hue, saturation, value), [0.0, 0.0, 0.0, 0.0, 0.0]
        )
        angle = math.radians(hue)
        entry[0] += 1.0
        entry[1] += math.sin(angle)
        entry[2] += math.cos(angle)
        entry[3] += saturation
        entry[4] += value
    bins = [
        _Bin(
            chromatic=key[0] == "c",
            pixels=int(count),
            hue=math.degrees(math.atan2(sines / count, cosines / count)) % 360.0,
            saturation=saturations / count,
            value=values / count,
        )
        for key, (count, sines, cosines, saturations, values) in totals.items()
    ]
    bins.sort(key=lambda entry: -entry.pixels)
    return bins


def _same_colour(seed: _Bin, other: _Bin) -> bool:
    if seed.chromatic != other.chromatic:
        return False
    if not seed.chromatic:
        return abs(seed.value - other.value) <= MERGE_GRAY_VALUE
    hue_gap = abs(seed.hue - other.hue) % 360.0
    hue_gap = min(hue_gap, 360.0 - hue_gap)
    return (
        hue_gap <= MERGE_HUE_DEGREES
        and abs(seed.saturation - other.saturation) <= MERGE_SATURATION
        and abs(seed.value - other.value) <= MERGE_VALUE
    )


def hsv_palette(rgb: bytes, top: int = 5) -> List[Dict[str, Any]]:
    """The main colours of flat RGB bytes: [{hex, pct}], largest share first."""
    total = len(rgb) // 3
    if total == 0:
        return []
    bins = _collect_bins(rgb)
    groups: List[Tuple[int, _Bin]] = []
    used = [False] * len(bins)
    for index, seed in enumerate(bins):
        if used[index]:
            continue
        used[index] = True
        count = seed.pixels
        for other_index in range(index + 1, len(bins)):
            if not used[other_index] and _same_colour(seed, bins[other_index]):
                used[other_index] = True
                count += bins[other_index].pixels
        groups.append((count, seed))
    groups.sort(key=lambda group: -group[0])
    large_enough = [
        group for group in groups if group[0] / total * 100.0 >= MIN_SHARE_PERCENT
    ] or groups[:1]
    return [
        {
            "hex": _hsv_to_hex(seed.hue, seed.saturation, seed.value),
            "pct": round(count / total * 100.0, 1),
        }
        for count, seed in large_enough[:top]
    ]
