"""CPU-only picture quality scores: blur, edge density, flat-colour share."""
from __future__ import annotations

import random

import numpy as np
import pytest
from PIL import Image, ImageDraw, ImageFilter

from services.image_quality_scores import (
    BLUR_REVIEW_BELOW,
    FLAT_REVIEW_ABOVE,
    QualityScores,
    quality_flags,
    score_image,
)


def _busy_picture(size=(768, 768), seed=1) -> Image.Image:
    rng = random.Random(seed)
    img = Image.new("RGB", size, (90, 120, 160))
    draw = ImageDraw.Draw(img)
    for _ in range(140):
        x0, y0 = rng.randrange(size[0]), rng.randrange(size[1])
        box = [x0, y0, x0 + rng.randrange(8, 160), y0 + rng.randrange(8, 160)]
        color = tuple(rng.randrange(256) for _ in range(3))
        draw.rectangle(box, fill=color, outline=(0, 0, 0))
    return img


def test_a_sharp_busy_picture_has_high_blur_score_and_no_flag(tmp_path):
    path = tmp_path / "sharp.png"
    _busy_picture().save(path)

    scores = score_image(str(path))

    assert scores is not None
    assert scores.blur > 10 * BLUR_REVIEW_BELOW
    assert scores.edge > 0.05
    assert scores.flat < FLAT_REVIEW_ABOVE
    assert quality_flags(scores) == []


def test_a_blurred_picture_is_possibly_blurry(tmp_path):
    path = tmp_path / "soft.png"
    _busy_picture().filter(ImageFilter.GaussianBlur(10)).save(path)

    scores = score_image(str(path))

    assert scores is not None and scores.blur < BLUR_REVIEW_BELOW
    assert quality_flags(scores) == ["blurry"]


def test_a_solid_colour_is_flat_and_not_also_blurry(tmp_path):
    path = tmp_path / "flat.png"
    Image.new("RGB", (640, 480), (200, 120, 40)).save(path)

    scores = score_image(str(path))

    assert scores == QualityScores(blur=0.0, edge=0.0, flat=1.0)
    assert quality_flags(scores) == ["flat"]


def test_a_smooth_gradient_is_flat(tmp_path):
    path = tmp_path / "gradient.png"
    ramp = np.tile(np.linspace(40, 200, 600, dtype=np.uint8), (400, 1))
    Image.fromarray(np.dstack([ramp, ramp, np.full_like(ramp, 120)])).save(path)

    assert quality_flags(score_image(str(path))) == ["flat"]


def test_a_subject_on_a_plain_background_is_not_flat(tmp_path):
    path = tmp_path / "subject.png"
    img = Image.new("RGB", (768, 768), (235, 225, 210))
    draw = ImageDraw.Draw(img)
    draw.rectangle([160, 160, 600, 600], fill=(200, 120, 140), outline=(30, 20, 20), width=3)
    for i in range(40):
        draw.ellipse([180 + i * 9, 200 + (i * 37) % 360, 230 + i * 9, 250 + (i * 37) % 360], fill=(40 + i * 5, 80, 200 - i * 4), outline=(0, 0, 0))
    img.save(path)

    scores = score_image(str(path))

    assert 0.3 < scores.flat < FLAT_REVIEW_ABOVE
    assert quality_flags(scores) == []


def test_scores_do_not_depend_on_file_size_beyond_the_working_copy(tmp_path):
    # The score is measured on a copy no larger than 512 px on the long side.
    big = tmp_path / "big.png"
    _busy_picture((2048, 2048)).save(big)
    small = tmp_path / "small.png"
    _busy_picture((2048, 2048)).resize((512, 512), Image.Resampling.BOX).save(small)

    a, b = score_image(str(big)), score_image(str(small))

    assert a is not None and b is not None
    assert a.blur == pytest.approx(b.blur, rel=0.02)
    assert a.edge == pytest.approx(b.edge, rel=0.02)


def test_transparent_pixels_count_as_a_plain_white_backdrop(tmp_path):
    path = tmp_path / "alpha.png"
    Image.new("RGBA", (300, 300), (255, 0, 0, 0)).save(path)

    assert quality_flags(score_image(str(path))) == ["flat"]


def test_unreadable_and_tiny_files_have_no_scores(tmp_path):
    broken = tmp_path / "broken.png"
    broken.write_bytes(b"not an image")
    tiny = tmp_path / "tiny.png"
    Image.new("RGB", (2, 2), (1, 2, 3)).save(tiny)

    assert score_image(str(broken)) is None
    assert score_image(str(tiny)) is None
    assert score_image(str(tmp_path / "missing.png")) is None


def test_the_default_leaves_soft_shaded_anime_alone():
    """Calibrated on real pictures (docs/MODELS_CONSIDERED.md): 50, not 60.

    Clean anime art with smooth airbrush shading and crisp outlines scored 51-59
    (and so did dark or minimal scenes), while the pictures a trainer would drop
    for blur sit mostly under 50. The numbers are those of real files.
    """
    assert BLUR_REVIEW_BELOW == 50.0
    soft_shaded_but_clean = QualityScores(blur=58.5, edge=0.0389, flat=0.30)
    smeared_mush = QualityScores(blur=33.2, edge=0.0067, flat=0.22)

    assert quality_flags(soft_shaded_but_clean) == []
    assert quality_flags(smeared_mush) == ["blurry"]
    assert quality_flags(QualityScores(blur=49.9, edge=0.01, flat=0.1)) == ["blurry"]
    assert quality_flags(QualityScores(blur=50.0, edge=0.01, flat=0.1)) == []


def test_thresholds_can_be_moved():
    scores = QualityScores(blur=80.0, edge=0.05, flat=0.5)

    assert quality_flags(scores) == []
    assert quality_flags(scores, blur_below=100.0) == ["blurry"]
    assert quality_flags(scores, flat_above=0.4) == ["flat"]
