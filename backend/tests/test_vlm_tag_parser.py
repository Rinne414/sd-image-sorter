"""Regression tests for VLM tag-list parser.

The previous version of ``_parse_tag_list`` only checked ``2 ≤ len ≤ 100``.
Real Gemma / Qwen / GPT responses leak markdown headings, bullet lists,
LaTeX equations and entire sentences into the "danbooru tags" output, so
those phrases ended up as tags in the user's library and silently polluted
``/api/stats`` top tags, prompt-lab seeds, and tag autocomplete.

These tests pin the new shape-based filter introduced in v3.2.2.
"""
from __future__ import annotations

import pytest

from vlm_providers.base import _parse_tag_list, _looks_like_garbage_tag


@pytest.mark.parametrize(
    "phrase",
    [
        "### 1. Address the \"Unreadable / Missing\" and \"Parse Errors\" (10 + 10)",
        "*   **Character Design:** The character has long",
        "*   **Action:** If you deleted the images from your computer",
        "Are you looking for information on the character",
        "$$x = \\frac{-3y \\pm \\sqrt{(3y)^2 - 4(1)(y^2 - 1)}}{2}$$",
        "$$x^2 + (3y)x + (y^2 - 1) = 0$$",
        "### Summary of Workflow",
        "### ç¸½çµå»ºè­°ï¼",
        "1. If you moved your folders or changed drive letters",
        "Specifically",  # single ambiguous prose token, allowed by old parser
        "\" \"standing",  # leading quotation
        "\"Cyphotes",  # leading quote, ambiguous
        "This image features a highly detailed",  # prose sentence fragment
        "dark",  # too generic but ambiguous - keep as it might be a real tag
    ],
)
def test_garbage_phrases_are_filtered(phrase: str) -> None:
    """Verify the parser rejects markdown / prose / LaTeX phrases."""
    if phrase in {"Specifically", "dark"}:
        # These are ambiguous - keep them as legit tags. Annotated for
        # documentation but we don't *enforce* rejection here. A future
        # tightening might reject single capitalized words.
        return
    parsed = _parse_tag_list(phrase)
    assert phrase not in parsed, (
        f"Garbage phrase {phrase!r} should be filtered, got {parsed!r}"
    )


@pytest.mark.parametrize(
    "tag",
    [
        "1girl",
        "long_hair",
        "blue_eyes",
        "school_uniform",
        "hatsune miku",
        "blue archive",
        "saori (blue archive)",
        "smile",
        "looking_at_viewer",
        "general",
        "sensitive",
        "explicit",
        "score_8_up",
        "masterpiece",
        "best_quality",
        "1boy 1girl",  # multi-word
        "very_long_hair",
    ],
)
def test_real_tags_are_kept(tag: str) -> None:
    """Verify the parser keeps real danbooru / quality / rating tags."""
    parsed = _parse_tag_list(tag)
    assert parsed == [tag], f"Real tag {tag!r} was filtered, got {parsed!r}"


def test_comma_separated_real_tags() -> None:
    text = "1girl, long_hair, blue_eyes, school_uniform, smile"
    parsed = _parse_tag_list(text)
    assert parsed == [
        "1girl",
        "long_hair",
        "blue_eyes",
        "school_uniform",
        "smile",
    ]


def test_newline_separated_real_tags() -> None:
    text = "1girl\nlong_hair\nblue_eyes"
    parsed = _parse_tag_list(text)
    assert parsed == ["1girl", "long_hair", "blue_eyes"]


def test_mixed_real_and_garbage_keeps_only_real() -> None:
    """A mixed VLM response with both prose and tags retains only the tags."""
    text = (
        "### 1. Address the issue\n"
        "*   **Character Design:** The character has long\n"
        "1girl, long_hair, blue_eyes, smile\n"
        "$$x^2 + y^2 = 1$$\n"
        "school_uniform"
    )
    parsed = _parse_tag_list(text)
    assert "1girl" in parsed
    assert "long_hair" in parsed
    assert "blue_eyes" in parsed
    assert "smile" in parsed
    assert "school_uniform" in parsed
    for garbage in (
        "### 1. Address the issue",
        "*   **Character Design:** The character has long",
        "$$x^2 + y^2 = 1$$",
    ):
        assert garbage not in parsed


def test_empty_input_returns_empty_list() -> None:
    assert _parse_tag_list("") == []
    assert _parse_tag_list(None) == []  # type: ignore[arg-type]


def test_whitespace_only_returns_empty_list() -> None:
    assert _parse_tag_list("   \n  \t  ") == []


@pytest.mark.parametrize(
    "tag",
    [
        "### header",
        "## header",
        "# header",
        "* bullet item",
        "- list item",
        "+ list item",
        "> quoted",
    ],
)
def test_markdown_prefixes_are_rejected(tag: str) -> None:
    assert _looks_like_garbage_tag(tag), (
        f"Markdown-prefixed {tag!r} should be flagged"
    )


@pytest.mark.parametrize(
    "tag",
    [
        "Sentence ending with period.",
        "Question?",
        "Exclamation!",
        "Chinese sentence。",
    ],
)
def test_prose_endings_are_rejected(tag: str) -> None:
    assert _looks_like_garbage_tag(tag), (
        f"Prose-shaped {tag!r} should be flagged"
    )


def test_latex_blocks_are_rejected() -> None:
    assert _looks_like_garbage_tag("$$x = 1$$")
    assert _looks_like_garbage_tag("inline $$x$$ math")


def test_code_fences_are_rejected() -> None:
    assert _looks_like_garbage_tag("```python")


def test_url_substrings_are_rejected() -> None:
    assert _looks_like_garbage_tag("see https://example.com/x")


def test_too_many_spaces_rejected() -> None:
    """Real tags rarely have more than 6 spaces; long phrases do."""
    long_phrase = "this is a very long natural language phrase here"
    assert _looks_like_garbage_tag(long_phrase)


def test_short_multiword_keeps() -> None:
    """Two- or three-word artist names like 'hatsune miku' are real tags."""
    assert not _looks_like_garbage_tag("hatsune miku")
    assert not _looks_like_garbage_tag("blue archive")
    assert not _looks_like_garbage_tag("saori (blue archive)")


def test_colon_with_space_is_rejected() -> None:
    """Section markers like 'Description: foo' are prose, not tags."""
    assert _looks_like_garbage_tag("Description: a beautiful image")


def test_numbered_list_with_prose_rejected() -> None:
    assert _looks_like_garbage_tag("1. If you moved your folders")
    assert _looks_like_garbage_tag("2) The second item is important")


def test_max_length_still_enforced() -> None:
    """Tags > 100 chars are still rejected."""
    too_long = "a" * 101
    assert _looks_like_garbage_tag(too_long)


def test_min_length_still_enforced() -> None:
    """Single-character tokens are still rejected."""
    assert _looks_like_garbage_tag("a")
    assert _looks_like_garbage_tag("")
