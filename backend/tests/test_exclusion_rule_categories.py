"""Prompt Lab exclusion rules can exclude a whole category (V3.5 issue #28).

A rule target may name a category instead of a tag. The matcher had only a
``pass`` there, so such a rule was saved without complaint and then did
nothing. A category target now excludes every tag of that category,
including tags the user moved into it.
"""

from __future__ import annotations

from typing import Any, Dict

from prompt_generator import PromptGenerator
from tag_rules import categorize_tag, get_exclusion_targets

_FROM_BEHIND_NO_EXPRESSION = [
    {
        "name": "from behind hides the face",
        "conditions": [{"tag": "from_behind", "type": "present"}],
        "targets": [{"category": "expression"}, {"tag": "looking_at_viewer"}],
    }
]


def test_a_category_target_excludes_every_tag_of_that_category():
    assert categorize_tag("smile") == "expression"
    assert categorize_tag("standing") == "pose"

    excluded = get_exclusion_targets({"from_behind"}, _FROM_BEHIND_NO_EXPRESSION)

    assert "smile" in excluded
    assert "grin" in excluded
    assert "looking_at_viewer" in excluded
    assert "standing" not in excluded


def test_a_category_target_waits_for_its_condition():
    excluded = get_exclusion_targets({"from_side"}, _FROM_BEHIND_NO_EXPRESSION)

    assert "smile" not in excluded


def test_a_tag_moved_into_the_category_is_excluded_too():
    excluded = get_exclusion_targets(
        {"from_behind"},
        _FROM_BEHIND_NO_EXPRESSION,
        categorize=lambda tag: (
            "expression" if tag == "my_custom_face" else categorize_tag(tag)
        ),
    )

    assert "my_custom_face" in excluded


def test_the_generator_leaves_out_the_excluded_category():
    generator = PromptGenerator()
    generator._user_exclusion_rules = list(_FROM_BEHIND_NO_EXPRESSION)
    config: Dict[str, Any] = {
        "quality_preset": "none",
        "include_negative": False,
        "outfit": "none",
        "pose": "none",
        "angle": "from_behind",
        "body": "none",
        "expression": "random",
        "background": "none",
        "style": "none",
        "artist": "none",
    }

    for seed in range(12):
        result = generator.generate({**config, "seed": seed})
        categories = {entry.get("category") for entry in result["tags_used"]}
        assert "expression" not in categories, result["positive_prompt"]


def test_a_tag_already_in_the_prompt_from_an_excluded_category_is_reported():
    """Tags placed before exclusions are checked (the count tag) are named as conflicts."""
    generator = PromptGenerator()
    generator._user_exclusion_rules = [
        {
            "name": "from behind, no character count",
            "conditions": [{"tag": "from_behind", "type": "present"}],
            "targets": [{"category": "character"}],
        }
    ]

    result = generator.generate(
        {
            "quality_preset": "none",
            "include_negative": False,
            "outfit": "none",
            "pose": "none",
            "angle": "from_behind",
            "body": "none",
            "expression": "none",
            "background": "none",
            "style": "none",
            "artist": "none",
            "seed": 3,
        }
    )

    assert "1girl" in result["positive_prompt"]
    assert any("'1girl'" in warning for warning in result["warnings"])
