"""Color analysis utilities for images.

Computes dominant colors, brightness statistics, color temperature, and
brightness distribution shape during image scanning.

Performance: ~5-15ms per image on a 64x64 thumbnail; negligible vs metadata parse.
"""
from __future__ import annotations

import json
import logging
import math
from typing import Any, Dict, List, Optional, Tuple

from PIL import Image

logger = logging.getLogger(__name__)


# Number of histogram buckets (16 = good resolution for shape analysis)
HIST_BUCKETS = 16
# Resize dimension for color analysis
ANALYSIS_SIZE = 64
# Max distinct colors to extract via PIL quantize (then we keep top 5)
QUANTIZE_COLORS = 8


def analyze_image_colors(image_path: str) -> Optional[Dict[str, Any]]:
    """Run full color analysis on an image file.

    Returns dict with keys matching DB columns:
      - dominant_colors (JSON string)
      - avg_brightness (float)
      - color_temperature (str)
      - color_saturation (float)
      - brightness_histogram (JSON string)
      - brightness_skew (float)
      - brightness_distribution (str)

    Returns None on any error (e.g., corrupt image).
    """
    try:
        with Image.open(image_path) as img:
            img = img.convert("RGB")
            # Resize to small thumbnail for fast analysis
            img.thumbnail((ANALYSIS_SIZE, ANALYSIS_SIZE), getattr(Image, "Resampling", Image).LANCZOS)
            return _analyze_pil_image(img)
    except Exception as e:
        logger.debug(f"Color analysis failed for {image_path}: {e}")
        return None


def _analyze_pil_image(img: Image.Image) -> Dict[str, Any]:
    """Analyze a small PIL RGB image."""
    # Dominant colors via PIL quantize
    dominant = _extract_dominant_colors(img, QUANTIZE_COLORS, top_n=5)

    # HSV stats
    hsv = img.convert("HSV")
    avg_h, avg_s, avg_v = _avg_hsv(hsv)

    # Brightness histogram (16 buckets) and shape classification
    hist, skew, distribution = _brightness_distribution(img)

    # Color temperature based on average hue (PIL HSV: H is 0-255)
    temperature = _classify_temperature(avg_h, avg_s)

    dominant_json = json.dumps(dominant, separators=(",", ":"))
    return {
        "dominant_colors": dominant_json,
        "dominant_color_tags": dominant_color_tags_from_json(dominant_json),
        "avg_brightness": float(avg_v),
        "color_temperature": temperature,
        "color_saturation": float(avg_s),
        "brightness_histogram": json.dumps(hist, separators=(",", ":")),
        "brightness_skew": float(skew),
        "brightness_distribution": distribution,
    }


def _extract_dominant_colors(img: Image.Image, num_colors: int, top_n: int) -> List[Dict[str, Any]]:
    """Extract top N dominant colors using PIL quantize.

    Returns list of {hex, pct} sorted by pct desc.
    """
    quantized = img.quantize(colors=num_colors, method=Image.Quantize.MEDIANCUT)
    palette = quantized.getpalette() or []
    color_counts = sorted(
        (count, idx) for count, idx in (quantized.getcolors() or [])
    )
    color_counts.reverse()  # Descending by count

    total_pixels = sum(c for c, _ in color_counts) or 1
    results: List[Dict[str, Any]] = []
    for count, idx in color_counts[:top_n]:
        if idx * 3 + 2 >= len(palette):
            continue
        r, g, b = palette[idx * 3], palette[idx * 3 + 1], palette[idx * 3 + 2]
        pct = round(count / total_pixels * 100, 1)
        results.append({"hex": f"#{r:02X}{g:02X}{b:02X}", "pct": pct})
    return results


def _avg_hsv(hsv_img: Image.Image) -> Tuple[float, float, float]:
    """Compute average H, S, V channels (each 0-255)."""
    pixels = hsv_img.getdata()
    n = len(pixels)
    if n == 0:
        return 0.0, 0.0, 0.0

    # Hue is circular - compute as mean of unit vectors
    sum_sin = 0.0
    sum_cos = 0.0
    sum_s = 0
    sum_v = 0
    for h, s, v in pixels:
        # Convert PIL hue (0-255) to radians
        angle = (h / 255.0) * 2 * math.pi
        sum_sin += math.sin(angle)
        sum_cos += math.cos(angle)
        sum_s += s
        sum_v += v

    mean_angle = math.atan2(sum_sin / n, sum_cos / n)
    if mean_angle < 0:
        mean_angle += 2 * math.pi
    avg_h = (mean_angle / (2 * math.pi)) * 255.0

    return avg_h, sum_s / n, sum_v / n


def _classify_temperature(avg_hue: float, avg_saturation: float) -> str:
    """Classify color temperature based on average hue.

    PIL HSV hue range is 0-255 (not 0-360).
      - Warm: red/orange/yellow region (hue ~ 0-43 or 213-255 in PIL HSV)
      - Cool: blue/cyan/violet (hue ~ 85-191)
      - Neutral: low saturation (grayscale-ish) or transitional zones
    """
    # Low saturation = neutral regardless of hue
    if avg_saturation < 30:
        return "neutral"

    # PIL HSV: 0-255 maps to 0-360 degrees
    # Red/Orange/Yellow: 0-60 deg = 0-43 PIL
    # Yellow-Green/Green: 60-180 = 43-128
    # Cyan/Blue/Violet: 180-300 = 128-213
    # Magenta-Red: 300-360 = 213-255
    if avg_hue < 43 or avg_hue >= 213:
        return "warm"
    if 85 <= avg_hue < 213:
        return "cool"
    return "neutral"


def _brightness_distribution(img: Image.Image) -> Tuple[List[int], float, str]:
    """Compute brightness histogram (16 buckets), skew, and shape classification.

    Returns (histogram, skew, distribution_label).

    Shape classification:
      - left_heavy: >50% of pixels in lower 4 buckets
      - right_heavy: >50% in upper 4 buckets
      - edge_heavy: >40% combined in lowest 2 + highest 2 buckets (high contrast / line art)
      - middle_heavy: >50% in middle 8 buckets (4-11)
      - balanced: otherwise
    """
    gray = img.convert("L")
    pixels = list(gray.getdata())
    n = len(pixels) or 1

    # Build histogram with HIST_BUCKETS buckets
    bucket_size = 256 // HIST_BUCKETS
    hist = [0] * HIST_BUCKETS
    for v in pixels:
        bucket = min(v // bucket_size, HIST_BUCKETS - 1)
        hist[bucket] += 1

    # Compute mean and std for skew
    mean = sum(p for p in pixels) / n
    variance = sum((p - mean) ** 2 for p in pixels) / n
    std = math.sqrt(variance) if variance > 0 else 1.0

    # Skew: third standardized moment
    skew_sum = sum((p - mean) ** 3 for p in pixels) / n
    skew = skew_sum / (std ** 3) if std > 0 else 0.0

    # Classify shape
    total = sum(hist) or 1
    lower_4 = sum(hist[:4]) / total
    upper_4 = sum(hist[12:]) / total
    middle_8 = sum(hist[4:12]) / total
    # Edge-heavy requires BOTH ends to be significant (high contrast / line art)
    low_2 = sum(hist[:2]) / total
    high_2 = sum(hist[14:]) / total

    if low_2 > 0.20 and high_2 > 0.20 and (low_2 + high_2) > 0.50:
        # Both ends are heavy - true high-contrast / line art image
        distribution = "edge_heavy"
    elif lower_4 > 0.50:
        distribution = "left_heavy"
    elif upper_4 > 0.50:
        distribution = "right_heavy"
    elif middle_8 > 0.50:
        distribution = "middle_heavy"
    else:
        distribution = "balanced"

    return hist, skew, distribution


def needs_color_analysis(image_row: Dict[str, Any]) -> bool:
    """Check if an image row needs color analysis (for lazy backfill)."""
    return image_row.get("avg_brightness") is None


# ---------------------------------------------------------------------------
# Dominant-hue tagging (v3.5.0 color filter completion)
#
# Classifies each stored dominant color into a small human vocabulary so the
# gallery can answer `color:red`. Derived ENTIRELY from the dominant_colors
# JSON — backfill never has to reopen image files.
# ---------------------------------------------------------------------------

# The queryable vocabulary, ordered for UI display.
DOMINANT_COLOR_TAGS = [
    "red", "orange", "yellow", "green", "cyan", "blue",
    "purple", "pink", "brown", "white", "black", "gray",
]

# A dominant color must cover at least this share of the frame to count as
# "this image is <color>".
MIN_DOMINANT_PCT = 15.0


def classify_hex_color(hex_color: str) -> Optional[str]:
    """Map a #RRGGBB color to one tag from DOMINANT_COLOR_TAGS.

    Returns None for colors that carry no search signal (skin tones — an
    anime library would drown "orange" in face close-ups otherwise).
    """
    try:
        raw = hex_color.lstrip("#")
        r, g, b = int(raw[0:2], 16), int(raw[2:4], 16), int(raw[4:6], 16)
    except (ValueError, IndexError):
        return None

    rf, gf, bf = r / 255.0, g / 255.0, b / 255.0
    mx, mn = max(rf, gf, bf), min(rf, gf, bf)
    v = mx
    s = 0.0 if mx == 0 else (mx - mn) / mx
    if mx == mn:
        h = 0.0
    elif mx == rf:
        h = (60 * ((gf - bf) / (mx - mn))) % 360
    elif mx == gf:
        h = 60 * ((bf - rf) / (mx - mn)) + 120
    else:
        h = 60 * ((rf - gf) / (mx - mn)) + 240

    # Achromatic ladder first.
    if v < 0.14:
        return "black"
    if s < 0.10:
        if v > 0.82:
            return "white"
        return "gray"

    # Skin tones: warm hue, moderate saturation, bright — no search signal.
    if 15 <= h <= 45 and 0.10 <= s <= 0.45 and v > 0.72:
        return None

    # Brown = dark, muted warm hues.
    if 15 <= h <= 50 and v <= 0.62:
        return "brown"

    # Pink = light desaturated reds OR the magenta band. Deep saturated
    # reds near the wrap (crimson, hue ~348) must stay red, so the magenta
    # band ends at 340.
    if (h >= 340 or h < 15) and s <= 0.45 and v > 0.75:
        return "pink"
    if 315 <= h < 340:
        return "pink"

    if h >= 340 or h < 15:
        return "red"
    if h < 42:
        return "orange"
    if h < 68:
        return "yellow"
    if h < 165:
        return "green"
    if h < 195:
        return "cyan"
    if h < 255:
        return "blue"
    return "purple"  # 255-315


def dominant_color_tags_from_json(dominant_colors_json: Optional[str]) -> str:
    """Build the stored dominant_color_tags value from a dominant_colors JSON.

    Returns a comma-wrapped tag list (",red,white,") so SQL can match single
    tags with LIKE '%,red,%'. Empty string when nothing qualifies.
    """
    if not dominant_colors_json:
        return ""
    try:
        entries = json.loads(dominant_colors_json)
    except (ValueError, TypeError):
        return ""
    if not isinstance(entries, list):
        return ""

    tags: List[str] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        try:
            pct = float(entry.get("pct") or 0)
        except (TypeError, ValueError):
            pct = 0.0
        if pct < MIN_DOMINANT_PCT:
            continue
        tag = classify_hex_color(str(entry.get("hex") or ""))
        if tag and tag not in tags:
            tags.append(tag)
    if not tags:
        return ""
    return "," + ",".join(tags) + ","
