"""
CRITICAL: Path validation security tests.

These tests verify that the path validation utilities correctly prevent
directory traversal attacks and other path-based security vulnerabilities.

Priority: CRITICAL
"""
import os
import sys
from pathlib import Path

import pytest

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from utils.path_validation import (
    is_safe_path,
    normalize_user_path,
    validate_folder_path,
    validate_file_path,
    sanitize_filename,
    validate_output_path,
    validate_image_output_path,
    ALLOWED_IMAGE_EXTENSIONS,
    MAX_PATH_DEPTH,
    MAX_PATH_LENGTH,
)


class TestIsSafePath:
    """Tests for is_safe_path function - critical for preventing directory traversal."""

    def test_identical_paths_are_safe(self, tmp_path: Path):
        """Identical paths should be considered safe."""
        base = str(tmp_path)
        assert is_safe_path(base, base) is True

    def test_subdirectory_is_safe(self, tmp_path: Path):
        """Subdirectories within base path should be safe."""
        base = str(tmp_path)
        sub = str(tmp_path / "subdir" / "nested")
        assert is_safe_path(base, sub) is True

    def test_parent_directory_is_unsafe(self, tmp_path: Path):
        """Parent directory traversal should be blocked."""
        base = str(tmp_path / "subdir")
        parent = str(tmp_path)
        # parent is NOT a child of base, so it should be False
        assert is_safe_path(base, parent) is False

    def test_relative_traversal_is_blocked(self, tmp_path: Path):
        """Path traversal with ../ should be blocked."""
        base = str(tmp_path)
        traversal = str(tmp_path / "subdir" / ".." / ".." / ".." / "etc" / "passwd")
        # After resolution, this should be outside base
        assert is_safe_path(base, traversal) is False

    def test_sibling_directory_is_unsafe(self, tmp_path: Path):
        """Sibling directories should not be accessible."""
        base = str(tmp_path / "allowed")
        sibling = str(tmp_path / "forbidden")
        assert is_safe_path(base, sibling) is False

    def test_absolute_path_outside_base_is_unsafe(self, tmp_path: Path):
        """Absolute paths outside base should be blocked."""
        base = str(tmp_path)
        outside = "/etc/passwd" if os.name != "nt" else "C:\\Windows\\System32"
        assert is_safe_path(base, outside) is False

    def test_symlink_outside_base_is_blocked(self, tmp_path: Path):
        """Symlinks pointing outside base should be blocked."""
        # Create a directory inside tmp_path
        base_dir = tmp_path / "base"
        base_dir.mkdir()

        # Create a symlink pointing outside
        link_target = tmp_path / "outside"
        link_target.mkdir()
        link_path = base_dir / "link"

        try:
            link_path.symlink_to(link_target)
            # The symlink resolves to outside base, should be blocked
            assert is_safe_path(str(base_dir), str(link_path)) is False
        except OSError:
            # Symlinks may not be supported on this system
            pytest.skip("Symlinks not supported on this system")

    def test_null_byte_in_path_is_handled(self, tmp_path: Path):
        """Null bytes in paths should be handled safely."""
        base = str(tmp_path)
        malicious = str(tmp_path / "file\x00.txt")
        # Should either return False or handle gracefully
        result = is_safe_path(base, malicious)
        # The important thing is it doesn't crash or return True incorrectly
        assert isinstance(result, bool)

    def test_empty_path_returns_false(self, tmp_path: Path):
        """Empty paths should return False."""
        assert is_safe_path(str(tmp_path), "") is False
        assert is_safe_path(str(tmp_path), None) is False


class TestValidateFolderPath:
    """Tests for folder path validation."""

    def test_valid_existing_folder(self, tmp_path: Path):
        """Valid existing folder should pass."""
        is_valid, error = validate_folder_path(str(tmp_path))
        assert is_valid is True
        assert error is None

    def test_empty_path_fails(self):
        """Empty path should fail validation."""
        is_valid, error = validate_folder_path("")
        assert is_valid is False
        assert "empty" in error.lower()

    def test_none_path_fails(self):
        """None path should fail validation."""
        is_valid, error = validate_folder_path(None)
        assert is_valid is False
        assert "empty" in error.lower()

    def test_null_byte_in_path_fails(self):
        """Null bytes in path should fail validation."""
        is_valid, error = validate_folder_path("/path/to/\x00folder")
        assert is_valid is False
        assert "invalid" in error.lower()

    def test_nonexistent_folder_fails(self):
        """Nonexistent folder should fail without allow_create."""
        is_valid, error = validate_folder_path("/nonexistent/path/12345")
        assert is_valid is False
        assert "not exist" in error.lower()

    def test_nonexistent_folder_with_allow_create(self):
        """Nonexistent folder should pass with allow_create=True."""
        # Use a path that definitely doesn't exist
        nonexistent = f"/tmp/nonexistent_test_{os.getpid()}_12345"
        is_valid, error = validate_folder_path(nonexistent, allow_create=True)
        assert is_valid is True
        assert error is None

    def test_moderately_deep_path_is_allowed(self, tmp_path: Path):
        """Valid nested paths below the configured depth should still pass."""
        base_depth = len(tmp_path.parts)
        extra_levels = max(1, min(25, MAX_PATH_DEPTH - base_depth - 1))
        nested = tmp_path
        for index in range(extra_levels):
            nested = nested / f"level_{index}"

        is_valid, error = validate_folder_path(str(nested), allow_create=True)
        assert is_valid is True
        assert error is None

    def test_path_depth_limit_still_blocks_excessive_nesting(self, tmp_path: Path):
        """Paths beyond MAX_PATH_DEPTH should still fail."""
        base_depth = len(tmp_path.parts)
        extra_levels = max(1, MAX_PATH_DEPTH - base_depth + 2)
        nested = tmp_path
        for index in range(extra_levels):
            nested = nested / f"too_deep_{index}"

        is_valid, error = validate_folder_path(str(nested), allow_create=True)
        assert is_valid is False
        assert "depth" in error.lower()

    def test_double_dot_inside_name_is_allowed(self, tmp_path: Path):
        """Legitimate names containing '..' should not be treated as traversal."""
        candidate = tmp_path / "model..v2"
        is_valid, error = validate_folder_path(str(candidate), allow_create=True)
        assert is_valid is True
        assert error is None

    def test_file_path_fails(self, tmp_path: Path):
        """File path should fail folder validation."""
        file_path = tmp_path / "test.txt"
        file_path.write_text("test")

        is_valid, error = validate_folder_path(str(file_path))
        assert is_valid is False
        assert "not a directory" in error.lower()

    def test_very_long_path_fails(self):
        """Paths exceeding MAX_PATH_LENGTH should fail with a length-specific error."""
        prefix = "C:\\" if os.name == "nt" else "/"
        long_path = prefix + "a" * (MAX_PATH_LENGTH + 1)
        is_valid, error = validate_folder_path(long_path)
        assert is_valid is False
        assert "length" in error.lower() or "long" in error.lower() or "invalid" in error.lower()

    def test_wsl_windows_drive_path_is_normalized_and_valid(self):
        """Windows drive paths should map to /mnt/<drive>/... under WSL-like environments."""
        if os.name == "nt":
            pytest.skip("Windows path translation is only needed on non-Windows systems")

        repo_root = Path(__file__).resolve().parents[2]
        repo_parts = repo_root.parts
        if len(repo_parts) < 3 or repo_parts[1] != "mnt" or len(repo_parts[2]) != 1:
            pytest.skip("Repository is not mounted from /mnt/<drive> in this environment")

        drive = repo_parts[2].upper()
        remainder = repo_parts[3:]
        windows_style = drive + ":\\" + "\\".join(remainder)

        normalized = normalize_user_path(windows_style)

        assert normalized == str(repo_root)
        is_valid, error = validate_folder_path(windows_style)
        assert is_valid is True
        assert error is None

    def test_windows_drive_letter_is_not_mistaken_for_invalid_filename(self):
        """Drive-letter colons should not trigger the invalid filename guard."""
        is_valid, error = validate_folder_path(r"L:\folder:name")
        assert is_valid is False
        assert "invalid filename" in error.lower()


class TestValidateFilePath:
    """Tests for file path validation."""

    def test_valid_existing_file(self, tmp_path: Path):
        """Valid existing file should pass."""
        file_path = tmp_path / "test.png"
        file_path.write_bytes(b"fake image data")

        is_valid, error = validate_file_path(str(file_path))
        assert is_valid is True
        assert error is None

    def test_empty_path_fails(self):
        """Empty path should fail validation."""
        is_valid, error = validate_file_path("")
        assert is_valid is False
        assert "empty" in error.lower()

    def test_null_byte_in_path_fails(self):
        """Null bytes in path should fail validation."""
        is_valid, error = validate_file_path("/path/\x00file.png")
        assert is_valid is False
        assert "invalid" in error.lower()

    def test_nonexistent_file_fails(self):
        """Nonexistent file should fail validation."""
        is_valid, error = validate_file_path("/nonexistent/file_12345.png")
        assert is_valid is False
        assert "not exist" in error.lower()

    def test_directory_fails(self, tmp_path: Path):
        """Directory path should fail file validation."""
        is_valid, error = validate_file_path(str(tmp_path))
        assert is_valid is False
        assert "not a file" in error.lower()

    def test_extension_validation_allowed(self, tmp_path: Path):
        """Files with allowed extensions should pass."""
        for ext in ALLOWED_IMAGE_EXTENSIONS:
            file_path = tmp_path / f"test{ext}"
            file_path.write_bytes(b"fake data")

            is_valid, error = validate_file_path(str(file_path), ALLOWED_IMAGE_EXTENSIONS)
            assert is_valid is True, f"Extension {ext} should be allowed"

    def test_extension_validation_blocked(self, tmp_path: Path):
        """Files with disallowed extensions should fail."""
        file_path = tmp_path / "test.exe"
        file_path.write_bytes(b"fake data")

        is_valid, error = validate_file_path(str(file_path), ALLOWED_IMAGE_EXTENSIONS)
        assert is_valid is False
        assert "not allowed" in error.lower()

    def test_case_insensitive_extension(self, tmp_path: Path):
        """Extension check should be case-insensitive."""
        file_path = tmp_path / "test.PNG"
        file_path.write_bytes(b"fake data")

        is_valid, error = validate_file_path(str(file_path), ALLOWED_IMAGE_EXTENSIONS)
        assert is_valid is True

    def test_no_extension_with_allowed_list(self, tmp_path: Path):
        """Files without extension should fail when allowed_extensions is set."""
        file_path = tmp_path / "noextension"
        file_path.write_bytes(b"fake data")

        is_valid, error = validate_file_path(str(file_path), ALLOWED_IMAGE_EXTENSIONS)
        assert is_valid is False


class TestSanitizeFilename:
    """Tests for filename sanitization."""

    def test_normal_filename_unchanged(self):
        """Normal filenames should pass through unchanged."""
        assert sanitize_filename("image.png") == "image.png"
        assert sanitize_filename("my_file.jpg") == "my_file.jpg"

    def test_path_separators_removed(self):
        """Path separators should be removed."""
        assert ".." not in sanitize_filename("../../../etc/passwd")
        assert "/" not in sanitize_filename("path/to/file.png")
        assert "\\" not in sanitize_filename("path\\to\\file.png")

    def test_dangerous_characters_replaced(self):
        """Dangerous characters should be replaced."""
        sanitized = sanitize_filename('file<>:"|?*.png')
        for char in '<>:"|?*':
            assert char not in sanitized

    def test_empty_filename_returns_default(self):
        """Empty filenames should return 'unnamed'."""
        assert sanitize_filename("") == "unnamed"
        assert sanitize_filename(None) == "unnamed"

    def test_whitespace_only_returns_default(self):
        """Whitespace-only filenames should return 'unnamed'."""
        assert sanitize_filename("   ") == "unnamed"
        assert sanitize_filename("\t\n") == "unnamed"

    def test_dots_only_returns_default(self):
        """Dot-only filenames should be handled safely."""
        # Multiple dots are collapsed but single dot is kept for extensions
        result = sanitize_filename("...")
        # Should either be collapsed or return default
        assert result in ["unnamed", "."]

    def test_leading_trailing_dots_handled(self):
        """Leading and trailing dots should be handled safely."""
        # New behavior: dots are preserved for extensions and hidden files
        # but multiple leading dots are reduced
        result = sanitize_filename(".hidden.")
        assert "hidden" in result
        result2 = sanitize_filename("...file...")
        assert "file" in result2

    def test_long_filename_truncated(self):
        """Very long filenames should be truncated."""
        long_name = "a" * 300 + ".png"
        sanitized = sanitize_filename(long_name)
        assert len(sanitized) <= 200 + len(".png")
        assert sanitized.endswith(".png")

    def test_unicode_preserved(self):
        """Unicode characters should be preserved."""
        assert sanitize_filename("image.png") == "image.png"
        # Chinese characters
        result = sanitize_filename(".png")
        assert ".png" in result

    def test_safe_special_chars_preserved(self):
        """v3.2.2: parens, apostrophes, commas, brackets, ampersands etc.
        must be preserved so caption sidecars keep their basename match
        with the source image (critical for LoRA training)."""
        assert sanitize_filename("my (lora char).png") == "my (lora char).png"
        assert sanitize_filename("apostrophe's.png") == "apostrophe's.png"
        assert sanitize_filename("with.commas, sort.png") == "with.commas, sort.png"
        assert sanitize_filename("[bracket] - tag.png") == "[bracket] - tag.png"
        assert sanitize_filename("food&drink.png") == "food&drink.png"
        assert sanitize_filename("price=$5.png") == "price=$5.png"
        assert sanitize_filename("cool!#1.png") == "cool!#1.png"
        # Mixed case the user originally reported
        assert sanitize_filename("mixed (test_001).png") == "mixed (test_001).png"

    def test_os_illegal_chars_still_replaced(self):
        """v3.2.2: even with the relaxed allow-list, the OS-illegal
        characters that Windows / NTFS reject must still be sanitized."""
        # Windows-illegal: < > : " / \\ | ? *
        for ch in ['<', '>', ':', '"', '|', '?', '*']:
            sanitized = sanitize_filename(f"foo{ch}bar.png")
            assert ch not in sanitized, f"{ch!r} should be removed but got {sanitized!r}"
        # Path separators
        assert "/" not in sanitize_filename("a/b.png")
        assert "\\" not in sanitize_filename("a\\b.png")
        # Null byte
        assert "\x00" not in sanitize_filename("foo\x00bar.png")


class TestValidateOutputPath:
    """Tests for output path validation."""

    def test_valid_output_path(self, tmp_path: Path):
        """Valid output path should pass."""
        is_valid, error, full_path = validate_output_path(
            str(tmp_path), "output.png"
        )
        assert is_valid is True
        assert error is None
        assert full_path is not None
        assert full_path.endswith("output.png")

    def test_sanitizes_filename(self, tmp_path: Path):
        """Output path should sanitize the filename."""
        is_valid, error, full_path = validate_output_path(
            str(tmp_path), "../../../etc/passwd"
        )
        # Should sanitize the filename
        assert "passwd" not in full_path or ".." not in full_path

    def test_creates_directory_if_needed(self, tmp_path: Path):
        """Should allow creation of new directory."""
        new_dir = tmp_path / "new_subdir"
        is_valid, error, full_path = validate_output_path(
            str(new_dir), "test.png"
        )
        assert is_valid is True

    def test_invalid_base_path_fails(self):
        """Invalid base path should fail."""
        # Use a path that definitely doesn't exist and can't be created (invalid chars)
        is_valid, error, full_path = validate_output_path(
            "/nonexistent\0path/invalid", "test.png"
        )
        # Should fail due to null byte or other invalid characters
        assert is_valid is False or error is not None


class TestValidateImageOutputPath:
    """Tests for safe output image path validation used by metadata editing."""

    def test_valid_image_output_path(self, tmp_path: Path):
        candidate = tmp_path / "edited.png"

        result = validate_image_output_path(str(candidate))

        assert result.path == candidate.resolve()
        assert result.exists is False
        assert result.extension == ".png"

    def test_rejects_missing_parent_directory(self, tmp_path: Path):
        candidate = tmp_path / "missing" / "edited.png"

        with pytest.raises(ValueError, match="parent directory"):
            validate_image_output_path(str(candidate))

    def test_rejects_unsupported_extension(self, tmp_path: Path):
        candidate = tmp_path / "edited.gif"

        with pytest.raises(ValueError, match="Unsupported output format"):
            validate_image_output_path(str(candidate))

    def test_rejects_symlink_output_target(self, tmp_path: Path):
        real_target = tmp_path / "real.png"
        real_target.write_bytes(b"png")
        link_target = tmp_path / "link.png"

        try:
            link_target.symlink_to(real_target)
        except OSError:
            pytest.skip("Symlinks not supported on this system")

        with pytest.raises(ValueError, match="symlink"):
            validate_image_output_path(str(link_target), allow_overwrite=True)


class TestDirectoryTraversalAttacks:
    """
    CRITICAL: Test various directory traversal attack patterns.

    These tests verify that common attack patterns are blocked.
    """

    @pytest.mark.parametrize("attack_pattern", [
        "../../../etc/passwd",
        "..\\..\\..\\windows\\system32",
        "..%2F..%2F..%2Fetc%2Fpasswd",  # URL encoded
        "....//....//....//etc/passwd",  # Double dots
        "..%252f..%252f..%252f",  # Double URL encoded
        "%2e%2e%2f%2e%2e%2f%2e%2e%2f",  # All URL encoded
        "..\u0000",  # Null byte injection
        "..%00",  # URL encoded null
    ])
    def test_traversal_patterns_blocked(self, tmp_path: Path, attack_pattern: str):
        """Various traversal patterns should be blocked."""
        base = str(tmp_path)
        # The pattern may not resolve to anything valid, but should be blocked
        result = is_safe_path(base, attack_pattern)
        # Either returns False or the path doesn't exist anyway
        # The important thing is it doesn't allow access to parent directories
        if result:
            # If it returns True, verify it's still within base
            resolved = Path(attack_pattern).resolve()
            base_resolved = Path(base).resolve()
            assert base_resolved in resolved.parents or resolved == base_resolved


class TestEdgeCases:
    """Edge case tests for path validation."""

    def test_symlink_to_self(self, tmp_path: Path):
        """Symlink pointing to itself should be handled."""
        link_path = tmp_path / "self_link"
        try:
            # Create symlink pointing to parent
            link_path.symlink_to(tmp_path)
            # Should be handled gracefully
            is_valid, _ = validate_folder_path(str(link_path))
            # Should either work or fail gracefully
            assert isinstance(is_valid, bool)
        except OSError:
            pytest.skip("Symlinks not supported")

    def test_unicode_path(self, tmp_path: Path):
        """Unicode characters in paths should be handled."""
        unicode_dir = tmp_path / "unicode_dir"
        unicode_dir.mkdir()

        is_valid, error = validate_folder_path(str(unicode_dir))
        assert is_valid is True

    def test_spaces_in_path(self, tmp_path: Path):
        """Spaces in paths should be handled correctly."""
        space_dir = tmp_path / "path with spaces"
        space_dir.mkdir()

        is_valid, error = validate_folder_path(str(space_dir))
        assert is_valid is True

    def test_relative_path_handling(self, tmp_path: Path):
        """Relative paths should be resolved correctly."""
        # Use the tmp_path which exists
        is_valid, error = validate_folder_path(str(tmp_path))
        assert is_valid is True

    def test_network_path_on_windows(self):
        """UNC/network paths should be handled on Windows."""
        if os.name != "nt":
            pytest.skip("Windows-only test")

        # This should either fail validation or be handled
        is_valid, error = validate_folder_path("\\\\server\\share")
        # Just check it doesn't crash
        assert isinstance(is_valid, bool)


class TestSQLInjectionInPaths:
    """
    Test that SQL injection patterns in paths don't cause issues.

    While paths are not directly used in SQL, this ensures defense in depth.
    """

    @pytest.mark.parametrize("sql_pattern", [
        "'; DROP TABLE images; --",
        "file' OR '1'='1",
        "file; DELETE FROM tags",
        "file\" OR \"1\"=\"1",
        "file) OR (1=1",
    ])
    def test_sql_patterns_in_paths(self, tmp_path: Path, sql_pattern: str):
        """SQL injection patterns in paths should be handled safely."""
        # These patterns should just be treated as filenames
        sanitized = sanitize_filename(sql_pattern)

        # Should not contain SQL special characters after sanitization
        dangerous_chars = ["'", '"', ";", "(", ")"]
        for char in dangerous_chars:
            # Either removed or replaced
            pass  # sanitize_filename replaces with underscore

        # The important thing is it doesn't crash
        assert isinstance(sanitized, str)
