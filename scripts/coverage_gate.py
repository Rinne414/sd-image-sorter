"""Click-coverage ratchet gate (QA coverage ledger, Phase 2).

Inputs (produced by the Playwright run):
  artifacts/click-coverage-run.json       successful publication identity
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
  python scripts/coverage_gate.py --expected-run-id RUN_ID [--allow-missing]

--allow-missing exits 0 when the artifacts are absent (partial local runs
that skipped the crawl spec); the full-CI run always has them.
"""

from __future__ import annotations

import argparse
import json
import math
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
COVERAGE_RUN_PATH = ARTIFACTS / "click-coverage-run.json"
PLAYWRIGHT_LAST_RUN_PATH = ROOT / "tests" / "e2e" / "test-results" / ".last-run.json"

RATCHET_HINT_MARGIN_PCT = 2.0
COVERAGE_RUN_SCHEMA_VERSION = 1
COVERAGE_RUN_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


class CoverageArtifactError(ValueError):
    """Raised when current-run coverage publication data is invalid."""


def _load_json_object(path: Path, label: str) -> dict[str, object]:
    try:
        with path.open("r", encoding="utf-8") as handle:
            payload: object = json.load(handle)
    except OSError as error:
        raise CoverageArtifactError(
            f"could not read {label} at {path}: {error}"
        ) from error
    except json.JSONDecodeError as error:
        raise CoverageArtifactError(
            f"{label} is invalid JSON at {path}: {error}"
        ) from error
    except UnicodeError as error:
        raise CoverageArtifactError(
            f"{label} has invalid UTF-8 at {path}: {error}"
        ) from error
    if not isinstance(payload, dict) or not all(
        isinstance(key, str) for key in payload
    ):
        raise CoverageArtifactError(f"{label} must be a JSON object: {path}")
    return payload


def _require_non_empty_string(
    record: dict[str, object],
    field_name: str,
    label: str,
    path: Path,
) -> str:
    value = record.get(field_name)
    if not isinstance(value, str) or not value.strip():
        raise CoverageArtifactError(
            f"{label} requires non-empty string field {field_name!r}: {path}"
        )
    return value


def _require_expected_run_id(value: object) -> str:
    if not isinstance(value, str) or not COVERAGE_RUN_ID_PATTERN.fullmatch(value):
        raise CoverageArtifactError(
            "--expected-run-id is required and must match "
            "/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/"
        )
    return value


def _load_current_run_id(expected_run_id: str) -> str:
    coverage_run = _load_json_object(COVERAGE_RUN_PATH, "coverage run marker")
    schema_version = coverage_run.get("schemaVersion")
    if type(schema_version) is not int or schema_version != COVERAGE_RUN_SCHEMA_VERSION:
        raise CoverageArtifactError(
            "coverage run marker requires "
            f"schemaVersion={COVERAGE_RUN_SCHEMA_VERSION}, received "
            f"{schema_version!r}: {COVERAGE_RUN_PATH}"
        )
    coverage_run_id = _require_non_empty_string(
        coverage_run,
        "runId",
        "coverage run marker",
        COVERAGE_RUN_PATH,
    )

    terminal_run = _load_json_object(
        PLAYWRIGHT_LAST_RUN_PATH,
        "Playwright terminal status",
    )
    terminal_run_id = _require_non_empty_string(
        terminal_run,
        "runId",
        "Playwright terminal status",
        PLAYWRIGHT_LAST_RUN_PATH,
    )
    status = _require_non_empty_string(
        terminal_run,
        "status",
        "Playwright terminal status",
        PLAYWRIGHT_LAST_RUN_PATH,
    )
    failed_tests = terminal_run.get("failedTests")
    if not isinstance(failed_tests, list) or any(
        not isinstance(test_id, str) or not test_id.strip()
        for test_id in failed_tests
    ):
        raise CoverageArtifactError(
            "Playwright terminal status requires failedTests to contain only "
            f"non-empty strings: {PLAYWRIGHT_LAST_RUN_PATH}"
        )
    if status != "passed" or failed_tests:
        raise CoverageArtifactError(
            "Playwright terminal status is not a clean success "
            f"(status={status!r}, failedTests={failed_tests!r}): "
            f"{PLAYWRIGHT_LAST_RUN_PATH}"
        )
    if coverage_run_id != terminal_run_id:
        raise CoverageArtifactError(
            "run identity mismatch: coverage marker "
            f"runId={coverage_run_id!r}, Playwright terminal "
            f"runId={terminal_run_id!r}. Run the full Playwright suite again."
        )
    if coverage_run_id != expected_run_id:
        raise CoverageArtifactError(
            f"expected runId={expected_run_id!r}, current "
            f"runId={coverage_run_id!r}. Another Playwright run replaced the "
            "canonical coverage artifacts."
        )
    return coverage_run_id


def _invalidate_derived_outputs() -> None:
    MERGED_PATH.unlink(missing_ok=True)
    UNTESTED_PATH.unlink(missing_ok=True)


def _load_baseline() -> tuple[float, list[re.Pattern[str]]]:
    baseline = _load_json_object(BASELINE_PATH, "coverage baseline")
    minimum_value = baseline.get("min_click_coverage_pct")
    if isinstance(minimum_value, bool) or not isinstance(minimum_value, (int, float)):
        raise CoverageArtifactError(
            "coverage baseline requires numeric field "
            f"'min_click_coverage_pct': {BASELINE_PATH}"
        )
    minimum = float(minimum_value)
    if not math.isfinite(minimum):
        raise CoverageArtifactError(
            "coverage baseline field 'min_click_coverage_pct' must be finite, "
            f"received {minimum!r}: {BASELINE_PATH}"
        )
    if minimum < 0.0 or minimum > 100.0:
        raise CoverageArtifactError(
            "coverage baseline field 'min_click_coverage_pct' must be between "
            f"0 and 100, received {minimum!r}: {BASELINE_PATH}"
        )
    if "waivers" not in baseline:
        raise CoverageArtifactError(
            f"coverage baseline requires 'waivers': {BASELINE_PATH}"
        )
    waiver_values = baseline["waivers"]
    if not isinstance(waiver_values, list) or any(
        not isinstance(pattern, str) or not pattern.strip()
        for pattern in waiver_values
    ):
        raise CoverageArtifactError(
            "coverage baseline requires 'waivers' to contain only non-empty "
            f"strings: {BASELINE_PATH}"
        )
    try:
        waivers = [re.compile(pattern) for pattern in waiver_values]
    except re.error as error:
        raise CoverageArtifactError(
            f"coverage baseline contains an invalid waiver regex at "
            f"{BASELINE_PATH}: {error}"
        ) from error
    return minimum, waivers


def _load_inventory_controls() -> list[tuple[str, str]]:
    inventory = _load_json_object(INVENTORY_PATH, "control inventory")
    controls = inventory.get("controls")
    if not isinstance(controls, list):
        raise CoverageArtifactError(
            f"control inventory requires list field 'controls': {INVENTORY_PATH}"
        )
    normalized: list[tuple[str, str]] = []
    for index, value in enumerate(controls):
        label = f"control inventory row {index}"
        if not isinstance(value, dict) or not all(
            isinstance(field_name, str) for field_name in value
        ):
            raise CoverageArtifactError(
                f"{label} must be a JSON object: {INVENTORY_PATH}"
            )
        row: dict[str, object] = value
        key = _require_non_empty_string(row, "key", label, INVENTORY_PATH)
        context = _require_non_empty_string(
            row,
            "context",
            label,
            INVENTORY_PATH,
        )
        normalized.append((key, context))
    return normalized


def _load_clicked_keys() -> tuple[set[str], dict[str, int]]:
    clicked: set[str] = set()
    per_test: dict[str, int] = {}
    for raw in sorted(LEDGER_DIR.glob("raw-*.jsonl")):
        try:
            lines = raw.read_text(encoding="utf-8").splitlines()
        except OSError as error:
            raise CoverageArtifactError(
                f"could not read click ledger at {raw}: {error}"
            ) from error
        except UnicodeError as error:
            raise CoverageArtifactError(
                f"click ledger has invalid UTF-8 at {raw}: {error}"
            ) from error
        for line_number, line in enumerate(lines, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                value: object = json.loads(line)
            except json.JSONDecodeError as error:
                raise CoverageArtifactError(
                    f"click ledger row is invalid JSON at {raw}:{line_number}: "
                    f"{error}"
                ) from error
            label = f"click ledger row {line_number}"
            if not isinstance(value, dict) or not all(
                isinstance(field_name, str) for field_name in value
            ):
                raise CoverageArtifactError(
                    f"{label} must be a JSON object: {raw}"
                )
            entry: dict[str, object] = value
            key = _require_non_empty_string(entry, "key", label, raw)
            test_id = _require_non_empty_string(entry, "test", label, raw)
            clicked.add(key)
            per_test[test_id] = per_test.get(test_id, 0) + 1
    return clicked, per_test


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--allow-missing",
        action="store_true",
        help="exit 0 when coverage artifacts are absent (partial runs)",
    )
    parser.add_argument(
        "--expected-run-id",
        help="require canonical artifacts from this Playwright run identity",
    )
    args = parser.parse_args()

    _invalidate_derived_outputs()

    required_inputs = (
        BASELINE_PATH,
        COVERAGE_RUN_PATH,
        INVENTORY_PATH,
        LEDGER_DIR,
        PLAYWRIGHT_LAST_RUN_PATH,
    )
    missing_inputs = [path for path in required_inputs if not path.exists()]
    if missing_inputs:
        message = (
            "[coverage-gate] missing current-run artifacts "
            f"({', '.join(str(path) for path in missing_inputs)}) — run the "
            "full Playwright suite first."
        )
        if args.allow_missing:
            print(f"{message} Skipping (--allow-missing).")
            return 0
        print(message)
        return 1

    try:
        expected_run_id = _require_expected_run_id(args.expected_run_id)
        run_id = _load_current_run_id(expected_run_id)
        min_pct, waivers = _load_baseline()
        controls = _load_inventory_controls()
        clicked, per_test = _load_clicked_keys()
    except CoverageArtifactError as error:
        print(f"[coverage-gate] FAIL: {error}")
        return 1

    inventory_keys = {key for key, _context in controls}

    def waived(key: str) -> bool:
        return any(pattern.search(key) for pattern in waivers)

    covered = {key for key in inventory_keys if key in clicked or waived(key)}
    untested = sorted(inventory_keys - covered)
    pct = 100.0 * len(covered) / len(inventory_keys) if inventory_keys else 0.0

    try:
        _load_current_run_id(expected_run_id)
    except CoverageArtifactError as error:
        print(f"[coverage-gate] FAIL: coverage inputs changed while reading: {error}")
        return 1

    merged_output = json.dumps(
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
    )

    by_context: dict[str, list[str]] = {}
    key_context = dict(controls)
    for key in untested:
        by_context.setdefault(key_context.get(key, "unknown"), []).append(key)
    untested_output = json.dumps(
        {
            "count": len(untested),
            "by_context": by_context,
        },
        indent=2,
        ensure_ascii=False,
    )
    try:
        MERGED_PATH.write_text(merged_output, encoding="utf-8")
        UNTESTED_PATH.write_text(untested_output, encoding="utf-8")
    except (OSError, UnicodeError) as error:
        _invalidate_derived_outputs()
        print(
            "[coverage-gate] FAIL: could not write coverage outputs "
            f"(merged={MERGED_PATH}, untested={UNTESTED_PATH}): {error}"
        )
        return 1

    try:
        _load_current_run_id(expected_run_id)
    except CoverageArtifactError as error:
        _invalidate_derived_outputs()
        print(f"[coverage-gate] FAIL: coverage inputs changed while writing: {error}")
        return 1

    print(f"[coverage-gate] validated Playwright run identity: {run_id}")

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
