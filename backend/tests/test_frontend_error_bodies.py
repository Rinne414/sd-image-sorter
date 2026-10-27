"""Pages that read a failed request's body read the program's own field.

The program answers an error with {"error": "...", "type": ..., "status_code": ...}
(main.py http_exception_handler); FastAPI's {"detail": ...} never reaches a
page. A page that read only ``body.detail`` lost the reason and showed
"Failed to browse folder", "API Error: 500" or a bare status text instead.
"""

from __future__ import annotations

import re
from pathlib import Path

FRONTEND_JS = Path(__file__).resolve().parents[2] / "frontend" / "js"
DETAIL_FIRST = re.compile(r"\b([A-Za-z_$][\w$]*)\??\.detail\s*\|\|")
LOOKBACK_LINES = 8


def _parsed_from_response(name: str, lines: list[str], index: int) -> bool:
    """Whether `name` holds a response body parsed a few lines above (or on this line)."""
    assigned = re.compile(rf"\b{re.escape(name)}\s*=\s*await\s+[\w$.]+\.json\(")
    window = lines[max(0, index - LOOKBACK_LINES) : index + 1]
    return any(assigned.search(line) for line in window)


def _detail_only_reads() -> list[str]:
    found = []
    for path in sorted(FRONTEND_JS.rglob("*.js")):
        rel = path.relative_to(FRONTEND_JS).as_posix()
        if rel.startswith(("vendor/", "lang/")):
            continue
        lines = path.read_text(encoding="utf-8").splitlines()
        for index, line in enumerate(lines):
            for match in DETAIL_FIRST.finditer(line):
                name = match.group(1)
                if f"{name}.error" in line or f"{name}?.error" in line:
                    continue
                if _parsed_from_response(name, lines, index):
                    found.append(f"{rel}:{index + 1}: {line.strip()}")
    return found


def test_no_page_reads_only_detail_from_a_failed_response():
    assert _detail_only_reads() == []


def test_the_scan_sees_a_detail_only_read():
    lines = [
        "if (!resp.ok) {",
        "    const errData = await resp.json().catch(() => ({}));",
        "    throw new Error(errData.detail || 'Failed');",
    ]
    match = DETAIL_FIRST.search(lines[2])

    assert match and _parsed_from_response(match.group(1), lines, 2)
