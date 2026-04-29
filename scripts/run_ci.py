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


def _first_existing(*candidates: Path) -> Path | None:
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return None


_BACKEND_PYTHON = _first_existing(
    ROOT / "backend" / "venv" / "Scripts" / "python.exe",
    ROOT / "backend" / "venv" / "bin" / "python",
)
BACKEND_PYTHON = _BACKEND_PYTHON or Path(sys.executable)
E2E_PLAYWRIGHT = _first_existing(
    ROOT / "tests" / "e2e" / "node_modules" / ".bin" / "playwright.cmd",
    ROOT / "tests" / "e2e" / "node_modules" / ".bin" / "playwright",
)
PLAYWRIGHT_CLI = ROOT / "tests" / "e2e" / "node_modules" / "playwright" / "cli.js"
PLAYWRIGHT_WRAPPER = ROOT / "tests" / "e2e" / "scripts" / "run-playwright.mjs"
FRONTEND_JS_FILES = sorted((ROOT / "frontend" / "js").glob("**/*.js"))


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
HOST_NODE_EXECUTABLE = _first_executable(
    *(
        [
            Path("C:/Program Files/nodejs/node.exe"),
            "node",
        ]
        if os.name == "nt"
        else [
            "node",
            Path("/usr/bin/node"),
            Path("/usr/local/bin/node"),
            Path("/mnt/c/Program Files/nodejs/node.exe"),
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


def _apply_stable_temp_env(env: dict[str, str]) -> None:
    """Keep Linux/WSL pytest capture away from inherited Windows temp paths."""
    if os.name == "nt":
        return

    stable_tmp = "/tmp"
    env["TMPDIR"] = stable_tmp
    env["TEMP"] = stable_tmp
    env["TMP"] = stable_tmp


def main() -> int:
    checks: list[tuple[str, list[str], Path]] = [
        (
            "compiled lock freshness",
            [
                str(BACKEND_PYTHON),
                "scripts/check_lockfiles.py",
            ],
            ROOT,
        ),
        (
            "dependency security audit",
            [
                str(BACKEND_PYTHON),
                "scripts/security_check.py",
            ],
            ROOT,
        ),
        (
            "frontend js syntax",
            [
                sys.executable,
                "-c",
                (
                    "import subprocess, sys; "
                    "node = sys.argv[1]; files = sys.argv[2:]; "
                    "failed = [path for path in files if subprocess.run([node, '--check', path]).returncode != 0]; "
                    "print(f'Checked {len(files)} frontend JS files'); "
                    "sys.exit(1 if failed else 0)"
                ),
                str(HOST_NODE_EXECUTABLE),
                *[str(path) for path in FRONTEND_JS_FILES],
            ],
            ROOT,
        ),
        (
            "backend full suite",
            [
                str(BACKEND_PYTHON),
                "-m",
                "pytest",
                "-p",
                "pytest_cov",
                "backend/tests",
                "-q",
                "--cov=backend",
                "--cov-report=term-missing",
                "--cov-report=xml:backend/coverage.xml",
            ],
            ROOT,
        ),
        (
            "playwright e2e",
            [
                str(NODE_EXECUTABLE),
                (
                    "./scripts/run-playwright.mjs"
                    if PLAYWRIGHT_WRAPPER.exists()
                    else ("./node_modules/playwright/cli.js" if PLAYWRIGHT_CLI.exists() else str(E2E_PLAYWRIGHT))
                ),
                "test",
            ],
            ROOT / "tests" / "e2e",
        ),
    ]

    all_ok = True
    for name, command, cwd in checks:
        print(f"[CI] Working directory: {cwd}")
        env = os.environ.copy()
        _apply_stable_temp_env(env)
        if name == "playwright e2e":
            env_values = {
                "PW_REUSE_SERVER": "1",
                "PW_WEB_SERVER_PORT": _find_available_port(19087, 19187, 19287),
            }
            env.update(env_values)
            if str(command[0]).lower().endswith(".exe") and os.name != "nt":
                script_path = command[1]
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
                        "const path = require('path'); "
                        "const { pathToFileURL } = require('url'); "
                        f"const script = {json.dumps(script_path)}; "
                        f"process.argv = [process.execPath, script, {argv}]; "
                        "(async () => { "
                        "await import(pathToFileURL(path.resolve(script)).href); "
                        "})().catch((error) => { console.error(error); process.exit(1); });"
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
