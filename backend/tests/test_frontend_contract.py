"""
Frontend contract tests that guard shared state boundaries.
"""

from __future__ import annotations

import os
import re
from pathlib import Path


FORBIDDEN_APPSTATE_ASSIGN_RE = re.compile(
    r"(?:window\.)?(?:App\.)?AppState\.[A-Za-z_][A-Za-z0-9_]*\s*=",
    re.MULTILINE,
)
FORBIDDEN_WINDOW_APP_ASSIGN_RE = re.compile(
    r"window\.App\.[A-Za-z_$][A-Za-z0-9_$]*\s*=(?!=)",
    re.MULTILINE,
)

ALLOWED_DIRECT_WRITER_FILES = {"app.js", "gallery.js"}
SKIPPED_DIRS = {"__pycache__", "node_modules"}


def _iter_frontend_js_files(frontend_root: Path):
    for root, dirs, files in os.walk(frontend_root):
        dirs[:] = [name for name in dirs if name not in SKIPPED_DIRS]
        root_path = Path(root)
        for filename in files:
            if filename.endswith(".js"):
                yield root_path / filename


def test_frontend_feature_modules_do_not_directly_assign_appstate():
    repo_root = Path(__file__).resolve().parents[2]
    frontend_root = repo_root / "frontend" / "js"
    violations: list[str] = []

    for file_path in sorted(_iter_frontend_js_files(frontend_root)):
        if file_path.name in ALLOWED_DIRECT_WRITER_FILES:
            continue
        source = file_path.read_text(encoding="utf-8")
        for match in FORBIDDEN_APPSTATE_ASSIGN_RE.finditer(source):
            line_number = source.count("\n", 0, match.start()) + 1
            relative_path = file_path.relative_to(repo_root).as_posix()
            violations.append(f"{relative_path}:{line_number}: {match.group(0)}")

    assert not violations, (
        "Feature modules must not directly assign `AppState.*`.\n"
        "Use narrow app APIs (for example `markGalleryNeedsRefresh`) instead.\n"
        + "\n".join(violations)
    )

def test_frontend_feature_modules_do_not_mutate_window_app_namespace():
    repo_root = Path(__file__).resolve().parents[2]
    frontend_root = repo_root / "frontend" / "js"
    violations: list[str] = []

    for file_path in sorted(_iter_frontend_js_files(frontend_root)):
        if file_path.name == "app.js":
            continue
        source = file_path.read_text(encoding="utf-8")
        for match in FORBIDDEN_WINDOW_APP_ASSIGN_RE.finditer(source):
            line_number = source.count("\n", 0, match.start()) + 1
            relative_path = file_path.relative_to(repo_root).as_posix()
            violations.append(f"{relative_path}:{line_number}: {match.group(0)}")

    assert not violations, (
        "Feature modules must not mutate `window.App.*`; use named module bridges or narrow app APIs.\n"
        + "\n".join(violations)
    )


def test_window_app_context_is_sealed_after_creation():
    repo_root = Path(__file__).resolve().parents[2]
    source = (repo_root / "frontend" / "js" / "app.js").read_text(encoding="utf-8")

    assert "window.App = buildAppContext();" in source
    assert "Object.seal(window.App);" in source
