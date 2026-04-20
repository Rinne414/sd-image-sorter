#!/usr/bin/env python3
"""Minimal CI entrypoint for sd-image-sorter release work."""

from __future__ import annotations

import subprocess
import sys
import os
import shutil
import socket
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _first_existing(*candidates: Path) -> Path:
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return candidates[0]


BACKEND_PYTHON = _first_existing(
    ROOT / "backend" / "venv" / "Scripts" / "python.exe",
    ROOT / "backend" / "venv" / "bin" / "python",
)
E2E_PLAYWRIGHT = _first_existing(
    ROOT / "tests" / "e2e" / "node_modules" / ".bin" / "playwright.cmd",
    ROOT / "tests" / "e2e" / "node_modules" / ".bin" / "playwright",
)
PLAYWRIGHT_CLI = ROOT / "tests" / "e2e" / "node_modules" / "playwright" / "cli.js"


def _first_executable(*candidates: str | Path) -> str:
    for candidate in candidates:
        if isinstance(candidate, Path):
            if candidate.exists():
                return str(candidate)
        else:
            found = shutil.which(candidate)
            if found:
                return found
    return str(candidates[0])


NODE_EXECUTABLE = _first_executable(
    "node",
    Path("/mnt/c/Program Files/nodejs/node.exe"),
    Path("C:/Program Files/nodejs/node.exe"),
    Path("/usr/bin/node"),
    Path("/usr/local/bin/node"),
)


def _find_available_port(*preferred_ports: int) -> str:
    for port in preferred_ports:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind(("127.0.0.1", port))
            except OSError:
                continue
            return str(port)

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return str(sock.getsockname()[1])


def main() -> int:
    checks: list[tuple[str, list[str], Path]] = [
        (
            "backend full suite",
            [
                str(BACKEND_PYTHON),
                "-m",
                "pytest",
                "backend/tests",
                "-q",
            ],
            ROOT,
        ),
        (
            "playwright e2e",
            [
                str(NODE_EXECUTABLE),
                "./node_modules/playwright/cli.js" if PLAYWRIGHT_CLI.exists() else str(E2E_PLAYWRIGHT),
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
            env["PW_REUSE_SERVER"] = "1"
            env.setdefault("PW_WEB_SERVER_PORT", _find_available_port(19087, 19187, 19287))
        result = subprocess.run(command, cwd=cwd, env=env)
        if result.returncode != 0:
            print(f"[CI] FAILED: {name}")
            all_ok = False
        else:
            print(f"[CI] PASSED: {name}")

    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
