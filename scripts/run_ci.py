#!/usr/bin/env python3
"""Minimal CI entrypoint for sd-image-sorter release work."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def run_step(name: str, command: list[str]) -> bool:
    print(f"[CI] Running {name}: {' '.join(command)}")
    result = subprocess.run(command, cwd=ROOT)
    if result.returncode != 0:
        print(f"[CI] FAILED: {name}")
        return False
    print(f"[CI] PASSED: {name}")
    return True


def main() -> int:
    checks: list[tuple[str, list[str]]] = []

    all_ok = True
    for name, command in checks:
        if not run_step(name, command):
            all_ok = False

    if all_ok:
        print("[CI] No checks registered yet. Add checks as the release team expands coverage.")
        return 0

    return 1


if __name__ == "__main__":
    sys.exit(main())
