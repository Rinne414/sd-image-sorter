"""No page uses the browser's prompt box.

The desktop program (Electron) has no window.prompt(): it throws "prompt() is
not supported", so New library and Rename library did nothing there (found
2026-10-30). Every name or value is asked with the program's own dialog
(classic: App.showInputModal; V Opus: its Dialog).
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PROMPT_CALL = re.compile(r"\bwindow\s*\.\s*prompt\s*\(|\bglobalThis\s*\.\s*prompt\s*\(")


def _sources():
    yield from (ROOT / "frontend").rglob("*.js")
    yield from (ROOT / "frontend").rglob("*.html")
    for pattern in ("*.ts", "*.tsx"):
        yield from (ROOT / "frontend-v4" / "src").rglob(pattern)


def test_no_page_calls_the_browser_prompt_box():
    found = []
    for path in _sources():
        if "node_modules" in path.parts or "dist" in path.parts:
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        for number, line in enumerate(text.splitlines(), start=1):
            if PROMPT_CALL.search(line):
                found.append(f"{path.relative_to(ROOT)}:{number}: {line.strip()[:120]}")
    assert not found, (
        "window.prompt() throws in the desktop program (Electron). Ask with the "
        "program's own dialog instead (classic: App.showInputModal):\n" + "\n".join(found)
    )
