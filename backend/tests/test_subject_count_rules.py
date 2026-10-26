"""Subject-count conflicts: contradictory 1girl/2girls/solo tags in one caption."""
from __future__ import annotations

import pytest

from services.subject_count_rules import resolve_subject_counts


@pytest.mark.parametrize(
    "tags",
    [
        [],
        ["1girl", "solo", "blue eyes"],
        ["2girls", "multiple girls"],
        ["1girl", "1boy"],
        ["1girl", "solo focus", "looking at viewer"],
        ["6+girls", "multiple girls"],
        ["no humans", "solo"],
        ["solo focus"],
    ],
)
def test_consistent_captions_are_left_alone(tags):
    assert resolve_subject_counts(tags) is None


def test_lower_explicit_count_is_dropped_for_the_higher_one():
    plan = resolve_subject_counts(["1girl", "2girls", "smile"])
    assert plan == {"keep": ["2girls"], "drop": ["1girl"]}


def test_multiple_tag_beats_a_single_subject_tag():
    plan = resolve_subject_counts(["1boy", "multiple boys"])
    assert plan == {"keep": ["multiple boys"], "drop": ["1boy"]}


def test_the_higher_of_three_counts_wins():
    plan = resolve_subject_counts(["1girl", "2girls", "3girls"])
    assert plan == {"keep": ["3girls"], "drop": ["1girl", "2girls"]}


def test_multiple_tag_stays_beside_an_explicit_count():
    plan = resolve_subject_counts(["1girl", "2girls", "multiple girls"])
    assert plan == {"keep": ["2girls", "multiple girls"], "drop": ["1girl"]}


def test_six_plus_counts_as_six():
    plan = resolve_subject_counts(["5girls", "6+girls"])
    assert plan == {"keep": ["6+girls"], "drop": ["5girls"]}


def test_solo_is_dropped_when_a_multi_subject_tag_is_present():
    assert resolve_subject_counts(["solo", "2girls"]) == {"keep": ["2girls"], "drop": ["solo"]}
    assert resolve_subject_counts(["solo", "multiple girls"]) == {"keep": ["multiple girls"], "drop": ["solo"]}


def test_solo_is_dropped_when_girl_and_boy_are_both_counted():
    plan = resolve_subject_counts(["1girl", "1boy", "solo"])
    assert plan == {"keep": ["1boy", "1girl"], "drop": ["solo"]}


def test_count_conflict_and_solo_resolve_together():
    plan = resolve_subject_counts(["1girl", "2girls", "solo", "smile"])
    assert plan == {"keep": ["2girls"], "drop": ["1girl", "solo"]}


def test_solo_focus_is_never_touched():
    plan = resolve_subject_counts(["2girls", "solo focus", "solo"])
    assert plan == {"keep": ["2girls"], "drop": ["solo"]}


def test_underscore_and_mixed_case_spellings_are_the_same_tags():
    plan = resolve_subject_counts(["1Girl", "Multiple_Girls", "Solo"])
    assert plan == {"keep": ["multiple girls"], "drop": ["1girl", "solo"]}


def test_other_subjects_count_too():
    assert resolve_subject_counts(["1other", "2others"]) == {"keep": ["2others"], "drop": ["1other"]}
