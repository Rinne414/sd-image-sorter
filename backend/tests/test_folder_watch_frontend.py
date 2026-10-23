"""Folder watching is offered where a folder was just imported.

Loads the real ``frontend/js/folder-watch.js`` in a Node vm realm with a stub
``App.API`` and checks ``FolderWatch.watchFolder``: it finds the library root
for the imported folder (exact path, or the root that contains it, either
slash, any case), turns watching on through
``PATCH /api/library-roots/{id}/watch`` and says so; an already watched root
is not patched again; a folder outside every root is refused with a reason.
The import-done banner (scan-progress-lifecycle.js) offers the action.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

FRONTEND = Path(__file__).resolve().parents[2] / "frontend"

SCRIPT = r"""
const vm = require('vm');
const fs = require('fs');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const calls = [];
const toasts = [];
const App = {
  API: {
    get: async (path) => (path === '/api/library-roots' ? { roots: input.roots } : { generation: 0, roots: [] }),
    patch: async (path, body) => { calls.push([path, body]); return {}; },
  },
  showToast: (text, type) => toasts.push([type, text]),
};
const ctx = {
  window: { App },
  document: { readyState: 'complete', hidden: false, addEventListener() {} },
  appT: (key, fallback, params) => `${key}|${params.folder}`,
  setTimeout: () => 0, clearTimeout() {}, CustomEvent: class {}, console,
};
ctx.window.dispatchEvent = () => {};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(input.file, 'utf8'), ctx);
ctx.window.FolderWatch.watchFolder(input.folder).then((ok) => {
  process.stdout.write(JSON.stringify({ ok, calls, toasts }));
});
"""

pytestmark = pytest.mark.skipif(
    shutil.which("node") is None, reason="node is not installed"
)

ROOTS = [
    {"id": 1, "path": "D:/AI/ComfyUI/output", "watch": 0},
    {"id": 2, "path": "D:/AI/ComfyUI", "watch": 0},
    {"id": 3, "path": "E:/watched", "watch": 1},
]


def watch(folder: str, roots: list | None = None) -> dict:
    run = subprocess.run(
        ["node", "-e", SCRIPT],
        input=json.dumps(
            {
                "file": str(FRONTEND / "js" / "folder-watch.js"),
                "folder": folder,
                "roots": roots or ROOTS,
            }
        ),
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=True,
    )
    return json.loads(run.stdout)


def test_watching_the_imported_folder_patches_its_own_root():
    result = watch("d:\\AI\\ComfyUI\\output\\")
    assert result["ok"] is True
    assert result["calls"] == [["/api/library-roots/1/watch", {"watch": True}]]
    assert result["toasts"] == [["success", "flow.watchFolderOn|output"]]


def test_a_subfolder_import_watches_the_deepest_root_that_holds_it():
    result = watch("D:/AI/ComfyUI/output/2026-10-23")
    assert result["calls"] == [["/api/library-roots/1/watch", {"watch": True}]]


def test_an_already_watched_root_is_not_patched_again():
    result = watch("E:\\watched")
    assert result["ok"] is True
    assert result["calls"] == []
    assert result["toasts"] == [["info", "flow.watchFolderAlready|watched"]]


def test_a_folder_outside_every_root_is_refused_with_a_reason():
    result = watch("F:/elsewhere")
    assert result["ok"] is False
    assert result["calls"] == []
    assert result["toasts"] == [["warning", "flow.watchFolderNotFound|elsewhere"]]


def test_import_done_banner_offers_watching_and_shows_every_action():
    lifecycle = (FRONTEND / "js" / "app" / "scan-progress-lifecycle.js").read_text(
        encoding="utf-8"
    )
    assert "flow.ctaWatchFolder" in lifecycle
    assert "window.FolderWatch.watchFolder(ctaFolder)" in lifecycle
    banner = (FRONTEND / "js" / "app" / "toasts-modals.js").read_text(encoding="utf-8")
    # No cap: a fourth action (watch) must not be cut off.
    assert "opts.actions.slice(0, 3)" not in banner
