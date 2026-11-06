"""A folder without write permission answers at once; nothing hangs on one."""

from __future__ import annotations

import ast
import getpass
import os
import subprocess
import sys
from pathlib import Path

import pytest

import folder_access

BACKEND = Path(folder_access.__file__).resolve().parent
TEMP_CALLS = {"mkstemp", "mkdtemp", "NamedTemporaryFile", "TemporaryDirectory"}
GUARD_LINES_BEFORE = 4
HOW_TO_FIX = (
    "tempfile hangs on Windows when this folder cannot be written. Call "
    "folder_access.require_writable(folder) just before it."
)


def test_a_normal_folder_is_writable_and_keeps_no_probe(tmp_path):
    assert folder_access.folder_is_writable(tmp_path) is True
    assert list(tmp_path.iterdir()) == []


def test_a_missing_folder_is_not_writable(tmp_path):
    assert folder_access.folder_is_writable(tmp_path / "missing") is False


def test_require_writable_raises_a_permission_error_naming_the_folder(tmp_path):
    missing = tmp_path / "missing"
    with pytest.raises(PermissionError) as caught:
        folder_access.require_writable(missing)
    assert caught.value.filename == str(missing)


@pytest.mark.skipif(sys.platform != "win32", reason="Windows permissions")
def test_a_folder_refused_by_windows_answers_at_once_instead_of_hanging(tmp_path):
    """tempfile.mkstemp retries 2,147,483,647 times here, so this runs in its own process."""
    user = getpass.getuser()
    subprocess.run(
        ["icacls", str(tmp_path), "/deny", f"{user}:(OI)(CI)(WD,AD)"],
        check=True,
        capture_output=True,
    )
    code = f"import folder_access; print(folder_access.folder_is_writable({str(tmp_path)!r}))"
    try:
        answer = subprocess.run(
            [sys.executable, "-c", code],
            env={**os.environ, "PYTHONPATH": str(BACKEND)},
            capture_output=True,
            text=True,
            timeout=30,
        )
    finally:
        subprocess.run(
            ["icacls", str(tmp_path), "/remove:d", user, "/T", "/Q"],
            capture_output=True,
        )
    assert answer.stdout.strip() == "False"


def _program_files():
    for path in BACKEND.rglob("*.py"):
        parts = path.relative_to(BACKEND).parts
        if not {"venv", "tests", "__pycache__"}.intersection(parts):
            yield path


def test_every_temporary_file_in_a_chosen_folder_checks_the_folder_first():
    unguarded = []
    for path in _program_files():
        source = path.read_text(encoding="utf-8")
        lines = source.splitlines()
        for node in ast.walk(ast.parse(source)):
            if not (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr in TEMP_CALLS
                and any(keyword.arg == "dir" for keyword in node.keywords)
            ):
                continue
            before = lines[max(0, node.lineno - 1 - GUARD_LINES_BEFORE) : node.lineno]
            if not any("require_writable(" in line for line in before):
                unguarded.append(f"{path.relative_to(BACKEND)}:{node.lineno}")
    assert not unguarded, f"{HOW_TO_FIX}\n  " + "\n  ".join(unguarded)
