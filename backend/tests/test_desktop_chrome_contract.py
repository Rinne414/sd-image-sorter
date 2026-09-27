"""The V4 design doc (docs/DESIGN.md) says what the V4 code does."""
from __future__ import annotations

from pathlib import Path
import re

REPO = Path(__file__).resolve().parents[2]
DESIGN = (REPO / "docs" / "DESIGN.md").read_text(encoding="utf-8")
UI_SCALE = (REPO / "frontend-v4" / "src" / "lib" / "uiScale.ts").read_text(encoding="utf-8")
TOKENS = REPO / "frontend-v4" / "src" / "design" / "tokens.css"


def test_design_doc_names_the_v4_token_owner_and_the_no_ai_look_rule():
    assert TOKENS.is_file()
    css_own = DESIGN.split("## §css-ownership", 1)[1]
    assert "`src/design/tokens.css` owns every colour" in css_own[:600]
    assert "Must not look AI-made" in DESIGN
    # V3.5's retired three-accent scheme stays out.
    assert "Blue = next action, pink = user decision, purple = AI output" not in DESIGN


def test_design_doc_zoom_steps_match_ui_scale():
    steps = re.findall(r"windowWidth >= (\d+)\) return ([\d.]+)", UI_SCALE)
    assert steps, "uiScale.ts no longer has the width steps this test reads"
    collapsed = re.sub(r"\s+", " ", DESIGN)
    widths = " / ".join(width for width, _ in sorted(steps, key=lambda s: int(s[0])))
    percents = " / ".join(f"{round(float(zoom) * 100)}%" for _, zoom in sorted(steps, key=lambda s: int(s[0])))
    assert f"from {widths} px" in collapsed
    assert f"then {percents}" in collapsed
