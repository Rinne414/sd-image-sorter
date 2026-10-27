"""The caption token limits the pages use are the ones the backend counts against.

Krea 2's limit drifted: the pages said 512, but its prompt template takes 5 of
them, so 507 tokens of a caption are read (caption_tokenizer_service). Both
interfaces keep their own table, so this holds them to the backend's.
"""

from __future__ import annotations

import re
from pathlib import Path

from services.caption_tokenizer_service import PROFILES

ROOT = Path(__file__).resolve().parents[2]
CLASSIC = ROOT / "frontend" / "js" / "modules" / "target-model.js"
VOPUS = (
    ROOT / "frontend-v4" / "src" / "features" / "batch" / "check" / "captionChecks.ts"
)


def _classic_budgets() -> dict[str, int]:
    source = CLASSIC.read_text(encoding="utf-8")
    budgets = {}
    for model in PROFILES:
        start = source.index(f"        {model}: {{")
        match = re.compile(r"tokenBudget:\s*(\d+)").search(source, start)
        assert match, model
        budgets[model] = int(match.group(1))
    return budgets


def _vopus_budgets() -> dict[str, int]:
    source = VOPUS.read_text(encoding="utf-8")
    table = re.search(
        r"TOKEN_BUDGET: Record<TargetModel, number> = \{([^}]*)\}", source
    )
    assert table
    pairs = re.findall(r"'?(\w*)'?:\s*(\d+)", table.group(1))
    return {name: int(value) for name, value in pairs}


def test_classic_token_budgets_are_the_backend_limits():
    assert _classic_budgets() == {model: p.limit for model, p in PROFILES.items()}


def test_vopus_token_budgets_are_the_backend_limits():
    budgets = _vopus_budgets()
    assert {model: budgets[model] for model in PROFILES} == {
        model: p.limit for model, p in PROFILES.items()
    }
    # No base model chosen counts as CLIP, as the backend's sdxl profile does.
    assert budgets[""] == PROFILES["sdxl"].limit
