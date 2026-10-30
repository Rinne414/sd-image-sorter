"""Static guard for the `[hidden]` trap in the classic page.

The UA rule ``[hidden] { display: none }`` has the lowest specificity, so any
class or id rule that sets ``display`` beats it and ``el.hidden = true`` stops
hiding the element. It happened again on 2026-10-23: ``.settings-home-panel``
is ``display: grid``, so the desktop-only Settings panel showed in a normal
browser with controls that did nothing.

This test reads every element that ``frontend/index.html`` ships with the
``hidden`` attribute, finds plain ``.class`` / ``#id`` rules that give it a
display, and requires a matching ``[hidden]`` guard for each (on the element
itself, or a container guard such as ``.entry-page [hidden]``). The
browser-side twin is ``tests/e2e/specs/desktop-layout-guards.spec.ts``, which
also covers elements hidden later from JavaScript.
"""

from __future__ import annotations

import re
from html.parser import HTMLParser
from pathlib import Path

FRONTEND = Path(__file__).resolve().parents[2] / "frontend"
RULE_RE = re.compile(r"([^{}]+)\{([^{}]*)\}")
DISPLAY_RE = re.compile(r"(?:^|;)\s*display\s*:\s*([a-z-]+)", re.IGNORECASE)
COMMENT_RE = re.compile(r"/\*.*?\*/", re.DOTALL)
MEDIA_RE = re.compile(r"@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}")
VOID_TAGS = {
    "area",
    "base",
    "br",
    "col",
    "embed",
    "hr",
    "img",
    "input",
    "link",
    "meta",
    "source",
    "track",
    "wbr",
}


def _token(element_id: str, classes: list[str]) -> list[str]:
    tokens = [f".{name}" for name in classes]
    if element_id:
        tokens.append(f"#{element_id}")
    return tokens


class _HiddenCollector(HTMLParser):
    """Elements carrying ``hidden``, each with the id/class tokens of its ancestors."""

    def __init__(self) -> None:
        super().__init__()
        self.elements: list[tuple[str, list[str], set[str]]] = []
        self._stack: list[tuple[str, list[str]]] = []

    def handle_starttag(self, tag, attrs):  # noqa: ANN001 - HTMLParser API
        names = dict(attrs)
        tokens = _token(names.get("id") or "", (names.get("class") or "").split())
        if "hidden" in names:
            ancestors = {token for _tag, parent in self._stack for token in parent}
            self.elements.append((names.get("id") or "", tokens, ancestors))
        if tag not in VOID_TAGS:
            self._stack.append((tag, tokens))

    def handle_endtag(self, tag):  # noqa: ANN001 - HTMLParser API
        for index in range(len(self._stack) - 1, -1, -1):
            if self._stack[index][0] == tag:
                del self._stack[index:]
                return


def _stylesheets() -> list[Path]:
    html = (FRONTEND / "index.html").read_text(encoding="utf-8")
    hrefs = re.findall(r'href="/static/(css/[^"?]+\.css)', html)
    return [FRONTEND / href for href in hrefs if (FRONTEND / href).exists()]


def _rules() -> list[tuple[str, str]]:
    rules = []
    for sheet in _stylesheets():
        text = COMMENT_RE.sub("", sheet.read_text(encoding="utf-8"))
        # Top-level rules only: @media blocks hold width-specific layout.
        for selectors, body in RULE_RE.findall(MEDIA_RE.sub("", text)):
            for selector in selectors.split(","):
                rules.append((selector.strip(), body))
    return rules


def _has_guard(tokens: list[str], ancestors: set[str], guards: set[str]) -> bool:
    for guard in guards:
        if any(guard.endswith(f"{token}[hidden]") for token in tokens):
            return True
        # A container guard such as `.entry-page [hidden]` covers its children.
        if (
            guard.endswith(" [hidden]")
            and guard[: -len(" [hidden]")].split()[-1] in ancestors
        ):
            return True
    return False


def test_elements_shipped_hidden_have_a_guard_against_display_rules():
    collector = _HiddenCollector()
    collector.feed((FRONTEND / "index.html").read_text(encoding="utf-8"))
    rules = _rules()
    guards = {
        selector
        for selector, body in rules
        if "[hidden]" in selector and "none" in body
    }
    leaks = []
    for element_id, tokens, ancestors in collector.elements:
        shows = [
            selector
            for selector, body in rules
            if selector in tokens
            and (match := DISPLAY_RE.search(body))
            and match.group(1).lower() != "none"
        ]
        if shows and not _has_guard(tokens, ancestors, guards):
            leaks.append(
                f"{element_id or tokens}: {shows[0]} sets display without a [hidden] guard"
            )
    assert leaks == []


def test_desktop_settings_panel_is_guarded_and_only_the_shell_shows_it():
    css = (FRONTEND / "css" / "tokens.css").read_text(encoding="utf-8")
    assert ".settings-home-panel[hidden]" in css
    script = (FRONTEND / "js" / "desktop-settings.js").read_text(encoding="utf-8")
    # The only place that reveals the shell's panel is start(), which the
    # desktop bridge calls when the page runs inside the desktop shell. The
    # browser gets its own note panel (where the desktop program is).
    start = script.split("function start(desktop", 1)[1].split("\n    }\n", 1)[0]
    assert "el('settings-desktop-panel')" in start
    assert "panel.hidden = false" in start
    assert script.count("settings-desktop-panel") == 1
    note = script.split("async function showBrowserNote", 1)[1].split("\n    }\n", 1)[0]
    assert "el('settings-desktop-browser')" in note
    assert "window.sdDesktop" in note
