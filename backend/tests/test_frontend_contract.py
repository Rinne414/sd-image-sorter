"""
Frontend contract tests that guard shared state boundaries.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
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


def test_load_images_options_are_passed_as_second_argument():
    repo_root = Path(__file__).resolve().parents[2]
    source = (repo_root / "frontend" / "js" / "app.js").read_text(encoding="utf-8")

    assert "loadImages({" not in source
    assert "loadImages(false, {" in source


def test_cancelled_gallery_load_marks_refresh_intent():
    repo_root = Path(__file__).resolve().parents[2]
    source = (repo_root / "frontend" / "js" / "app.js").read_text(encoding="utf-8")

    assert "function cancelGalleryImageLoad()" in source
    assert "hadPendingGalleryLoad" in source
    assert "AppState.galleryNeedsRefresh = true;" in source


def test_selection_store_clears_filtered_token_for_non_filtered_scopes():
    if shutil.which("node") is None:
        return

    repo_root = Path(__file__).resolve().parents[2]
    script = f"""
const fs = require('fs');
global.window = {{}};
const source = fs.readFileSync({str(repo_root / 'frontend' / 'js' / 'stores' / 'selection-store.js')!r}, 'utf8');
eval(source);
const visibleState = window.SelectionStore.cloneState({{
  selectionMode: true,
  selectedIds: [1, 2],
  scope: 'visible',
  filterKey: 'stale-filter',
  selectionToken: 'stale-token',
}});
if (visibleState.filterKey !== null || visibleState.selectionToken !== null) {{
  throw new Error('visible selection retained filtered token state');
}}
const loadedState = window.SelectionStore.cloneState({{
  selectionMode: true,
  selectedIds: [1, 2],
  scope: 'loaded',
  filterKey: 'stale-filter',
  selectionToken: 'stale-token',
}});
if (loadedState.filterKey !== null || loadedState.selectionToken !== null) {{
  throw new Error('loaded selection retained filtered token state');
}}
const filteredState = window.SelectionStore.cloneState({{
  selectionMode: true,
  selectedIds: [1, 2],
  scope: 'filtered',
  filterKey: 'active-filter',
  selectionToken: 'active-token',
}});
if (filteredState.filterKey !== 'active-filter' || filteredState.selectionToken !== 'active-token') {{
  throw new Error('filtered selection lost active token state');
}}
"""
    subprocess.run(["node", "-e", script], check=True)


def test_manual_sort_resume_failure_does_not_render_null_visible_banner():
    repo_root = Path(__file__).resolve().parents[2]
    source = (repo_root / "frontend" / "js" / "manual-sort.js").read_text(encoding="utf-8")

    assert "renderManualSortResumeBanner(null, { visible: true })" not in source
    assert "previousResumeSnapshot" in source

def test_gallery_load_finally_clears_only_active_sequence():
    repo_root = Path(__file__).resolve().parents[2]
    source = (repo_root / "frontend" / "js" / "app.js").read_text(encoding="utf-8")

    assert "let _activeImageLoadSequence = 0;" in source
    assert "const isActiveLoad = _activeImageLoadSequence === loadSequence;" in source
    assert "RequestManager.complete(IMAGE_LOAD_KEY, controller);" in source


def test_autosep_critical_action_settings_are_visible_on_main_panel():
    repo_root = Path(__file__).resolve().parents[2]
    html = (repo_root / "frontend" / "index.html").read_text(encoding="utf-8")
    source = (repo_root / "frontend" / "js" / "autosep.js").read_text(encoding="utf-8")

    assert "autosep-action-settings" in html
    assert 'name="autosep-operation-mode-main"' in html
    assert 'data-autosep-setting="confirmBeforeMove"' in html
    assert 'data-autosep-setting="rememberDestination"' in html
    assert "setAutoSepOperationMode(input.value, { persist: true })" in source


def test_metadata_resolving_chip_is_driven_by_stats_contract():
    repo_root = Path(__file__).resolve().parents[2]
    html = (repo_root / "frontend" / "index.html").read_text(encoding="utf-8")
    source = (repo_root / "frontend" / "js" / "app.js").read_text(encoding="utf-8")

    assert "metadata-status-chip" in html
    assert "stats.metadata_pending" in source
    assert "stats.scan_status" in source
    assert "stats.scan_library_ready" in source
    assert "const countsResolving = metadataPending > 0 || (scanRunning && !scanLibraryReady);" in source
    assert "gallery.metadataResolving" in source
    assert "gallery.scanResolving" in source
    assert "countEl.textContent = countsResolving && count === 0 ? '…' : String(count);" in source


def test_gallery_delete_key_removes_from_gallery_not_disk():
    repo_root = Path(__file__).resolve().parents[2]
    source = (repo_root / "frontend" / "js" / "app.js").read_text(encoding="utf-8")

    match = re.search(r"else if \(e\.key === 'Delete'\) \{(?P<body>.*?)\n        \}", source, re.DOTALL)
    assert match is not None
    body = match.group("body")
    assert "removeSelectedGalleryImages();" in body
    assert "deleteSelectedGalleryImages();" not in body


def test_manual_sort_start_routes_unfinished_sessions_to_resume():
    repo_root = Path(__file__).resolve().parents[2]
    source = (repo_root / "frontend" / "js" / "manual-sort.js").read_text(encoding="utf-8")

    assert "confirmResumeSavedSessionFromStart(savedSession)" in source
    assert "resumeSavedSession(savedSession)" in source
    assert "discard the saved session first" in source
    assert "replaceExisting = false" in source
