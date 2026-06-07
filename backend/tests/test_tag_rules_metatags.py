"""Unit tests for tag_rules.categorize_tag danbooru metatag handling.

Guards the v3.3.x dataset-maker tag-color/group feature: every tag must land in
one of the 14 categories the frontend renders, and the unambiguous danbooru
colon/score metatags must not fall through to 'unknown'.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from tag_rules import categorize_tag  # noqa: E402

CATEGORIES = {
    "character", "artist", "outfit", "pose", "body", "expression",
    "background", "action", "style", "quality", "meta", "rating", "angle", "unknown",
}


def test_danbooru_rating_metatag_is_rating():
    assert categorize_tag("rating:safe") == "rating"
    assert categorize_tag("rating:questionable") == "rating"
    assert categorize_tag("rating:explicit") == "rating"


def test_score_metatags_are_quality():
    assert categorize_tag("score:8") == "quality"
    assert categorize_tag("score_9") == "quality"
    assert categorize_tag("score_8_up") == "quality"


def test_score_prefix_does_not_overmatch_real_words():
    # "scoreboard" must NOT be miscategorized as quality by the score_ prefix rule.
    assert categorize_tag("scoreboard") != "quality"


def test_common_tags_keep_expected_groups():
    expected = {
        "masterpiece": "quality",
        "1girl": "meta",
        "blue_eyes": "body",
        "school_uniform": "outfit",
        "standing": "pose",
        "smile": "expression",
        "from_above": "angle",
        "holding": "action",
        "outdoors": "background",
        "watercolor": "style",
    }
    for tag, cat in expected.items():
        assert categorize_tag(tag) == cat, f"{tag} -> {categorize_tag(tag)} (expected {cat})"


def test_every_result_is_a_known_category():
    sample = [
        "masterpiece", "1girl", "blue_eyes", "school_uniform", "standing",
        "looking_at_viewer", "from_above", "holding_cup", "outdoors", "watercolor",
        "rating:safe", "score_9", "zzz_made_up_tag",
    ]
    for tag in sample:
        assert categorize_tag(tag) in CATEGORIES
