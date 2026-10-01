"""Run pip from launchers while keeping console output beginner-friendly."""

from __future__ import annotations

import os
import re
import subprocess
import sys
import tempfile
from collections.abc import Sequence
from importlib import metadata
from pathlib import Path
from typing import TextIO


PIP_MARKER_IGNORE_RE = re.compile(
    r"^Ignoring .+: markers .+ don't match your environment$"
)
PIP_MARKER_IGNORE_PREFIX = "Ignoring "


# A GPU/DirectML onnxruntime is installed by repair_onnxruntime.py *instead of*
# the CPU wheel. Re-installing the pinned CPU wheel from the requirements file
# would make the next repair remove it again and re-download the GPU wheel.
NON_CPU_ORT_DISTRIBUTIONS = ("onnxruntime-gpu", "onnxruntime-directml")
CPU_ORT_LINE_RE = re.compile(r"^\s*onnxruntime\s*(?:[=<>!~;]|$)", re.IGNORECASE)
GPU_ORT_SKIP_MESSAGE = (
    "[INFO] 已装 GPU 版 onnxruntime，跳过 CPU 版 / "
    "GPU onnxruntime present, CPU onnxruntime skipped"
)


def non_cpu_onnxruntime_installed() -> bool:
    for name in NON_CPU_ORT_DISTRIBUTIONS:
        try:
            metadata.distribution(name)
        except metadata.PackageNotFoundError:
            continue
        return True
    return False


def _requirement_applies_here(line: str) -> bool:
    """True when the requirement line's environment marker matches this machine."""
    try:
        try:
            from packaging.requirements import Requirement
        except ImportError:
            from pip._vendor.packaging.requirements import Requirement
        requirement = Requirement(line.split(" #", 1)[0].strip())
    except Exception:
        return False
    return requirement.marker is None or requirement.marker.evaluate()


def filter_cpu_onnxruntime(requirements_text: str) -> tuple[str, int]:
    """Drop the plain ``onnxruntime`` pin that applies to this platform."""
    kept: list[str] = []
    removed = 0
    for line in requirements_text.splitlines(keepends=True):
        if CPU_ORT_LINE_RE.match(line) and _requirement_applies_here(line):
            removed += 1
            continue
        kept.append(line)
    return "".join(kept), removed


def _requirements_arg_index(pip_args: Sequence[str]) -> int | None:
    if not pip_args or pip_args[0] != "install":
        return None
    for index, arg in enumerate(pip_args[:-1]):
        if arg in ("-r", "--requirement"):
            return index + 1
    return None


def prepare_pip_args(pip_args: list[str]) -> tuple[list[str], Path | None]:
    """Swap the requirements file for a filtered copy when a GPU onnxruntime is installed.

    Returns the pip arguments and the temporary file to delete afterwards.
    """
    index = _requirements_arg_index(pip_args)
    if index is None or not non_cpu_onnxruntime_installed():
        return pip_args, None
    source = Path(pip_args[index])
    try:
        filtered, removed = filter_cpu_onnxruntime(source.read_text(encoding="utf-8"))
    except OSError:
        return pip_args, None
    if not removed:
        return pip_args, None
    # Same directory first, so relative includes inside the file keep working.
    for directory in (source.resolve().parent, Path(tempfile.gettempdir())):
        try:
            handle, name = tempfile.mkstemp(
                prefix=".launcher-filtered-", suffix=".txt", dir=directory
            )
        except OSError:
            continue
        with os.fdopen(handle, "w", encoding="utf-8", newline="") as stream:
            stream.write(filtered)
        try:
            print(GPU_ORT_SKIP_MESSAGE, flush=True)
        except UnicodeEncodeError:  # redirected output in a legacy code page
            print(
                GPU_ORT_SKIP_MESSAGE.encode("ascii", "replace").decode("ascii"),
                flush=True,
            )
        return [*pip_args[:index], name, *pip_args[index + 1 :]], Path(name)
    return pip_args, None


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

    pip_args, temp_requirements = prepare_pip_args(pip_args)
    try:
        return _run_pip(pip_args)
    finally:
        if temp_requirements is not None:
            temp_requirements.unlink(missing_ok=True)


def _run_pip(pip_args: Sequence[str]) -> int:
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
