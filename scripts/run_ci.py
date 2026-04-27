#!/usr/bin/env python3
"""Minimal CI entrypoint for sd-image-sorter release work."""

from __future__ import annotations

import subprocess
import sys
import os
import json
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
    *(
        [
            Path("/mnt/c/Program Files/nodejs/node.exe"),
            Path("C:/Program Files/nodejs/node.exe"),
            "node",
            Path("/usr/bin/node"),
            Path("/usr/local/bin/node"),
        ]
        if str(BACKEND_PYTHON).lower().endswith(".exe")
        else [
            "node",
            Path("/usr/bin/node"),
            Path("/usr/local/bin/node"),
            Path("/mnt/c/Program Files/nodejs/node.exe"),
            Path("C:/Program Files/nodejs/node.exe"),
        ]
    )
)


def _find_available_port(*preferred_ports: int) -> str:
    def runtime_can_bind(port: int) -> bool:
        backend_python = str(BACKEND_PYTHON)
        if not backend_python.lower().endswith(".exe"):
            return True

        check_script = (
            "import socket, sys; "
            "sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM); "
            "sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); "
            "sock.bind(('127.0.0.1', int(sys.argv[1]))); "
            "sock.close()"
        )
        try:
            result = subprocess.run(
                [backend_python, "-c", check_script, str(port)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except OSError:
            return False
        return result.returncode == 0

    for port in preferred_ports:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind(("127.0.0.1", port))
            except OSError:
                continue
            if not runtime_can_bind(port):
                continue
            return str(port)

    for _ in range(20):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(("127.0.0.1", 0))
            port = int(sock.getsockname()[1])
            if runtime_can_bind(port):
                return str(port)

    raise RuntimeError("Could not find a free localhost port for Playwright webServer")


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
            env_values = {
                "PW_REUSE_SERVER": "1",
                "PW_WEB_SERVER_PORT": _find_available_port(19087, 19187, 19287),
            }
            env.update(env_values)
            if str(command[0]).lower().endswith(".exe") and os.name != "nt":
                cli_args = command[2:]
                env_assignments = "; ".join(
                    f"process.env[{json.dumps(key)}]={json.dumps(value)}"
                    for key, value in env_values.items()
                )
                argv = ", ".join(json.dumps(arg) for arg in cli_args)
                command = [
                    command[0],
                    "-e",
                    (
                        f"{env_assignments}; "
                        "const cli = require.resolve('./node_modules/playwright/cli.js'); "
                        f"process.argv = [process.execPath, cli, {argv}]; "
                        "require(cli);"
                    ),
                ]
        result = subprocess.run(command, cwd=cwd, env=env)
        if result.returncode != 0:
            print(f"[CI] FAILED: {name}")
            all_ok = False
        else:
            print(f"[CI] PASSED: {name}")

    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
