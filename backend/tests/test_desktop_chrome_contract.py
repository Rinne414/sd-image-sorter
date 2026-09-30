"""Desktop chrome contracts: gallery-first nav, quiet rooms, Graphite overlay."""

from __future__ import annotations

from pathlib import Path
import re

REPO = Path(__file__).resolve().parents[2]
FRONTEND = REPO / "frontend"
INDEX = (FRONTEND / "index.html").read_text(encoding="utf-8")
NAV_MISSIONS = (FRONTEND / "js" / "modules" / "nav-missions.js").read_text(
    encoding="utf-8"
)
TOKENS = (FRONTEND / "css" / "tokens.css").read_text(encoding="utf-8")
LIBRARY_WORKSPACE = (FRONTEND / "js" / "library-workspace.js").read_text(
    encoding="utf-8"
)
BOOT_SHELL = (FRONTEND / "js" / "app" / "boot-listeners-shell.js").read_text(
    encoding="utf-8"
)
DESIGN = (REPO / "docs" / "DESIGN.md").read_text(encoding="utf-8")


def test_default_nav_tabs_are_gallery_home():
    match = re.search(r"const DEFAULT_TABS = \[([^\]]+)\]", NAV_MISSIONS)
    assert match, "DEFAULT_TABS missing"
    tabs = [part.strip().strip("'\"") for part in match.group(1).split(",")]
    # Owner 2026-09-30: the Style Map is the sixth default tab (verified to
    # fit at 1366 zh with compact labels, 1366 en with the brand rung).
    assert tabs == ["gallery", "reader", "sorting", "censor", "similar", "stylemap"]
    assert "promptlab" not in tabs
    assert "artist" not in tabs
    assert "reverse" not in tabs


def test_import_and_tag_are_gallery_only_chrome():
    assert 'data-view="gallery"' in INDEX
    assert '.nav-bar:not([data-view="gallery"]) #btn-scan' in TOKENS
    assert '.nav-bar:not([data-view="gallery"]) #btn-tag' in TOKENS


def test_clear_library_lives_in_library_menu_not_gallery_chrome():
    """Owner 2026-09-28: the danger button sat right under Select Images.

    It is now the last item of the library menu, and both the menu item and
    any future entrance call the one clearCurrentLibraryInteractive().
    """
    assert 'id="btn-clear-db"' not in INDEX
    footer_start = INDEX.find('class="filter-sidebar-footer"')
    footer_end = INDEX.find("</aside>", footer_start)
    assert footer_start != -1 and footer_end > footer_start
    assert "danger" not in INDEX[footer_start:footer_end]

    assert "entry-library-menu-clear" in LIBRARY_WORKSPACE
    assert "window.clearCurrentLibraryInteractive()" in LIBRARY_WORKSPACE
    assert BOOT_SHELL.count("async function clearCurrentLibraryInteractive()") == 1
    assert "API.clearGallery()" not in LIBRARY_WORKSPACE


def test_hard_refresh_lives_in_settings_not_nav():
    assert 'id="btn-refresh-ui"' in INDEX
    nav_start = INDEX.find('class="nav-actions"')
    main_start = INDEX.find('id="main-content"')
    assert nav_start != -1 and main_start > nav_start
    assert 'id="btn-refresh-ui"' not in INDEX[nav_start:main_start]
    general_start = INDEX.find('data-settings-panel="general"')
    assert general_start != -1
    assert 'id="btn-refresh-ui"' in INDEX[general_start : general_start + 16000]


def test_update_buttons_use_sprite_not_emoji():
    assert "i-arrow-up" in INDEX
    assert "⬆️" not in INDEX
    assert ">⬆</button>" not in INDEX


def test_index_html_has_no_post_token_palette():
    assert "backdrop-filter: blur(12px)" not in INDEX
    assert "rgba(8, 18, 27" not in INDEX
    assert "rgba(255, 138, 61" not in INDEX
    assert ".folder-browser {" in TOKENS
    folder_block = TOKENS.split(".folder-browser {", 1)[1][:800]
    assert "backdrop-filter" not in folder_block


def test_censor_toolbar_is_not_a_pill():
    censor = (FRONTEND / "css" / "censor-v2.css").read_text(encoding="utf-8")
    assert "translateY(-1px)" not in censor
    assert re.search(
        r"\.censor-toolbar-v2[^{]*\{[^}]*border-radius:\s*var\(--r-card", censor
    )


def test_prompt_lab_and_artist_start_cards_default_hidden():
    assert 'id="promptlab-start-card" hidden' in INDEX
    assert 'id="artist-start-card" hidden' in INDEX
    lifecycle = (FRONTEND / "js" / "prompt-lab" / "lifecycle.js").read_text(
        encoding="utf-8"
    )
    artist = (FRONTEND / "js" / "artist" / "events.js").read_text(encoding="utf-8")
    assert "card.hidden = true" in lifecycle
    assert "card.hidden = true" in artist
    assert "promptlab-guide-seen') === 'true'" not in lifecycle
    assert "artist-guide-seen') === 'true'" not in artist


def test_prompt_lab_does_not_draw_empty_caption_dash_card():
    stats = (FRONTEND / "js" / "prompt-lab" / "stats.js").read_text(encoding="utf-8")
    assert "card.hidden = !hasValue" in stats
    assert 'class="promptlab-summary-card" hidden' in INDEX


def test_design_doc_matches_graphite_not_aurora_accents():
    assert "Graphite contract" in DESIGN
    assert "Blue = next action, pink = user decision, purple = AI output" not in DESIGN
    collapsed = re.sub(r"\s+", " ", DESIGN)
    assert "Do not put palette literals in" in collapsed
    css_own = DESIGN.split("## §css-ownership", 1)[1]
    assert "index.html" in css_own[:1200]
