"""BE-1 property test: re-threshold(t) == direct inference at t.

The whole value of tag_scores rests on one equivalence: rebuilding tags
from stored scores at threshold t must produce EXACTLY what running
``_process_probs`` at t would have produced (for any t >= the storage
floor). These tests construct a synthetic WD14 vocab + prob vector, emit
scores once at a low threshold, then check the equivalence across a sweep
of thresholds, including the model-specific high thresholds (camie 0.62)
that HARD-1 protects.
"""
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

import config
from services.tag_score_service import build_tags_from_scores
from tagger import WD14Tagger


def _make_tagger():
    tagger = WD14Tagger.__new__(WD14Tagger)
    tagger.model_name = "wd-test"
    tagger._output_activation = "probability"
    tagger._rating_fallback_mode = "none"
    tagger._general_category_overrides = {"artist_name": "artist"}
    tagger.threshold = 0.35
    tagger.character_threshold = 0.85
    tagger.general_tags = [
        (0, "1girl"), (1, "smile"), (2, "long_hair"), (3, "artist_name"), (4, "dust"),
    ]
    tagger.copyright_tags = [(5, "blue_archive")]
    tagger.character_tags = [(6, "shiroko_(blue_archive)"), (7, "obscure_char")]
    tagger.rating_tags = [(8, "general"), (9, "sensitive"), (10, "questionable"), (11, "explicit")]
    return tagger


PROBS = np.array(
    [0.97, 0.41, 0.36, 0.55, 0.05, 0.63, 0.88, 0.31, 0.20, 0.62, 0.30, 0.11],
    dtype=np.float32,
)


def _key_set(tags):
    return {(t["tag"], round(float(t["confidence"]), 6), t["category"]) for t in tags}


@pytest.fixture
def scores_enabled(monkeypatch):
    monkeypatch.setattr(config, "TAG_SCORES_ENABLED", True)
    monkeypatch.setattr(config, "TAG_SCORES_FLOOR", 0.10)


def test_process_probs_emits_floored_scores(scores_enabled):
    result = _make_tagger()._process_probs(PROBS, threshold=0.35, character_threshold=0.85)
    scores = result["tag_scores"]
    names = {s["tag"] for s in scores}
    assert "dust" not in names, "0.05 is under the 0.10 floor"
    assert "smile" in names and "obscure_char" in names, "sub-threshold scores ARE stored"
    by_name = {s["tag"]: s for s in scores}
    assert by_name["artist_name"]["category"] == "artist", "category overrides preserved"
    assert by_name["blue_archive"]["category"] == "copyright"
    assert by_name["sensitive"]["category"] == "rating"


def test_disabled_emits_no_scores(monkeypatch):
    monkeypatch.setattr(config, "TAG_SCORES_ENABLED", False)
    result = _make_tagger()._process_probs(PROBS, threshold=0.35, character_threshold=0.85)
    assert "tag_scores" not in result


@pytest.mark.parametrize("threshold,char_threshold", [
    (0.35, 0.85),
    (0.50, 0.85),
    (0.62, 0.62),   # camie-style high general threshold
    (0.80, 0.90),
    (0.10, 0.10),   # exactly at the floor
])
def test_rethreshold_equals_direct_inference(scores_enabled, threshold, char_threshold):
    tagger = _make_tagger()
    stored = tagger._process_probs(PROBS, threshold=0.35, character_threshold=0.85)[
        "tag_scores"
    ]
    rebuilt = build_tags_from_scores(stored, threshold, char_threshold)
    direct = tagger._process_probs(
        PROBS, threshold=threshold, character_threshold=char_threshold
    )["all_tags"]
    assert _key_set(rebuilt) == _key_set(direct)


def test_rating_argmax_survives_any_threshold(scores_enabled):
    tagger = _make_tagger()
    stored = tagger._process_probs(PROBS, threshold=0.35, character_threshold=0.85)[
        "tag_scores"
    ]
    rebuilt = build_tags_from_scores(stored, 0.99, 0.99)
    ratings = [t for t in rebuilt if t["category"] == "rating"]
    assert len(ratings) == 1
    assert ratings[0]["tag"] == "sensitive", "argmax rating kept even at extreme thresholds"
