"""Frontend UX contract tests — pin invariants the user can see.

Bug 19 (UX): The Reader nav tab was missing its <span class="tab-icon">,
making it visually inconsistent with the other 6 tabs (Gallery 🖼️,
Censor 🔳, Sorting 📁, Similar 🔍, Artist 🎨, PromptLab 🧪 all had
icons; only Reader was text-only). Added 📖 icon.

Bug 20 (UX/a11y): 6 of 7 nav tabs were missing ``id`` attributes
(only ``nav-tab-gallery`` had one). This:
  - makes the tabs harder to target programmatically (testing,
    deep-linking)
  - makes screen-reader announcements less consistent
  - makes inconsistent aria pattern in the same tablist
Added id="nav-tab-{view}" to the other 6 tabs.

Bug 21 (UX/a11y): The mass-tag-editor modal opened via its own
classList.add('visible') call, bypassing the global ``showModal``
helper. As a result Escape did not close it, focus was not trapped
inside, and focus did not restore to the trigger button on close.
The modal also lacked role="dialog" / aria-modal / aria-labelledby.

Fix: mass-tag-editor.openModal/closeModal now delegate to
window.showModal / window.hideModal; modal has full aria attributes.
"""
from __future__ import annotations

from pathlib import Path
import re

FRONTEND = Path(__file__).resolve().parent.parent.parent / "frontend"
INDEX_HTML = (FRONTEND / "index.html").read_text(encoding="utf-8")


def test_every_nav_tab_has_id_and_icon():
    """All 7 desktop nav tabs must have id="nav-tab-X" and a <span class="tab-icon">."""
    expected_views = ["gallery", "reader", "censor", "sorting", "similar", "artist", "promptlab"]
    for view in expected_views:
        # The tab button line should look like:
        # <button class="nav-tab..." id="nav-tab-{view}" data-view="{view}" role="tab" ...>
        pattern_id = rf'<button[^>]*id="nav-tab-{view}"[^>]*data-view="{view}"'
        pattern_data = rf'<button[^>]*data-view="{view}"[^>]*id="nav-tab-{view}"'
        has_id = re.search(pattern_id, INDEX_HTML) or re.search(pattern_data, INDEX_HTML)
        assert has_id, f"nav-tab for view='{view}' is missing id='nav-tab-{view}'"

        # Find the button block and ensure it has a tab-icon span
        # (greedy match between button open and matching </button>)
        block_match = re.search(
            rf'<button[^>]*data-view="{view}"[^>]*>(.*?)</button>',
            INDEX_HTML, re.DOTALL,
        )
        assert block_match, f"Could not locate <button data-view='{view}'>"
        block = block_match.group(1)
        assert 'class="tab-icon"' in block, (
            f"Nav tab for view='{view}' is missing <span class='tab-icon'>. "
            f"All tabs in this tablist should be visually consistent."
        )


def test_mass_tag_modal_has_aria_attributes():
    """mass-tag-modal must declare role=dialog + aria-modal + aria-labelledby
    for screen-reader compatibility."""
    block_match = re.search(
        r'<div class="modal" id="mass-tag-modal"[^>]*>',
        INDEX_HTML,
    )
    assert block_match, "mass-tag-modal not found"
    opening = block_match.group(0)
    assert 'role="dialog"' in opening, f"mass-tag-modal missing role='dialog': {opening}"
    assert 'aria-modal="true"' in opening, f"mass-tag-modal missing aria-modal='true': {opening}"
    assert 'aria-labelledby=' in opening, f"mass-tag-modal missing aria-labelledby: {opening}"


def test_mass_tag_modal_title_has_id_for_aria_labelledby():
    """The aria-labelledby reference must point to a real element id."""
    # Extract the labelledby value
    m = re.search(r'id="mass-tag-modal"[^>]*aria-labelledby="([^"]+)"', INDEX_HTML)
    assert m, "mass-tag-modal aria-labelledby not parseable"
    title_id = m.group(1)
    # Confirm an element with that id exists
    assert re.search(rf'id="{re.escape(title_id)}"', INDEX_HTML), (
        f"aria-labelledby points to id='{title_id}' but no such element exists in index.html"
    )


def test_mass_tag_editor_uses_global_show_hide_modal():
    """mass-tag-editor.js must delegate open/close to the global
    window.showModal/window.hideModal helpers so it gets the same
    Escape-key handler, focus trap, and focus restoration as every
    other modal in the app."""
    src = (FRONTEND / "js" / "mass-tag-editor.js").read_text(encoding="utf-8")
    # The opener should reference window.showModal
    assert "window.showModal" in src, (
        "mass-tag-editor.openModal must use window.showModal so the modal "
        "gets the standard Escape handler and focus trap. Bypassing it via "
        "a manual classList.add('visible') breaks Escape-to-close."
    )
    assert "window.hideModal" in src, (
        "mass-tag-editor.closeModal must use window.hideModal for symmetry "
        "with showModal (focus restore, listener cleanup)."
    )
