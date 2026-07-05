"""ComfyUI workflow regression corpus (v3.5.0 metadata L4).

Every real-world workflow shape the parser has ever been fixed for lives in
``fixtures/comfyui_workflows/*.json`` and is replayed here on every run —
fixing shape A can never silently break shape B again.

Fixture format (see also scripts/extract_workflow_fixture.py):

    {
      "name": "human-readable id",
      "description": "why this shape exists / where it came from",
      "prompt_data": { "<node_id>": {"class_type": ..., "inputs": {...}}, ... },
      "expect": {
        "positive_contains":     ["substr", ...],   # all must appear
        "positive_not_contains": ["substr", ...],   # none may appear
        "negative_contains":     ["substr", ...],
        "checkpoint_contains":   "substr" | null,
        "loras_contain":         ["substr", ...]
      }
    }

Add a fixture for every future parser report: reproduce → fix → freeze.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from metadata_parser import MetadataParser

FIXTURE_DIR = Path(__file__).parent / "fixtures" / "comfyui_workflows"


def _load_fixtures():
    cases = []
    for path in sorted(FIXTURE_DIR.glob("*.json")):
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        cases.append(pytest.param(data, id=data.get("name", path.stem)))
    return cases


def test_corpus_is_not_empty():
    assert FIXTURE_DIR.is_dir(), "corpus directory missing"
    assert list(FIXTURE_DIR.glob("*.json")), "corpus has no fixtures"


@pytest.mark.parametrize("case", _load_fixtures())
def test_workflow_shape_parses_as_expected(case):
    parser = MetadataParser()
    pos, neg, checkpoint, loras, *_rest = parser._extract_comfyui_data_extended(
        case["prompt_data"]
    )
    expect = case.get("expect", {})

    for fragment in expect.get("positive_contains", []):
        assert pos is not None, f"{case['name']}: positive is None"
        assert fragment.lower() in pos.lower(), (
            f"{case['name']}: positive missing {fragment!r}\ngot: {pos!r}"
        )
    for fragment in expect.get("positive_not_contains", []):
        if pos is not None:
            assert fragment.lower() not in pos.lower(), (
                f"{case['name']}: positive must NOT contain {fragment!r}\ngot: {pos!r}"
            )
    for fragment in expect.get("negative_contains", []):
        assert neg is not None, f"{case['name']}: negative is None"
        assert fragment.lower() in neg.lower(), (
            f"{case['name']}: negative missing {fragment!r}\ngot: {neg!r}"
        )
    checkpoint_fragment = expect.get("checkpoint_contains")
    if checkpoint_fragment:
        assert checkpoint is not None, f"{case['name']}: checkpoint is None"
        assert checkpoint_fragment.lower() in checkpoint.lower()
    for fragment in expect.get("loras_contain", []):
        assert any(fragment.lower() in str(name).lower() for name in (loras or [])), (
            f"{case['name']}: loras missing {fragment!r}\ngot: {loras!r}"
        )
