"""CPU-only picture quality scores for the dataset Check step.

Three numbers per picture, from one small grey copy (long side at most
``SCORE_LONG_SIDE`` pixels, never enlarged):

* ``blur``      variance of the 4-neighbour Laplacian, 0-255 grey scale. A soft
                picture has few sharp edges, so the variance is low.
* ``edge``      share of pixels whose gradient (difference to the next pixel)
                is at least ``EDGE_GRADIENT_MIN`` grey levels.
* ``flat``      share of 8x8 blocks in which every colour channel moves by at
                most ``FLAT_BLOCK_RANGE`` levels (a solid colour or a smooth
                gradient reads as flat).

Only the idea (variance of the Laplacian as a blur hint, plus edge density and
flat-colour share) comes from shira-qwq/lora-dataset-studio, whose licence is
non-commercial; this code is written from scratch and shares nothing with it.

These are hints for a person to look at, never a verdict: the Check step lists
the pictures and never deletes anything. See ``docs/MODELS_CONSIDERED.md`` for
how the thresholds were chosen and where they are weak.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Optional

import numpy as np
from PIL import Image, UnidentifiedImageError

logger = logging.getLogger(__name__)

# Bump when a number's meaning changes: cached scores of an older version are recomputed.
SCORES_VERSION = 1

SCORE_LONG_SIDE = 512
EDGE_GRADIENT_MIN = 16.0
FLAT_BLOCK = 8
FLAT_BLOCK_RANGE = 4

# Review thresholds (see docs/MODELS_CONSIDERED.md, "Blurry and flat pictures":
# 50 was chosen on 1,000 real pictures with 10 real pictures blurred by hand).
BLUR_REVIEW_BELOW = 50.0
FLAT_REVIEW_ABOVE = 0.92


@dataclass(frozen=True)
class QualityScores:
    blur: float
    edge: float
    flat: float


def _load_small_rgb(path: str) -> Optional[np.ndarray]:
    """The picture as a uint8 RGB array no larger than ``SCORE_LONG_SIDE``, or None."""
    try:
        with Image.open(path) as img:
            # JPEG and WebP can decode at a fraction of the size: much faster on big files.
            img.draft("RGB", (SCORE_LONG_SIDE * 2, SCORE_LONG_SIDE * 2))
            if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
                rgba = img.convert("RGBA")
                backdrop = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
                rgb = Image.alpha_composite(backdrop, rgba).convert("RGB")
            else:
                rgb = img.convert("RGB")
        scale = SCORE_LONG_SIDE / max(rgb.size)
        if scale < 1.0:
            size = (max(1, round(rgb.width * scale)), max(1, round(rgb.height * scale)))
            rgb = rgb.resize(size, Image.Resampling.BOX)
        return np.asarray(rgb, dtype=np.uint8)
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError) as exc:
        logger.debug("quality: cannot read %s: %s", path, exc)
        return None


def scores_from_rgb(rgb: np.ndarray) -> Optional[QualityScores]:
    """The three scores of an RGB array; None when it is too small to measure."""
    if rgb.ndim != 3 or rgb.shape[0] < 3 or rgb.shape[1] < 3:
        return None
    grey = rgb.astype(np.float32) @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    laplacian = (
        grey[:-2, 1:-1] + grey[2:, 1:-1] + grey[1:-1, :-2] + grey[1:-1, 2:] - 4.0 * grey[1:-1, 1:-1]
    )
    blur = float(laplacian.var())
    gx = np.abs(np.diff(grey, axis=1))[:-1, :]
    gy = np.abs(np.diff(grey, axis=0))[:, :-1]
    edge = float(np.mean(np.maximum(gx, gy) >= EDGE_GRADIENT_MIN))

    rows = rgb.shape[0] // FLAT_BLOCK
    cols = rgb.shape[1] // FLAT_BLOCK
    if rows == 0 or cols == 0:
        flat = 1.0
    else:
        blocks = rgb[: rows * FLAT_BLOCK, : cols * FLAT_BLOCK].reshape(rows, FLAT_BLOCK, cols, FLAT_BLOCK, 3)
        spread = blocks.max(axis=(1, 3)).astype(np.int16) - blocks.min(axis=(1, 3)).astype(np.int16)
        flat = float(np.mean(spread.max(axis=2) <= FLAT_BLOCK_RANGE))
    return QualityScores(blur=round(blur, 3), edge=round(edge, 5), flat=round(flat, 4))


def score_image(path: str) -> Optional[QualityScores]:
    """Scores for the picture at ``path``; None when it cannot be read."""
    rgb = _load_small_rgb(path)
    return scores_from_rgb(rgb) if rgb is not None else None


def quality_flags(
    scores: QualityScores,
    *,
    blur_below: float = BLUR_REVIEW_BELOW,
    flat_above: float = FLAT_REVIEW_ABOVE,
) -> list[str]:
    """``flat`` (very flat / low detail) or ``blurry`` (may be soft or blurry), never both.

    A flat picture has no edges at all, so its Laplacian variance is near zero;
    calling it "blurry" as well would only say the same thing twice. The edge
    share is kept for the person reading the finding and does not decide a flag:
    a heavily blurred picture has almost no edges too, and is still "blurry".
    """
    if scores.flat >= flat_above:
        return ["flat"]
    if scores.blur < blur_below:
        return ["blurry"]
    return []
