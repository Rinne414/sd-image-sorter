#!/usr/bin/env python3
"""Minimal CI entrypoint for sd-image-sorter release work."""

from __future__ import annotations

import subprocess
import sys
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

if sys.platform == "win32":
    BACKEND_PYTHON = ROOT / "backend" / "venv" / "Scripts" / "python.exe"
    E2E_PLAYWRIGHT = ROOT / "tests" / "e2e" / "node_modules" / ".bin" / "playwright.cmd"
else:
    BACKEND_PYTHON = ROOT / "backend" / "venv" / "bin" / "python"
    E2E_PLAYWRIGHT = ROOT / "tests" / "e2e" / "node_modules" / ".bin" / "playwright"


def main() -> int:
    checks: list[tuple[str, list[str], Path]] = [
        (
            "backend regression",
            [
                str(BACKEND_PYTHON),
                "-m",
                "pytest",
                "backend/tests/test_model_health.py",
                "backend/tests/test_tagger.py",
                "backend/tests/test_tagging_service.py",
                "backend/tests/test_routers/test_tags.py",
                "backend/tests/test_routers/test_prompts_censor_similarity_artists.py",
                "-q",
            ],
            ROOT,
        ),
        (
            "playwright e2e",
            [
                str(E2E_PLAYWRIGHT),
                "test",
            ],
            ROOT / "tests" / "e2e",
        ),
    ]

    all_ok = True
    for name, command, cwd in checks:
        print(f"[CI] Working directory: {cwd}")
        env = os.environ.copy()
        if name == "playwright e2e":
            env.setdefault("PW_REUSE_SERVER", "1")
        result = subprocess.run(command, cwd=cwd, env=env)
        if result.returncode != 0:
            print(f"[CI] FAILED: {name}")
            all_ok = False
        else:
            print(f"[CI] PASSED: {name}")

    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
