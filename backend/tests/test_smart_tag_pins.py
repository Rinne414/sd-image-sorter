"""Characterization pins for smart_tag_service pure helpers (god-file redesign, step 0).

These tests PIN current behavior — including quirks — so the planned
decomposition of backend/services/smart_tag_service.py (~2900 lines) cannot
silently change semantics. They deliberately do NOT duplicate what
test_smart_tag_service.py / test_consensus_tags.py / test_export_training_guarantees.py
already cover; this file is the gap matrix:

  * compute_consensus_tags — weight-sum boundary, consensus_min coercion,
    positional-bucket vs per-row category precedence, double-listing weight
    quirk, confidence rounding / zero-confidence quirk, rating tie + score-0
    edge cases, None input.
  * _score_sets_from_raw — precedence and filtering.
  * _booru_partial_from_tag_result — strip/cap ordering, reserved-overflow
    branch, rating passthrough shape.
  * _assemble_result_dict — trigger passthrough, separator-folded row
    selection, scalar passthrough fields.
  * _coerce_request — validation surface + coercion quirks (all tests pass
    enable_vlm=False so the VLM-config gate is not exercised here; that gate
    has its own tests).
  * PROMPT_PRESETS / build_vlm_prompt — {tags} placeholder contract and
    suppressed-traits rendering edges.
  * _rating_row_from — the input cells missing from
    test_export_training_guarantees.py.

DB-touching pins for _persist_result live in test_smart_tag_pins_persist.py.

Behaviors marked "QUIRK" are pinned as-is on purpose: if a refactor changes
them, that must be a conscious decision, not an accident.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import services.smart_tag_service as sts  # noqa: E402
from services.smart_tag_service import (  # noqa: E402
    PROMPT_PRESETS,
    SmartTagRequest,
    _coerce_request,
    _rating_row_from,
    build_vlm_prompt,
    compute_consensus_tags,
)


def _t(name, conf=0.9, **extra):
    row = {"tag": name, "confidence": conf}
    row.update(extra)
    return row


def _out(
    model="M", weight=1.0, general=None, copyright=None, character=None, rating=None
):
    return {
        "model": model,
        "weight": float(weight),
        "general_tags": general or [],
        "copyright_tags": copyright or [],
        "character_tags": character or [],
        "rating": rating,
    }


# ===========================================================================
# compute_consensus_tags — edge matrix beyond test_consensus_tags.py
# ===========================================================================


def test_weight_sum_exactly_at_consensus_min_survives() -> None:
    """The drop rule is strictly `weight_sum < consensus_min`: equality passes."""
    kept = compute_consensus_tags(
        [
            _out("A", weight=0.5, general=[_t("x")]),
            _out("B", weight=1.5, general=[_t("x")]),
        ],
        consensus_min=2,
    )
    assert [row["tag"] for row in kept["general_tags"]] == ["x"]

    dropped = compute_consensus_tags(
        [
            _out("A", weight=0.75, general=[_t("x")]),
            _out("B", weight=0.75, general=[_t("x")]),
        ],
        consensus_min=2,
    )
    assert dropped["general_tags"] == []


def test_consensus_min_zero_and_none_coerce_to_one() -> None:
    """max(1, int(consensus_min or 1)): 0 / None / negatives all become 1,
    which is OR semantics — a singleton tag survives."""
    for raw_min in (0, None, -5):
        out = compute_consensus_tags(
            [_out("A", general=[_t("solo")])], consensus_min=raw_min
        )
        assert [row["tag"] for row in out["general_tags"]] == ["solo"], raw_min


def test_skip_categories_match_case_insensitively() -> None:
    out = compute_consensus_tags(
        [_out("A", character=[_t("reimu", category="character")])],
        consensus_min=2,
        skip_categories=["CHARACTER"],
    )
    assert [row["tag"] for row in out["character_tags"]] == ["reimu"]


def test_positional_bucket_wins_over_row_category_for_gating_and_output() -> None:
    """A row inside general_tags claiming category='character' is still
    treated as GENERAL: it does NOT get the character OR-bypass, and the
    output row's category is 'general'. The positional bucket
    (first_category) is authoritative; the per-row category override is
    parsed but ignored for bucketing."""
    taggers = [_out("A", general=[_t("himeko", category="character")])]

    gated = compute_consensus_tags(taggers, consensus_min=2)
    assert gated["general_tags"] == []
    assert gated["character_tags"] == []  # no bypass despite category claim

    passed = compute_consensus_tags(taggers, consensus_min=1)
    assert [row["tag"] for row in passed["general_tags"]] == ["himeko"]
    assert passed["general_tags"][0]["category"] == "general"
    assert passed["character_tags"] == []


def test_same_tag_in_two_buckets_first_producer_bucket_wins() -> None:
    """When tagger A reports a tag as character and tagger B as general,
    the FIRST producer's bucket decides the output category (and therefore
    the OR-bypass). Votes and max-confidence still merge across both."""
    a = _out("A", character=[_t("himeko", conf=0.7, category="character")])
    b = _out("B", general=[_t("himeko", conf=0.9)])

    out = compute_consensus_tags([a, b], consensus_min=2)

    assert out["general_tags"] == []
    rows = out["character_tags"]
    assert [row["tag"] for row in rows] == ["himeko"]
    assert rows[0]["votes"] == 2
    assert rows[0]["confidence"] == 0.9


def test_single_tagger_double_listing_double_counts_weight() -> None:
    """QUIRK: one tagger listing the same tag in two category lists counts
    its weight twice — a single weight-1.0 tagger alone satisfies
    consensus_min=2 for that tag (votes=2 as well)."""
    a = _out(
        "A",
        general=[_t("dup", conf=0.6)],
        character=[_t("dup", conf=0.4, category="character")],
    )

    out = compute_consensus_tags([a], consensus_min=2, skip_categories=[])

    rows = out["general_tags"]  # first bucket seen = general
    assert [row["tag"] for row in rows] == ["dup"]
    assert rows[0]["votes"] == 2
    assert rows[0]["confidence"] == 0.6  # max across the two listings


def test_confidence_rounds_to_four_places() -> None:
    out = compute_consensus_tags(
        [_out("A", general=[_t("x", conf=0.123456)])], consensus_min=1
    )
    assert out["general_tags"][0]["confidence"] == 0.1235


def test_zero_confidence_renders_as_one() -> None:
    """QUIRK: `round(max_conf, 4) if max_conf else 1.0` — a tag whose only
    confidence is 0.0 is rendered with confidence 1.0, not 0.0."""
    out = compute_consensus_tags(
        [_out("A", general=[_t("z", conf=0.0)])], consensus_min=1
    )
    assert out["general_tags"][0]["confidence"] == 1.0


def test_string_rows_get_confidence_one_and_bucket_category() -> None:
    out = compute_consensus_tags(
        [_out("A", general=["plain_string"], copyright=["some_series"])],
        consensus_min=1,
        skip_categories=[],
    )
    general = {row["tag"]: row for row in out["general_tags"]}
    assert general["plain_string"]["confidence"] == 1.0
    assert general["plain_string"]["category"] == "general"
    copyright_rows = {row["tag"]: row for row in out["copyright_tags"]}
    assert copyright_rows["some_series"]["category"] == "copyright"


def test_tag_spelling_verbatim_from_first_producer() -> None:
    """The rendered tag keeps the FIRST tagger's exact spelling; later
    producers only add votes/weight under the case-folded key."""
    a = _out("A", general=[_t("Blue_Hair", conf=0.5)])
    b = _out("B", general=[_t("blue_hair", conf=0.8)])

    out = compute_consensus_tags([a, b], consensus_min=2)

    assert [row["tag"] for row in out["general_tags"]] == ["Blue_Hair"]
    assert out["general_tags"][0]["votes"] == 2


def test_none_input_returns_empty_shape() -> None:
    out = compute_consensus_tags(None)
    assert out == {
        "general_tags": [],
        "copyright_tags": [],
        "character_tags": [],
        "rating": "",
    }


def test_blank_tag_names_are_skipped() -> None:
    out = compute_consensus_tags(
        [_out("A", general=[_t("   "), _t(""), {"tag": None}])], consensus_min=1
    )
    assert out["general_tags"] == []


def test_rating_dict_score_zero_still_wins_over_nothing() -> None:
    """A dict rating with score 0.0 beats the initial best (-1.0), so it is
    surfaced rather than treated as missing."""
    out = compute_consensus_tags(
        [_out("A", rating={"label": "general", "score": 0.0})], consensus_min=1
    )
    assert out["rating"] == "general"


def test_rating_tie_first_tagger_wins() -> None:
    """Strictly-greater comparison: on a score tie the earlier tagger's
    label is kept."""
    out = compute_consensus_tags(
        [
            _out("A", rating={"label": "general", "score": 0.9}),
            _out("B", rating={"label": "sensitive", "score": 0.9}),
        ],
        consensus_min=1,
    )
    assert out["rating"] == "general"


def test_rating_empty_label_or_missing_yields_empty_string() -> None:
    out = compute_consensus_tags(
        [
            _out("A", rating={"label": "", "score": 0.99}),
            _out("B", rating=None),
        ],
        consensus_min=1,
    )
    assert out["rating"] == ""


# ===========================================================================
# _score_sets_from_raw — passthrough shapes
# ===========================================================================


def test_score_sets_take_precedence_over_flat_scores() -> None:
    raw = {
        "tag_score_sets": [
            {"model": "fused-a", "scores": [{"tag": "x", "score": 0.9}]}
        ],
        "tag_scores": [{"tag": "y", "score": 0.5}],
    }
    sets = sts._score_sets_from_raw(raw, "single-model")
    assert sets == [{"model": "fused-a", "scores": [{"tag": "x", "score": 0.9}]}]


def test_score_sets_filter_non_dict_entries() -> None:
    raw = {"tag_score_sets": ["junk", None, {"model": "a", "scores": []}, 42]}
    assert sts._score_sets_from_raw(raw, None) == [{"model": "a", "scores": []}]


def test_flat_scores_without_model_yield_nothing() -> None:
    raw = {"tag_scores": [{"tag": "x", "score": 0.9}]}
    assert sts._score_sets_from_raw(raw, None) == []
    assert sts._score_sets_from_raw({}, "model") == []


def test_empty_score_sets_fall_back_to_flat_scores() -> None:
    """An empty tag_score_sets list is falsy, so the flat tag_scores path
    still applies when a score_model is available."""
    raw = {"tag_score_sets": [], "tag_scores": [{"tag": "x", "score": 0.9}]}
    assert sts._score_sets_from_raw(raw, "wd-x") == [
        {"model": "wd-x", "scores": [{"tag": "x", "score": 0.9}]}
    ]


# ===========================================================================
# _booru_partial_from_tag_result — strip/cap ordering + shapes
# ===========================================================================


def _partial_req(**overrides):
    defaults = dict(image_ids=[1], enable_wd14=True, enable_vlm=False)
    defaults.update(overrides)
    return SmartTagRequest(**defaults)


def test_partial_keeps_noise_when_auto_strip_disabled() -> None:
    raw = {
        "general_tags": [_t("masterpiece", 0.99), _t("1girl", 0.9)],
        "copyright_tags": [],
        "character_tags": [],
        "rating": "general",
    }
    partial = sts._booru_partial_from_tag_result(
        raw, _partial_req(auto_strip_noise=False)
    )
    assert partial["general_names"] == ["masterpiece", "1girl"]
    assert partial["noise_stripped"] == 0


def test_partial_counts_noise_across_all_three_categories() -> None:
    raw = {
        "general_tags": [_t("masterpiece", 0.99), _t("1girl", 0.9)],
        "copyright_tags": [_t("score_9", 0.8), _t("touhou", 0.7)],
        "character_tags": [_t("nsfw", 0.6), _t("reimu", 0.5)],
        "rating": "general",
    }
    partial = sts._booru_partial_from_tag_result(
        raw, _partial_req(auto_strip_noise=True)
    )
    assert partial["general_names"] == ["1girl"]
    assert partial["copyright_names"] == ["touhou"]
    assert partial["character_names"] == ["reimu"]
    assert partial["noise_stripped"] == 3


def test_noise_strip_happens_before_cap() -> None:
    """Noise must not consume the max_tags budget: with cap 2, a stripped
    masterpiece(0.99) leaves room for BOTH keepers."""
    raw = {
        "general_tags": [_t("masterpiece", 0.99), _t("keep_a", 0.9), _t("keep_b", 0.8)],
        "copyright_tags": [],
        "character_tags": [],
        "rating": None,
    }
    partial = sts._booru_partial_from_tag_result(
        raw, _partial_req(auto_strip_noise=True, max_tags_per_image=2)
    )
    assert partial["general_names"] == ["keep_a", "keep_b"]


def test_cap_reorders_general_rows_by_confidence() -> None:
    """When the cap bites, the kept general rows come back confidence-sorted
    (descending) — the tagger's original order is NOT preserved."""
    raw = {
        "general_tags": [_t("c_low", 0.10), _t("a", 0.96), _t("b", 0.95)],
        "copyright_tags": [],
        "character_tags": [],
        "rating": None,
    }
    partial = sts._booru_partial_from_tag_result(
        raw, _partial_req(max_tags_per_image=2)
    )
    assert partial["general_names"] == ["a", "b"]


def test_cap_reserved_overflow_drops_general_and_keeps_top_reserved() -> None:
    """character+copyright rows have absolute budget priority: when they
    alone exceed max_tags, ALL general rows are dropped (even a 0.99 one)
    and the reserved rows are cut to the top-N by confidence, re-split by
    category."""
    raw = {
        "general_tags": [_t("g1", 0.99)],
        "copyright_tags": [_t("k1", 0.7, category="copyright")],
        "character_tags": [
            _t("c1", 0.9, category="character"),
            _t("c2", 0.5, category="character"),
        ],
        "rating": None,
    }
    partial = sts._booru_partial_from_tag_result(
        raw, _partial_req(max_tags_per_image=2)
    )
    assert partial["general_names"] == []
    assert partial["copyright_names"] == ["k1"]
    assert partial["character_names"] == ["c1"]  # c2 (0.5) lost the cut


def test_partial_rating_passthrough_shape() -> None:
    req = _partial_req()
    empty = sts._booru_partial_from_tag_result({"rating": ""}, req)
    assert empty["rating"] is None  # falsy rating normalizes to None

    rating_dict = {"label": "explicit", "score": 0.42}
    kept = sts._booru_partial_from_tag_result({"rating": rating_dict}, req)
    assert kept["rating"] == rating_dict  # dict passes through untouched


# ===========================================================================
# _assemble_result_dict
# ===========================================================================


def _empty_partial(**overrides):
    partial = {
        "general_names": [],
        "copyright_names": [],
        "character_names": [],
        "general_rows": [],
        "copyright_rows": [],
        "character_rows": [],
        "rating": None,
        "noise_stripped": 0,
    }
    partial.update(overrides)
    return partial


def test_result_trigger_word_is_stripped_passthrough() -> None:
    req = SmartTagRequest(image_ids=[1], trigger_word="  padded_trigger  ")
    result = sts._assemble_result_dict(_empty_partial(), "", 1, req)
    assert result["trigger_word"] == "padded_trigger"


def test_selection_matches_rows_across_space_underscore_spelling() -> None:
    """Purpose filtering selects by a space/underscore-folded key: a row
    spelled 'blue eyes' survives when the name list said 'blue_eyes'."""
    partial = _empty_partial(
        general_names=["lineart", "blue_eyes"],
        general_rows=[{"tag": "lineart"}, {"tag": "blue eyes"}],
    )
    req = SmartTagRequest(image_ids=[1], training_purpose="style")

    result = sts._assemble_result_dict(partial, "", 1, req)

    assert result["general_tags"] == ["blue_eyes"]  # lineart filtered by style mode
    assert result["general_tag_rows"] == [{"tag": "blue eyes"}]


def test_result_scalar_passthrough_fields() -> None:
    rating = {"label": "explicit", "score": 0.3}
    partial = _empty_partial(rating=rating, noise_stripped=7)
    req = SmartTagRequest(image_ids=[42])

    result = sts._assemble_result_dict(partial, "hello world.", 42, req)

    assert result["image_id"] == 42
    assert result["rating"] is rating
    assert result["nl_text"] == "hello world."
    assert result["noise_stripped_count"] == 7
    assert result["tag_score_sets"] == []  # missing key defaults to []


# ===========================================================================
# _coerce_request — validation surface + coercion quirks
# (enable_vlm=False everywhere: the VLM-config gate has its own tests)
# ===========================================================================


def test_coerce_rejects_non_list_image_ids() -> None:
    with pytest.raises(ValueError, match="image_ids must be a list"):
        _coerce_request({"image_ids": "1,2,3", "enable_vlm": False})


def test_coerce_rejects_non_integer_image_id_entries() -> None:
    with pytest.raises(ValueError, match="non-integer"):
        _coerce_request({"image_ids": [1, "abc"], "enable_vlm": False})


def test_coerce_image_ids_coercion_dedupe_and_nonpositive_drop() -> None:
    """QUIRK: numeric strings are accepted and floats are silently truncated
    (2.9 -> 2); zero/negative ids are silently dropped; duplicates fold."""
    req = _coerce_request(
        {
            "image_ids": ["3", 3, 2.9, 0, -1, 2],
            "enable_vlm": False,
        }
    )
    assert req.image_ids == [3, 2]


def test_coerce_rejects_non_list_image_paths() -> None:
    with pytest.raises(ValueError, match="image_paths must be a list"):
        _coerce_request({"image_paths": "/a.png", "enable_vlm": False})


def test_coerce_requires_at_least_one_source() -> None:
    with pytest.raises(ValueError, match="Smart Tag needs"):
        _coerce_request({"enable_vlm": False})


def test_coerce_image_paths_filtering(tmp_path) -> None:
    """Real files with allowed extensions are kept (case-insensitive) and
    deduped; wrong extensions and directories are silently dropped."""
    keep = tmp_path / "a.png"
    keep.write_bytes(b"x")
    upper = tmp_path / "b.PNG"
    upper.write_bytes(b"x")
    text = tmp_path / "c.txt"
    text.write_bytes(b"x")
    subdir = tmp_path / "d.png"  # a directory with an image suffix
    subdir.mkdir()

    req = _coerce_request(
        {
            "image_paths": [str(keep), str(upper), str(keep), str(text), str(subdir)],
            "enable_vlm": False,
        }
    )

    assert req.image_paths == [str(keep.resolve()), str(upper.resolve())]


def test_coerce_nonexistent_paths_drop_silently_then_no_source_error(tmp_path) -> None:
    """QUIRK: a payload whose only paths do not exist does not say "file not
    found" — the silent drop cascades into the generic no-source error."""
    with pytest.raises(ValueError, match="Smart Tag needs"):
        _coerce_request(
            {
                "image_paths": [str(tmp_path / "missing.png")],
                "enable_vlm": False,
            }
        )


def test_coerce_merge_strategy_lowercased_and_unvalidated() -> None:
    trimmed = _coerce_request(
        {
            "image_ids": [1],
            "enable_vlm": False,
            "merge_strategy": " APPEND ",
        }
    )
    assert trimmed.merge_strategy == "append"

    # QUIRK: merge_strategy is NOT validated against {replace, append} —
    # junk passes through and downstream treats anything != "append" as
    # replace.
    junk = _coerce_request(
        {
            "image_ids": [1],
            "enable_vlm": False,
            "merge_strategy": "banana",
        }
    )
    assert junk.merge_strategy == "banana"


def test_coerce_consensus_min_zero_falls_back_to_default_two() -> None:
    """QUIRK: `int(payload.get("consensus_min", 2) or 2)` — an explicit 0 is
    falsy and becomes the DEFAULT 2, not 1. Negatives clamp to 1."""
    zero = _coerce_request({"image_ids": [1], "enable_vlm": False, "consensus_min": 0})
    assert zero.consensus_min == 2

    negative = _coerce_request(
        {"image_ids": [1], "enable_vlm": False, "consensus_min": -3}
    )
    assert negative.consensus_min == 1

    default = _coerce_request({"image_ids": [1], "enable_vlm": False})
    assert default.consensus_min == 2


def test_coerce_tagger_entries_normalization() -> None:
    req = _coerce_request(
        {
            "image_ids": [1],
            "enable_vlm": False,
            "taggers": [
                "not-a-dict",
                {"weight": 2.0},  # no model -> skipped
                {"model": "  "},  # blank model -> skipped
                {"model": "mystery-model", "weight": 0},
            ],
        }
    )
    assert len(req.taggers) == 1
    entry = req.taggers[0]
    assert entry["model"] == "mystery-model"
    # QUIRK: weight=0 is falsy -> silently becomes 1.0.
    assert entry["weight"] == 1.0
    # Unknown models get the generic threshold defaults.
    assert entry["general_threshold"] == pytest.approx(0.35)
    assert entry["character_threshold"] == pytest.approx(0.85)


def test_coerce_taggers_non_list_becomes_empty() -> None:
    req = _coerce_request(
        {
            "image_ids": [1],
            "enable_vlm": False,
            "taggers": "wd14",
        }
    )
    assert req.taggers == []


def test_coerce_skip_categories_normalization() -> None:
    mixed = _coerce_request(
        {
            "image_ids": [1],
            "enable_vlm": False,
            "consensus_skip_categories": ["Character", "  ", "COPYRIGHT"],
        }
    )
    assert mixed.consensus_skip_categories == ["character", "copyright"]

    # Empty list is respected (disables the bypass) ...
    empty = _coerce_request(
        {
            "image_ids": [1],
            "enable_vlm": False,
            "consensus_skip_categories": [],
        }
    )
    assert empty.consensus_skip_categories == []

    # ... but a non-list falls back to the default pair.
    junk = _coerce_request(
        {
            "image_ids": [1],
            "enable_vlm": False,
            "consensus_skip_categories": "junk",
        }
    )
    assert junk.consensus_skip_categories == ["character", "copyright"]


def test_coerce_threshold_clamps_and_junk_fallback() -> None:
    clamped = _coerce_request(
        {
            "image_ids": [1],
            "enable_vlm": False,
            "general_threshold": 5,
            "character_threshold": -1,
        }
    )
    assert clamped.general_threshold == 1.0
    assert clamped.character_threshold == 0.0

    defaults = sts._tagger_defaults("")
    junk = _coerce_request(
        {
            "image_ids": [1],
            "enable_vlm": False,
            "general_threshold": "abc",
        }
    )
    assert junk.general_threshold == pytest.approx(defaults["general_threshold"])


def test_coerce_max_tags_clamps() -> None:
    high = _coerce_request(
        {
            "image_ids": [1],
            "enable_vlm": False,
            "max_tags_per_image": 99999,
        }
    )
    assert high.max_tags_per_image == 2000

    negative = _coerce_request(
        {
            "image_ids": [1],
            "enable_vlm": False,
            "max_tags_per_image": -5,
        }
    )
    assert negative.max_tags_per_image == 0


def test_coerce_natural_language_mode_aliases_and_junk() -> None:
    for alias in ("torii", "TORII", "toriigate-0.5"):
        req = _coerce_request(
            {
                "image_ids": [1],
                "enable_vlm": False,
                "natural_language_mode": alias,
            }
        )
        assert req.natural_language_mode == "toriigate", alias

    junk = _coerce_request(
        {
            "image_ids": [1],
            "enable_vlm": False,
            "natural_language_mode": "banana",
        }
    )
    assert junk.natural_language_mode == "vlm"


# ===========================================================================
# PROMPT_PRESETS / build_vlm_prompt — placeholder + suppression rendering
# ===========================================================================


def test_every_preset_carries_exactly_one_tags_placeholder() -> None:
    for purpose, template in PROMPT_PRESETS.items():
        assert template.count("{tags}") == 1, purpose


@pytest.mark.parametrize("purpose", sorted(PROMPT_PRESETS))
def test_rendered_prompt_substitutes_tags_placeholder(purpose) -> None:
    prompt = build_vlm_prompt(purpose, ["1girl", "blue eyes"])
    assert "{tags}" not in prompt
    assert "1girl, blue eyes" in prompt


@pytest.mark.parametrize("purpose", sorted(PROMPT_PRESETS))
def test_include_tags_false_renders_empty_tag_slot(purpose) -> None:
    prompt = build_vlm_prompt(purpose, ["1girl"], include_tags=False)
    assert "{tags}" not in prompt
    assert "1girl" not in prompt


def test_empty_and_blank_suppressed_traits_render_identical_to_base() -> None:
    base = build_vlm_prompt("character", ["1girl"])
    assert build_vlm_prompt("character", ["1girl"], suppressed_traits=[]) == base
    assert build_vlm_prompt("character", ["1girl"], suppressed_traits=None) == base
    # Whitespace-only / underscore-only traits normalize away -> no block.
    assert (
        build_vlm_prompt("character", ["1girl"], suppressed_traits=["  ", ""]) == base
    )


def test_suppression_folds_duplicate_trait_spellings() -> None:
    prompt = build_vlm_prompt(
        "character",
        ["1girl"],
        suppressed_traits=["silver_hair", "silver hair", "SILVER_HAIR"],
    )
    assert prompt.count("silver hair") == 1
    assert "silver_hair" not in prompt  # underscores fold to spaces in the block


# ===========================================================================
# _rating_row_from — cells missing from test_export_training_guarantees.py
# ===========================================================================


def test_rating_row_none_and_falsy_inputs() -> None:
    assert _rating_row_from(None) == ("", 0.0)
    assert _rating_row_from(0) == ("", 0.0)
    assert _rating_row_from({}) == ("", 0.0)


def test_rating_row_dict_score_defaults_and_junk() -> None:
    assert _rating_row_from({"label": "explicit"}) == ("explicit", 1.0)
    assert _rating_row_from({"label": "s", "score": "junk"}) == ("sensitive", 1.0)
    # QUIRK: `float(rating.get("score") or 1.0)` — an explicit score of 0
    # is falsy and becomes 1.0, not 0.0.
    assert _rating_row_from({"label": "e", "score": 0}) == ("explicit", 1.0)


def test_rating_row_score_clamps_to_unit_interval() -> None:
    assert _rating_row_from({"label": "e", "score": 5}) == ("explicit", 1.0)
    assert _rating_row_from({"label": "e", "score": -2}) == ("explicit", 0.0)


def test_rating_row_label_alias_matrix() -> None:
    assert _rating_row_from("g") == ("general", 1.0)
    assert _rating_row_from("safe") == ("general", 1.0)
    assert _rating_row_from("rating:safe") == ("general", 1.0)
    assert _rating_row_from("s") == ("sensitive", 1.0)
    assert _rating_row_from("e") == ("explicit", 1.0)
    assert _rating_row_from("EXPLICIT") == ("explicit", 1.0)
    # Plain strings always carry confidence 1.0 (there is nowhere to put a score).
    assert _rating_row_from("sensitive") == ("sensitive", 1.0)


def test_rating_row_unknown_label_dict_drops_score_too() -> None:
    assert _rating_row_from({"label": "weird", "score": 0.9}) == ("", 0.0)
