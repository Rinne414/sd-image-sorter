"""Run pip from launchers while keeping console output beginner-friendly."""

from __future__ import annotations

import re
import subprocess
import sys
from collections.abc import Sequence
from typing import TextIO


PIP_MARKER_IGNORE_RE = re.compile(
    r"^Ignoring .+: markers .+ don't match your environment$"
)
PIP_MARKER_IGNORE_PREFIX = "Ignoring "


def should_show_pip_line(line: str) -> bool:
    return PIP_MARKER_IGNORE_RE.match(line.rstrip("\r\n")) is None


def stream_filtered_pip_output(output: TextIO) -> None:
    held_line: str | None = ""
    while True:
        char = output.read(1)
        if char == "":
            break

        if held_line is None:
            print(char, end="", flush=True)
            if char == "\n":
                held_line = ""
            continue

        held_line += char
        if char == "\n":
            if should_show_pip_line(held_line):
                print(held_line, end="", flush=True)
            held_line = ""
            continue

        if PIP_MARKER_IGNORE_PREFIX.startswith(held_line):
            continue
        if held_line.startswith(PIP_MARKER_IGNORE_PREFIX):
            continue

        print(held_line, end="", flush=True)
        held_line = None

    if held_line:
        if should_show_pip_line(held_line):
            print(held_line, end="", flush=True)


def main(argv: Sequence[str] | None = None) -> int:
    pip_args = list(sys.argv[1:] if argv is None else argv)
    if not pip_args:
        print("Usage: python launcher_pip.py <pip arguments...>", file=sys.stderr)
        return 2

    command = [sys.executable, "-m", "pip", "--disable-pip-version-check", *pip_args]
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    if process.stdout is None:
        return process.wait()

    try:
        stream_filtered_pip_output(process.stdout)
    except KeyboardInterrupt:
        process.terminate()
        raise

    return process.wait()


if __name__ == "__main__":
    raise SystemExit(main())
