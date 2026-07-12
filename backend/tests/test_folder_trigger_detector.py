"""Regression tests for removing the legacy Dataset folder-trigger UI.

Dataset Maker now uses a direct folder path bar plus drag/drop. Trigger
words belong in the caption/export controls, not in a separate folder
import modal.
"""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _dataset_family_source() -> str:
    # The dataset-maker JS family was decomposed VERBATIM into
    # frontend/js/dataset/*.js; pins now grep the family concatenation
    # (same adaptation as the censor / smart_tag splits).
    return "\n".join(
        path.read_text(encoding="utf-8")
        for path in sorted((ROOT / "frontend" / "js" / "dataset").glob("*.js"))
    )


def test_dataset_folder_import_uses_inline_path_bar_only():
    html = (ROOT / "frontend" / "index.html").read_text(encoding="utf-8")
    assert 'id="dataset-folder-import-modal"' not in html
    assert 'id="dataset-folder-trigger-mode"' not in html
    assert 'id="dataset-folder-base-model"' not in html
    assert 'id="dataset-folder-import-path"' in html
    assert 'id="dataset-folder-import-recursive" checked' in html


def test_folder_import_js_does_not_autofill_trigger_from_path():
    js = _dataset_family_source()
    assert "_deriveTriggerFromFolder" not in js
    assert "dataset-folder-trigger-mode" not in js
    assert "folderTriggerAutofilled" not in js


def test_max_tags_suggestions_align_with_research_notes():
    """Research notes in tag-power.js: SDXL/Pony/Illustrious approx 50,
    FLUX approx 120, Anima approx 200.
    """
    js = (ROOT / "frontend" / "js" / "tag-power.js").read_text(encoding="utf-8")
    assert "'sdxl': 50" in js
    assert "'flux': 120" in js
    assert "'anima_style': 200" in js
    assert "'anima_character': 200" in js
