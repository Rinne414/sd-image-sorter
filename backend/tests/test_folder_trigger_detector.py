"""Regression tests for v3.2.2 T-power-PR1 (J) folder→trigger detector.

Pins the exact rules so future agents don't accidentally regress one of
the verified-against-source behaviours:

  - leading ``^(\\d+)_`` strip is anchored at start only
  - non-ASCII bails out cleanly
  - ``@`` prefix only for ``anima_style`` base model
  - all other base models leave the trigger plain

These assertions inspect the JS source string. The function itself runs
in the browser; we don't need to execute JS to know the rule is intact
because the regex + branches are static.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _read_module():
    return (ROOT / "frontend" / "js" / "dataset-maker-local-import.js").read_text(
        encoding="utf-8"
    )


def test_module_defines_derive_trigger_function():
    js = _read_module()
    assert "_deriveTriggerFromFolder" in js, (
        "Folder→trigger detection function (J) missing."
    )


def test_kohya_repeats_strip_is_anchored_at_start():
    js = _read_module()
    # Anchored regex; must NOT match middle-of-string digits.
    assert re.search(r"\^\\?\(\\d\+\\?\)_", js), (
        "Kohya repeats prefix regex lost its ^ anchor — would now strip "
        "'8_' from 'candy8_oc' which is wrong."
    )


def test_non_ascii_branch_present():
    js = _read_module()
    # Should reject any non-ASCII character (matches anything outside \x00-\x7f).
    assert "x00-\\x7f" in js or "x7f" in js, (
        "Non-ASCII rejection branch missing — folder names with Chinese / "
        "Japanese characters could leak into the trigger field."
    )


def test_anima_style_at_prefix_only_applies_to_anima_style():
    """The `@` prefix is Anima-STYLE specific. Anima-character and all
    other base models must NOT get the prefix."""
    js = _read_module()
    # Only one anima_style equality check; if a future agent adds the
    # prefix to anima_character too, this catches it.
    assert "baseModel === 'anima_style'" in js
    assert "baseModel === 'anima_character'" not in js


def test_modal_has_three_trigger_modes():
    """The folder-import modal exposes off / suggest / autofill — the
    user picked 'suggest' as default; do not change without an ADR."""
    html = (ROOT / "frontend" / "index.html").read_text(encoding="utf-8")
    assert 'id="dataset-folder-trigger-mode"' in html
    for mode in ("suggest", "autofill", "off"):
        assert f'value="{mode}"' in html, f"trigger mode '{mode}' missing"
    # Verify suggest is the default (first option in the markup, no
    # explicit selected attr — HTML defaults to first option).
    block = re.search(
        r'<select id="dataset-folder-trigger-mode"[^>]*>(.*?)</select>',
        html,
        re.DOTALL,
    )
    assert block is not None
    options = re.findall(r'value="(\w+)"', block.group(1))
    assert options[0] == "suggest", (
        f"Default trigger-mode option must be 'suggest', got '{options[0]}'."
    )


def test_modal_has_four_base_model_options():
    html = (ROOT / "frontend" / "index.html").read_text(encoding="utf-8")
    block = re.search(
        r'<select id="dataset-folder-base-model"[^>]*>(.*?)</select>',
        html,
        re.DOTALL,
    )
    assert block is not None
    options = set(re.findall(r'value="(\w+)"', block.group(1)))
    assert {"sdxl", "flux", "anima_style", "anima_character"}.issubset(options)


def test_max_tags_suggestions_align_with_research_notes():
    """Research notes in tag-power.js: SDXL/Pony/Illustrious ≈ 50,
    FLUX ≈ 120, Anima ≈ 200. Lock these constants so a refactor can't
    quietly change the recommendation a noob will follow."""
    js = (ROOT / "frontend" / "js" / "tag-power.js").read_text(encoding="utf-8")
    assert "'sdxl': 50" in js
    assert "'flux': 120" in js
    assert "'anima_style': 200" in js
    assert "'anima_character': 200" in js
