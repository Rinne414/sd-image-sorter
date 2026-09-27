"""Desktop chrome contract that outlives the V3.5 markup: the Graphite design doc."""
from __future__ import annotations

from pathlib import Path
import re

REPO = Path(__file__).resolve().parents[2]
DESIGN = (REPO / "docs" / "DESIGN.md").read_text(encoding="utf-8")


def test_design_doc_matches_graphite_not_aurora_accents():
    assert "Graphite contract" in DESIGN
    assert "Blue = next action, pink = user decision, purple = AI output" not in DESIGN
    collapsed = re.sub(r"\s+", " ", DESIGN)
    assert "Do not put palette literals in" in collapsed
    css_own = DESIGN.split("## §css-ownership", 1)[1]
    assert "index.html" in css_own[:1200]
