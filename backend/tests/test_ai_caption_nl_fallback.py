"""When may ``ai_caption`` stand in for a missing natural-language caption?

Only when it is not the image's own tag list. A booru-only Smart Tag run
composes ``ai_caption`` from the very tag rows the export renders, so using it
as the sentence writes every tag twice. Deciding that by the text's shape alone
was wrong both ways: comma-heavy legacy prose ("A woman, blonde hair, blue
eyes, smiling") read as tags and was dropped, while a composed list whose tags
are multi-word ("1girl, standing in the rain, holding an umbrella") read as
prose and was kept. The rule is membership: nearly every comma segment,
normalized, is one of that image's own tag names (or the trigger). The shape
classifier is only the fallback when the caller has no tags.
"""

from __future__ import annotations

import pytest

from services.caption_dialect import (
    CODE_NL_FALLBACK_IS_TAG_LIST,
    ai_caption_nl_fallback,
)


def _rows(*names: str) -> list[dict]:
    return [{"tag": name, "confidence": 0.9} for name in names]


IMAGE_TAGS = _rows(
    "1girl",
    "solo",
    "long_hair",
    "blonde_hair",
    "blue_eyes",
    "smile",
    "flower",
    "blue_dress",
    "garden",
    "day",
    "field",
    "holding_flower",
)


@pytest.mark.parametrize(
    "legacy_prose",
    [
        "a girl, standing in a field, holding a flower, smiling at the viewer",
        "A woman, blonde hair, blue eyes, smiling",
        "Smiling girl, blue dress, garden, sunny day",
        "一个女孩站在花田里，手里拿着一朵花，对着镜头微笑。",
    ],
)
def test_legacy_prose_is_kept_even_when_it_reads_like_tags(legacy_prose):
    sink: list = []

    assert (
        ai_caption_nl_fallback(legacy_prose, IMAGE_TAGS, advisories=sink)
        == legacy_prose
    )
    assert sink == []


@pytest.mark.parametrize(
    ("caption", "tags", "trigger"),
    [
        (
            "1girl, standing in the rain, holding an umbrella",
            _rows("1girl", "standing in the rain", "holding_an_umbrella"),
            "",
        ),
        # A booru-only Smart Tag ai_caption: trigger first, tags with spaces.
        (
            "mylora_walk, 1girl, solo, long hair, twin braids",
            [
                {"tag": "mylora_walk", "source": "trigger", "category": "trigger"},
                *_rows(
                    "1girl",
                    "solo",
                    "long_hair",
                    "twin_braids",
                ),
            ],
            "",
        ),
        # Weights, brackets, case and the trigger from the request.
        (
            "MyTrigger, (1girl:1.2), ((Long_Hair)), [solo]",
            _rows("1girl", "long hair", "solo"),
            "mytrigger",
        ),
    ],
)
def test_the_images_own_tag_list_is_refused_and_reported(caption, tags, trigger):
    sink: list = []

    assert ai_caption_nl_fallback(caption, tags, trigger=trigger, advisories=sink) == ""
    assert [advisory.code for advisory in sink] == [CODE_NL_FALLBACK_IS_TAG_LIST]


def test_one_segment_the_tags_no_longer_carry_still_counts_as_the_list():
    """Ten tags, one since removed from the rows: still the app's own list."""
    names = [f"tag_{index}" for index in range(10)]
    caption = ", ".join(name.replace("_", " ") for name in names)

    assert ai_caption_nl_fallback(caption, _rows(*names[:9])) == ""


def test_a_short_list_with_a_foreign_segment_is_not_the_list():
    assert ai_caption_nl_fallback(
        "1girl, solo, a quiet road", _rows("1girl", "solo")
    ) == ("1girl, solo, a quiet road")


def test_without_tags_the_shape_classifier_decides():
    sink: list = []

    assert ai_caption_nl_fallback("1girl, solo, long hair", None, advisories=sink) == ""
    assert [advisory.code for advisory in sink] == [CODE_NL_FALLBACK_IS_TAG_LIST]
    assert ai_caption_nl_fallback("A girl walks along a quiet road.", []) == (
        "A girl walks along a quiet road."
    )
    assert ai_caption_nl_fallback("一个女孩站在花田里，手里拿着一朵花。", None) == (
        "一个女孩站在花田里，手里拿着一朵花。"
    )


def test_empty_text_is_not_reported():
    sink: list = []

    assert ai_caption_nl_fallback("", IMAGE_TAGS, advisories=sink) == ""
    assert ai_caption_nl_fallback(None, None, advisories=sink) == ""
    assert sink == []
