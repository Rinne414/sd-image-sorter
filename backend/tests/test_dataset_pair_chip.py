"""Regression test for v3.2.2 T12: renamed-pair preview chip.

Pins the markup + i18n keys so a future agent can't silently remove
the chip and break Issue #5 Point 6's discoverability.
"""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def test_pair_chip_present_in_dataset_maker_html():
    html = (ROOT / "frontend" / "index.html").read_text(encoding="utf-8")
    assert 'id="dataset-pair-chip"' in html
    assert 'id="dataset-pair-chip-png"' in html
    assert 'id="dataset-pair-chip-txt"' in html
    assert 'data-i18n="dataset.pairChipPrefix"' in html
    assert 'data-i18n="dataset.pairChipSuffix"' in html


def test_pair_chip_default_filenames_use_safe_underscored_form():
    """The default placeholder filenames must keep underscores
    (paired with the underscore-filename invariant fix from T1).
    A future change that flipped them to spaces would suggest the
    export was about to ship spaces too."""
    html = (ROOT / "frontend" / "index.html").read_text(encoding="utf-8")
    assert "your_lora_001.png" in html
    assert "your_lora_001.txt" in html
    assert "your lora 001.png" not in html


def test_pair_chip_binds_to_trigger_and_preset():
    js = (ROOT / "frontend" / "js" / "dataset-maker-pipeline.js").read_text(encoding="utf-8")
    assert "refreshPairChip" in js
    assert "dataset-trigger" in js
    assert "dataset-naming-pattern" in js
    assert 'name="dataset-naming-preset"' in js
