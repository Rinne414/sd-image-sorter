"""All-features catalog rows line up whatever their icon is.

Rows with a sprite icon (``#i-...``, 16 px wide) sat about 9 px left of the
colour-emoji rows (about 25 px wide), so their titles did not line up. The
icon cell is now one fixed box for every row. Measured in a browser on
2026-10-23: every title at the same x (53 px into the row at 1366x768).
"""

from __future__ import annotations

import re
from pathlib import Path

FRONTEND = Path(__file__).resolve().parents[2] / "frontend"


def _rule(css: str, selector: str) -> str:
    match = re.search(rf"(?m)^{re.escape(selector)}\s*\{{([^}}]*)\}}", css)
    assert match, f"{selector} rule missing"
    return match.group(1)


def test_catalog_icon_is_one_fixed_centred_box():
    css = (FRONTEND / "css" / "entry.css").read_text(encoding="utf-8")
    box = _rule(css, ".catalog-icon")
    assert re.search(r"\bwidth:\s*\d+px", box)
    assert "justify-content: center" in box
    assert re.search(r"\bwidth:\s*\d+px", _rule(css, ".catalog-icon .icon"))


def test_catalog_descriptions_do_not_repeat_their_titles():
    for pack in ("en.js", "zh-CN.js"):
        text = (FRONTEND / "js" / "lang" / pack).read_text(encoding="utf-8")
        desc = re.search(r"'catalog\.browserExtension':\s*'([^']*)'", text).group(1)
        assert not desc.lower().startswith(("browser extension", "浏览器扩展")), pack
