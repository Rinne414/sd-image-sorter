"""
Contract tests that keep indexed-path identity behind shared helpers.
"""

from __future__ import annotations

import re
from pathlib import Path


DIRECT_PATH_IDENTITY_SQL_RE = re.compile(
    r"(?:WHERE|AND|OR)\s+(?:[A-Za-z_][A-Za-z0-9_]*\.)?path\s*=\s*\?",
    re.IGNORECASE | re.MULTILINE,
)


def test_backend_non_test_python_files_do_not_reintroduce_direct_path_identity_sql():
    backend_root = Path(__file__).resolve().parents[1]
    violations: list[str] = []

    for file_path in sorted(backend_root.rglob("*.py")):
        relative_path = file_path.relative_to(backend_root).as_posix()
        if relative_path.startswith(("tests/", "venv/")):
            continue

        source = file_path.read_text(encoding="utf-8")
        for match in DIRECT_PATH_IDENTITY_SQL_RE.finditer(source):
            line_number = source.count("\n", 0, match.start()) + 1
            snippet = match.group(0).replace("\n", " ")
            violations.append(f"{relative_path}:{line_number}: {snippet}")

    assert not violations, (
        "Direct indexed-path equality SQL reappeared outside the shared path helpers.\n"
        "Use database/path helper APIs instead of literal `WHERE path = ?` clauses.\n"
        + "\n".join(violations)
    )
