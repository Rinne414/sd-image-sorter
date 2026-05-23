"""Tests for v3.2.2 T-power-PR1: pre-tag blacklist + max-tags filters
applied INSIDE the tagging worker before the DB write.

These pin the exact normalisation behaviour (case + underscore folding)
and the top-N-by-confidence ordering. If a future agent simplifies
``_apply_pre_tag_filters`` and changes the contract, these tests catch
the regression because the normalisation has user-visible consequences
(typing ``score_9_up`` in the blacklist must drop ``score 9 up`` too).
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services.tagging_service import _apply_pre_tag_filters  # noqa: E402


def _tag(name, conf=0.9):
    return {"tag": name, "confidence": conf, "category": "general"}


def test_no_filter_passes_everything_through():
    tags = [_tag("1girl"), _tag("blue_hair"), _tag("masterpiece")]
    out = _apply_pre_tag_filters(tags, blacklist=[], max_tags=0)
    assert [t["tag"] for t in out] == ["1girl", "blue_hair", "masterpiece"]


def test_blacklist_normalises_underscores_and_case():
    """User writes 'masterpiece' — drops 'masterpiece' and
    'Masterpiece' (case-insensitive). User writes 'score_9_up' —
    drops both 'score_9_up' and 'score 9 up' (the export pipeline
    emits both forms depending on underscore_to_space).

    'master piece' (two words) is a different tag and is NOT dropped
    by 'masterpiece' — the user must list it explicitly if they want
    that. WD14 / OppaiOracle never produce 'master piece' anyway, so
    we keep the rule narrow.
    """
    tags = [
        _tag("masterpiece"),
        _tag("Masterpiece"),
        _tag("master piece"),
        _tag("score_9_up"),
        _tag("score 9 up"),
        _tag("1girl"),
    ]
    out = _apply_pre_tag_filters(
        tags,
        blacklist=["masterpiece", "score_9_up"],
        max_tags=0,
    )
    # 'master piece' survives (different tag), the rest of the
    # blacklisted forms are dropped.
    assert [t["tag"] for t in out] == ["master piece", "1girl"]


def test_blacklist_strips_whitespace_only_entries():
    out = _apply_pre_tag_filters(
        [_tag("1girl"), _tag("masterpiece")],
        blacklist=["", "   ", "\t", "masterpiece"],
        max_tags=0,
    )
    assert [t["tag"] for t in out] == ["1girl"]


def test_max_tags_keeps_top_n_by_confidence():
    tags = [
        _tag("low_a", 0.31),
        _tag("low_b", 0.32),
        _tag("med_a", 0.61),
        _tag("med_b", 0.62),
        _tag("high_a", 0.91),
        _tag("high_b", 0.92),
    ]
    out = _apply_pre_tag_filters(tags, blacklist=[], max_tags=3)
    names = sorted(t["tag"] for t in out)
    assert names == ["high_a", "high_b", "med_b"], (
        "max_tags should keep top 3 by descending confidence"
    )


def test_max_tags_zero_means_unlimited():
    tags = [_tag(f"tag_{i}", 0.5) for i in range(50)]
    out = _apply_pre_tag_filters(tags, blacklist=[], max_tags=0)
    assert len(out) == 50


def test_filters_apply_in_order_blacklist_then_max():
    """Blacklist runs first; max_tags is applied to the surviving set,
    NOT to the pre-blacklist set. Otherwise a user could lose useful
    tags to dead blacklist slots."""
    tags = [
        _tag("masterpiece", 0.99),  # blacklisted
        _tag("best_quality", 0.98),  # blacklisted
        _tag("1girl", 0.97),
        _tag("blue_hair", 0.85),
    ]
    out = _apply_pre_tag_filters(
        tags,
        blacklist=["masterpiece", "best_quality"],
        max_tags=2,
    )
    # Both useful tags survive (max_tags counts post-blacklist)
    assert [t["tag"] for t in out] == ["1girl", "blue_hair"]


def test_handles_string_only_tags_gracefully():
    """Older taggers occasionally produce raw strings instead of dicts.
    The worker wraps them so downstream callers always see a dict shape."""
    out = _apply_pre_tag_filters(["1girl", "blue_hair"], blacklist=[], max_tags=0)
    assert [t["tag"] for t in out] == ["1girl", "blue_hair"]
    assert all(isinstance(t, dict) for t in out)


def test_skips_tags_with_no_name():
    """Defensive: a tagger returning ``{tag: None}`` or empty string
    should not surface as an empty entry."""
    out = _apply_pre_tag_filters(
        [_tag("1girl"), {"tag": "", "confidence": 0.5}, {"tag": None, "confidence": 0.5}],
        blacklist=[],
        max_tags=0,
    )
    assert [t["tag"] for t in out] == ["1girl"]
