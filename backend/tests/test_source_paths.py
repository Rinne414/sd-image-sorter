"""
Tests for cross-runtime indexed image path resolution.
"""
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from utils.source_paths import (  # noqa: E402
    build_indexed_folder_scope_query_patterns,
    build_indexed_image_lookup_candidates,
    build_indexed_image_path_candidates,
    is_indexed_image_path_in_folder_scope,
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


def test_normalize_indexed_image_path_normalizes_windows_drive_case_and_separators():
    normalized = normalize_indexed_image_path(r"l:/Tencent Files\foo/bar.png")

    assert normalized == r"L:\Tencent Files\foo\bar.png"


def test_build_indexed_image_lookup_candidates_include_windows_path_variants():
    candidates = build_indexed_image_lookup_candidates(r"l:/Tencent Files\foo/bar.png")

    assert r"L:\Tencent Files\foo\bar.png" in candidates
    if os.name != "nt":
        assert "/mnt/l/Tencent Files/foo/bar.png" in candidates


def test_build_indexed_folder_scope_query_patterns_include_cross_runtime_prefixes():
    patterns = build_indexed_folder_scope_query_patterns(r"l:/Tencent Files\foo")

    assert (r"L:\Tencent Files\foo", "L:\\Tencent Files\\foo\\") in patterns
    if os.name != "nt":
        assert ("/mnt/l/Tencent Files/foo", "/mnt/l/Tencent Files/foo/") in patterns


def test_is_indexed_image_path_in_folder_scope_distinguishes_recursive_and_direct_children():
    image_path = r"L:\Tencent Files\foo\nested\image.png"
    folder_path = "/mnt/l/Tencent Files/foo"

    assert is_indexed_image_path_in_folder_scope(image_path, folder_path, recursive=True) is True
    assert is_indexed_image_path_in_folder_scope(image_path, folder_path, recursive=False) is False

    direct_child_path = r"L:\Tencent Files\foo\image.png"
    assert is_indexed_image_path_in_folder_scope(direct_child_path, folder_path, recursive=False) is True


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
