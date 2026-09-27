# Click-Coverage Ledger (V4)

The ledger answers one question for the V4 interface: of all the controls the
E2E suite put on screen, how many did some test actually use? The gate turns
the answer into a ratchet so it can only go up.

## Parts

| File | Role |
|---|---|
| `tests/e2e/fixtures/control-key.js` | Names a control (`window.__controlKey`), where it lives (`window.__controlContext`: the open dialog or menu, else the page), and lists every control on screen (`window.__controlsInView`). The same names are used for "seen" and "used", so the diff is exact. |
| `tests/e2e/fixtures/click-ledger.ts` | The `test` every spec imports (it re-exports everything else from `@playwright/test`). Records a **used** row when a test clicks a control or changes a field (click, change, input), and **seen** rows for every control on screen 250 ms after an action, after each page load and when the test ends. Rows go to `artifacts/click-coverage/raw-*.jsonl`. |
| `tests/e2e/fixtures/global-setup.ts` | Empties the ledger before a local (non-sharded) run. In a sharded run the runner owns the reset and publishes the ledger with the run identity. |
| `scripts/coverage_gate.py` | Merges the rows into `artifacts/click-coverage.json` and `artifacts/untested-controls.json` (seen but never used, grouped by page or dialog) and fails when coverage falls below the baseline. |
| `tests/e2e/coverage-baseline.json` | The committed floor `min_click_coverage_pct` (may only go up) and a list of waiver regexes, each with a reason. |

`scripts/run_ci.py` runs the gate right after the sharded Playwright run, and
only when that run passed.

## Control names

- A control with a `data-testid` is `tid:<test id>`; runs of two or more digits
  become `#`, so `card-1234` and `card-5678` are one control.
- Otherwise it is `<role or tag>[<input type>]:<accessible name>`, prefixed by
  the nearest ancestor's test id, so "Close" in two dialogs stays two controls.
- Contexts: `dialog:<label>`, `menu:<label>`, `listbox:<label>`, or
  `page:<name>` (the hash for Settings and Tools pages, else the page root's
  test id, else the current top-bar tab).

## What the number means

- **coverage** = used controls (plus waivers) ÷ controls seen anywhere in the
  suite.
- A control no test ever renders is not counted at all: the ledger measures how
  well the suite uses what it shows, not whether every page is visited. Adding
  a spec that opens a new page therefore adds its controls to the denominator.
- `untested-controls.json` is the work list for the next round of tests.

## Common commands

```bash
# after a partial local run (skips when the run artifacts are missing)
python scripts/coverage_gate.py --allow-missing

# full run (run_ci runs the gate after the sharded E2E)
python scripts/run_ci.py

# the untested list by page or dialog
python -c "import json;d=json.load(open('artifacts/untested-controls.json',encoding='utf-8'));print(d['count']);[print(k,len(v)) for k,v in d['by_context'].items()]"
```

When a run beats the baseline by more than 2 points the gate says so; raising
`min_click_coverage_pct` in that commit is one notch of the ratchet.
