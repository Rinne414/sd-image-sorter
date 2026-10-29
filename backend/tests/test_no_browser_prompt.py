"""No page uses the browser's own question boxes.

The desktop program (Electron) has no window.prompt(): it throws "prompt() is
not supported", so New library and Rename library did nothing there (found
2026-10-30). Every name or value is asked with the program's own dialog
(classic: App.showInputModal; V Opus: its Dialog).

confirm() and alert() work, but look unfinished: Chrome's unstyled
"127.0.0.1:8487 says" box with untranslated buttons, or a native OS box in the
desktop program (found 2026-10-30). Every question is asked in the program's
own dialog (classic: App.confirmAsync or App.showConfirm) and every notice is a
toast (showToast).
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CLASSIC_JS = ROOT / "frontend" / "js"
# Translations and third-party code are not program code.
CLASSIC_SKIP = (CLASSIC_JS / "lang", CLASSIC_JS / "vendor")
PROMPT_CALL = re.compile(r"\bwindow\s*\.\s*prompt\s*\(|\bglobalThis\s*\.\s*prompt\s*\(")
# window.confirm( / alert( and the bare calls, but not a method (obj.confirm()
# or a longer name (showConfirm(, _confirm().
CLASSIC_BOX_CALL = re.compile(
    r"(?<![\w$.])(?:(?:window|globalThis)\s*\.\s*)?(?:confirm|alert)\s*\("
)
V4_BOX_CALL = re.compile(r"\b(?:window|globalThis)\s*\.\s*(?:confirm|alert)\s*\(")


def _sources():
    yield from (ROOT / "frontend").rglob("*.js")
    yield from (ROOT / "frontend").rglob("*.html")
    for pattern in ("*.ts", "*.tsx"):
        yield from (ROOT / "frontend-v4" / "src").rglob(pattern)


def _classic_sources():
    for path in CLASSIC_JS.rglob("*.js"):
        if not any(path.is_relative_to(skip) for skip in CLASSIC_SKIP):
            yield path
    yield from (ROOT / "frontend").glob("*.html")


def _v4_sources():
    for pattern in ("*.ts", "*.tsx"):
        yield from (ROOT / "frontend-v4" / "src").rglob(pattern)


def _matching_lines(paths, pattern):
    found = []
    for path in paths:
        if "node_modules" in path.parts or "dist" in path.parts:
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        for number, line in enumerate(text.splitlines(), start=1):
            if pattern.search(line):
                found.append(f"{path.relative_to(ROOT)}:{number}: {line.strip()[:120]}")
    return found


def test_no_page_calls_the_browser_prompt_box():
    found = _matching_lines(_sources(), PROMPT_CALL)
    assert not found, (
        "window.prompt() throws in the desktop program (Electron). Ask with the "
        "program's own dialog instead (classic: App.showInputModal):\n"
        + "\n".join(found)
    )


def test_the_classic_ui_never_calls_the_browser_confirm_or_alert_box():
    found = _matching_lines(_classic_sources(), CLASSIC_BOX_CALL)
    assert not found, (
        "confirm() and alert() show the browser's own box. Ask with "
        "`await App.confirmAsync({ title, message, danger })` (or App.showConfirm) "
        "and tell with showToast(message, level). A local helper named confirm "
        "or alert trips this check too: give it another name:\n" + "\n".join(found)
    )


def test_v_opus_never_calls_the_browser_confirm_or_alert_box():
    found = _matching_lines(_v4_sources(), V4_BOX_CALL)
    assert not found, (
        "window.confirm() and window.alert() show the browser's own box. Use "
        "V Opus's own Dialog and toasts instead:\n" + "\n".join(found)
    )


def test_the_box_check_tells_calls_from_methods_and_longer_names():
    assert CLASSIC_BOX_CALL.search("if (!window.confirm(msg)) return;")
    assert CLASSIC_BOX_CALL.search("if (!confirm(text)) return;")
    assert CLASSIC_BOX_CALL.search("alert(`Smart Tag failed: ${msg}`);")
    assert CLASSIC_BOX_CALL.search("globalThis.alert (message)")
    assert not CLASSIC_BOX_CALL.search("app.showConfirm(title, message, run);")
    assert not CLASSIC_BOX_CALL.search("this._confirm(message)")
    assert not CLASSIC_BOX_CALL.search("dialog.confirm(answer)")
    assert not CLASSIC_BOX_CALL.search("await App.confirmAsync({ title })")
    assert V4_BOX_CALL.search("if (window.confirm('Delete?')) remove()")
    assert not V4_BOX_CALL.search("onClick={() => void confirm()}")
