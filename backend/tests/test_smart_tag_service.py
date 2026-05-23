"""Tests for the Smart Tag service: noise-strip, training-purpose, caption assembly.

These pin the four pieces of logic that, if they regress, will silently
ship bad LoRA captions:

1. Noise-tag filter — `masterpiece`, `score_9`, `anime`, `year 2024`,
   etc. must be stripped before going anywhere near the VLM or the
   final caption.
2. Training-purpose alias map — `style_lora` -> `style`, `nsfw` ->
   `general`, etc.
3. Prompt-preset wording — the STYLE / CHARACTER / GENERAL prompts must
   direct the VLM toward the right kind of description for each training
   intent. We assert FUNCTIONAL content (mentions clothing? forbids
   identity features?) rather than verbatim wording so the prose can
   evolve.
4. Caption assembly — trigger word at front (or skipped if already
   present), tags deduped, NL sentences glued on the end.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services.smart_tag_service import (  # noqa: E402
    DEFAULT_NOISE_TAGS,
    META_NOISE_TAGS,
    PROMPT_PRESETS,
    QUALITY_NOISE_TAGS,
    SAFETY_NOISE_TAGS,
    SCORE_NOISE_TAGS,
    TIME_NOISE_TAGS,
    TRAINING_PURPOSE_ALIASES,
    assemble_caption,
    build_vlm_prompt,
    filter_noise_tags,
    is_noise_tag,
    normalize_training_purpose,
)


# ---------------------------------------------------------------------------
# Noise-tag filter
# ---------------------------------------------------------------------------


def test_quality_noise_tags_are_stripped() -> None:
    assert is_noise_tag("masterpiece")
    assert is_noise_tag("MASTERPIECE")
    assert is_noise_tag("best quality")
    assert is_noise_tag("worst_quality") is False  # underscore variant we don't track
    # Both the space form and the underscore form are in the set, so:
    assert is_noise_tag("best_quality")
    assert is_noise_tag("high_quality")


def test_score_family_is_stripped_via_regex() -> None:
    """The score_N family includes bare and `_up` rollups, plus the rare
    space-separated form."""
    assert is_noise_tag("score_7")
    assert is_noise_tag("score_9_up")
    assert is_noise_tag("score 7")
    assert is_noise_tag("SCORE_8_UP")
    assert is_noise_tag("score_42")  # regex matches arbitrary digits


def test_safety_and_meta_tags_are_stripped() -> None:
    for t in ["safe", "sensitive", "questionable", "nsfw", "explicit"]:
        assert is_noise_tag(t)
    for t in ["anime", "illustration", "monochrome", "sketch", "official_art"]:
        assert is_noise_tag(t), t
    # OppaiOracle-style rating:* prefix
    for t in ["rating:general", "rating:explicit"]:
        assert is_noise_tag(t)


def test_year_tag_is_stripped() -> None:
    assert is_noise_tag("year 2024")
    assert is_noise_tag("YEAR 2018")


def test_real_tags_are_kept() -> None:
    for tag in ["1girl", "blue_eyes", "long_hair", "smile", "bikini", "outdoors"]:
        assert is_noise_tag(tag) is False, tag


def test_filter_noise_tags_preserves_order_and_drops_noise() -> None:
    inp = ["masterpiece", "1girl", "score_9", "blue eyes", "anime", "long hair"]
    out = filter_noise_tags(inp)
    assert out == ["1girl", "blue eyes", "long hair"]


def test_default_noise_set_is_union_of_all_buckets() -> None:
    expected_subset = QUALITY_NOISE_TAGS | SCORE_NOISE_TAGS | SAFETY_NOISE_TAGS | META_NOISE_TAGS | TIME_NOISE_TAGS
    assert expected_subset.issubset(DEFAULT_NOISE_TAGS)


# ---------------------------------------------------------------------------
# Training-purpose normalisation
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "given,expected",
    [
        ("style", "style"),
        ("style_lora", "style"),
        ("Style-LoRA", "style"),
        ("art", "style"),
        ("character", "character"),
        ("character_lora", "character"),
        ("char", "character"),
        ("general", "general"),
        ("concept", "concept"),
        ("concept_lora", "concept"),
        ("nsfw", "general"),
        ("nsfw_lora", "general"),
        ("", "general"),
        (None, "general"),
        ("totally_unknown", "general"),
    ],
)
def test_normalize_training_purpose(given, expected) -> None:
    assert normalize_training_purpose(given) == expected


def test_training_purpose_alias_table_is_complete() -> None:
    """Every alias must map to a key that exists in PROMPT_PRESETS."""
    for alias, canonical in TRAINING_PURPOSE_ALIASES.items():
        assert canonical in PROMPT_PRESETS, f"{alias} -> {canonical} missing preset"


# ---------------------------------------------------------------------------
# Prompt presets — sanity-check that each preset directs the VLM toward
# the right kind of natural-language description for its training intent.
# We assert FUNCTIONAL content (does the prompt cover lighting? clothing?
# does it forbid identity features?) rather than verbatim wording so the
# wording can evolve without breaking tests.
# ---------------------------------------------------------------------------


def test_style_preset_targets_medium_lighting_composition() -> None:
    prompt = PROMPT_PRESETS["style"].lower()
    # The whole point of the STYLE preset is that it teaches the text
    # encoder the visual style, so these terms must appear.
    for needle in ["medium", "lighting", "composition", "style"]:
        assert needle in prompt, needle
    # And the prompt must direct the VLM AWAY from enumerating clothing
    # (that's character-LoRA territory). We allow any phrasing as long
    # as the prompt says "don't" (or "do not") about clothing.
    assert "clothing" in prompt
    assert ("do not" in prompt) or ("don't" in prompt)


def test_character_preset_excludes_fixed_identity_features() -> None:
    """Character LoRA must avoid teaching hair / eye / signature outfit."""
    prompt = PROMPT_PRESETS["character"]
    assert "do not describe" in prompt.lower()
    assert "hair color" in prompt.lower()
    assert "eye color" in prompt.lower()
    assert "signature outfit" in prompt.lower()


def test_general_preset_covers_subject_pose_clothing_background_lighting() -> None:
    prompt = PROMPT_PRESETS["general"]
    for term in ["subject", "pose", "clothing", "background", "lighting"]:
        assert term in prompt.lower(), term


def test_concept_preset_emphasises_the_concept() -> None:
    prompt = PROMPT_PRESETS["concept"]
    assert "concept" in prompt.lower()


def test_build_vlm_prompt_strips_noise_before_substituting() -> None:
    """The VLM must not see `masterpiece, score_9, anime` in its tag list."""
    prompt = build_vlm_prompt("style", ["masterpiece", "1girl", "score_9", "anime", "blue eyes"])
    assert "masterpiece" not in prompt
    assert "score_9" not in prompt
    assert "anime" not in prompt
    assert "1girl" in prompt
    assert "blue eyes" in prompt


def test_build_vlm_prompt_respects_alias_for_unknown_purpose() -> None:
    """Unknown training_purpose -> falls through to general preset."""
    prompt = build_vlm_prompt("totally_unknown", ["1girl"])
    assert prompt == build_vlm_prompt("general", ["1girl"])


# ---------------------------------------------------------------------------
# Caption assembly + trigger injection
# ---------------------------------------------------------------------------


def test_assemble_caption_basic_layout() -> None:
    out = assemble_caption(
        rating="questionable",
        general_tags=["1girl", "long_hair", "blue_eyes"],
        character_tags=["furina_(genshin_impact)"],
        nl_text="A young girl stands on a balcony at sunset.",
        trigger_word="myloratrigger",
        auto_strip_noise=True,
    )
    # Trigger first, then characters, then generals, then NL.
    assert out.startswith("myloratrigger,")
    assert "furina (genshin impact)" in out
    assert "1girl" in out
    assert "long hair" in out
    assert "blue eyes" in out
    assert out.endswith("A young girl stands on a balcony at sunset.")


def test_assemble_caption_strips_noise_when_enabled() -> None:
    out = assemble_caption(
        rating="general",
        general_tags=["masterpiece", "1girl", "score_9", "blue_eyes", "anime"],
        character_tags=[],
        nl_text="",
        trigger_word="",
        auto_strip_noise=True,
    )
    assert "masterpiece" not in out
    assert "score_9" not in out
    assert "anime" not in out
    assert "1girl" in out
    assert "blue eyes" in out


def test_assemble_caption_keeps_noise_when_disabled() -> None:
    out = assemble_caption(
        rating="general",
        general_tags=["masterpiece", "1girl"],
        character_tags=[],
        nl_text="",
        trigger_word="",
        auto_strip_noise=False,
    )
    assert "masterpiece" in out
    assert "1girl" in out


def test_assemble_caption_does_not_duplicate_existing_trigger() -> None:
    """If trigger is already in the WD14 tag list, do not prepend it again."""
    out = assemble_caption(
        rating=None,
        general_tags=["mytrigger", "1girl", "blue_eyes"],
        character_tags=[],
        nl_text="",
        trigger_word="mytrigger",
        auto_strip_noise=True,
    )
    # mytrigger appears exactly once in the final caption.
    assert out.count("mytrigger") == 1
    # And the original tag-list ordering is preserved (mytrigger was at
    # index 0 of general_tags, so it stays at the front).
    assert "mytrigger" in out
    # 1girl and blue eyes also stay.
    assert "1girl" in out
    assert "blue eyes" in out


def test_assemble_caption_underscore_to_space() -> None:
    """Underscores in tag names get swapped to spaces, except score_N."""
    out = assemble_caption(
        rating=None,
        general_tags=["long_hair", "blue_eyes", "score_9"],
        character_tags=[],
        nl_text="",
        trigger_word="",
        auto_strip_noise=False,
    )
    assert "long hair" in out
    assert "blue eyes" in out
    # score_9 keeps the underscore (Pony recipe convention)
    assert "score_9" in out


def test_assemble_caption_dedupes_repeated_tags() -> None:
    out = assemble_caption(
        rating=None,
        general_tags=["1girl", "1girl", "BLUE_EYES", "blue eyes"],
        character_tags=["1girl"],
        nl_text="",
        trigger_word="",
        auto_strip_noise=True,
    )
    assert out.count("1girl") == 1
    assert out.count("blue eyes") == 1


def test_assemble_caption_handles_empty_inputs() -> None:
    out = assemble_caption(
        rating=None,
        general_tags=[],
        character_tags=[],
        nl_text="",
        trigger_word="",
        auto_strip_noise=True,
    )
    assert out == ""


def test_assemble_caption_only_nl_when_no_tags() -> None:
    out = assemble_caption(
        rating=None,
        general_tags=[],
        character_tags=[],
        nl_text="A photograph of a sunset.",
        trigger_word="",
        auto_strip_noise=True,
    )
    assert out == "A photograph of a sunset."


def test_assemble_caption_only_trigger_and_tags_when_no_nl() -> None:
    out = assemble_caption(
        rating=None,
        general_tags=["1girl", "blue_eyes"],
        character_tags=[],
        nl_text="",
        trigger_word="myloratrigger",
        auto_strip_noise=True,
    )
    assert "myloratrigger" in out
    assert "1girl" in out
    assert "blue eyes" in out
    assert "." not in out  # no NL sentence appended
