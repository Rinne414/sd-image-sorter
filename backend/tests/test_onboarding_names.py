"""The onboarding names places exactly as the program shows them.

The guide used to send users to a "Settings & Models" gear and list tabs
("图片库, 整理图片, 打码编辑") that the top bar does not show (found
2026-10-30). One name per place: these checks fail when a top-bar label or
the settings name changes and the guide is not changed with it.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
LANG_FILES = {
    "en": ROOT / "frontend" / "js" / "lang" / "en.js",
    "zh-CN": ROOT / "frontend" / "js" / "lang" / "zh-CN.js",
}
TOP_BAR_KEYS = (
    "nav.gallery",
    "nav.reader",
    "nav.sorting",
    "nav.censor",
    "nav.similar",
    "nav.dataset",
    "nav.promptlab",
    "nav.artist",
    "nav.stylemap",
)


def _table(path: Path) -> dict[str, str]:
    text = path.read_text(encoding="utf-8")
    pairs = re.findall(r"^\s*'([\w.]+)':\s*'((?:[^'\\]|\\.)*)',", text, re.M)
    table: dict[str, str] = {}
    for key, value in pairs:
        table.setdefault(key, value.replace("\\'", "'"))
    return table


@pytest.mark.parametrize("lang", sorted(LANG_FILES))
def test_the_tab_guide_uses_the_top_bar_labels(lang):
    table = _table(LANG_FILES[lang])
    guide = table["onboarding.step4Hint"]
    missing = [table[key] for key in TOP_BAR_KEYS if table[key] not in guide]
    assert not missing, (
        f"{lang}: onboarding.step4Hint does not name {missing} as the top bar does"
    )


@pytest.mark.parametrize("lang", sorted(LANG_FILES))
def test_the_model_step_names_settings_and_model_center(lang):
    table = _table(LANG_FILES[lang])
    settings = table["settings.tabGeneral"]
    model_center = table["entry.tileModels"]
    for key in ("onboarding.step3Title", "onboarding.step3Hint"):
        assert model_center in table[key], f"{lang}: {key} must say {model_center}"
    assert settings in table["onboarding.step3Hint"], (
        f"{lang}: onboarding.step3Hint must say {settings}"
    )
    assert table["models.title"] == settings, (
        f"{lang}: the gear is called {settings}, not {table['models.title']}"
    )
