"""
Path validation utilities for secure file operations.
Prevents directory traversal attacks and validates file paths.
"""
import os
import re
from pathlib import Path
from typing import Optional, Tuple
from urllib.parse import unquote

from config import (
    ALLOWED_IMAGE_EXTENSIONS,
    ALLOWED_MODEL_EXTENSIONS,
    MAX_PATH_DEPTH,
    MAX_PATH_LENGTH,
    MAX_FILENAME_LENGTH,
)


# Suspicious patterns for directory traversal and injection attacks
# Note: We don't check for ':' here because Windows drive letters (C:\) use it
SUSPICIOUS_PATTERNS = [
    r'[\x00-\x1f]',    # Control characters including null byte
    r'[\x7f-\x9f]',    # Extended control characters
    r'^\s+$',          # Whitespace-only
    r'^\.+$',          # Dot-only names (., .., ...)
]

# Invalid characters for filename components (not full paths)
INVALID_FILENAME_CHARS = r'[<>:"|?*]'


def _contains_suspicious_patterns(path_str: str) -> bool:
    """
    Check if a path string contains suspicious patterns.

    Checks for directory traversal and injection attacks, but NOT Windows
    drive letter colons which are valid in full paths.

    Args:
        path_str: The path string to check

    Returns:
        True if suspicious patterns found, False otherwise
    """
    variants = []
    candidate = str(path_str or "")
    for _ in range(3):
        if candidate in variants:
            break
        variants.append(candidate)
        candidate = unquote(candidate)

    for value in variants:
        for pattern in SUSPICIOUS_PATTERNS:
            if re.search(pattern, value):
                return True

        normalized = value.replace("\\", "/")
        parts = [part for part in normalized.split("/") if part not in ("", ".")]
        if any(part == ".." for part in parts):
            return True
    return False


def _contains_invalid_filename_chars(path_str: str) -> bool:
    """
    Check if the filename component contains invalid characters.

    This checks only the filename part, not the full path, so Windows
    drive letters like 'C:' are not flagged.

    Args:
        path_str: The path string to check

    Returns:
        True if filename contains invalid characters, False otherwise
    """
    # Extract just the filename component
    filename = os.path.basename(path_str)

    # Check for invalid characters in the filename only
    if re.search(INVALID_FILENAME_CHARS, filename):
        return True
    return False


def _is_same_or_subpath(parent: Path, child: Path) -> bool:
    """
    Check if child is the same as parent or is a subdirectory of parent.
    Uses proper path comparison, not string prefix matching.

    Args:
        parent: The parent directory path
        child: The child path to check

    Returns:
        True if child is parent or is inside parent, False otherwise
    """
    try:
        parent_resolved = parent.resolve()
        child_resolved = child.resolve()

        # Check if they are the same path
        if parent_resolved == child_resolved:
            return True

        # Check if child is a descendant of parent
        # This uses Path.parents which is a sequence of ancestor paths
        return parent_resolved in child_resolved.parents
    except (ValueError, OSError):
        return False


def _validate_path_depth(path: Path) -> bool:
    """
    Check if a path exceeds the maximum allowed depth.

    Args:
        path: The path to check

    Returns:
        True if path depth is acceptable, False otherwise
    """
    try:
        parts = path.parts
        return len(parts) <= MAX_PATH_DEPTH
    except (ValueError, OSError):
        return False


def _validate_symlink_target(path: Path, allowed_base: Optional[Path] = None) -> bool:
    """
    Validate that a symlink target is safe.

    Args:
        path: The path to check (may be a symlink)
        allowed_base: If provided, symlink target must be within this base

    Returns:
        True if symlink is safe or not a symlink, False otherwise
    """
    try:
        if not path.exists():
            return True

        if path.is_symlink():
            # Resolve the symlink target
            target = path.resolve()

            # If we have an allowed base, check the target is within it
            if allowed_base is not None:
                allowed_resolved = allowed_base.resolve()
                return _is_same_or_subpath(allowed_resolved, target)

            # Without a base, just ensure the target exists and is accessible
            return target.exists()

        return True
    except (ValueError, OSError):
        return False


def is_safe_path(base_path: str, user_path: str) -> bool:
    """
    Check if a user-provided path is safely within the base path.
    Prevents directory traversal attacks like '../../../etc/passwd'.

    Args:
        base_path: The allowed base directory
        user_path: The user-provided path to validate

    Returns:
        True if path is safe, False otherwise
    """
    if not base_path or not user_path:
        return False

    # Check for suspicious patterns in the raw user input
    if _contains_suspicious_patterns(user_path):
        return False

    # Check for invalid characters in filename component
    if _contains_invalid_filename_chars(user_path):
        return False

    try:
        base = Path(base_path).resolve()
        target = Path(user_path)

        # Check path depth before resolving
        if not _validate_path_depth(target):
            return False

        # Now resolve the target
        target_resolved = target.resolve()

        # Use proper path comparison instead of string prefix
        if not _is_same_or_subpath(base, target_resolved):
            return False

        # Validate symlink target if applicable
        if target.exists() and target.is_symlink():
            if not _validate_symlink_target(target, base):
                return False

        return True
    except (ValueError, OSError):
        return False


def validate_folder_path(
    path: str,
    allow_create: bool = False,
    allowed_base: Optional[str] = None
) -> Tuple[bool, Optional[str]]:
    """
    Validate that a folder path is safe and exists (or can be created).

    Args:
        path: The folder path to validate
        allow_create: If True, the folder doesn't need to exist
        allowed_base: If provided, path must be within this base directory

    Returns:
        Tuple of (is_valid, error_message)
    """
    if not path or not isinstance(path, str):
        return False, "Path cannot be empty"

    # Check for suspicious patterns (directory traversal, control chars)
    if _contains_suspicious_patterns(path):
        return False, "Path contains invalid or suspicious characters"

    # Check for invalid characters in filename component (but allow Windows drive letters)
    if _contains_invalid_filename_chars(path):
        return False, "Path contains invalid filename characters"

    # Check path length before processing
    if len(path) > MAX_PATH_LENGTH:
        return False, f"Path exceeds maximum length of {MAX_PATH_LENGTH} characters"

    # Resolve to absolute path
    try:
        path_obj = Path(path)
    except (ValueError, OSError) as e:
        return False, f"Invalid path format: {str(e)}"

    # Check path depth
    if not _validate_path_depth(path_obj):
        return False, f"Path depth exceeds maximum of {MAX_PATH_DEPTH}"

    try:
        resolved = path_obj.resolve()
    except (ValueError, OSError) as e:
        return False, f"Cannot resolve path: {str(e)}"

    # Check resolved path length
    resolved_str = str(resolved)
    if len(resolved_str) > MAX_PATH_LENGTH:
        return False, f"Resolved path exceeds maximum length of {MAX_PATH_LENGTH} characters"

    # If allowed_base is specified, verify the path is within it
    if allowed_base:
        try:
            base_resolved = Path(allowed_base).resolve()
            if not _is_same_or_subpath(base_resolved, resolved):
                return False, "Path is outside allowed directory"
        except (ValueError, OSError) as e:
            return False, f"Invalid base directory: {str(e)}"

    if allow_create:
        # Check if parent directory exists or can be created
        parent = resolved.parent
        if not parent.exists():
            # Walk up to find the first existing ancestor
            current = parent
            while current != current.parent:  # Stop at root
                if current.exists():
                    # Found existing ancestor, verify it's a directory
                    if not current.is_dir():
                        return False, f"Ancestor path '{current}' is not a directory"
                    break
                current = current.parent
            else:
                # Reached root without finding existing path
                # Check if root exists (e.g., drive letter on Windows)
                root = resolved.anchor
                if not root or not Path(root).exists():
                    return False, "Drive or root path does not exist"

        # Check for symlink safety
        if resolved.exists() and resolved.is_symlink():
            if allowed_base and not _validate_symlink_target(resolved, Path(allowed_base)):
                return False, "Symlink target is outside allowed directory"

        return True, None
    else:
        if not resolved.exists():
            return False, "Path does not exist"
        if not resolved.is_dir():
            return False, "Path is not a directory"

        # Check for symlink safety
        if resolved.is_symlink():
            if allowed_base and not _validate_symlink_target(resolved, Path(allowed_base)):
                return False, "Symlink target is outside allowed directory"

        return True, None


def validate_file_path(
    path: str,
    allowed_extensions: Optional[set] = None,
    allowed_base: Optional[str] = None
) -> Tuple[bool, Optional[str]]:
    """
    Validate that a file path is safe and exists.

    Args:
        path: The file path to validate
        allowed_extensions: Set of allowed file extensions (e.g., {'.png', '.jpg'})
        allowed_base: If provided, path must be within this base directory

    Returns:
        Tuple of (is_valid, error_message)
    """
    if not path or not isinstance(path, str):
        return False, "Path cannot be empty"

    # Check for suspicious patterns (directory traversal, control chars)
    if _contains_suspicious_patterns(path):
        return False, "Path contains invalid or suspicious characters"

    # Check for invalid characters in filename component (but allow Windows drive letters)
    if _contains_invalid_filename_chars(path):
        return False, "Path contains invalid filename characters"

    # Check path length before processing
    if len(path) > MAX_PATH_LENGTH:
        return False, f"Path exceeds maximum length of {MAX_PATH_LENGTH} characters"

    try:
        path_obj = Path(path)
    except (ValueError, OSError) as e:
        return False, f"Invalid path format: {str(e)}"

    # Check path depth
    if not _validate_path_depth(path_obj):
        return False, f"Path depth exceeds maximum of {MAX_PATH_DEPTH}"

    try:
        resolved = path_obj.resolve()
    except (ValueError, OSError) as e:
        return False, f"Cannot resolve path: {str(e)}"

    # Check resolved path length
    resolved_str = str(resolved)
    if len(resolved_str) > MAX_PATH_LENGTH:
        return False, f"Resolved path exceeds maximum length of {MAX_PATH_LENGTH} characters"

    # If allowed_base is specified, verify the path is within it
    if allowed_base:
        try:
            base_resolved = Path(allowed_base).resolve()
            if not _is_same_or_subpath(base_resolved, resolved):
                return False, "Path is outside allowed directory"
        except (ValueError, OSError) as e:
            return False, f"Invalid base directory: {str(e)}"

    if not resolved.exists():
        return False, "File does not exist"

    if not resolved.is_file():
        return False, "Path is not a file"

    # Validate symlink target if applicable
    if resolved.is_symlink():
        if allowed_base and not _validate_symlink_target(resolved, Path(allowed_base)):
            return False, "Symlink target is outside allowed directory"
        elif not allowed_base:
            # Even without a base, validate the symlink resolves to an existing file
            try:
                target = resolved.resolve()
                if not target.exists():
                    return False, "Symlink target does not exist"
                if not target.is_file():
                    return False, "Symlink target is not a file"
            except (ValueError, OSError):
                return False, "Cannot resolve symlink target"

    if allowed_extensions:
        ext = resolved.suffix.lower()
        if ext not in allowed_extensions:
            return False, f"File extension '{ext}' not allowed"

    return True, None


def sanitize_filename(filename: str) -> str:
    """
    Sanitize a filename to remove potentially dangerous characters.

    Args:
        filename: The filename to sanitize

    Returns:
        Sanitized filename
    """
    if not filename:
        return "unnamed"

    # Remove path separators (handles both forward and backslash)
    filename = os.path.basename(filename)

    # Check for suspicious patterns in the filename itself
    if _contains_suspicious_patterns(filename):
        # Remove the suspicious characters
        filename = re.sub(r'[\x00-\x1f\x7f-\x9f]', '', filename)  # Remove control chars
        filename = re.sub(r'\.\.', '.', filename)  # Collapse double dots

    # Remove or replace dangerous characters
    # Keep alphanumeric, spaces, dots, underscores, hyphens, and unicode letters
    sanitized = re.sub(r'[^\w\s\.\-]', '_', filename, flags=re.UNICODE)

    # Remove leading/trailing spaces only (keep dots for extensions like .png)
    sanitized = sanitized.strip(' ')

    # Remove leading dots only if there are multiple (like .hidden files become hidden)
    # But preserve single leading dot for hidden files and extension dots
    while sanitized.startswith('..'):
        sanitized = sanitized[1:]

    # Ensure we don't end up with an empty string
    if not sanitized:
        return "unnamed"

    # Limit length
    if len(sanitized) > MAX_FILENAME_LENGTH:
        name, ext = os.path.splitext(sanitized)
        sanitized = name[:MAX_FILENAME_LENGTH - len(ext)] + ext

    return sanitized


def validate_output_path(
    path: str,
    filename: str,
    allowed_base: Optional[str] = None
) -> Tuple[bool, Optional[str], Optional[str]]:
    """
    Validate an output path and filename, creating directory if needed.

    Args:
        path: The output directory path
        filename: The desired filename
        allowed_base: If provided, output must be within this base directory

    Returns:
        Tuple of (is_valid, error_message, full_output_path)
    """
    is_valid, error = validate_folder_path(path, allow_create=True, allowed_base=allowed_base)
    if not is_valid:
        return False, error, None

    safe_filename = sanitize_filename(filename)

    try:
        resolved_dir = Path(path).resolve()
        full_path = resolved_dir / safe_filename

        # Resolve to check the final path
        resolved_full = full_path.resolve()

        # CRITICAL: Use proper path comparison instead of string prefix matching
        # This prevents bypasses like paths that start with the same string but are different directories
        # e.g., /app/uploads vs /app/uploads_backup would incorrectly match with string prefix
        if not _is_same_or_subpath(resolved_dir, resolved_full):
            return False, "Resolved path escapes target directory", None

        # Additional check: the filename component should not have changed the directory
        # This catches cases where the filename itself contains path components
        # (already handled by sanitize_filename, but defense in depth)
        if resolved_full.parent != resolved_dir:
            # The resolved path's parent should be exactly the target directory
            # If not, something is wrong (e.g., symlink tricks, path traversal)
            return False, "Invalid filename results in path escape", None

        # Check path depth and length for the final path
        if not _validate_path_depth(resolved_full):
            return False, f"Output path depth exceeds maximum of {MAX_PATH_DEPTH}", None

        if len(str(resolved_full)) > MAX_PATH_LENGTH:
            return False, f"Output path exceeds maximum length of {MAX_PATH_LENGTH} characters", None

        # Validate symlink target if the resolved path exists and is a symlink
        if resolved_full.exists() and resolved_full.is_symlink():
            if allowed_base and not _validate_symlink_target(resolved_full, Path(allowed_base)):
                return False, "Symlink target is outside allowed directory", None

        return True, None, str(resolved_full)
    except (ValueError, OSError) as e:
        return False, f"Invalid path: {str(e)}", None
