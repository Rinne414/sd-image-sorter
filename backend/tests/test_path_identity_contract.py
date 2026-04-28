"""
Contract tests that keep indexed-path identity behind shared helpers.
"""

from __future__ import annotations

import os
import re
from pathlib import Path


DIRECT_PATH_IDENTITY_SQL_RE = re.compile(
    r"(?:WHERE|AND|OR)\s+(?:[A-Za-z_][A-Za-z0-9_]*\.)?path\s*=\s*\?",
    re.IGNORECASE | re.MULTILINE,
)

DIRECT_PATH_MUTATION_SQL_RE = re.compile(
    r"(?:UPDATE\s+[A-Za-z_][A-Za-z0-9_]*|DELETE\s+FROM\s+[A-Za-z_][A-Za-z0-9_]*)"
    r"[\s\S]{0,600}?\bWHERE\s+(?:[A-Za-z_][A-Za-z0-9_]*\.)?path\s*(?:=|IN)\s*(?:\?|\()",
    re.IGNORECASE | re.MULTILINE,
)

SKIPPED_SOURCE_DIRS = {"tests", "venv", "__pycache__"}


def iter_backend_python_files(backend_root: Path):
    for root, dirs, files in os.walk(backend_root):
        dirs[:] = [name for name in dirs if name not in SKIPPED_SOURCE_DIRS]
        root_path = Path(root)
        for filename in files:
            if filename.endswith(".py"):
                yield root_path / filename


def test_backend_non_test_python_files_do_not_reintroduce_direct_path_identity_sql():
    backend_root = Path(__file__).resolve().parents[1]
    violations: list[str] = []

    for file_path in sorted(iter_backend_python_files(backend_root)):
        relative_path = file_path.relative_to(backend_root).as_posix()

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


def test_backend_non_test_python_files_do_not_mutate_rows_by_direct_path_sql():
    backend_root = Path(__file__).resolve().parents[1]
    violations: list[str] = []

    for file_path in sorted(iter_backend_python_files(backend_root)):
        relative_path = file_path.relative_to(backend_root).as_posix()

        source = file_path.read_text(encoding="utf-8")
        for match in DIRECT_PATH_MUTATION_SQL_RE.finditer(source):
            line_number = source.count("\n", 0, match.start()) + 1
            snippet = " ".join(match.group(0).split())
            violations.append(f"{relative_path}:{line_number}: {snippet}")

    assert not violations, (
        "Direct indexed-path mutation SQL reappeared outside shared path helpers.\n"
        "Mutating rows by raw `path = ?` / `path IN (...)` bypasses Windows/WSL/POSIX "
        "indexed-path matching. Use database/path helper APIs instead.\n"
        + "\n".join(violations)
    )


def test_derived_writers_keep_path_resolution_on_shared_helper():
    backend_root = Path(__file__).resolve().parents[1]
    required_files = (
        "similarity.py",
        "services/aesthetic_service.py",
        "services/artist_service.py",
    )
    missing: list[str] = []

    for relative_path in required_files:
        source = (backend_root / relative_path).read_text(encoding="utf-8")
        if "resolve_existing_indexed_image_path(" not in source:
            missing.append(relative_path)

    assert not missing, (
        "Derived pipelines must resolve indexed paths via shared helper before disk access.\n"
        + "\n".join(missing)
    )
