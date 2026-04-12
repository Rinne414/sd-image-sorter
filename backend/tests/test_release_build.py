from __future__ import annotations

import importlib.util
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
BUILD_SCRIPT = ROOT / "scripts" / "build_release_packages.py"


def load_release_builder():
    spec = importlib.util.spec_from_file_location("build_release_packages", BUILD_SCRIPT)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_write_portable_launcher_uses_clean_crlf_endings(tmp_path):
    release_builder = load_release_builder()

    launcher_path = release_builder.write_portable_launcher(tmp_path)
    launcher_bytes = launcher_path.read_bytes()

    assert b"\r\r\n" not in launcher_bytes
    assert b"setlocal enabledelayedexpansion\r\n" in launcher_bytes
    assert b"import fastapi, PIL" in launcher_bytes
    assert b"Installing dependencies - first run may take a few minutes" in launcher_bytes
    assert launcher_bytes.endswith(b"pause\r\n")


def test_release_skip_rules_drop_hidden_and_docs_files():
    release_builder = load_release_builder()

    assert release_builder.should_skip_path(Path(".gitignore")) is True
    assert release_builder.should_skip_path(Path(".tmp_probe_browse.py")) is True
    assert release_builder.should_skip_path(Path(".tmp_move_target") / "note.txt") is True
    assert release_builder.should_skip_path(Path("docs") / "screenshots" / "gallery.png") is True
    assert release_builder.should_skip_path(Path(".env.example")) is False
    assert release_builder.should_skip_path(Path("README.md")) is False
