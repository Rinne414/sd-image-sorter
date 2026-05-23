"""Regression test for ADR-2026-05-24: Dataset Maker fresh sessions
seed Anime LoRA defaults (v3.2.2 T11).

Pins the HTML markup that carries the "Apply Anime LoRA defaults"
button + the JS module that wires it. If a future agent removes the
button or renames the i18n key, this test fails loudly and points at
the ADR.
"""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def test_anime_defaults_button_present_in_dataset_maker_html():
    html = (ROOT / "frontend" / "index.html").read_text(encoding="utf-8")
    assert 'id="btn-dataset-anime-defaults"' in html, (
        "Apply Anime LoRA defaults button missing from Dataset Maker markup."
    )
    assert 'data-i18n="dataset.animeDefaultsButton"' in html, (
        "Anime defaults button lost its i18n key — translations will break."
    )


def test_anime_defaults_localstorage_flag_used():
    """The fresh-session detection relies on a specific localStorage key.
    Hard-coding that key in the test pins the contract so refactors of
    the JS module can't silently change it."""
    js = (ROOT / "frontend" / "js" / "dataset-maker-pipeline.js").read_text(encoding="utf-8")
    assert "sd-image-sorter-dataset-customized" in js, (
        "Anime defaults localStorage flag renamed — old user sessions "
        "will be re-seeded with defaults on next visit."
    )


def test_anime_defaults_seed_common_tags_value():
    """``masterpiece, best_quality`` is the agreed-on seed value. If a
    future agent changes it to a different base-model recipe (Pony,
    NoobAI, etc.) without an ADR + new test, this catches it."""
    js = (ROOT / "frontend" / "js" / "dataset-maker-pipeline.js").read_text(encoding="utf-8")
    assert "'masterpiece, best_quality'" in js, (
        "Anime defaults common-tags seed value changed away from "
        "'masterpiece, best_quality'. See ADR-2026-05-24 — flipping this "
        "needs a new ADR and regression test."
    )


def test_anime_defaults_naming_preset_seed_is_renumber():
    """The seed naming preset is 'renumber' (so output is
    your_lora_001.png), not 'keep'. Locked by ADR-2026-05-24."""
    js = (ROOT / "frontend" / "js" / "dataset-maker-pipeline.js").read_text(encoding="utf-8")
    # The applyAnimeDefaults function selects the renumber radio.
    assert 'name="dataset-naming-preset"][value="renumber"' in js, (
        "Anime defaults stopped seeding the renumber preset — fresh "
        "sessions will revert to keeping random hex stems, breaking the "
        "noob-friendly flow."
    )
