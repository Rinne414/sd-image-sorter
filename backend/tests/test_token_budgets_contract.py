"""The caption token limits the pages use are the ones the backend counts against.

Krea 2's limit drifted: the pages said 512, but its prompt template takes 5 of
them, so 507 tokens of a caption are read (caption_tokenizer_service). The
page keeps its own table, so this holds it to the backend's.
"""

from __future__ import annotations

import re
from pathlib import Path

from services.caption_tokenizer_service import PROFILES

ROOT = Path(__file__).resolve().parents[2]
CLASSIC = ROOT / "frontend" / "js" / "modules" / "target-model.js"

def _classic_budgets() -> dict[str, int]:
    source = CLASSIC.read_text(encoding="utf-8")
    budgets = {}
    for model in PROFILES:
        start = source.index(f"        {model}: {{")
        match = re.compile(r"tokenBudget:\s*(\d+)").search(source, start)
        assert match, model
        budgets[model] = int(match.group(1))
    return budgets


def test_classic_token_budgets_are_the_backend_limits():
    assert _classic_budgets() == {model: p.limit for model, p in PROFILES.items()}
