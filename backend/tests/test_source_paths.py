"""
Tests for cross-runtime indexed image path resolution.
"""
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from utils.source_paths import (  # noqa: E402
    build_indexed_image_path_candidates,
    normalize_indexed_image_path,
    resolve_existing_indexed_image_path,
    translate_posix_mnt_path_to_windows_drive,
)


def test_build_indexed_image_path_candidates_keeps_translated_drive_path_on_posix():
    candidates = build_indexed_image_path_candidates(
        r"L:\Tencent Files\foo\bar.png",
        backend_file="/repo/backend/services/image_service.py",
    )

    if os.name == "nt":
        assert r"L:\Tencent Files\foo\bar.png" in candidates
    else:
        assert "/mnt/l/Tencent Files/foo/bar.png" in candidates


def test_normalize_indexed_image_path_preserves_posix_roots_without_host_abspath():
    normalized = normalize_indexed_image_path("/test/retrieve.png")

    assert normalized == "/test/retrieve.png"


def test_translate_posix_mnt_path_to_windows_drive():
    translated = translate_posix_mnt_path_to_windows_drive("/mnt/l/Tencent Files/foo/bar.png")

    assert translated == r"L:\Tencent Files\foo\bar.png"


@pytest.mark.skipif(os.name == "nt", reason="Drive-letter translation is only needed on non-Windows runtimes")
def test_resolve_existing_indexed_image_path_uses_translated_wsl_candidate(monkeypatch):
    translated = "/mnt/l/Tencent Files/foo/bar.png"

    def fake_exists(path):
        return path == translated

    monkeypatch.setattr("utils.source_paths.os.path.exists", fake_exists)
    monkeypatch.setattr("utils.source_paths.os.path.realpath", lambda path: path)

    resolved = resolve_existing_indexed_image_path(
        r"L:\Tencent Files\foo\bar.png",
        backend_file="/repo/backend/services/image_service.py",
    )

    assert resolved == translated
