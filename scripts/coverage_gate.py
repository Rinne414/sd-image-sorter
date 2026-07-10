"""Click-coverage ratchet gate (QA coverage ledger, Phase 2).

Inputs (produced by the Playwright run):
  artifacts/control-inventory.json        every interactive control the crawl
                                          saw across all views/modals
  artifacts/click-coverage/raw-*.jsonl    every control actually clicked by
                                          ANY spec (via the click-ledger base)

Outputs:
  artifacts/click-coverage.json           merged clicked-controls summary
  artifacts/untested-controls.json        inventory minus clicked minus waivers

Gate:
  tests/e2e/coverage-baseline.json holds min_click_coverage_pct and a waiver
  regex list. Coverage may only rise (ratchet): the gate fails when the run's
  coverage drops below the committed baseline, and prints a reminder to raise
  the baseline when the run beats it by a clear margin.

Usage:
  python scripts/coverage_gate.py [--allow-missing]

--allow-missing exits 0 when the artifacts are absent (partial local runs
that skipped the crawl spec); the full-CI run always has them.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "artifacts"
INVENTORY_PATH = ARTIFACTS / "control-inventory.json"
LEDGER_DIR = ARTIFACTS / "click-coverage"
MERGED_PATH = ARTIFACTS / "click-coverage.json"
UNTESTED_PATH = ARTIFACTS / "untested-controls.json"
BASELINE_PATH = ROOT / "tests" / "e2e" / "coverage-baseline.json"

RATCHET_HINT_MARGIN_PCT = 2.0


def _load_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def _load_clicked_keys() -> tuple[set[str], dict[str, int]]:
    clicked: set[str] = set()
    per_test: dict[str, int] = {}
    for raw in sorted(LEDGER_DIR.glob("raw-*.jsonl")):
        for line in raw.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            key = entry.get("key")
            if not isinstance(key, str) or not key:
                continue
            clicked.add(key)
            test_id = str(entry.get("test") or "unknown")
            per_test[test_id] = per_test.get(test_id, 0) + 1
    return clicked, per_test


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--allow-missing",
        action="store_true",
        help="exit 0 when coverage artifacts are absent (partial runs)",
    )
    args = parser.parse_args()

    if not INVENTORY_PATH.exists() or not LEDGER_DIR.exists():
        message = (
            f"[coverage-gate] missing artifacts ({INVENTORY_PATH.name} or "
            f"{LEDGER_DIR.name}/) — run the full Playwright suite first."
        )
        if args.allow_missing:
            print(f"{message} Skipping (--allow-missing).")
            return 0
        print(message)
        return 1

    baseline = _load_json(BASELINE_PATH) if BASELINE_PATH.exists() else {}
    min_pct = float(baseline.get("min_click_coverage_pct", 0.0))
    waivers = [re.compile(pattern) for pattern in baseline.get("waivers", [])]

    inventory = _load_json(INVENTORY_PATH)
    controls = inventory.get("controls", [])
    inventory_keys = {c["key"] for c in controls if isinstance(c.get("key"), str)}

    clicked, per_test = _load_clicked_keys()

    def waived(key: str) -> bool:
        return any(pattern.search(key) for pattern in waivers)

    covered = {key for key in inventory_keys if key in clicked or waived(key)}
    untested = sorted(inventory_keys - covered)
    pct = 100.0 * len(covered) / len(inventory_keys) if inventory_keys else 0.0

    MERGED_PATH.write_text(
        json.dumps(
            {
                "clicked_unique_controls": len(clicked),
                "inventory_controls": len(inventory_keys),
                "covered_controls": len(covered),
                "coverage_pct": round(pct, 2),
                "baseline_pct": min_pct,
                "clicks_per_test": per_test,
                "clicked_keys": sorted(clicked),
            },
            indent=2,
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    by_context: dict[str, list[str]] = {}
    key_context = {c["key"]: c.get("context", "unknown") for c in controls}
    for key in untested:
        by_context.setdefault(key_context.get(key, "unknown"), []).append(key)
    UNTESTED_PATH.write_text(
        json.dumps(
            {
                "count": len(untested),
                "by_context": by_context,
            },
            indent=2,
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    print(
        f"[coverage-gate] click coverage {pct:.2f}% "
        f"({len(covered)}/{len(inventory_keys)} controls; "
        f"{len(clicked)} unique clicked suite-wide; baseline {min_pct:.2f}%)"
    )
    print(f"[coverage-gate] untested controls: {len(untested)} → {UNTESTED_PATH}")

    if pct + 1e-9 < min_pct:
        print(
            f"[coverage-gate] FAIL: coverage {pct:.2f}% dropped below the "
            f"committed baseline {min_pct:.2f}% ({BASELINE_PATH})."
        )
        return 1
    if pct > min_pct + RATCHET_HINT_MARGIN_PCT:
        print(
            f"[coverage-gate] hint: coverage beats the baseline by more than "
            f"{RATCHET_HINT_MARGIN_PCT}% — consider ratcheting "
            f"min_click_coverage_pct up to {pct:.2f} in {BASELINE_PATH}."
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
