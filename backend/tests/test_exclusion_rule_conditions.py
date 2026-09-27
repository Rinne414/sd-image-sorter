"""Prompt Lab exclusion rules: "tag is missing" conditions (V3.5 issue #27).

The API stores a "missing" condition, but the matcher only knew the older
name "absent", so a "missing" condition was never checked at all: the rule
applied whether the tag was there or not. Both names now mean the same.
"""

from __future__ import annotations

import pytest

from tag_rules import get_exclusion_targets


def _rule(condition_type: str) -> list[dict]:
    return [
        {
            "name": "no hat, no hair ornament",
            "conditions": [{"tag": "hat", "type": condition_type}],
            "targets": [{"tag": "hair_ornament"}],
        }
    ]


@pytest.mark.parametrize("condition_type", ["missing", "absent"])
def test_a_missing_condition_applies_only_while_the_tag_is_missing(condition_type):
    assert get_exclusion_targets({"1girl", "smile"}, _rule(condition_type)) == {
        "hair_ornament"
    }
    assert get_exclusion_targets({"1girl", "hat"}, _rule(condition_type)) == set()


def test_a_rule_saved_through_the_api_with_missing_is_applied(test_client):
    created = test_client.post(
        "/api/prompts/exclusions",
        json={
            "rule_name": "missing hat rule",
            "conditions": [{"tag": "hat", "type": "missing"}],
            "targets": [{"tag": "hair_ornament"}],
        },
    )
    assert created.status_code == 200, created.text

    rules = test_client.get("/api/prompts/exclusions").json()["rules"]
    saved = [rule for rule in rules if rule["name"] == "missing hat rule"]
    assert saved and saved[0]["conditions"] == [{"tag": "hat", "type": "missing"}]

    assert get_exclusion_targets({"1girl", "hat"}, saved) == set()
    assert get_exclusion_targets({"1girl"}, saved) == {"hair_ornament"}
