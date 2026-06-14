"""Tests for robust VLM hybrid (NL + booru tags) output parsing.

Point 1: a weak model that ignores the JSON / marker contract must not dump its
booru tags into the natural-language caption. ``parse_output`` with
``output_format="both"`` should route tags to ``VLMResult.tags`` and prose to
``VLMResult.caption`` across JSON, XML-marker, header, and marker-less shapes.

Distinct from ``test_vlm_tag_parser.py`` (which pins the ``_parse_tag_list`` /
``_looks_like_garbage_tag`` shape filter); this file pins the booru-vs-NL
*routing* in ``parse_output`` / ``_parse_hybrid_output`` /
``_heuristic_split_tags_prose``.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from vlm_providers.base import (  # noqa: E402
    OUTPUT_FORMAT_BOTH,
    OUTPUT_FORMAT_NL,
    VLMConfig,
    VLMProvider,
)


def _hybrid() -> VLMProvider:
    return VLMProvider(VLMConfig(output_format=OUTPUT_FORMAT_BOTH))


def test_parse_json_object():
    r = _hybrid().parse_output(
        '{"description": "A girl stands in a field.", "tags": "1girl, solo, field"}'
    )
    assert r.caption == "A girl stands in a field."
    assert "1girl" in r.tags and "solo" in r.tags and "field" in r.tags
    assert "1girl" not in r.caption


def test_parse_json_fenced_with_list_tags():
    raw = '```json\n{"description": "Close-up portrait.", "tags": ["1girl", "blue_eyes", "smile"]}\n```'
    r = _hybrid().parse_output(raw)
    assert r.caption == "Close-up portrait."
    assert r.tags == ["1girl", "blue_eyes", "smile"]


def test_parse_json_with_leading_prose():
    raw = 'Here is the result:\n{"description": "A dog runs.", "tags": "dog, motion"}'
    r = _hybrid().parse_output(raw)
    assert r.caption == "A dog runs."
    assert "dog" in r.tags


def test_parse_xml_markers_still_supported():
    r = _hybrid().parse_output("<NL>A cat on a sofa.</NL><TAGS>cat, sofa, indoors</TAGS>")
    assert r.caption == "A cat on a sofa."
    assert "cat" in r.tags and "sofa" in r.tags


def test_parse_description_tags_headers():
    r = _hybrid().parse_output("Description: A sunny beach.\nTags: beach, ocean, sky")
    assert "sunny beach" in r.caption.lower()
    assert "beach" in r.tags and "ocean" in r.tags


def test_markerless_tags_then_prose_does_not_leak_into_caption():
    # The exact leak point 1 reported: a model emits "tags, ..., prose." with no
    # JSON / markers. The leading booru-tag run must NOT land in the caption.
    raw = "1girl, solo, long_hair, blue_eyes. A girl with long hair stands in a sunny field."
    r = _hybrid().parse_output(raw)
    assert "1girl" in r.tags and "solo" in r.tags and "long_hair" in r.tags
    assert "1girl, solo" not in r.caption
    assert "field" in r.caption.lower()


def test_markerless_line_structured():
    raw = "1girl, solo, long_hair, blue_eyes\nA girl stands in a field, smiling."
    r = _hybrid().parse_output(raw)
    assert "1girl" in r.tags and "blue_eyes" in r.tags
    assert "girl stands in a field" in r.caption.lower()
    assert "1girl" not in r.caption


def test_pure_prose_stays_caption():
    raw = "A lone tree on a grassy hill under a wide blue sky."
    r = _hybrid().parse_output(raw)
    assert r.caption == raw
    assert r.tags == []


def test_pure_tag_list_routes_to_tags_not_caption():
    raw = "1girl, solo, long_hair, blue_eyes, smile, outdoors"
    r = _hybrid().parse_output(raw)
    assert "1girl" in r.tags and "outdoors" in r.tags
    assert r.caption == ""


def test_nl_only_format_unaffected_by_commas():
    p = VLMProvider(VLMConfig(output_format=OUTPUT_FORMAT_NL))
    r = p.parse_output("A plain caption, with commas, stays whole.")
    assert r.caption == "A plain caption, with commas, stays whole."
    assert r.tags == []


# ---------------------------------------------------------------------------
# nl_caption format + JSON-shaped answers: presets like anima_flux set
# output_format=nl_caption, but JSON-tuned models answer with
# {"description": ..., "tags": ...} anyway — sometimes truncated by the token
# cap. The prose must be extracted instead of leaking raw JSON into captions.
# ---------------------------------------------------------------------------


def _nl() -> VLMProvider:
    return VLMProvider(VLMConfig(output_format=OUTPUT_FORMAT_NL))


def test_nl_format_extracts_description_from_json_answer():
    r = _nl().parse_output(
        '{"description": "A girl stands in a field.", "tags": "1girl, solo, field"}'
    )
    assert r.caption == "A girl stands in a field."
    assert "{" not in r.caption


def test_nl_format_extracts_description_from_fenced_json():
    r = _nl().parse_output(
        '```json\n{"description": "Close-up portrait of a knight.", "tags": ["armor"]}\n```'
    )
    assert r.caption == "Close-up portrait of a knight."


def test_nl_format_recovers_truncated_json_answer():
    r = _nl().parse_output(
        '{"description": "A close-up shot focuses on the torso of a woman.", '
        '"tags": "1girl, solo, head_out_of_frame, cropped_head,'
    )
    assert r.caption == "A close-up shot focuses on the torso of a woman."
    assert "1girl" not in r.caption


def test_nl_format_tags_only_json_yields_empty_caption_not_raw_json():
    r = _nl().parse_output('{"tags": "1girl, solo, long_hair"}')
    assert r.caption == ""


def test_nl_format_plain_prose_passes_through():
    raw = "A lone tree on a grassy hill under a wide blue sky."
    r = _nl().parse_output(raw)
    assert r.caption == raw


def test_nl_format_prose_with_inline_key_value_passes_through():
    raw = 'A monitor overlay reads "status": "recording" while the subject stands still.'
    r = _nl().parse_output(raw)
    assert r.caption == raw


def test_nl_format_bracketed_prose_passes_through():
    raw = "[wide shot] A lone tree on a grassy hill under a wide blue sky."
    r = _nl().parse_output(raw)
    assert r.caption == raw
