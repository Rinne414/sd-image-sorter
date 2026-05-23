"""Tests for v3.2.2 T-power-PR2 (D): multi-tagger consensus helper."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services.smart_tag_service import compute_consensus_tags  # noqa: E402


def _t(name, conf=0.9, category="general"):
    return {"tag": name, "confidence": conf, "category": category}


def _output(model, weight=1.0, general=None, character=None, rating=None):
    return {
        "model": model,
        "weight": float(weight),
        "general_tags": general or [],
        "character_tags": character or [],
        "rating": rating,
    }


def test_two_tagger_intersection_kept_at_min_2():
    """Tag agreed on by both taggers (sum of weights = 2.0) survives
    consensus_min=2."""
    a = _output("WD14", general=[_t("1girl"), _t("blue_hair"), _t("masterpiece")])
    b = _output("OppaiOracle", general=[_t("1girl"), _t("blue_hair"), _t("solo")])
    out = compute_consensus_tags([a, b], consensus_min=2)
    names = {t["tag"] for t in out["general_tags"]}
    assert names == {"1girl", "blue_hair"}


def test_singleton_tag_dropped_at_min_2():
    """A tag only one tagger produces fails the consensus."""
    a = _output("WD14", general=[_t("1girl"), _t("masterpiece")])
    b = _output("OppaiOracle", general=[_t("1girl"), _t("solo")])
    out = compute_consensus_tags([a, b], consensus_min=2)
    names = {t["tag"] for t in out["general_tags"]}
    assert "masterpiece" not in names
    assert "solo" not in names


def test_weights_sum_correctly():
    """Two taggers with weight=0.5 each agreeing = sum 1.0, fails consensus_min=2."""
    a = _output("A", weight=0.5, general=[_t("1girl")])
    b = _output("B", weight=0.5, general=[_t("1girl")])
    out = compute_consensus_tags([a, b], consensus_min=2)
    assert out["general_tags"] == []

    # Same two taggers + one full-weight tagger → sum 2.0, passes.
    c = _output("C", weight=1.0, general=[_t("1girl")])
    out2 = compute_consensus_tags([a, b, c], consensus_min=2)
    assert {t["tag"] for t in out2["general_tags"]} == {"1girl"}


def test_character_category_uses_or_rule():
    """Character/copyright tags bypass consensus_min: any single tagger
    detecting them is enough — most taggers can't recognize characters
    reliably so requiring agreement throws away too much."""
    a = _output("WD14", character=[_t("furina_(genshin_impact)", category="character")])
    b = _output("OppaiOracle", general=[_t("1girl"), _t("blue_hair")])
    out = compute_consensus_tags([a, b], consensus_min=2,
                                  skip_categories=["character", "copyright"])
    char_names = {t["tag"] for t in out["character_tags"]}
    assert "furina_(genshin_impact)" in char_names


def test_skip_categories_can_be_disabled():
    """If user passes empty skip_categories, character tags use the
    same consensus rule as general."""
    a = _output("WD14", character=[_t("furina_(genshin_impact)", category="character")])
    b = _output("OppaiOracle", general=[_t("1girl")])
    out = compute_consensus_tags([a, b], consensus_min=2, skip_categories=[])
    char_names = {t["tag"] for t in out["character_tags"]}
    assert char_names == set()


def test_max_confidence_kept_across_taggers():
    """Output confidence is the max across taggers that voted yes."""
    a = _output("WD14", general=[_t("1girl", conf=0.55)])
    b = _output("OppaiOracle", general=[_t("1girl", conf=0.97)])
    out = compute_consensus_tags([a, b], consensus_min=2)
    assert out["general_tags"][0]["confidence"] == 0.97


def test_votes_count_surfaced():
    a = _output("A", general=[_t("1girl")])
    b = _output("B", general=[_t("1girl")])
    c = _output("C", general=[_t("1girl"), _t("rare_tag")])
    out = compute_consensus_tags([a, b, c], consensus_min=2)
    by_tag = {t["tag"]: t["votes"] for t in out["general_tags"]}
    assert by_tag.get("1girl") == 3
    assert by_tag.get("rare_tag") is None  # only 1 vote, dropped


def test_rating_picks_highest_score():
    a = _output("A", rating={"label": "general", "score": 0.55})
    b = _output("B", rating={"label": "sensitive", "score": 0.85})
    c = _output("C", rating="questionable")  # plain string -> score=1.0
    out = compute_consensus_tags([a, b, c], consensus_min=1)
    assert out["rating"] == "questionable"


def test_zero_taggers_returns_empty():
    out = compute_consensus_tags([])
    assert out == {"general_tags": [], "character_tags": [], "rating": ""}


def test_consensus_min_one_keeps_everything():
    """consensus_min=1 = OR semantics for everything."""
    a = _output("WD14", general=[_t("only_a")])
    b = _output("OppaiOracle", general=[_t("only_b")])
    out = compute_consensus_tags([a, b], consensus_min=1)
    names = {t["tag"] for t in out["general_tags"]}
    assert names == {"only_a", "only_b"}
