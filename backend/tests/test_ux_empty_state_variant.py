"""Frontend contract test: gallery empty state has two variants.

UX-6 (MEDIUM): When the user filters their library and gets zero
matches, they used to see the "No images yet — import a folder"
onboarding card with the import-images CTA. On a 71k-image library
this is actively misleading: the user thinks their entire library
disappeared. The real situation is "your filter is too narrow".

The fix introduces two variants of the same #gallery-empty-state
element, switched by a class:
  - empty-state-no-library: original onboarding card
    ("No images yet" + "Import an image folder" + onboarding steps)
  - empty-state-no-matches: filter-aware variant
    ("No images match your filters" + "Try removing some filter
    criteria..." + a "Clear all filters" CTA, no onboarding steps)

The variant is applied by ``_applyGalleryEmptyStateVariant`` in
app.js based on whether ``_galleryHasActiveFilter`` returns true.

Two periodic re-translation hooks were also updated so they don't
overwrite the variant's text:
  - ui-refresh.js::_translateGallery now reads the variant class
  - The new ``gallery.noMatchesTitle/Hint/clearFilters`` keys are
    in en.js + zh-CN.js
"""
from __future__ import annotations

from pathlib import Path
import re

FRONTEND = Path(__file__).resolve().parent.parent.parent / "frontend"


def test_app_js_has_gallery_empty_state_variant_logic():
    """The variant helper functions must exist in app.js."""
    src = (FRONTEND / "js" / "app.js").read_text(encoding="utf-8")
    assert "_galleryHasActiveFilter" in src, (
        "app.js must define ``_galleryHasActiveFilter`` to detect "
        "whether a non-default filter is applied."
    )
    assert "_applyGalleryEmptyStateVariant" in src, (
        "app.js must define ``_applyGalleryEmptyStateVariant`` to switch "
        "between the empty-state-no-library and empty-state-no-matches "
        "variants based on filter state."
    )
    # The variant function must reference the new i18n keys
    assert "gallery.noMatchesTitle" in src, (
        "The variant logic must reference ``gallery.noMatchesTitle`` "
        "for the filter-active variant."
    )
    assert "gallery.noMatchesHint" in src, (
        "The variant logic must reference ``gallery.noMatchesHint``."
    )
    assert "gallery.clearFilters" in src, (
        "The variant must offer a 'Clear all filters' CTA via the "
        "``gallery.clearFilters`` key."
    )


def test_ui_refresh_respects_variant_class():
    """ui-refresh.js::_translateGallery must check the variant class
    instead of always overwriting the empty state with the no-images
    keys. Otherwise it would clobber the no-matches copy on every
    re-translate cycle."""
    src = (FRONTEND / "js" / "ui-refresh.js").read_text(encoding="utf-8")
    # Anywhere it sets the gallery-empty-state h3, it must be conditional
    # on the variant class
    pattern = re.compile(r"empty-state-no-matches", re.MULTILINE)
    assert pattern.search(src), (
        "ui-refresh.js::_translateGallery must check for the "
        "``empty-state-no-matches`` variant class and use the "
        "``gallery.noMatchesTitle/Hint`` keys when present, instead of "
        "always falling back to ``gallery.noImages/scanPrompt``."
    )


def test_no_matches_translations_present_both_languages():
    """The new translation keys must exist in both lang files."""
    en = (FRONTEND / "js" / "lang" / "en.js").read_text(encoding="utf-8")
    zh = (FRONTEND / "js" / "lang" / "zh-CN.js").read_text(encoding="utf-8")
    for key in ("gallery.noMatchesTitle", "gallery.noMatchesHint", "gallery.clearFilters"):
        assert f"'{key}':" in en, f"en.js missing translation for {key}"
        assert f"'{key}':" in zh, f"zh-CN.js missing translation for {key}"


def test_no_matches_translations_have_distinct_chinese():
    """The new Chinese translations should not reuse the existing
    'no images' copy verbatim - they need to be different so the user
    sees a clearly different message."""
    zh = (FRONTEND / "js" / "lang" / "zh-CN.js").read_text(encoding="utf-8")
    # gallery.noImages = "还没有图片"
    # gallery.noMatchesTitle should not be the same string
    no_images_match = re.search(r"'gallery\.noImages'\s*:\s*'([^']+)'", zh)
    no_matches_title_match = re.search(r"'gallery\.noMatchesTitle'\s*:\s*'([^']+)'", zh)
    assert no_images_match and no_matches_title_match
    assert no_images_match.group(1) != no_matches_title_match.group(1), (
        "gallery.noMatchesTitle must be DIFFERENT text from gallery.noImages, "
        "otherwise the variant is pointless."
    )
