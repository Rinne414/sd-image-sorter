"""Regression test for v3.2.2 follow-up: Dataset Maker 'Tag all'
exposes a 'Re-tag already-tagged images' toggle (default OFF).

Before this fix, ``_tagAll`` in dataset-maker-part3.js hardcoded
``retag_all: true``, contradicting the help text "Skips images that
are already tagged" and forcing every Tag-all click to re-process
the entire queue.
"""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def test_tag_retag_checkbox_present():
    html = (ROOT / "frontend" / "index.html").read_text(encoding="utf-8")
    assert 'id="dataset-tag-retag-all"' in html, (
        "Re-tag checkbox missing — Tag all will silently always retag."
    )
    assert 'data-i18n="dataset.tagRetagAll"' in html


def test_tag_all_reads_checkbox_not_hardcoded_retag():
    js = (ROOT / "frontend" / "js" / "dataset-maker-part3.js").read_text(encoding="utf-8")
    # Old: { image_ids: this.imageIds, retag_all: true } — must be gone.
    assert "retag_all: true" not in js, (
        "_tagAll still hardcodes retag_all: true — checkbox is bypassed."
    )
    # New: reads from the checkbox.
    assert "dataset-tag-retag-all" in js
    assert "retag_all: retagAll" in js


def test_tag_all_skips_local_source_items():
    """Path-source items (negative ids) cannot use the legacy
    /api/tag/start endpoint because they have no DB row. Tag all
    must filter them out before sending."""
    js = (ROOT / "frontend" / "js" / "dataset-maker-part3.js").read_text(encoding="utf-8")
    assert "isLocalId" in js, (
        "_tagAll does not filter local-source items — backend will 404 on negative ids."
    )
    assert "dataset.tagAllOnlyLocal" in js
