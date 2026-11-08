"""Icons are line icons from the sprite, never text glyphs (UI pass 2026-11-08).

Blind judges named "text symbols mixed with a line icon set" (triangles and
squares as arrows, view sizes, play/stop) twice in one day, after a first
sweep had missed the fold arrows and the menu carets. This check fails when a
triangle or square glyph comes back into the classic markup, scripts or
language packs.

Allowed: the fold-arrow spans that CSS draws as a chevron (ui-refresh.css,
"Fold arrows are line chevrons"); scripts may still write a glyph into them.
Comments are ignored, and so is onboarding copy that names the "More" menu.
"""

from __future__ import annotations

import re
from pathlib import Path

FRONTEND = Path(__file__).resolve().parents[2] / "frontend"

GLYPHS = re.compile("[▲▴▶▸▼▾◀◂■▬▮▦◼◥◫▣⌕⌖⟳↻↺＋⋯⚙⏹☁◎◇✕]")

# A multiplication sign is a fine "960 × 1440", but not a close or remove button.
BUTTON_CROSS = re.compile(r">\s*×\s*<|textContent\s*=\s*'×'|,\s*'×'\)")

# The same glyphs written as HTML entities (a close button's &times;, a
# folder arrow's &#9654;) slipped past the character check (2026-11-09).
ENTITIES = re.compile(
    r"&(times|#215|#x0*d7|#9654|#x0*25b6|#9660|#x0*25bc|#9650|#x0*25b2|#10005|#x0*2715);",
    re.IGNORECASE,
)

# Emoji used as icons beside line icons (censor undo/redo, keycap step numbers,
# busy hourglasses, keyboard marks; 2026-11-09). Rating stars and the warning
# sign stay allowed: they are typography in text.
EMOJI_ICONS = re.compile(
    "[⌨↩↪↔⬇ℹ⏳✂]️?|[0-9]️⃣|[🌀-🫿]"
)

# The whole-UI error fallback draws when scripts failed; its close stays text.
TEXT_ALLOWED_FILES = ("error-fallback.js",)

# Elements whose glyph is hidden and drawn as a chevron by CSS.
CSS_DRAWN = (
    "collapse-icon",
    "cat-arrow",
    "qs-section-collapse",
    "folder-row-toggle",
    "icon.textContent",
    "arrow.textContent",
)

# Copy that names a menu by its caret (onboarding text), not an icon.
COPY_LINES = ("<strong>More ▾</strong>", "<strong>更多 ▾</strong>")


def _is_comment(line: str) -> bool:
    stripped = line.strip()
    return stripped.startswith(("//", "*", "/*", "<!--"))


def _offenders(path: Path) -> list[str]:
    found = []
    lines = path.read_text(encoding="utf-8").split("\n")
    if path.name in TEXT_ALLOWED_FILES:
        return found
    for number, line in enumerate(lines, 1):
        hit = (
            GLYPHS.search(line)
            or BUTTON_CROSS.search(line)
            or ENTITIES.search(line)
            or EMOJI_ICONS.search(line)
        )
        if not hit or _is_comment(line):
            continue
        if any(marker in line for marker in CSS_DRAWN + COPY_LINES):
            continue
        found.append(f"{path.relative_to(FRONTEND)}:{number}: {line.strip()[:100]}")
    return found


def test_markup_and_scripts_use_line_icons_not_glyphs():
    files = [FRONTEND / "index.html"]
    files += [
        p for p in sorted((FRONTEND / "js").rglob("*.js")) if "lang" not in p.parts
    ]
    offenders = [hit for path in files for hit in _offenders(path)]
    assert offenders == [], (
        'Use a sprite icon (<svg class="icon"><use href="#i-..."/></svg> or '
        "UiIcon.html('i-...')) instead of a text glyph:\n" + "\n".join(offenders)
    )


def test_language_packs_carry_no_glyph_icons():
    offenders = []
    for name in ("en.js", "zh-CN.js"):
        offenders += _offenders(FRONTEND / "js" / "lang" / name)
    assert offenders == [], (
        "Translations are words; the icon belongs in the markup:\n"
        + "\n".join(offenders)
    )
